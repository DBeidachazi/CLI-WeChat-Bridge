#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BridgeLockPayload,
  readBridgeLockFile,
  shouldAutoReclaimBridgeLock,
} from "../bridge/bridge-state.ts";
import type {
  BridgeAdapterKind,
  BridgeLifecycleMode,
} from "../bridge/bridge-types.ts";
import {
  getConfiguredTmuxSessionPrefix,
  shouldMirrorBackgroundBridgeLogsToContainer,
} from "../config/bridge-config.ts";
import {
  BRIDGE_LOG_FILE,
  buildWorkspaceKey,
  CREDENTIALS_FILE,
  migrateLegacyChannelFiles,
} from "../wechat/channel-config.ts";
import {
  clearLocalCompanionEndpoint,
  type LocalCompanionEndpoint,
  readLocalCompanionEndpoint,
} from "./local-companion-link.ts";

type LocalCompanionLaunchAdapter = Exclude<BridgeAdapterKind, "shell">;

function requiresProxyCompanionEndpoint(
  adapter: LocalCompanionLaunchAdapter
): boolean {
  return adapter === "gemini" || adapter === "copilot";
}

interface LocalCompanionStartCliOptions {
  adapter: LocalCompanionLaunchAdapter;
  cwd: string;
  profile?: string;
  timeoutMs: number;
}

interface EndpointReadResult {
  endpoint: LocalCompanionEndpoint | null;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_ADAPTER: LocalCompanionLaunchAdapter = "codex";
const SHARED_SKILLS_ROOT = ".linkai";
const SHARED_SKILLS_DIRNAME = "skills";
const SHARED_ROOT_ENV_NAME = "WECHAT_BRIDGE_SHARED_ROOT";
const LEGACY_SHARED_SKILLS_ROOT = ".aiskill";
const SKILL_LINK_TARGETS = [
  ".claude/skills",
  ".codex/skills",
  ".gemini/skills",
  ".copilot/skills",
] as const;
const WECHAT_MULTIMODAL_SKILL_NAME = "wechat-bridge-multimodal";
const WECHAT_MULTIMODAL_SKILL_CONTENT = `# WeChat Bridge Multimodal

You are running behind CLI-WeChat-Bridge.

Rules:
- Treat WeChat as a multimodal channel.
- Incoming voice messages may already be transcribed into plain text.
- Incoming local images or media attachments, when present, are real user inputs and should be inspected directly.
- Do not claim that you cannot receive images if the runtime already provided local image inputs.
- When the user asks you to send local files or media back to WeChat, end the final reply with exactly one trailing \`wechat-attachments\` block.

Protocol:
\`\`\`wechat-attachments
image C:\\Users\\name\\Desktop\\photo.png
file C:\\Users\\name\\Desktop\\report.pdf
voice C:\\Users\\name\\Desktop\\reply.m4a
video C:\\Users\\name\\Desktop\\clip.mp4
\`\`\`

Notes:
- Put normal visible reply text before the attachment block.
- Use only absolute local paths unless the runtime explicitly accepts home-relative desktop paths.
- Include only files you really want to send.
`;

function log(adapter: LocalCompanionLaunchAdapter, message: string): void {
  process.stderr.write(`[wechat-${adapter}-start] ${message}\n`);
}

export function normalizeComparablePath(cwd: string): string {
  const normalized = path.resolve(cwd);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isSameWorkspaceCwd(left: string, right: string): boolean {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

export function parseCliArgs(argv: string[]): LocalCompanionStartCliOptions {
  let adapter: LocalCompanionLaunchAdapter = DEFAULT_ADAPTER;
  let cwd = process.env.WECHAT_BRIDGE_WORKDIR
    ? path.resolve(process.env.WECHAT_BRIDGE_WORKDIR)
    : process.cwd();
  let profile: string | undefined;
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: wechat-codex-start [--cwd <path>] [--profile <name-or-path>] [--timeout-ms <ms>]",
          "       wechat-claude-start [--cwd <path>] [--profile <name-or-path>] [--timeout-ms <ms>]",
          "       wechat-opencode-start [--cwd <path>] [--profile <name-or-path>] [--timeout-ms <ms>]",
          "       wechat-gemini-start [--cwd <path>] [--profile <name-or-path>] [--timeout-ms <ms>]",
          "       wechat-copilot-start [--cwd <path>] [--profile <name-or-path>] [--timeout-ms <ms>]",
          "       local-companion-start [--adapter <codex|claude|opencode|gemini|copilot>] [--cwd <path>] [--profile <name-or-path>] [--timeout-ms <ms>]",
          "",
          "Starts or reuses a Codex, Claude, OpenCode, Gemini, or Copilot bridge for the configured working directory, waits for the local endpoint, then opens the visible companion or panel.",
          "Default cwd is WECHAT_BRIDGE_WORKDIR when set; otherwise it is the current shell directory.",
          "tmux-backed launches keep the bridge persistent until another start command replaces it; direct foreground launches stay companion-bound.",
          "",
        ].join("\n")
      );
      process.exit(0);
    }

    if (arg === "--adapter") {
      if (
        !(
          next &&
          ["codex", "claude", "opencode", "gemini", "copilot"].includes(next)
        )
      ) {
        throw new Error(`Invalid adapter: ${next ?? "(missing)"}`);
      }
      adapter = next as LocalCompanionLaunchAdapter;
      i += 1;
      continue;
    }

    if (arg === "--cwd") {
      if (!next) {
        throw new Error("--cwd requires a value");
      }
      cwd = path.resolve(next);
      i += 1;
      continue;
    }

    if (arg === "--profile") {
      if (!next) {
        throw new Error("--profile requires a value");
      }
      profile = next;
      i += 1;
      continue;
    }

    if (arg === "--timeout-ms") {
      if (!next) {
        throw new Error("--timeout-ms requires a value");
      }
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 1000) {
        throw new Error("--timeout-ms must be a number >= 1000");
      }
      timeoutMs = Math.trunc(parsed);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { adapter, cwd, profile, timeoutMs };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !isPidAlive(pid);
}

async function stopExistingBridge(
  lock: BridgeLockPayload,
  requestedAdapter: LocalCompanionLaunchAdapter
): Promise<void> {
  const { pid, cwd } = lock;
  log(requestedAdapter, `Stopping existing bridge for ${cwd} (pid=${pid})...`);

  try {
    process.kill(pid);
  } catch (error) {
    if (isPidAlive(pid)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to stop existing bridge pid=${pid}: ${message}`);
    }
  }

  if (!(await waitForProcessExit(pid, 10_000))) {
    throw new Error(
      `Timed out waiting for existing bridge pid=${pid} to exit.`
    );
  }

  clearLocalCompanionEndpoint(cwd);
  log(
    requestedAdapter,
    `Cleared stale local companion endpoint for previous workspace ${cwd}.`
  );
}

async function isEndpointReachable(
  endpoint: LocalCompanionEndpoint
): Promise<boolean> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  return await new Promise<boolean>((resolve) => {
    const port = endpoint.serverPort ?? endpoint.port;
    const socket = net.connect({
      host: "127.0.0.1",
      port,
    });

    let done = false;
    const finish = (result: boolean) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(400);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function readUsableEndpoint(
  cwd: string,
  adapter: LocalCompanionLaunchAdapter
): Promise<EndpointReadResult> {
  const endpoint = readLocalCompanionEndpoint(cwd);
  if (!endpoint || endpoint.kind !== adapter) {
    return { endpoint: null };
  }

  if (await isEndpointReachable(endpoint)) {
    return { endpoint };
  }

  clearLocalCompanionEndpoint(cwd, endpoint.instanceId);
  log(adapter, `Removed stale local companion endpoint for ${cwd}.`);
  return { endpoint: null };
}

export function buildBackgroundBridgeArgs(
  entryPath: string,
  options: LocalCompanionStartCliOptions,
  lifecycle: BridgeLifecycleMode = "companion_bound",
  renderMode?: "embedded"
): string[] {
  const args = [
    "--no-warnings",
    "--experimental-strip-types",
    entryPath,
    "--adapter",
    options.adapter,
    "--cwd",
    options.cwd,
    "--lifecycle",
    lifecycle,
  ];

  if (renderMode) {
    args.push("--render-mode", renderMode);
  }

  if (options.profile) {
    args.push("--profile", options.profile);
  }

  return args;
}

export function resolveForegroundClientEntryPath(
  _adapter: LocalCompanionLaunchAdapter
): string {
  return path.resolve(MODULE_DIR, "local-companion.ts");
}

export function buildForegroundClientArgs(
  entryPath: string,
  options: LocalCompanionStartCliOptions
): string[] {
  return [
    "--no-warnings",
    "--experimental-strip-types",
    entryPath,
    "--adapter",
    options.adapter,
    "--cwd",
    options.cwd,
  ];
}

function quotePosixArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildForegroundClientCommandLine(
  options: LocalCompanionStartCliOptions
): string {
  const entryPath = resolveForegroundClientEntryPath(options.adapter);
  const args = buildForegroundClientArgs(entryPath, options);
  return [process.execPath, ...args].map(quotePosixArg).join(" ");
}

export function buildTmuxSessionName(
  options: LocalCompanionStartCliOptions
): string {
  return `${getConfiguredTmuxSessionPrefix()}-${options.adapter}-${buildWorkspaceKey(options.cwd)}`;
}

function isTmuxAvailable(): boolean {
  return (
    spawnSync("tmux", ["-V"], {
      stdio: "ignore",
      windowsHide: true,
    }).status === 0
  );
}

function tmuxCommand(
  args: string[],
  options: { stdio?: "ignore" | "inherit" } = {}
): number {
  const result = spawnSync("tmux", args, {
    cwd: process.cwd(),
    stdio: options.stdio ?? "ignore",
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

function doesTmuxSessionExist(sessionName: string): boolean {
  return tmuxCommand(["has-session", "-t", sessionName]) === 0;
}

function ensureSharedWechatSkill(sharedSkillsDir: string): void {
  const skillDir = path.join(sharedSkillsDir, WECHAT_MULTIMODAL_SKILL_NAME);
  const skillFile = path.join(skillDir, "SKILL.md");
  fs.mkdirSync(skillDir, { recursive: true });
  if (!fs.existsSync(skillFile)) {
    fs.writeFileSync(skillFile, WECHAT_MULTIMODAL_SKILL_CONTENT, "utf8");
  }
}

function resolveSharedSkillsDir(cwd: string): string {
  const sharedRoot = process.env[SHARED_ROOT_ENV_NAME]
    ? path.resolve(process.env[SHARED_ROOT_ENV_NAME])
    : path.join(cwd, SHARED_SKILLS_ROOT);
  return path.join(sharedRoot, SHARED_SKILLS_DIRNAME);
}

function linkOrCopyDirectory(
  sourceDir: string,
  targetDir: string,
  adapter: LocalCompanionLaunchAdapter,
  label: string
): void {
  try {
    fs.symlinkSync(
      path.relative(path.dirname(targetDir), sourceDir),
      targetDir,
      "dir"
    );
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(adapter, `Falling back to copying ${label}: ${message}`);
  }

  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}

function ensureSharedSkillAlias(
  cwd: string,
  adapter: LocalCompanionLaunchAdapter,
  sharedSkillsDir: string
): void {
  const aliasPath = path.join(
    cwd,
    LEGACY_SHARED_SKILLS_ROOT,
    SHARED_SKILLS_DIRNAME
  );
  fs.mkdirSync(path.dirname(aliasPath), { recursive: true });

  try {
    const stat = fs.lstatSync(aliasPath);
    if (stat.isSymbolicLink()) {
      const target = path.resolve(
        path.dirname(aliasPath),
        fs.readlinkSync(aliasPath)
      );
      if (target === sharedSkillsDir) {
        return;
      }
    } else if (stat.isDirectory()) {
      log(
        adapter,
        `Skipping legacy skills alias for ${LEGACY_SHARED_SKILLS_ROOT}/${SHARED_SKILLS_DIRNAME} because a real directory already exists.`
      );
      return;
    } else {
      log(
        adapter,
        `Skipping legacy skills alias for ${LEGACY_SHARED_SKILLS_ROOT}/${SHARED_SKILLS_DIRNAME} because a non-directory path already exists.`
      );
      return;
    }
  } catch {
    // Alias path does not exist yet.
  }

  try {
    fs.rmSync(aliasPath, { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
  linkOrCopyDirectory(
    sharedSkillsDir,
    aliasPath,
    adapter,
    "legacy skills alias"
  );
}

function ensureSkillSyncLinks(
  cwd: string,
  adapter: LocalCompanionLaunchAdapter
): void {
  const sharedSkillsDir = resolveSharedSkillsDir(cwd);
  fs.mkdirSync(sharedSkillsDir, { recursive: true });
  ensureSharedWechatSkill(sharedSkillsDir);
  ensureSharedSkillAlias(cwd, adapter, sharedSkillsDir);

  for (const relativeTarget of SKILL_LINK_TARGETS) {
    const linkPath = path.join(cwd, relativeTarget);
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });

    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const target = path.resolve(
          path.dirname(linkPath),
          fs.readlinkSync(linkPath)
        );
        if (target === sharedSkillsDir) {
          continue;
        }
      } else if (stat.isDirectory()) {
        log(
          adapter,
          `Skipping skills link for ${relativeTarget} because a real directory already exists.`
        );
        continue;
      } else {
        log(
          adapter,
          `Skipping skills link for ${relativeTarget} because a non-directory path already exists.`
        );
        continue;
      }
    } catch {
      // Path does not exist; create the link below.
    }

    try {
      fs.rmSync(linkPath, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
    linkOrCopyDirectory(sharedSkillsDir, linkPath, adapter, relativeTarget);
  }
}

function ensureTmuxSession(options: LocalCompanionStartCliOptions): {
  sessionName: string;
  created: boolean;
} {
  const sessionName = buildTmuxSessionName(options);
  if (doesTmuxSessionExist(sessionName)) {
    return { sessionName, created: false };
  }

  ensureSkillSyncLinks(options.cwd, options.adapter);
  const commandLine = buildForegroundClientCommandLine(options);
  const status = tmuxCommand([
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-c",
    options.cwd,
    commandLine,
  ]);
  if (status !== 0) {
    throw new Error(`Failed to create tmux session ${sessionName}.`);
  }

  return { sessionName, created: true };
}

export function ensureTmuxCompanionSessionForRunningBridge(options: {
  adapter: LocalCompanionLaunchAdapter;
  cwd: string;
  profile?: string;
  timeoutMs?: number;
}): {
  sessionName: string;
  created: boolean;
} {
  if (!isTmuxAvailable()) {
    throw new Error("tmux is not available.");
  }

  return ensureTmuxSession({
    adapter: options.adapter,
    cwd: options.cwd,
    profile: options.profile,
    timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
  });
}

async function runVisibleClientDirect(
  options: LocalCompanionStartCliOptions
): Promise<number> {
  const entryPath = resolveForegroundClientEntryPath(options.adapter);
  const args = buildForegroundClientArgs(entryPath, options);

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", (error) => reject(error));
    child.once("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

function resolveStartBridgeLifecycle(): BridgeLifecycleMode {
  return isTmuxAvailable() ? "persistent" : "companion_bound";
}

function openContainerLogMirrorFds(): [number, number] | null {
  if (!shouldMirrorBackgroundBridgeLogsToContainer()) {
    return null;
  }

  try {
    return [fs.openSync("/proc/1/fd/1", "w"), fs.openSync("/proc/1/fd/2", "w")];
  } catch {
    return null;
  }
}

function startBridgeInBackground(options: LocalCompanionStartCliOptions): void {
  const entryPath = path.resolve(
    MODULE_DIR,
    "..",
    "bridge",
    "wechat-bridge.ts"
  );
  const renderMode = requiresProxyCompanionEndpoint(options.adapter)
    ? "embedded"
    : undefined;
  const args = buildBackgroundBridgeArgs(
    entryPath,
    options,
    resolveStartBridgeLifecycle(),
    renderMode
  );
  const mirroredFds = openContainerLogMirrorFds();

  try {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: process.env,
      detached: true,
      stdio: mirroredFds
        ? ["ignore", mirroredFds[0], mirroredFds[1]]
        : "ignore",
      windowsHide: true,
    });

    child.unref();
  } finally {
    if (mirroredFds) {
      for (const fd of mirroredFds) {
        try {
          fs.closeSync(fd);
        } catch {
          // Best effort cleanup of the parent's copies.
        }
      }
    }
  }
}

async function waitForEndpoint(
  cwd: string,
  adapter: LocalCompanionLaunchAdapter,
  timeoutMs: number
): Promise<LocalCompanionEndpoint> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await readUsableEndpoint(cwd, adapter);
    if (result.endpoint) {
      return result.endpoint;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for the ${adapter} bridge endpoint for ${cwd}. Check ${BRIDGE_LOG_FILE}.`
  );
}

async function ensureBridgeReady(
  options: LocalCompanionStartCliOptions
): Promise<void> {
  // If the lock is absent or the lock-holding process is dead, do NOT trust a
  // leftover endpoint.  The bridge (WeChat transport) may have crashed while
  // the opencode server kept running.  Starting only the panel would leave no
  // bridge to poll WeChat messages.
  const lock = readBridgeLockFile();
  const lockProcessAlive = lock ? isPidAlive(lock.pid) : false;
  if (!(lock && lockProcessAlive)) {
    if (lock && !lockProcessAlive) {
      log(
        options.adapter,
        `Found stale lock for ${options.cwd} (pid=${lock.pid} dead). Clearing.`
      );
      clearLocalCompanionEndpoint(options.cwd);
    }

    log(options.adapter, `Starting bridge in background for ${options.cwd}...`);
    startBridgeInBackground(options);
    await waitForEndpoint(options.cwd, options.adapter, options.timeoutMs);
    return;
  }

  // Lock is held by a live process — check whether we can reuse or need to replace it.
  if (shouldAutoReclaimBridgeLock(lock)) {
    await stopExistingBridge(lock, options.adapter);
    log(
      options.adapter,
      `Starting replacement bridge in background for ${options.cwd}...`
    );
    startBridgeInBackground(options);
    await waitForEndpoint(options.cwd, options.adapter, options.timeoutMs);
    return;
  }

  if (
    lock.adapter !== options.adapter ||
    !isSameWorkspaceCwd(lock.cwd, options.cwd)
  ) {
    await stopExistingBridge(lock, options.adapter);
    log(
      options.adapter,
      `Starting replacement bridge in background for ${options.cwd}...`
    );
    startBridgeInBackground(options);
    await waitForEndpoint(options.cwd, options.adapter, options.timeoutMs);
    return;
  }

  const endpointResult = await readUsableEndpoint(options.cwd, options.adapter);
  if (endpointResult.endpoint) {
    log(options.adapter, `Reusing running bridge for ${options.cwd}.`);
    return;
  }

  if (requiresProxyCompanionEndpoint(options.adapter)) {
    log(
      options.adapter,
      `Running bridge for ${options.cwd} has no local companion endpoint. Restarting it in proxy mode for the visible companion.`
    );
    await stopExistingBridge(lock, options.adapter);
    startBridgeInBackground(options);
    await waitForEndpoint(options.cwd, options.adapter, options.timeoutMs);
    return;
  }

  log(
    options.adapter,
    `Found running bridge for ${options.cwd}. Waiting for endpoint...`
  );
  await waitForEndpoint(options.cwd, options.adapter, options.timeoutMs);
}

async function runVisibleClient(
  options: LocalCompanionStartCliOptions
): Promise<number> {
  if (!isTmuxAvailable()) {
    log(
      options.adapter,
      "tmux is not available; falling back to direct foreground launch."
    );
    return await runVisibleClientDirect(options);
  }

  const { sessionName, created } = ensureTmuxSession(options);
  log(
    options.adapter,
    created
      ? `Created tmux session ${sessionName} for ${options.cwd}.`
      : `Reusing tmux session ${sessionName} for ${options.cwd}.`
  );

  if (!process.stdout.isTTY) {
    log(options.adapter, `Attach with: tmux attach-session -t ${sessionName}`);
    return 0;
  }

  const tmuxArgs = process.env.TMUX
    ? ["switch-client", "-t", sessionName]
    : ["attach-session", "-t", sessionName];
  const status = tmuxCommand(tmuxArgs, { stdio: "inherit" });
  return status === 0 ? 0 : status;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  migrateLegacyChannelFiles((message) => log(options.adapter, message));

  if (!fs.existsSync(CREDENTIALS_FILE)) {
    throw new Error(
      `Missing WeChat credentials. Run "bun run setup" first. (${CREDENTIALS_FILE})`
    );
  }

  await ensureBridgeReady(options);
  const exitCode = await runVisibleClient(options);
  process.exit(exitCode);
}

const isDirectRun = Boolean(
  (import.meta as ImportMeta & { main?: boolean }).main
);
if (isDirectRun) {
  main().catch((error) => {
    const adapter = (() => {
      try {
        return parseCliArgs(process.argv.slice(2)).adapter;
      } catch {
        return DEFAULT_ADAPTER;
      }
    })();
    log(adapter, error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
