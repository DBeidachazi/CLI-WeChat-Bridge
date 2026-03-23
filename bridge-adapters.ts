import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as spawnPty } from "node-pty";
import type { IPty } from "node-pty";

import {
  attachCodexPanelMessageListener,
  buildCodexPanelToken,
  clearCodexPanelEndpoint,
  sendCodexPanelMessage,
  writeCodexPanelEndpoint,
  type CodexPanelCommand,
  type CodexPanelEndpoint,
  type CodexPanelMessage,
} from "./codex-panel-link.ts";
import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeAdapterKind,
  BridgeResumeThreadCandidate,
  BridgeAdapterState,
  BridgeEvent,
  BridgeThreadSwitchReason,
  BridgeThreadSwitchSource,
  BridgeTurnOrigin,
} from "./bridge-types.ts";
import {
  detectCliApproval,
  isHighRiskShellCommand,
  normalizeOutput,
  nowIso,
  truncatePreview,
} from "./bridge-utils.ts";

type AdapterOptions = {
  kind: BridgeAdapterKind;
  command: string;
  cwd: string;
  profile?: string;
  initialSharedThreadId?: string;
  renderMode?: "embedded" | "panel";
};

type EventSink = (event: BridgeEvent) => void;

type SpawnTarget = {
  file: string;
  args: string[];
};

type ResolveSpawnTargetOptions = {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  forwardArgs?: string[];
};

type CodexRpcRequestId = string | number;

type CodexRpcPendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type CodexQueuedNotification = {
  method: string;
  params: Record<string, unknown>;
};

type CodexPendingApprovalRequest = {
  requestId: CodexRpcRequestId;
  method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval";
  threadId: string;
  turnId: string;
  origin: BridgeTurnOrigin;
};

type CodexActiveTurn = {
  threadId: string;
  turnId: string;
  origin: BridgeTurnOrigin;
};

export type CodexSessionMeta = {
  id?: string;
  timestamp?: string;
  cwd?: string;
  source?: string | { custom?: string };
  originator?: string;
};

type CodexSessionSummary = {
  threadId: string;
  title: string;
  lastUpdatedAt: string;
  source?: string;
  filePath: string;
};

type CodexRecentSessionFile = {
  threadId: string;
  filePath: string;
  modifiedAtMs: number;
};

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];
const WINDOWS_POWERSHELL_EXTENSION = ".ps1";
const CODEX_SESSION_POLL_INTERVAL_MS = 500;
const CODEX_SESSION_MATCH_WINDOW_MS = 30_000;
const CODEX_SESSION_FALLBACK_SCAN_INTERVAL_MS = 5_000;
const CODEX_THREAD_SIGNAL_TTL_MS = 30_000;
const CODEX_RECENT_SESSION_KEY_LIMIT = 64;
const INTERRUPT_SETTLE_DELAY_MS = 1_500;
const CODEX_STARTUP_WARMUP_MS = 1_200;
const CODEX_APP_SERVER_HOST = "127.0.0.1";
const CODEX_APP_SERVER_READY_TIMEOUT_MS = 10_000;
const CODEX_APP_SERVER_LOG_LIMIT = 12_000;
const CODEX_RPC_CONNECT_RETRY_MS = 150;
const CODEX_RPC_RECONNECT_TIMEOUT_MS = 5_000;
const CODEX_SESSION_LOCAL_MIRROR_FALLBACK_WINDOW_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getCodexRpcRequestId(value: unknown): CodexRpcRequestId | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function getNotificationThreadId(params: unknown): string | null {
  if (!isRecord(params)) {
    return null;
  }

  if (typeof params.threadId === "string") {
    return params.threadId;
  }

  if (isRecord(params.thread) && typeof params.thread.id === "string") {
    return params.thread.id;
  }

  return null;
}

function getNotificationTurnId(params: unknown): string | null {
  if (!isRecord(params)) {
    return null;
  }

  if (typeof params.turnId === "string") {
    return params.turnId;
  }

  if (isRecord(params.turn) && typeof params.turn.id === "string") {
    return params.turn.id;
  }

  return null;
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function normalizeCodexRpcError(error: unknown): string {
  if (isRecord(error)) {
    const message =
      typeof error.message === "string"
        ? error.message
        : typeof error.code === "number"
          ? `RPC error ${error.code}`
          : "";
    const data =
      typeof error.data === "string"
        ? error.data
        : typeof error.details === "string"
          ? error.details
          : "";
    const combined = [message, data].filter(Boolean).join(": ");
    if (combined) {
      return combined;
    }
  }

  return describeUnknownError(error);
}

function isRecentIsoTimestamp(timestamp: string, maxAgeMs: number): boolean {
  const parsedMs = Date.parse(timestamp);
  if (!Number.isFinite(parsedMs)) {
    return false;
  }
  return parsedMs >= Date.now() - maxAgeMs;
}

function coerceWebSocketMessageData(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }

  return null;
}

export function buildCodexCliArgs(
  remoteUrl: string,
  options: {
    profile?: string;
    inlineMode?: boolean;
    resumeThreadId?: string;
  } = {},
): string[] {
  const args: string[] = [];

  if (options.resumeThreadId) {
    args.push("resume", options.resumeThreadId);
  }

  args.push("--enable", "tui_app_server", "--remote", remoteUrl);

  if (options.inlineMode) {
    args.push("--no-alt-screen");
  }

  if (options.profile) {
    args.push("--profile", options.profile);
  }

  return args;
}

export function buildCodexApprovalRequest(
  method: string,
  params: unknown,
): ApprovalRequest | null {
  if (!isRecord(params)) {
    return null;
  }

  if (method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string" ? params.command : "";
    const cwd = typeof params.cwd === "string" ? params.cwd : "";
    const reason = typeof params.reason === "string" ? params.reason : "";
    const preview =
      command && cwd
        ? `${command} (${cwd})`
        : command || reason || "Command execution approval requested.";

    return {
      source: "cli",
      summary: reason
        ? `Codex needs approval before running a command: ${truncatePreview(reason, 160)}`
        : "Codex needs approval before running a command.",
      commandPreview: truncatePreview(preview, 180),
    };
  }

  if (method === "item/fileChange/requestApproval") {
    const grantRoot = typeof params.grantRoot === "string" ? params.grantRoot : "";
    const reason = typeof params.reason === "string" ? params.reason : "";
    const preview = grantRoot || reason || "File change approval requested.";

    return {
      source: "cli",
      summary: reason
        ? `Codex needs approval before applying a file change: ${truncatePreview(reason, 160)}`
        : "Codex needs approval before applying a file change.",
      commandPreview: truncatePreview(preview, 180),
    };
  }

  return null;
}

export function extractCodexFinalTextFromItem(item: unknown): string | null {
  if (!isRecord(item) || item.type !== "agentMessage" || item.phase !== "final_answer") {
    return null;
  }

  const text = typeof item.text === "string" ? normalizeOutput(item.text).trim() : "";
  return text || null;
}

export function extractCodexUserMessageText(item: unknown): string | null {
  if (!isRecord(item) || item.type !== "userMessage" || !Array.isArray(item.content)) {
    return null;
  }

  const parts = item.content
    .map((entry) => {
      if (!isRecord(entry) || typeof entry.type !== "string") {
        return "";
      }

      switch (entry.type) {
        case "text":
          return typeof entry.text === "string" ? entry.text : "";
        case "image":
          return "[image]";
        case "localImage":
          return typeof entry.path === "string" ? `[local image: ${entry.path}]` : "[local image]";
        case "skill":
          return typeof entry.name === "string" ? `[skill: ${entry.name}]` : "[skill]";
        case "mention":
          return typeof entry.name === "string" ? `[mention: ${entry.name}]` : "[mention]";
        default:
          return "";
      }
    })
    .filter(Boolean);

  const text = normalizeOutput(parts.join("\n")).trim();
  return text || null;
}

export function extractCodexThreadFollowIdFromStatusChanged(params: unknown): string | null {
  if (!isRecord(params)) {
    return null;
  }

  const threadId = getNotificationThreadId(params);
  if (!threadId) {
    return null;
  }

  const status = isRecord(params.status) ? params.status : null;
  if (!status) {
    return threadId;
  }

  const statusType = typeof status.type === "string" ? status.type : "";
  if (statusType === "notLoaded") {
    return null;
  }

  if (statusType === "active" || statusType === "idle" || statusType === "systemError") {
    return threadId;
  }

  return threadId;
}

export function extractCodexThreadStartedThreadId(params: unknown): string | null {
  if (!isRecord(params) || !isRecord(params.thread)) {
    return null;
  }

  return typeof params.thread.id === "string" ? params.thread.id : null;
}

export function shouldIgnoreCodexSessionReplayEntry(
  timestamp: unknown,
  ignoreBeforeMs: number | null,
): boolean {
  if (ignoreBeforeMs === null) {
    return false;
  }
  if (typeof timestamp !== "string") {
    return true;
  }

  const parsedTimestampMs = Date.parse(timestamp);
  if (!Number.isFinite(parsedTimestampMs)) {
    return true;
  }

  return parsedTimestampMs < ignoreBeforeMs;
}

function getEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const direct = env[key];
  if (direct !== undefined) {
    return direct;
  }

  const matchedKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return matchedKey ? env[matchedKey] : undefined;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isPathLikeCommand(command: string): boolean {
  return (
    path.isAbsolute(command) ||
    command.startsWith(".") ||
    command.includes("/") ||
    command.includes("\\")
  );
}

function getWindowsCommandExtensions(
  env: Record<string, string | undefined>,
): string[] {
  const configured = (getEnvValue(env, "PATHEXT") ?? "")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const ordered = [...WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS, "", WINDOWS_POWERSHELL_EXTENSION];
  for (const extension of configured) {
    if (!ordered.includes(extension)) {
      ordered.push(extension);
    }
  }
  return ordered;
}

function expandCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  if (platform !== "win32") {
    return [command];
  }

  if (path.extname(command)) {
    return [command];
  }

  return getWindowsCommandExtensions(env).map((extension) => `${command}${extension}`);
}

function resolvePathLikeCommand(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string | undefined {
  const absoluteCommand = path.resolve(command);
  for (const candidate of expandCommandCandidates(absoluteCommand, platform, env)) {
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findCommandOnPath(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string | undefined {
  const pathEntries = (getEnvValue(env, "PATH") ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const candidates = expandCommandCandidates(command, platform, env);
  for (const directory of pathEntries) {
    for (const candidate of candidates) {
      const candidatePath = path.join(directory, candidate);
      if (fileExists(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return undefined;
}

function resolveCommandPath(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string | undefined {
  if (isPathLikeCommand(command)) {
    return resolvePathLikeCommand(command, platform, env);
  }

  return findCommandOnPath(command, platform, env);
}

function resolveCmdExe(env: Record<string, string | undefined>): string {
  const systemRoot = getEnvValue(env, "SystemRoot") ?? getEnvValue(env, "SYSTEMROOT");
  const configured =
    getEnvValue(env, "ComSpec") ??
    getEnvValue(env, "COMSPEC") ??
    (systemRoot ? `${systemRoot.replace(/[\\/]$/, "")}\\System32\\cmd.exe` : undefined);

  return configured || "cmd.exe";
}

function quoteForCmd(argument: string): string {
  if (!argument) {
    return '""';
  }

  if (!/[\s"]/u.test(argument)) {
    return argument;
  }

  return `"${argument.replace(/"/g, '""')}"`;
}

function wrapWithCmdExe(
  scriptPath: string,
  extraArgs: string[],
  env: Record<string, string | undefined>,
): SpawnTarget {
  const commandLine = [quoteForCmd(scriptPath), ...extraArgs.map(quoteForCmd)].join(" ");
  return {
    file: resolveCmdExe(env),
    args: ["/d", "/s", "/c", commandLine],
  };
}

function resolveBundledWindowsExe(
  kind: Extract<BridgeAdapterKind, "codex" | "claude">,
  launcherPath: string,
): string | undefined {
  const launcherDirectory = path.dirname(launcherPath);
  const openAiDirectory = path.join(launcherDirectory, "node_modules", "@openai");
  if (!fs.existsSync(openAiDirectory)) {
    return undefined;
  }

  const vendorSegments = [
    "vendor",
    "x86_64-pc-windows-msvc",
    kind,
    `${kind}.exe`,
  ];

  const directCandidate = path.join(
    openAiDirectory,
    `${kind}-win32-x64`,
    ...vendorSegments,
  );
  if (fileExists(directCandidate)) {
    return directCandidate;
  }

  const packageCandidate = path.join(
    openAiDirectory,
    kind,
    "node_modules",
    "@openai",
    `${kind}-win32-x64`,
    ...vendorSegments,
  );
  if (fileExists(packageCandidate)) {
    return packageCandidate;
  }

  const dirEntries = fs.readdirSync(openAiDirectory, { withFileTypes: true });
  for (const entry of dirEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`.${kind}-`)) {
      continue;
    }

    const nestedCandidate = path.join(
      openAiDirectory,
      entry.name,
      "node_modules",
      "@openai",
      `${kind}-win32-x64`,
      ...vendorSegments,
    );
    if (fileExists(nestedCandidate)) {
      return nestedCandidate;
    }
  }

  return undefined;
}

function buildCliEnvironment(kind: BridgeAdapterKind): Record<string, string> {
  if (kind === "codex" || kind === "claude") {
    const env: Record<string, string> = {
      TERM: process.env.TERM || "xterm-256color",
    };

    const keys = [
      "PATH",
      "PATHEXT",
      "ComSpec",
      "COMSPEC",
      "SystemRoot",
      "SYSTEMROOT",
      "USERPROFILE",
      "HOME",
      "APPDATA",
      "LOCALAPPDATA",
      "TEMP",
      "TMP",
      "OS",
      "ProgramFiles",
      "ProgramFiles(x86)",
      "CommonProgramFiles",
      "CommonProgramFiles(x86)",
    ] as const;

    for (const key of keys) {
      const value = process.env[key];
      if (value) {
        env[key] = value;
      }
    }

    if (!env.HOME && env.USERPROFILE) {
      env.HOME = env.USERPROFILE;
    }

    return env;
  }

  return {
    ...process.env,
    TERM: process.env.TERM || "xterm-256color",
  } as Record<string, string>;
}

async function reserveLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, CODEX_APP_SERVER_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve a local Codex app-server port.")));
        return;
      }

      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForTcpPort(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const finish = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };

      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.setTimeout(500);
    });

    if (connected) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`Timed out waiting for Codex app-server on ${host}:${port}.`);
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function appendBoundedLog(existing: string, chunk: string): string {
  const next = existing ? `${existing}${chunk}` : chunk;
  if (next.length <= CODEX_APP_SERVER_LOG_LIMIT) {
    return next;
  }
  return next.slice(next.length - CODEX_APP_SERVER_LOG_LIMIT);
}

function normalizeComparablePath(filePath: string): string {
  return path.resolve(filePath).replace(/\//g, "\\").toLowerCase();
}

function buildCodexSessionDayPath(date: Date): string | null {
  const homeDirectory = process.env.USERPROFILE ?? process.env.HOME;
  if (!homeDirectory) {
    return null;
  }

  return path.join(
    homeDirectory,
    ".codex",
    "sessions",
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  );
}

function buildCodexSessionsRoot(): string | null {
  const homeDirectory = process.env.USERPROFILE ?? process.env.HOME;
  if (!homeDirectory) {
    return null;
  }

  return path.join(homeDirectory, ".codex", "sessions");
}

function listCodexSessionFilesRecursively(rootDirectory: string): string[] {
  if (!fs.existsSync(rootDirectory)) {
    return [];
  }

  const files: string[] = [];
  const pending = [rootDirectory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

function readCodexSessionMeta(filePath: string): CodexSessionMeta | null {
  try {
    const firstLine = fs.readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine) {
      return null;
    }

    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: CodexSessionMeta;
    };
    if (parsed.type !== "session_meta" || !parsed.payload) {
      return null;
    }

    return parsed.payload;
  } catch {
    return null;
  }
}

function getCodexSessionSource(meta: CodexSessionMeta | null | undefined): string | null {
  if (!meta) {
    return null;
  }

  if (typeof meta.source === "string") {
    return meta.source;
  }

  if (isRecord(meta.source) && typeof meta.source.custom === "string") {
    return meta.source.custom;
  }

  return null;
}

function parseCodexSessionUserMessage(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      type?: string;
      payload?: {
        type?: string;
        message?: string;
      };
    };
    if (parsed.type !== "event_msg" || parsed.payload?.type !== "user_message") {
      return null;
    }

    const message =
      typeof parsed.payload.message === "string"
        ? normalizeOutput(parsed.payload.message).trim()
        : "";
    return message || null;
  } catch {
    return null;
  }
}

function summarizeCodexSessionFile(filePath: string): CodexSessionSummary | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/).filter(Boolean);
  const meta = readCodexSessionMeta(filePath);
  if (!meta?.id || !meta.cwd) {
    return null;
  }

  let lastTimestamp = meta.timestamp ?? null;
  let lastUserMessage: string | null = null;
  for (const line of lines) {
    const parsedUserMessage = parseCodexSessionUserMessage(line);
    if (parsedUserMessage) {
      lastUserMessage = parsedUserMessage;
    }

    try {
      const parsed = JSON.parse(line) as { timestamp?: string };
      if (typeof parsed.timestamp === "string") {
        lastTimestamp = parsed.timestamp;
      }
    } catch {
      // Ignore malformed lines while summarizing persisted sessions.
    }
  }

  const stats = fs.statSync(filePath);
  const lastUpdatedAt =
    lastTimestamp && Number.isFinite(Date.parse(lastTimestamp))
      ? lastTimestamp
      : new Date(stats.mtimeMs).toISOString();

  return {
    threadId: meta.id,
    title: truncatePreview(lastUserMessage ?? meta.id, 120),
    lastUpdatedAt,
    source: getCodexSessionSource(meta) ?? undefined,
    filePath,
  };
}

export function matchesCodexSessionMeta(
  meta: CodexSessionMeta | null | undefined,
  options: {
    cwd: string;
    startedAtMs: number;
    threadId?: string;
    sessionSource?: string;
  },
): boolean {
  if (!meta?.cwd || !meta.id) {
    return false;
  }

  if (normalizeComparablePath(meta.cwd) !== normalizeComparablePath(options.cwd)) {
    return false;
  }

  if (options.threadId && meta.id !== options.threadId) {
    return false;
  }

  const sessionSource = getCodexSessionSource(meta);
  if (options.sessionSource && sessionSource !== options.sessionSource) {
    return false;
  }

  if (options.threadId) {
    return true;
  }

  const sessionStartedAtMs = meta.timestamp ? Date.parse(meta.timestamp) : Number.NaN;
  if (
    Number.isFinite(sessionStartedAtMs) &&
    sessionStartedAtMs < options.startedAtMs - CODEX_SESSION_MATCH_WINDOW_MS
  ) {
    return false;
  }

  return true;
}

function findCodexSessionFile(
  cwd: string,
  startedAtMs: number,
  options: {
    threadId?: string;
    sessionSource?: string;
  } = {},
): string | null {
  if (options.threadId) {
    const sessionsRoot = buildCodexSessionsRoot();
    if (!sessionsRoot) {
      return null;
    }

    const candidates = listCodexSessionFilesRecursively(sessionsRoot)
      .map((filePath) => {
        const meta = readCodexSessionMeta(filePath);
        if (!matchesCodexSessionMeta(meta, { cwd, startedAtMs, ...options })) {
          return null;
        }

        const stats = fs.statSync(filePath);
        return {
          filePath,
          modifiedAtMs: stats.mtimeMs,
        };
      })
      .filter((candidate): candidate is { filePath: string; modifiedAtMs: number } => Boolean(candidate))
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);

    return candidates[0]?.filePath ?? null;
  }

  const dayDirectories = [new Date(), new Date(startedAtMs), new Date(startedAtMs - 86_400_000)]
    .map(buildCodexSessionDayPath)
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .filter((directory) => fs.existsSync(directory));

  const candidates: Array<{
    filePath: string;
    modifiedAtMs: number;
    sessionStartedAtMs: number;
  }> = [];

  for (const directory of dayDirectories) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(directory, entry.name);
      const stats = fs.statSync(filePath);
      if (stats.mtimeMs < startedAtMs - CODEX_SESSION_MATCH_WINDOW_MS) {
        continue;
      }

      const meta = readCodexSessionMeta(filePath);
      if (!matchesCodexSessionMeta(meta, { cwd, startedAtMs, ...options })) {
        continue;
      }

      const sessionStartedAtMs = meta?.timestamp ? Date.parse(meta.timestamp) : Number.NaN;
      candidates.push({
        filePath,
        modifiedAtMs: stats.mtimeMs,
        sessionStartedAtMs,
      });
    }
  }

  candidates.sort((left, right) => {
    const leftDistance = Number.isFinite(left.sessionStartedAtMs)
      ? Math.abs(left.sessionStartedAtMs - startedAtMs)
      : Number.POSITIVE_INFINITY;
    const rightDistance = Number.isFinite(right.sessionStartedAtMs)
      ? Math.abs(right.sessionStartedAtMs - startedAtMs)
      : Number.POSITIVE_INFINITY;

    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }
    return right.modifiedAtMs - left.modifiedAtMs;
  });

  return candidates[0]?.filePath ?? null;
}

export function findRecentCodexSessionFileForCwd(
  cwd: string,
  startedAtMs: number,
): CodexRecentSessionFile | null {
  const sessionsRoot = buildCodexSessionsRoot();
  if (!sessionsRoot) {
    return null;
  }

  const currentCwd = normalizeComparablePath(cwd);
  let bestCandidate: CodexRecentSessionFile | null = null;

  for (const filePath of listCodexSessionFilesRecursively(sessionsRoot)) {
    const meta = readCodexSessionMeta(filePath);
    if (!meta?.id || !meta.cwd || normalizeComparablePath(meta.cwd) !== currentCwd) {
      continue;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      continue;
    }

    if (stats.mtimeMs < startedAtMs - CODEX_SESSION_MATCH_WINDOW_MS) {
      continue;
    }

    if (!bestCandidate || stats.mtimeMs > bestCandidate.modifiedAtMs) {
      bestCandidate = {
        threadId: meta.id,
        filePath,
        modifiedAtMs: stats.mtimeMs,
      };
    }
  }

  return bestCandidate;
}

export function listCodexResumeThreads(
  cwd: string,
  limit = 10,
): BridgeResumeThreadCandidate[] {
  const sessionsRoot = buildCodexSessionsRoot();
  if (!sessionsRoot) {
    return [];
  }

  const currentCwd = normalizeComparablePath(cwd);
  const newestByThreadId = new Map<string, CodexSessionSummary>();
  for (const filePath of listCodexSessionFilesRecursively(sessionsRoot)) {
    const summary = summarizeCodexSessionFile(filePath);
    if (!summary) {
      continue;
    }

    const meta = readCodexSessionMeta(filePath);
    if (!meta?.cwd || normalizeComparablePath(meta.cwd) !== currentCwd) {
      continue;
    }

    const previous = newestByThreadId.get(summary.threadId);
    if (!previous || Date.parse(summary.lastUpdatedAt) > Date.parse(previous.lastUpdatedAt)) {
      newestByThreadId.set(summary.threadId, summary);
    }
  }

  return Array.from(newestByThreadId.values())
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt))
    .slice(0, Math.max(1, limit))
    .map((summary) => ({
      threadId: summary.threadId,
      title: summary.title,
      lastUpdatedAt: summary.lastUpdatedAt,
      source: summary.source,
    }));
}

export function resolveSpawnTarget(
  command: string,
  kind: BridgeAdapterKind,
  options: ResolveSpawnTargetOptions = {},
): SpawnTarget {
  const trimmed = command.trim();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const forwardArgs = options.forwardArgs ?? [];

  if (!trimmed) {
    return { file: trimmed, args: [...forwardArgs] };
  }

  const resolved = resolveCommandPath(trimmed, platform, env) ?? trimmed;
  if (platform !== "win32" || (kind !== "codex" && kind !== "claude")) {
    return { file: resolved, args: [...forwardArgs] };
  }

  const bundledExe = resolveBundledWindowsExe(kind, resolved);
  if (bundledExe) {
    return { file: bundledExe, args: [...forwardArgs] };
  }

  const extension = path.extname(resolved).toLowerCase();
  if (WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS.includes(extension)) {
    if (extension === ".cmd" || extension === ".bat") {
      return wrapWithCmdExe(resolved, forwardArgs, env);
    }
    return { file: resolved, args: [...forwardArgs] };
  }

  if (extension === WINDOWS_POWERSHELL_EXTENSION) {
    const siblingCmd = resolved.slice(0, -extension.length) + ".cmd";
    if (fileExists(siblingCmd)) {
      return wrapWithCmdExe(siblingCmd, forwardArgs, env);
    }
  }

  return { file: resolved, args: [...forwardArgs] };
}

class CodexPanelProxyAdapter implements BridgeAdapter {
  private readonly options: AdapterOptions;
  private readonly state: BridgeAdapterState;
  private eventSink: EventSink = () => undefined;
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private detachMessageListener: (() => void) | null = null;
  private requestCounter = 0;
  private endpoint: CodexPanelEndpoint | null = null;
  private readonly pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }
  >();
  private shuttingDown = false;

  constructor(options: AdapterOptions) {
    this.options = options;
    this.state = {
      kind: options.kind,
      status: "stopped",
      cwd: options.cwd,
      command: options.command,
      profile: options.profile,
      sharedThreadId: options.initialSharedThreadId,
    };
  }

  setEventSink(sink: EventSink): void {
    this.eventSink = sink;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.shuttingDown = false;
    this.setStatus(
      "starting",
      'Waiting for manual Codex panel connection. Run "wechat-codex" in a second terminal for this directory.',
    );

    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.handlePanelSocket(socket);
      });
      this.server = server;
      server.on("error", (error) => {
        reject(error);
      });
      server.listen(0, CODEX_APP_SERVER_HOST, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate a local Codex panel port."));
          return;
        }

        this.endpoint = {
          instanceId: `${process.pid}-${Date.now().toString(36)}`,
          port: address.port,
          token: buildCodexPanelToken(),
          cwd: this.options.cwd,
          command: this.options.command,
          profile: this.options.profile,
          sharedThreadId: this.state.sharedThreadId,
          startedAt: nowIso(),
        };
        writeCodexPanelEndpoint(this.endpoint);
        resolve();
      });
    });
  }

  async sendInput(text: string): Promise<void> {
    await this.sendRequest({
      command: "send_input",
      text,
    });
  }

  async listResumeThreads(limit = 10): Promise<BridgeResumeThreadCandidate[]> {
    const result = await this.sendRequest({
      command: "list_resume_threads",
      limit,
    });
    return Array.isArray(result) ? (result as BridgeResumeThreadCandidate[]) : [];
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.sendRequest({
      command: "resume_thread",
      threadId,
    });
  }

  async interrupt(): Promise<boolean> {
    const result = await this.sendRequest({
      command: "interrupt",
    });
    return Boolean(result);
  }

  async reset(): Promise<void> {
    await this.sendRequest({
      command: "reset",
    });
  }

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    const result = await this.sendRequest({
      command: "resolve_approval",
      action,
    });
    return Boolean(result);
  }

  async dispose(): Promise<void> {
    this.shuttingDown = true;
    this.rejectPendingRequests("Codex panel proxy is shutting down.");
    clearCodexPanelEndpoint(this.options.cwd, this.endpoint?.instanceId);

    if (this.socket) {
      try {
        sendCodexPanelMessage(this.socket, {
          type: "request",
          id: `${++this.requestCounter}`,
          payload: { command: "dispose" },
        });
      } catch {
        // Best effort.
      }
      this.detachPanelSocket();
    }

    if (!this.server) {
      this.state.status = "stopped";
      return;
    }

    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.state.status = "stopped";
  }

  getState(): BridgeAdapterState {
    return JSON.parse(JSON.stringify(this.state)) as BridgeAdapterState;
  }

  private handlePanelSocket(socket: net.Socket): void {
    if (!this.endpoint) {
      socket.destroy();
      return;
    }

    if (this.socket) {
      socket.end();
      socket.destroy();
      return;
    }

    let authenticated = false;
    socket.setNoDelay(true);
    const detachListener = attachCodexPanelMessageListener(socket, (message) => {
      if (!authenticated) {
        if (
          message.type !== "hello" ||
          message.token !== this.endpoint?.token
        ) {
          socket.destroy();
          return;
        }

        authenticated = true;
        this.socket = socket;
        this.detachMessageListener = detachListener;
        sendCodexPanelMessage(socket, { type: "hello_ack" });
        return;
      }

      this.handlePanelMessage(message);
    });

    socket.once("close", () => {
      if (this.socket === socket) {
        this.detachPanelSocket();
        if (!this.shuttingDown) {
          this.setStatus(
            "starting",
            'Codex panel disconnected. Run "wechat-codex" again in a second terminal for this directory.',
          );
        }
      }
    });
    socket.once("error", () => {
      socket.destroy();
    });
  }

  private handlePanelMessage(message: CodexPanelMessage): void {
    switch (message.type) {
      case "event":
        this.eventSink(message.event);
        return;
      case "state":
        if (
          this.endpoint &&
          this.endpoint.sharedThreadId !== message.state.sharedThreadId
        ) {
          this.endpoint.sharedThreadId = message.state.sharedThreadId;
          writeCodexPanelEndpoint(this.endpoint);
        }
        Object.assign(this.state, message.state);
        this.eventSink({
          type: "status",
          status: this.state.status,
          timestamp: nowIso(),
        });
        return;
      case "response": {
        const pending = this.pendingRequests.get(message.id);
        if (!pending) {
          return;
        }
        this.pendingRequests.delete(message.id);
        if (!message.ok) {
          pending.reject(new Error(message.error ?? "Unknown Codex panel error."));
          return;
        }
        pending.resolve(message.result);
        return;
      }
    }
  }

  private detachPanelSocket(): void {
    this.detachMessageListener?.();
    this.detachMessageListener = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.state.pid = undefined;
    this.state.startedAt = undefined;
    this.state.lastInputAt = undefined;
    this.state.lastOutputAt = undefined;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.state.activeTurnId = undefined;
    this.state.activeTurnOrigin = undefined;
  }

  private setStatus(status: BridgeAdapterState["status"], message?: string): void {
    this.state.status = status;
    this.eventSink({
      type: "status",
      status,
      message,
      timestamp: nowIso(),
    });
  }

  private rejectPendingRequests(message: string): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error(message));
    }
    this.pendingRequests.clear();
  }

  private async sendRequest(payload: CodexPanelCommand): Promise<unknown> {
    const socket = this.socket;
    if (!socket) {
      throw new Error(
        'Codex panel is not connected. Run "wechat-codex" in a second terminal for this directory.',
      );
    }
    if (!this.state.pid && payload.command !== "dispose") {
      throw new Error("Codex panel is connected but not ready yet. Wait for the panel to finish starting.");
    }

    const id = `${++this.requestCounter}`;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });

    sendCodexPanelMessage(socket, {
      type: "request",
      id,
      payload,
    });
    return await response;
  }
}

abstract class AbstractPtyAdapter implements BridgeAdapter {
  protected readonly options: AdapterOptions;
  protected pty: IPty | null = null;
  protected eventSink: EventSink = () => undefined;
  protected completionTimer: ReturnType<typeof setTimeout> | null = null;
  protected state: BridgeAdapterState;
  protected hasAcceptedInput = false;
  protected shuttingDown = false;
  protected currentPreview = "(idle)";
  protected pendingApproval: ApprovalRequest | null = null;

  constructor(options: AdapterOptions) {
    this.options = options;
    this.state = {
      kind: options.kind,
      status: "stopped",
      cwd: options.cwd,
      command: options.command,
      profile: options.profile,
    };
  }

  setEventSink(sink: EventSink): void {
    this.eventSink = sink;
  }

  async start(): Promise<void> {
    if (this.pty) {
      return;
    }

    this.setStatus("starting", `Starting ${this.options.kind} adapter...`);

    let spawnTarget: SpawnTarget | null = null;
    try {
      spawnTarget = resolveSpawnTarget(this.options.command, this.options.kind);
      const ptyProcess = spawnPty(
        spawnTarget.file,
        [...spawnTarget.args, ...this.buildSpawnArgs()],
        {
          name: "xterm-color",
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
          cwd: this.options.cwd,
          env: this.buildEnv(),
          useConpty: true,
        },
      );

      this.pty = ptyProcess;
      this.shuttingDown = false;
      this.hasAcceptedInput = false;
      this.state.pid = ptyProcess.pid;
      this.state.startedAt = nowIso();
      this.state.status = "idle";
      this.state.pendingApproval = null;

      ptyProcess.onData((data) => this.handleData(data));
      ptyProcess.onExit(({ exitCode }) => this.handleExit(exitCode));

      this.afterStart();
      this.setStatus("idle", `${this.options.kind} adapter is ready.`);
    } catch (err) {
      this.state.status = "error";
      this.emit({
        type: "fatal_error",
        message: `Failed to start ${this.options.kind}${spawnTarget ? ` (${spawnTarget.file})` : ""}: ${String(err)}`,
        timestamp: nowIso(),
      });
      throw err;
    }
  }

  async sendInput(text: string): Promise<void> {
    if (!this.pty) {
      throw new Error(`${this.options.kind} adapter is not running.`);
    }

    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(text);
    this.state.lastInputAt = nowIso();
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.writeToPty(this.prepareInput(text));
    this.setStatus("busy");
    this.scheduleTaskComplete(this.defaultCompletionDelayMs());
  }

  async listResumeThreads(_limit = 10): Promise<BridgeResumeThreadCandidate[]> {
    throw new Error("/resume is only supported for the codex adapter.");
  }

  async resumeThread(_threadId: string): Promise<void> {
    throw new Error("/resume is only supported for the codex adapter.");
  }

  async interrupt(): Promise<boolean> {
    if (!this.pty) {
      return false;
    }

    this.writeToPty("\u0003");
    this.scheduleTaskComplete(INTERRUPT_SETTLE_DELAY_MS);
    this.emit({
      type: "status",
      status: this.state.status,
      message: "Interrupt signal sent to the worker.",
      timestamp: nowIso(),
    });
    return true;
  }

  async reset(): Promise<void> {
    await this.dispose();
    await this.start();
  }

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    if (!this.pendingApproval) {
      return false;
    }

    const handled = await this.applyApproval(action, this.pendingApproval);
    if (!handled) {
      return false;
    }

    this.pendingApproval = null;
    this.state.pendingApproval = null;
    return true;
  }

  async dispose(): Promise<void> {
    this.clearCompletionTimer();
    this.pendingApproval = null;
    this.state.pendingApproval = null;

    if (!this.pty) {
      this.state.status = "stopped";
      return;
    }

    this.shuttingDown = true;
    try {
      this.pty.kill();
    } catch {
      // Best effort shutdown.
    }
    this.pty = null;
    this.state.status = "stopped";
    this.state.pid = undefined;
  }

  getState(): BridgeAdapterState {
    return JSON.parse(JSON.stringify(this.state)) as BridgeAdapterState;
  }

  protected abstract buildSpawnArgs(): string[];

  protected afterStart(): void {
    // Optional hook.
  }

  protected prepareInput(text: string): string {
    return `${text.replace(/\r?\n/g, "\r")}\r`;
  }

  protected defaultCompletionDelayMs(): number {
    return 5_000;
  }

  protected async applyApproval(
    action: "confirm" | "deny",
    pendingApproval: ApprovalRequest,
  ): Promise<boolean> {
    if (!this.pty) {
      return false;
    }

    const input =
      action === "confirm"
        ? pendingApproval.confirmInput ?? "y\r"
        : pendingApproval.denyInput ?? "n\r";
    this.setStatus("busy");
    this.writeToPty(input);
    this.scheduleTaskComplete(this.defaultCompletionDelayMs());
    return true;
  }

  protected buildEnv(): Record<string, string> {
    return buildCliEnvironment(this.options.kind);
  }

  protected emit(event: BridgeEvent): void {
    this.eventSink(event);
  }

  protected setStatus(
    status: BridgeAdapterState["status"],
    message?: string,
  ): void {
    this.state.status = status;
    this.emit({
      type: "status",
      status,
      message,
      timestamp: nowIso(),
    });
  }

  protected scheduleTaskComplete(delayMs: number): void {
    if (!this.hasAcceptedInput || this.state.status !== "busy") {
      return;
    }

    this.clearCompletionTimer();
    this.completionTimer = setTimeout(() => {
      this.completionTimer = null;
      if (this.state.status !== "busy") {
        return;
      }
      this.setStatus("idle");
      this.emit({
        type: "task_complete",
        summary: this.currentPreview,
        timestamp: nowIso(),
      });
    }, delayMs);
  }

  protected clearCompletionTimer(): void {
    if (!this.completionTimer) {
      return;
    }
    clearTimeout(this.completionTimer);
    this.completionTimer = null;
  }

  protected writeToPty(data: string): void {
    this.pty?.write(data);
  }

  protected handleData(rawText: string): void {
    const text = normalizeOutput(rawText);
    if (!text) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    if (!this.hasAcceptedInput) {
      return;
    }

    if (!this.pendingApproval) {
      const approval = detectCliApproval(text);
      if (approval) {
        this.pendingApproval = approval;
        this.state.pendingApproval = approval;
        this.setStatus("awaiting_approval", "CLI approval is required.");
        this.emit({
          type: "approval_required",
          request: approval,
          timestamp: nowIso(),
        });
        return;
      }
    }

    this.emit({
      type: "stdout",
      text,
      timestamp: nowIso(),
    });

    if (this.state.status === "busy") {
      this.scheduleTaskComplete(this.defaultCompletionDelayMs());
    }
  }

  protected handleExit(exitCode: number | undefined): void {
    this.clearCompletionTimer();
    const expectedShutdown = this.shuttingDown;
    this.shuttingDown = false;
    this.pty = null;
    this.state.status = "stopped";
    this.state.pid = undefined;
    this.pendingApproval = null;
    this.state.pendingApproval = null;

    if (expectedShutdown) {
      this.emit({
        type: "status",
        status: "stopped",
        message: `${this.options.kind} worker stopped.`,
        timestamp: nowIso(),
      });
      return;
    }

    const exitLabel =
      typeof exitCode === "number" ? `code ${exitCode}` : "an unknown code";
    this.emit({
      type: "fatal_error",
      message: `${this.options.kind} worker exited unexpectedly with ${exitLabel}.`,
      timestamp: nowIso(),
    });
  }
}

class CodexPtyAdapter extends AbstractPtyAdapter {
  private appServer: ChildProcessWithoutNullStreams | null = null;
  private nativeProcess: ChildProcess | null = null;
  private appServerPort: number | null = null;
  private appServerShuttingDown = false;
  private appServerLog = "";
  private rpcSocket: WebSocket | null = null;
  private rpcShuttingDown = false;
  private rpcReconnectPromise: Promise<boolean> | null = null;
  private rpcRequestCounter = 0;
  private pendingRpcRequests = new Map<string, CodexRpcPendingRequest>();
  private sharedThreadId: string | null = null;
  private activeTurn: CodexActiveTurn | null = null;
  private bridgeOwnedTurnIds = new Set<string>();
  private recentBridgeThreadSignalAtById = new Map<string, number>();
  private pendingTurnStart = false;
  private pendingTurnThreadId: string | null = null;
  private interruptPendingTurnStart = false;
  private pendingThreadFollowId: string | null = null;
  private pendingApprovalRequest: CodexPendingApprovalRequest | null = null;
  private queuedTurnNotifications: CodexQueuedNotification[] = [];
  private queuedTurnServerRequests: Array<{
    requestId: CodexRpcRequestId;
    method: CodexPendingApprovalRequest["method"];
    params: Record<string, unknown>;
  }> = [];
  private mirroredUserInputTurnIds = new Set<string>();
  private turnFinalMessages = new Map<string, Map<string, string>>();
  private turnDeltaByItem = new Map<string, Map<string, string>>();
  private turnErrorById = new Map<string, string>();
  private startupBlocker: string | null = null;
  private warmupUntilMs = 0;
  private sessionFilePath: string | null = null;
  private sessionPollTimer: ReturnType<typeof setInterval> | null = null;
  private sessionReadOffset = 0;
  private sessionPartialLine = "";
  private sessionFinalText: string | null = null;
  private sessionIgnoreBeforeMs: number | null = null;
  private nextSessionFallbackScanAtMs = 0;
  private completedTurnIds = new Set<string>();
  private completedTurnOrder: string[] = [];
  private pendingInjectedInputs: Array<{
    text: string;
    normalizedText: string;
    createdAtMs: number;
  }> = [];
  private localInputListener: ((chunk: string | Buffer) => void) | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeThreadId: string | null;

  constructor(options: AdapterOptions) {
    super(options);
    this.resumeThreadId = options.initialSharedThreadId ?? null;
    if (this.resumeThreadId && options.renderMode !== "panel") {
      this.state.sharedThreadId = this.resumeThreadId;
    }
  }

  override async start(): Promise<void> {
    if (this.isCodexClientRunning()) {
      return;
    }

    await this.startAppServer();
    await this.connectRpcClient();
    await this.restoreInitialSharedThreadIfNeeded();

    try {
      if (this.isNativePanelMode()) {
        await this.startNativeClient();
      } else {
        await super.start();
      }
    } catch (err) {
      await this.disconnectRpcClient();
      await this.stopAppServer();
      throw err;
    }
  }

  protected buildSpawnArgs(): string[] {
    if (!this.appServerPort) {
      throw new Error("Codex app-server is not ready.");
    }

    return buildCodexCliArgs(`ws://${CODEX_APP_SERVER_HOST}:${this.appServerPort}`, {
      inlineMode: this.options.renderMode !== "panel",
      profile: this.options.profile,
    });
  }

  protected override afterStart(): void {
    this.warmupUntilMs = this.isNativePanelMode()
      ? 0
      : Date.now() + CODEX_STARTUP_WARMUP_MS;
    if (!this.isNativePanelMode()) {
      this.attachLocalInputForwarding();
    }
    this.startSessionPolling();
  }

  override async sendInput(text: string): Promise<void> {
    if (this.isNativePanelMode()) {
      await this.sendPanelTurn(text);
      return;
    }

    if (!this.pty) {
      throw new Error("codex adapter is not running.");
    }
    if (this.state.status === "busy") {
      throw new Error("codex is still working. Wait for the current reply or use /stop.");
    }
    if (this.pendingApproval) {
      throw new Error("A Codex approval request is pending. Reply with /confirm <code> or /deny.");
    }
    if (this.startupBlocker) {
      throw new Error("Codex is waiting for local terminal input before the session can continue.");
    }

    await delay(this.warmupUntilMs - Date.now());
    if (!this.pty) {
      throw new Error("codex adapter is not running.");
    }
    if (this.startupBlocker) {
      throw new Error("Codex is waiting for local terminal input before the session can continue.");
    }

    this.clearInterruptTimer();
    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(text);
    this.state.lastInputAt = nowIso();
    this.rememberInjectedInput(text);
    this.setStatus("busy");
    this.state.activeTurnOrigin = "wechat";
    await this.typeIntoPty(text.replace(/\r?\n/g, "\r"));
    await delay(40);
    this.writeToPty("\r");
  }

  override async listResumeThreads(limit = 10): Promise<BridgeResumeThreadCandidate[]> {
    return listCodexResumeThreads(this.options.cwd, limit);
  }

  override async resumeThread(threadId: string): Promise<void> {
    if (this.isNativePanelMode()) {
      throw new Error(
        'WeChat /resume is disabled in codex mode. Use /resume directly inside "wechat-codex"; WeChat will follow the active local thread.',
      );
    }
    await this.resumeSharedThread(threadId);
  }

  override async interrupt(): Promise<boolean> {
    if (this.isNativePanelMode()) {
      return await this.interruptPanelTurn();
    }

    if (!this.pty) {
      return false;
    }

    if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
      return false;
    }

    this.clearPendingApprovalState();
    this.writeToPty("\u0003");
    this.armInterruptFallback();
    return true;
  }

  override async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    if (!this.pendingApproval) {
      return false;
    }

    if (this.pendingApprovalRequest && this.rpcSocket) {
      const request = this.pendingApprovalRequest;
      await this.respondToApprovalRequest(request, action);
      this.clearPendingApprovalState();
      this.setStatus("busy");
      return true;
    }

    return await super.resolveApproval(action);
  }

  override async dispose(): Promise<void> {
    this.resetTurnTracking({ preserveThread: false });
    if (!this.isNativePanelMode()) {
      this.detachLocalInputForwarding();
    }
    this.stopSessionPolling();
    await this.disconnectRpcClient();
    if (this.isNativePanelMode()) {
      await this.stopNativeClient();
      this.clearCompletionTimer();
      this.pendingApproval = null;
      this.state.pendingApproval = null;
      this.state.status = "stopped";
      this.state.pid = undefined;
    } else {
      await super.dispose();
    }
    await this.stopAppServer();
  }

  protected override handleData(rawText: string): void {
    this.renderLocalOutput(rawText);

    const text = normalizeOutput(rawText);
    if (!text) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    const approval = detectCliApproval(text);

    if (this.hasAcceptedInput) {
      if (approval && !this.pendingApproval) {
        this.pendingApproval = approval;
        this.state.pendingApproval = approval;
        this.state.pendingApprovalOrigin = this.state.activeTurnOrigin;
        this.setStatus("awaiting_approval", "Codex approval is required.");
        this.emit({
          type: "approval_required",
          request: approval,
          timestamp: nowIso(),
        });
      }
      return;
    }

    if (approval) {
      this.startupBlocker = approval.commandPreview;
      if (this.state.status !== "awaiting_approval") {
        this.setStatus("awaiting_approval", "Codex is waiting for local terminal input.");
      }
      return;
    }

    if (this.startupBlocker) {
      this.startupBlocker = null;
      if (this.state.status === "awaiting_approval") {
        this.setStatus("idle", "codex adapter is ready.");
      }
    }
  }

  protected override handleExit(exitCode: number | undefined): void {
    this.resetTurnTracking({ preserveThread: false });
    this.detachLocalInputForwarding();
    this.stopSessionPolling();
    void this.disconnectRpcClient();
    void this.stopAppServer();
    super.handleExit(exitCode);
  }

  private isNativePanelMode(): boolean {
    return this.options.renderMode === "panel";
  }

  private isCodexClientRunning(): boolean {
    return this.isNativePanelMode() ? Boolean(this.nativeProcess) : Boolean(this.pty);
  }

  private async startNativeClient(): Promise<void> {
    this.setStatus("starting", `Starting ${this.options.kind} adapter...`);

    let spawnTarget: SpawnTarget | null = null;
    try {
      spawnTarget = resolveSpawnTarget(this.options.command, this.options.kind);
      const child = spawnChild(
        spawnTarget.file,
        [...spawnTarget.args, ...this.buildSpawnArgs()],
        {
          cwd: this.options.cwd,
          env: this.buildEnv(),
          stdio: "inherit",
          windowsHide: false,
        },
      );

      this.nativeProcess = child;
      this.shuttingDown = false;
      this.hasAcceptedInput = false;
      this.state.pid = child.pid ?? undefined;
      this.state.startedAt = nowIso();
      this.state.status = "idle";
      this.state.pendingApproval = null;

      child.once("error", (error) => {
        if (this.nativeProcess === child) {
          this.handleNativeExit(undefined, undefined, error);
        }
      });
      child.once("exit", (exitCode, signal) => {
        if (this.nativeProcess === child) {
          this.handleNativeExit(exitCode ?? undefined, signal ?? undefined);
        }
      });

      this.afterStart();
      this.setStatus("idle", `${this.options.kind} adapter is ready.`);
    } catch (err) {
      this.state.status = "error";
      this.emit({
        type: "fatal_error",
        message: `Failed to start ${this.options.kind}${spawnTarget ? ` (${spawnTarget.file})` : ""}: ${String(err)}`,
        timestamp: nowIso(),
      });
      throw err;
    }
  }

  private handleNativeExit(
    exitCode: number | undefined,
    signal?: NodeJS.Signals,
    startupError?: Error,
  ): void {
    this.clearCompletionTimer();
    this.resetTurnTracking({ preserveThread: false });
    this.stopSessionPolling();
    void this.disconnectRpcClient();
    void this.stopAppServer();

    const expectedShutdown = this.shuttingDown;
    this.shuttingDown = false;
    this.nativeProcess = null;
    this.state.status = "stopped";
    this.state.pid = undefined;
    this.pendingApproval = null;
    this.state.pendingApproval = null;

    if (expectedShutdown) {
      this.emit({
        type: "status",
        status: "stopped",
        message: `${this.options.kind} worker stopped.`,
        timestamp: nowIso(),
      });
      return;
    }

    const exitLabel = startupError
      ? startupError.message
      : signal
        ? `signal ${signal}`
        : typeof exitCode === "number"
          ? `code ${exitCode}`
          : "an unknown code";
    this.emit({
      type: "fatal_error",
      message: `${this.options.kind} worker exited unexpectedly with ${exitLabel}.`,
      timestamp: nowIso(),
    });
  }

  private async stopNativeClient(): Promise<void> {
    if (!this.nativeProcess) {
      this.state.pid = undefined;
      return;
    }

    const child = this.nativeProcess;
    this.shuttingDown = true;
    this.nativeProcess = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      child.once("exit", () => finish());
      try {
        child.kill();
      } catch {
        finish();
      }
      const timer = setTimeout(() => finish(), 1_500);
      timer.unref?.();
    });
  }

  private startSessionPolling(): void {
    this.stopSessionPolling();
    const poll = () => {
      void this.pollSessionLog();
    };
    this.sessionPollTimer = setInterval(poll, CODEX_SESSION_POLL_INTERVAL_MS);
    this.sessionPollTimer.unref?.();
    poll();
  }

  private stopSessionPolling(): void {
    if (this.sessionPollTimer) {
      clearInterval(this.sessionPollTimer);
      this.sessionPollTimer = null;
    }
    this.sessionFilePath = null;
    this.sessionReadOffset = 0;
    this.sessionPartialLine = "";
    this.sessionFinalText = null;
    this.sessionIgnoreBeforeMs = null;
    this.nextSessionFallbackScanAtMs = 0;
  }

  private async pollSessionLog(): Promise<void> {
    if (!this.isCodexClientRunning()) {
      return;
    }

    this.maybeApplyRecentSessionFallback();

    if (!this.sessionFilePath) {
      const startedAtMs = this.state.startedAt ? Date.parse(this.state.startedAt) : Date.now();
      this.sessionFilePath = findCodexSessionFile(
        this.options.cwd,
        startedAtMs,
        { threadId: this.sharedThreadId ?? undefined },
      );
      if (!this.sessionFilePath) {
        return;
      }
      this.sessionReadOffset = 0;
      this.sessionPartialLine = "";
    }

    let content: string;
    try {
      content = fs.readFileSync(this.sessionFilePath, "utf8");
    } catch {
      this.sessionFilePath = null;
      this.sessionReadOffset = 0;
      this.sessionPartialLine = "";
      return;
    }

    if (content.length < this.sessionReadOffset) {
      this.sessionReadOffset = 0;
      this.sessionPartialLine = "";
    }
    if (content.length === this.sessionReadOffset) {
      return;
    }

    const chunk = content.slice(this.sessionReadOffset);
    this.sessionReadOffset = content.length;
    const lines = `${this.sessionPartialLine}${chunk}`.split(/\r?\n/);
    this.sessionPartialLine = lines.pop() ?? "";

    for (const line of lines) {
      this.handleSessionLogLine(line);
    }
  }

  private maybeApplyRecentSessionFallback(): void {
    if (!this.isNativePanelMode()) {
      return;
    }

    const now = Date.now();
    if (now < this.nextSessionFallbackScanAtMs) {
      return;
    }
    this.nextSessionFallbackScanAtMs = now + CODEX_SESSION_FALLBACK_SCAN_INTERVAL_MS;

    const startedAtMs = this.state.startedAt ? Date.parse(this.state.startedAt) : now;
    const candidate = findRecentCodexSessionFileForCwd(this.options.cwd, startedAtMs);
    if (!candidate) {
      return;
    }

    let currentSessionModifiedAtMs = Number.NEGATIVE_INFINITY;
    if (this.sessionFilePath) {
      try {
        currentSessionModifiedAtMs = fs.statSync(this.sessionFilePath).mtimeMs;
      } catch {
        currentSessionModifiedAtMs = Number.NEGATIVE_INFINITY;
      }
    }

    if (candidate.threadId !== this.sharedThreadId) {
      if (this.sessionFilePath && candidate.modifiedAtMs <= currentSessionModifiedAtMs) {
        return;
      }

      this.updateSharedThread(candidate.threadId, {
        source: "local",
        reason: "local_session_fallback",
        notify: true,
      });
    }

    if (this.sessionFilePath !== candidate.filePath) {
      this.sessionFilePath = candidate.filePath;
      this.sessionReadOffset = 0;
      this.sessionPartialLine = "";
      this.sessionFinalText = null;
    }
  }

  private handleSessionLogLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (!isRecord(parsed) || !isRecord(parsed.payload) || typeof parsed.payload.type !== "string") {
      return;
    }

    if (shouldIgnoreCodexSessionReplayEntry(parsed.timestamp, this.sessionIgnoreBeforeMs)) {
      return;
    }

    const payload = parsed.payload;
    const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : nowIso();
    if (this.sessionIgnoreBeforeMs !== null) {
      this.sessionIgnoreBeforeMs = null;
    }

    switch (payload.type) {
      case "task_started": {
        if (typeof payload.turn_id === "string") {
          this.hasAcceptedInput = true;
          this.state.activeTurnId = payload.turn_id;
          if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
            const message =
              this.state.activeTurnOrigin === "local"
                ? "Codex is busy with a local terminal turn."
                : undefined;
            this.setStatus("busy", message);
          }
        }
        return;
      }

      case "user_message": {
        if (typeof payload.message !== "string") {
          return;
        }

        const message = normalizeOutput(payload.message).trim();
        if (!message) {
          return;
        }

        this.hasAcceptedInput = true;
        this.state.lastInputAt = timestamp;
        const origin = this.consumeInjectedInput(message) ? "wechat" : "local";
        this.state.activeTurnOrigin = origin;

        if (origin === "local") {
          const turnId = this.activeTurn?.turnId ?? this.state.activeTurnId ?? null;
          if (turnId && !this.mirroredUserInputTurnIds.has(turnId)) {
            this.mirroredUserInputTurnIds.add(turnId);
            this.emit({
              type: "mirrored_user_input",
              text: message,
              timestamp,
              origin: "local",
            });
          }

          if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
            this.setStatus("busy", "Codex is busy with a local terminal turn.");
          }

          if (
            !turnId &&
            !this.isRpcSocketOpen() &&
            isRecentIsoTimestamp(timestamp, CODEX_SESSION_LOCAL_MIRROR_FALLBACK_WINDOW_MS)
          ) {
            this.emit({
              type: "mirrored_user_input",
              text: message,
              timestamp,
              origin: "local",
            });
          }
        }
        return;
      }

      case "agent_message": {
        if (payload.phase !== "final_answer" || typeof payload.message !== "string") {
          return;
        }

        const message = normalizeOutput(payload.message).trim();
        if (message) {
          this.sessionFinalText = message;
          this.state.lastOutputAt = timestamp;
        }
        return;
      }

      case "task_complete": {
        if (typeof payload.turn_id !== "string") {
          return;
        }

        if (this.hasCompletedTurn(payload.turn_id)) {
          this.sessionFinalText = null;
          if (this.activeTurn?.turnId === payload.turn_id) {
            this.setActiveTurn(null);
          }
          if (this.state.status !== "stopped") {
            this.setStatus("idle");
          }
          return;
        }

        const finalText =
          this.sessionFinalText ||
          (typeof payload.last_agent_message === "string"
            ? normalizeOutput(payload.last_agent_message).trim()
            : "");
        const completionOrigin = this.state.activeTurnOrigin;
        this.sessionFinalText = null;
        this.clearPendingApprovalState();

        if (finalText) {
          this.emit({
            type: "stdout",
            text: finalText,
            timestamp,
          });
        }

        if (this.state.status !== "stopped") {
          this.setStatus("idle");
        }

        this.emit({
          type: "task_complete",
          summary:
            completionOrigin === "local"
              ? "Local terminal turn completed."
              : this.currentPreview,
          timestamp,
        });

        this.rememberCompletedTurn(payload.turn_id);
        this.state.activeTurnId = undefined;
        this.state.activeTurnOrigin = undefined;
        return;
      }
    }
  }

  private rememberInjectedInput(text: string): void {
    const normalizedText = normalizeOutput(text).trim();
    if (!normalizedText) {
      return;
    }

    const cutoff = Date.now() - 60_000;
    this.pendingInjectedInputs = this.pendingInjectedInputs.filter(
      (entry) => entry.createdAtMs >= cutoff,
    );
    this.pendingInjectedInputs.push({
      text,
      normalizedText,
      createdAtMs: Date.now(),
    });
    if (this.pendingInjectedInputs.length > 8) {
      this.pendingInjectedInputs.splice(0, this.pendingInjectedInputs.length - 8);
    }
  }

  private consumeInjectedInput(message: string): boolean {
    const normalizedMessage = normalizeOutput(message).trim();
    if (!normalizedMessage) {
      return false;
    }

    const cutoff = Date.now() - 60_000;
    this.pendingInjectedInputs = this.pendingInjectedInputs.filter(
      (entry) => entry.createdAtMs >= cutoff,
    );

    const index = this.pendingInjectedInputs.findIndex(
      (entry) => entry.normalizedText === normalizedMessage,
    );
    if (index < 0) {
      return false;
    }

    this.pendingInjectedInputs.splice(index, 1);
    return true;
  }

  private async typeIntoPty(text: string): Promise<void> {
    for (const character of text) {
      this.writeToPty(character);
      await delay(4);
    }
  }

  private async sendPanelTurn(text: string): Promise<void> {
    if (!this.nativeProcess) {
      throw new Error("codex panel is not running.");
    }
    if (this.pendingApproval) {
      throw new Error("A Codex approval request is pending. Reply with /confirm <code> or /deny.");
    }
    if (this.pendingTurnStart || this.activeTurn || this.state.status === "busy") {
      const origin = this.state.activeTurnOrigin;
      if (origin === "local") {
        throw new Error("The local Codex panel is still working. Wait for the current reply or use /stop.");
      }
      throw new Error("codex is still working. Wait for the current reply or use /stop.");
    }

    this.clearInterruptTimer();
    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(text);
    this.state.lastInputAt = nowIso();
    this.rememberInjectedInput(text);
    this.clearPendingApprovalState();

    const threadId = await this.ensureThreadStarted();
    this.pendingTurnStart = true;
    this.pendingTurnThreadId = threadId;
    this.interruptPendingTurnStart = false;
    this.state.activeTurnOrigin = "wechat";
    this.setStatus("busy");

    try {
      const response = await this.sendRpcRequest("turn/start", {
        threadId,
        cwd: this.options.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        input: [
          {
            type: "text",
            text,
          },
        ],
      });

      const turnId = this.extractTurnIdFromResponse(response);
      if (!turnId) {
        throw new Error("Codex did not return a turn id for the requested turn.");
      }

      this.bindActiveTurn({
        threadId,
        turnId,
        origin: "wechat",
      });

      if (this.interruptPendingTurnStart) {
        await this.requestActiveTurnInterrupt();
        this.armInterruptFallback();
      }
    } catch (error) {
      this.pendingTurnStart = false;
      this.pendingTurnThreadId = null;
      this.interruptPendingTurnStart = false;
      this.state.activeTurnOrigin = undefined;
      if (!this.activeTurn && this.state.status === "busy") {
        this.setStatus("idle");
      }
      throw error;
    }
  }

  private async interruptPanelTurn(): Promise<boolean> {
    if (!this.nativeProcess) {
      return false;
    }

    const turnPending =
      this.pendingTurnStart || this.state.status === "busy" || this.state.status === "awaiting_approval";
    if (!turnPending) {
      return false;
    }

    this.clearPendingApprovalState();

    if (this.pendingTurnStart && !this.activeTurn) {
      this.interruptPendingTurnStart = true;
      this.armInterruptFallback();
      return true;
    }

    if (!this.activeTurn) {
      return false;
    }

    await this.requestActiveTurnInterrupt();
    this.armInterruptFallback();
    return true;
  }

  private async startAppServer(): Promise<void> {
    if (this.appServer) {
      return;
    }

    const port = await reserveLocalPort();
    const env = this.buildEnv();
    const spawnTarget = resolveSpawnTarget(this.options.command, "codex");
    const child = spawnChild(
      spawnTarget.file,
      [
        ...spawnTarget.args,
        "app-server",
        "--listen",
        `ws://${CODEX_APP_SERVER_HOST}:${port}`,
      ],
      {
        cwd: this.options.cwd,
        env,
        stdio: "pipe",
        windowsHide: true,
      },
    );

    this.appServer = child;
    this.appServerPort = port;
    this.appServerShuttingDown = false;
    this.appServerLog = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.appServerLog = appendBoundedLog(this.appServerLog, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      this.appServerLog = appendBoundedLog(this.appServerLog, chunk);
    });
    child.on("exit", (code, signal) => {
      const expectedShutdown = this.appServerShuttingDown;
      this.appServer = null;
      this.appServerPort = null;
      this.appServerShuttingDown = false;

      if (expectedShutdown) {
        return;
      }

      const exitLabel =
        signal ? `signal ${signal}` : `code ${typeof code === "number" ? code : "unknown"}`;
      const details = this.describeAppServerLog();
      this.emit({
        type: "fatal_error",
        message: `codex app-server exited unexpectedly with ${exitLabel}.${details}`,
        timestamp: nowIso(),
      });

      this.terminateCodexClient();
    });

    try {
      await waitForTcpPort(
        CODEX_APP_SERVER_HOST,
        port,
        CODEX_APP_SERVER_READY_TIMEOUT_MS,
      );
    } catch (err) {
      await this.stopAppServer();
      const details = this.describeAppServerLog();
      throw new Error(`Failed to start Codex app-server: ${String(err)}${details}`);
    }
  }

  private async connectRpcClient(): Promise<void> {
    if (this.rpcSocket) {
      return;
    }
    if (!this.appServerPort) {
      throw new Error("Codex app-server is not ready.");
    }
    if (typeof WebSocket !== "function") {
      throw new Error("Global WebSocket is unavailable in this runtime.");
    }

    const url = `ws://${CODEX_APP_SERVER_HOST}:${this.appServerPort}`;
    const deadline = Date.now() + CODEX_APP_SERVER_READY_TIMEOUT_MS;
    let lastError = "Timed out before the websocket became ready.";

    while (Date.now() < deadline) {
      try {
        const socket = await this.openRpcSocket(url, deadline - Date.now());
        this.attachRpcSocket(socket);
        await this.initializeRpcClient();
        return;
      } catch (err) {
        lastError = describeUnknownError(err);
        await this.disconnectRpcClient();
        await delay(CODEX_RPC_CONNECT_RETRY_MS);
      }
    }

    throw new Error(`Failed to connect to Codex app-server websocket: ${lastError}`);
  }

  private async openRpcSocket(url: string, timeoutMs: number): Promise<WebSocket> {
    return await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          socket.close();
        } catch {
          // Best effort cleanup after timeout.
        }
        reject(new Error(`Timed out opening Codex websocket ${url}.`));
      }, Math.max(500, timeoutMs));

      const cleanup = () => {
        clearTimeout(timer);
      };

      socket.addEventListener(
        "open",
        () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve(socket);
        },
        { once: true },
      );

      socket.addEventListener(
        "error",
        () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(new Error(`Failed to open Codex websocket ${url}.`));
        },
        { once: true },
      );
    });
  }

  private attachRpcSocket(socket: WebSocket): void {
    this.rpcSocket = socket;
    this.rpcShuttingDown = false;

    socket.addEventListener("message", (event) => {
      this.handleRpcMessageData(event.data);
    });
    socket.addEventListener("close", () => {
      this.handleRpcSocketClosed();
    });
  }

  private async disconnectRpcClient(): Promise<void> {
    const socket = this.rpcSocket;
    this.rpcSocket = null;
    this.rpcShuttingDown = true;
    this.rejectPendingRpcRequests("Codex websocket connection closed.");

    if (!socket) {
      this.rpcShuttingDown = false;
      return;
    }

    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      socket.addEventListener("close", () => finish(), { once: true });
      const timer = setTimeout(() => finish(), 1_000);
      timer.unref?.();

      try {
        socket.close();
      } catch {
        finish();
      }
    });

    this.rpcShuttingDown = false;
  }

  private handleRpcSocketClosed(): void {
    const expectedShutdown = this.rpcShuttingDown || this.shuttingDown;
    this.rpcSocket = null;
    this.rejectPendingRpcRequests("Codex websocket connection closed.");
    this.rpcShuttingDown = false;

    if (expectedShutdown) {
      return;
    }

    void this.reconnectRpcClientAfterUnexpectedClose();
  }

  private async reconnectRpcClientAfterUnexpectedClose(): Promise<boolean> {
    if (this.rpcReconnectPromise) {
      return await this.rpcReconnectPromise;
    }

    this.rpcReconnectPromise = (async () => {
      if (!this.appServer || !this.appServerPort) {
        const details = this.describeAppServerLog();
        this.emit({
          type: "fatal_error",
          message: `codex app-server websocket closed unexpectedly.${details}`,
          timestamp: nowIso(),
        });
        this.terminateCodexClient();
        return false;
      }

      const reconnectDeadline = Date.now() + CODEX_RPC_RECONNECT_TIMEOUT_MS;
      let lastError = "Codex websocket connection closed.";

      while (!this.shuttingDown && Date.now() < reconnectDeadline) {
        try {
          await this.connectRpcClient();
          return true;
        } catch (error) {
          lastError = describeUnknownError(error);
          await delay(CODEX_RPC_CONNECT_RETRY_MS);
        }
      }

      const details = this.describeAppServerLog();
      this.emit({
        type: "fatal_error",
        message: `codex app-server websocket closed unexpectedly and could not reconnect: ${lastError}.${details}`,
        timestamp: nowIso(),
      });
      this.terminateCodexClient();
      return false;
    })();

    try {
      return await this.rpcReconnectPromise;
    } finally {
      this.rpcReconnectPromise = null;
    }
  }

  private rejectPendingRpcRequests(message: string): void {
    for (const pending of this.pendingRpcRequests.values()) {
      pending.reject(new Error(message));
    }
    this.pendingRpcRequests.clear();
  }

  private async initializeRpcClient(): Promise<void> {
    await this.sendRpcRequest("initialize", {
      clientInfo: {
        name: "wechat-bridge",
        title: "WeChat Bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  private async restoreInitialSharedThreadIfNeeded(): Promise<void> {
    if (!this.resumeThreadId || this.isNativePanelMode()) {
      return;
    }

    const threadId = this.resumeThreadId;
    this.resumeThreadId = null;

    try {
      await this.resumeSharedThread(threadId, { startup: true });
    } catch (error) {
      this.updateSharedThread(null);
      this.emit({
        type: "status",
        status: "starting",
        message: `Failed to restore the previous Codex thread ${threadId.slice(0, 12)}. Starting without resume: ${describeUnknownError(error)}`,
        timestamp: nowIso(),
      });
    }
  }

  private async ensureThreadStarted(): Promise<string> {
    if (this.sharedThreadId) {
      return this.sharedThreadId;
    }

    const response = await this.sendRpcRequest("thread/start", {
      cwd: this.options.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      serviceName: "wechat-bridge",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });

    const threadId = this.extractThreadIdFromResponse(response);
    if (!threadId) {
      throw new Error("Codex did not return a thread id for the bridge session.");
    }

    this.rememberBridgeOwnedThreadSignal(threadId);
    this.updateSharedThread(threadId);
    return threadId;
  }

  private async resumeSharedThread(
    threadId: string,
    options: { startup?: boolean } = {},
  ): Promise<void> {
    const trimmedThreadId = threadId.trim();
    if (!trimmedThreadId) {
      throw new Error("A thread id is required to resume a Codex thread.");
    }

    if (this.pendingApproval) {
      throw new Error("A Codex approval request is pending. Reply with /confirm <code> or /deny.");
    }

    if (
      !options.startup &&
      (this.pendingTurnStart ||
        this.activeTurn ||
        this.state.status === "busy" ||
        this.state.status === "awaiting_approval")
    ) {
      throw new Error("codex is still working. Wait for the current reply or use /stop.");
    }

    const response = await this.sendRpcRequest("thread/resume", {
      threadId: trimmedThreadId,
      cwd: this.options.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });

    const resumedThreadId = this.extractThreadIdFromResponse(response);
    if (!resumedThreadId) {
      throw new Error("Codex did not return a thread id while resuming the saved thread.");
    }

    this.rememberBridgeOwnedThreadSignal(resumedThreadId);
    this.sessionFilePath = null;
    this.sessionReadOffset = 0;
    this.sessionPartialLine = "";
    this.sessionFinalText = null;
    this.pendingThreadFollowId = null;
    this.updateSharedThread(resumedThreadId, {
      source: options.startup ? "restore" : "wechat",
      reason: options.startup ? "startup_restore" : "wechat_resume",
      notify: true,
    });
  }

  private extractThreadIdFromResponse(response: unknown): string | null {
    if (!isRecord(response) || !isRecord(response.thread)) {
      return null;
    }
    return typeof response.thread.id === "string" ? response.thread.id : null;
  }

  private extractTurnIdFromResponse(response: unknown): string | null {
    if (!isRecord(response) || !isRecord(response.turn)) {
      return null;
    }
    return typeof response.turn.id === "string" ? response.turn.id : null;
  }

  private bindActiveTurn(activeTurn: CodexActiveTurn): void {
    this.pendingTurnStart = false;
    this.pendingTurnThreadId = null;
    this.bridgeOwnedTurnIds.add(activeTurn.turnId);
    this.setActiveTurn(activeTurn);

    const queuedNotifications = this.queuedTurnNotifications;
    this.queuedTurnNotifications = [];
    for (const notification of queuedNotifications) {
      this.handleRpcNotification(notification.method, notification.params);
    }

    const queuedRequests = this.queuedTurnServerRequests;
    this.queuedTurnServerRequests = [];
    for (const request of queuedRequests) {
      this.handleRpcServerRequest(request.requestId, request.method, request.params);
    }
  }

  private async requestActiveTurnInterrupt(): Promise<void> {
    if (!this.activeTurn) {
      return;
    }

    await this.sendRpcRequest("turn/interrupt", {
      threadId: this.activeTurn.threadId,
      turnId: this.activeTurn.turnId,
    });
  }

  private armInterruptFallback(): void {
    this.clearInterruptTimer();
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
        return;
      }

      this.resetTurnTracking({ preserveThread: true });
      this.setStatus("idle", "Codex task interrupted.");
      this.emit({
        type: "task_complete",
        summary: "Interrupted",
        timestamp: nowIso(),
      });
    }, INTERRUPT_SETTLE_DELAY_MS);
  }

  private clearInterruptTimer(): void {
    if (!this.interruptTimer) {
      return;
    }
    clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
  }

  private resetTurnTracking(options: { preserveThread: boolean }): void {
    this.clearInterruptTimer();
    if (this.activeTurn) {
      this.cleanupTurnArtifacts(this.activeTurn.turnId);
    }
    this.setActiveTurn(null);
    this.pendingTurnStart = false;
    this.pendingTurnThreadId = null;
    this.interruptPendingTurnStart = false;
    this.pendingThreadFollowId = null;
    this.clearPendingApprovalState();
    this.queuedTurnNotifications = [];
    this.queuedTurnServerRequests = [];
    this.turnFinalMessages.clear();
    this.turnDeltaByItem.clear();
    this.turnErrorById.clear();
    this.mirroredUserInputTurnIds.clear();
    this.bridgeOwnedTurnIds.clear();
    this.completedTurnIds.clear();
    this.completedTurnOrder = [];
    this.pendingInjectedInputs = [];
    this.recentBridgeThreadSignalAtById.clear();
    this.sessionFinalText = null;
    this.nextSessionFallbackScanAtMs = 0;
    this.state.activeTurnId = undefined;
    this.state.activeTurnOrigin = undefined;
    if (!options.preserveThread) {
      this.updateSharedThread(null);
    }
  }

  private updateSharedThread(
    threadId: string | null,
    options: {
      source?: BridgeThreadSwitchSource;
      reason?: BridgeThreadSwitchReason;
      notify?: boolean;
    } = {},
  ): void {
    const previousThreadId = this.sharedThreadId;
    this.sharedThreadId = threadId;
    this.state.sharedThreadId = threadId ?? undefined;
    if (threadId && options.source && options.reason) {
      const switchedAt = nowIso();
      this.state.lastThreadSwitchAt = switchedAt;
      this.state.lastThreadSwitchSource = options.source;
      this.state.lastThreadSwitchReason = options.reason;
      if (options.notify && previousThreadId !== threadId) {
        this.emit({
          type: "thread_switched",
          threadId,
          source: options.source,
          reason: options.reason,
          timestamp: switchedAt,
        });
      }
    }
    if (previousThreadId !== threadId) {
      this.sessionFilePath = null;
      this.sessionReadOffset = 0;
      this.sessionPartialLine = "";
      this.sessionFinalText = null;
      this.sessionIgnoreBeforeMs = threadId ? Date.now() : null;
      this.nextSessionFallbackScanAtMs = 0;
      this.emit({
        type: "status",
        status: this.state.status,
        timestamp: nowIso(),
      });
    }
  }

  private setActiveTurn(activeTurn: CodexActiveTurn | null): void {
    this.activeTurn = activeTurn;
    this.state.activeTurnId = activeTurn?.turnId;
    this.state.activeTurnOrigin = activeTurn?.origin;
    if (!activeTurn && this.pendingThreadFollowId) {
      const pendingThreadId = this.pendingThreadFollowId;
      this.pendingThreadFollowId = null;
      this.updateSharedThread(pendingThreadId, {
        source: "local",
        reason: "local_follow",
        notify: true,
      });
    }
  }

  private rememberBridgeOwnedThreadSignal(threadId: string): void {
    const cutoff = Date.now() - CODEX_THREAD_SIGNAL_TTL_MS;
    for (const [candidateThreadId, recordedAtMs] of this.recentBridgeThreadSignalAtById.entries()) {
      if (recordedAtMs < cutoff) {
        this.recentBridgeThreadSignalAtById.delete(candidateThreadId);
      }
    }
    this.recentBridgeThreadSignalAtById.set(threadId, Date.now());
  }

  private isRecentlyBridgeOwnedThread(threadId: string): boolean {
    const recordedAtMs = this.recentBridgeThreadSignalAtById.get(threadId);
    if (!recordedAtMs) {
      return false;
    }
    if (recordedAtMs < Date.now() - CODEX_THREAD_SIGNAL_TTL_MS) {
      this.recentBridgeThreadSignalAtById.delete(threadId);
      return false;
    }
    return true;
  }

  private clearPendingApprovalState(): void {
    this.pendingApprovalRequest = null;
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
  }

  private cleanupTurnArtifacts(turnId: string): void {
    this.turnFinalMessages.delete(turnId);
    this.turnDeltaByItem.delete(turnId);
    this.turnErrorById.delete(turnId);
    this.mirroredUserInputTurnIds.delete(turnId);
    this.bridgeOwnedTurnIds.delete(turnId);
  }

  private rpcRequestKey(requestId: CodexRpcRequestId): string {
    return `${typeof requestId}:${String(requestId)}`;
  }

  private isRpcSocketOpen(): boolean {
    return Boolean(this.rpcSocket && this.rpcSocket.readyState === WebSocket.OPEN);
  }

  private async ensureRpcClientConnected(): Promise<void> {
    if (this.isRpcSocketOpen()) {
      return;
    }

    if (this.rpcReconnectPromise) {
      const reconnected = await this.rpcReconnectPromise;
      if (!reconnected || !this.isRpcSocketOpen()) {
        throw new Error("Codex websocket is not connected.");
      }
      return;
    }

    await this.connectRpcClient();
    if (!this.isRpcSocketOpen()) {
      throw new Error("Codex websocket is not connected.");
    }
  }

  private async sendRpcRequest(method: string, params: unknown): Promise<unknown> {
    await this.ensureRpcClientConnected();
    const socket = this.rpcSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex websocket is not connected.");
    }

    const requestId = ++this.rpcRequestCounter;
    const requestKey = this.rpcRequestKey(requestId);
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      this.pendingRpcRequests.set(requestKey, {
        method,
        resolve,
        reject,
      });
    });

    try {
      this.sendRpcMessage({
        id: requestId,
        method,
        params,
      });
    } catch (err) {
      this.pendingRpcRequests.delete(requestKey);
      throw err;
    }

    return await responsePromise;
  }

  private sendRpcMessage(payload: Record<string, unknown>): void {
    const socket = this.rpcSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex websocket is not connected.");
    }

    socket.send(JSON.stringify(payload));
  }

  private async respondToApprovalRequest(
    request: CodexPendingApprovalRequest,
    action: "confirm" | "deny",
  ): Promise<void> {
    const decision = action === "confirm" ? "accept" : "decline";
    this.sendRpcMessage({
      id: request.requestId,
      result: { decision },
    });
  }

  private handleRpcMessageData(data: unknown): void {
    const text = coerceWebSocketMessageData(data);
    if (!text) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }

    if (!isRecord(payload)) {
      return;
    }

    const requestId = getCodexRpcRequestId(payload.id);
    const method = typeof payload.method === "string" ? payload.method : null;

    if (requestId !== null && method) {
      this.handleRpcServerRequest(requestId, method, payload.params);
      return;
    }

    if (requestId !== null) {
      this.handleRpcResponse(requestId, payload);
      return;
    }

    if (method) {
      this.handleRpcNotification(method, payload.params);
    }
  }

  private handleRpcResponse(requestId: CodexRpcRequestId, payload: Record<string, unknown>): void {
    const requestKey = this.rpcRequestKey(requestId);
    const pending = this.pendingRpcRequests.get(requestKey);
    if (!pending) {
      return;
    }

    this.pendingRpcRequests.delete(requestKey);
    if (payload.error !== undefined && payload.error !== null) {
      pending.reject(new Error(normalizeCodexRpcError(payload.error)));
      return;
    }

    pending.resolve(payload.result);
  }

  private handleRpcNotification(method: string, params: unknown): void {
    if (!isRecord(params)) {
      return;
    }

    if (method === "thread/started") {
      this.handleThreadStarted(params);
      return;
    }

    if (method === "thread/status/changed") {
      this.handleThreadStatusChanged(params);
      return;
    }

    if (
      method === "item/started" ||
      method === "item/agentMessage/delta" ||
      method === "item/completed" ||
      method === "turn/completed" ||
      method === "turn/started" ||
      method === "error" ||
      method === "serverRequest/resolved"
    ) {
      if (this.shouldQueuePendingTurnEvent(params)) {
        this.queuedTurnNotifications.push({ method, params });
        return;
      }

      const trackedTurn = this.identifyTrackedTurn(method, params);
      if (!trackedTurn) {
        return;
      }

      this.handleTrackedTurnNotification(method, params, trackedTurn);
      return;
    }

    if (this.activeTurn) {
      this.state.lastOutputAt = nowIso();
    }
  }

  private shouldQueuePendingTurnEvent(params: Record<string, unknown>): boolean {
    if (!this.pendingTurnStart || this.activeTurn || !this.pendingTurnThreadId) {
      return false;
    }

    return getNotificationThreadId(params) === this.pendingTurnThreadId;
  }

  private identifyTrackedTurn(
    method: string,
    params: Record<string, unknown>,
  ): CodexActiveTurn | null {
    const threadId = getNotificationThreadId(params);
    const turnId = getNotificationTurnId(params);
    if (!threadId || !turnId) {
      return null;
    }

    if (this.bridgeOwnedTurnIds.has(turnId)) {
      return {
        threadId,
        turnId,
        origin: "wechat",
      };
    }

    if (this.sharedThreadId && threadId === this.sharedThreadId) {
      return {
        threadId,
        turnId,
        origin: "local",
      };
    }

    if (method === "turn/started" && !this.activeTurn) {
      return {
        threadId,
        turnId,
        origin: "local",
      };
    }

    return null;
  }

  private handleTrackedTurnNotification(
    method: string,
    params: Record<string, unknown>,
    trackedTurn: CodexActiveTurn,
  ): void {
    this.state.lastOutputAt = nowIso();
    this.handleTrackedTurnStarted(trackedTurn);

    switch (method) {
      case "item/started": {
        this.maybeMirrorLocalUserInput(trackedTurn, params.item);
        return;
      }

      case "item/agentMessage/delta": {
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!itemId || !delta) {
          return;
        }

        const deltaByItem = this.getTurnDeltaMap(trackedTurn.turnId);
        const previous = deltaByItem.get(itemId) ?? "";
        deltaByItem.set(itemId, `${previous}${delta}`);
        return;
      }

      case "item/completed": {
        this.maybeMirrorLocalUserInput(trackedTurn, params.item);
        const itemId =
          isRecord(params.item) && typeof params.item.id === "string"
            ? params.item.id
            : null;
        const finalText = extractCodexFinalTextFromItem(params.item);
        if (itemId && finalText) {
          this.getTurnFinalMessageMap(trackedTurn.turnId).set(itemId, finalText);
        }
        return;
      }

      case "error": {
        if (isRecord(params.error) && typeof params.error.message === "string") {
          this.turnErrorById.set(trackedTurn.turnId, params.error.message);
        }
        return;
      }

      case "serverRequest/resolved": {
        const requestId = getCodexRpcRequestId(params.requestId);
        if (
          requestId !== null &&
          this.pendingApprovalRequest &&
          requestId === this.pendingApprovalRequest.requestId &&
          trackedTurn.turnId === this.pendingApprovalRequest.turnId
        ) {
          this.clearPendingApprovalState();
          if (this.state.status === "awaiting_approval") {
            this.setStatus("busy", "Codex approval resolved.");
          }
        }
        return;
      }

      case "turn/completed": {
        this.handleTurnCompleted(trackedTurn, params);
        return;
      }
    }
  }

  private handleRpcServerRequest(
    requestId: CodexRpcRequestId,
    method: string,
    params: unknown,
  ): void {
    if (
      method !== "item/commandExecution/requestApproval" &&
      method !== "item/fileChange/requestApproval"
    ) {
      this.sendRpcMessage({
        id: requestId,
        error: {
          code: -32601,
          message: `Unsupported server request: ${method}`,
        },
      });
      return;
    }

    if (!isRecord(params)) {
      this.sendRpcMessage({
        id: requestId,
        error: {
          code: -32602,
          message: "Invalid Codex approval request payload.",
        },
      });
      return;
    }

    if (this.shouldQueuePendingTurnEvent(params)) {
      this.queuedTurnServerRequests.push({
        requestId,
        method,
        params,
      });
      return;
    }

    const trackedTurn = this.identifyTrackedTurn("server/request", params);
    if (!trackedTurn) {
      return;
    }

    this.handleTrackedTurnStarted(trackedTurn);
    this.handleTrackedTurnServerRequest(requestId, method, params, trackedTurn);
  }

  private handleTrackedTurnServerRequest(
    requestId: CodexRpcRequestId,
    method: CodexPendingApprovalRequest["method"],
    params: Record<string, unknown>,
    trackedTurn: CodexActiveTurn,
  ): void {
    const request = buildCodexApprovalRequest(method, params);
    if (!request) {
      return;
    }

    this.pendingApprovalRequest = {
      requestId,
      method,
      threadId: trackedTurn.threadId,
      turnId: trackedTurn.turnId,
      origin: trackedTurn.origin,
    };
    this.pendingApproval = request;
    this.state.pendingApproval = request;
    this.state.pendingApprovalOrigin = trackedTurn.origin;
    this.state.lastOutputAt = nowIso();
    this.setStatus("awaiting_approval", "Codex approval is required.");
    this.emit({
      type: "approval_required",
      request,
      timestamp: nowIso(),
    });
  }

  private handleThreadStatusChanged(params: Record<string, unknown>): void {
    const threadId = extractCodexThreadFollowIdFromStatusChanged(params);
    if (!threadId) {
      return;
    }

    if (!this.activeTurn || this.activeTurn.threadId === threadId) {
      this.updateSharedThread(threadId, {
        source: "local",
        reason: "local_follow",
        notify: true,
      });
      this.pendingThreadFollowId = null;
      return;
    }

    this.pendingThreadFollowId = threadId;
  }

  private handleThreadStarted(params: Record<string, unknown>): void {
    const threadId = extractCodexThreadStartedThreadId(params);
    if (!threadId) {
      return;
    }

    if (this.isRecentlyBridgeOwnedThread(threadId)) {
      return;
    }

    const thread = isRecord(params.thread) ? params.thread : null;
    if (thread && typeof thread.cwd === "string") {
      if (normalizeComparablePath(thread.cwd) !== normalizeComparablePath(this.options.cwd)) {
        return;
      }
    }

    if (!this.activeTurn || this.activeTurn.threadId === threadId) {
      this.updateSharedThread(threadId, {
        source: "local",
        reason: "local_follow",
        notify: true,
      });
      this.pendingThreadFollowId = null;
      return;
    }

    this.pendingThreadFollowId = threadId;
  }

  private handleTrackedTurnStarted(trackedTurn: CodexActiveTurn): void {
    if (this.activeTurn?.turnId === trackedTurn.turnId) {
      return;
    }

    if (
      trackedTurn.origin === "local" &&
      trackedTurn.threadId !== this.sharedThreadId
    ) {
      this.pendingThreadFollowId = trackedTurn.threadId;
    }

    if (!this.activeTurn) {
      this.setActiveTurn(trackedTurn);
      if (trackedTurn.origin === "local" && this.state.status !== "awaiting_approval") {
        this.setStatus("busy", "Codex is busy with a local terminal turn.");
      }
      return;
    }

    if (this.activeTurn.threadId !== trackedTurn.threadId) {
      this.pendingThreadFollowId = trackedTurn.threadId;
    }
  }

  private maybeMirrorLocalUserInput(
    trackedTurn: CodexActiveTurn,
    item: unknown,
  ): void {
    if (trackedTurn.origin !== "local" || this.mirroredUserInputTurnIds.has(trackedTurn.turnId)) {
      return;
    }

    const text = extractCodexUserMessageText(item);
    if (!text) {
      return;
    }

    this.mirroredUserInputTurnIds.add(trackedTurn.turnId);
    this.emit({
      type: "mirrored_user_input",
      text,
      timestamp: nowIso(),
      origin: "local",
    });
  }

  private handleTurnCompleted(
    trackedTurn: CodexActiveTurn,
    params: Record<string, unknown>,
  ): void {
    if (this.hasCompletedTurn(trackedTurn.turnId)) {
      if (this.activeTurn?.turnId === trackedTurn.turnId) {
        this.setActiveTurn(null);
      }
      this.cleanupTurnArtifacts(trackedTurn.turnId);
      return;
    }

    const turn = isRecord(params.turn) ? params.turn : null;
    const status = turn && typeof turn.status === "string" ? turn.status : "completed";
    const completedError =
      turn && isRecord(turn.error) && typeof turn.error.message === "string"
        ? turn.error.message
        : this.turnErrorById.get(trackedTurn.turnId) ?? null;
    const finalText = this.collectTurnOutput(trackedTurn.turnId);
    const completedTrackedTurn =
      this.activeTurn?.turnId === trackedTurn.turnId ? this.activeTurn : trackedTurn;
    const summary =
      status === "interrupted"
        ? "Interrupted"
        : completedTrackedTurn.origin === "local"
          ? "Local terminal turn completed."
          : this.currentPreview;

    if (
      this.pendingApprovalRequest &&
      this.pendingApprovalRequest.turnId === trackedTurn.turnId
    ) {
      this.clearPendingApprovalState();
    }
    if (this.activeTurn?.turnId === trackedTurn.turnId) {
      this.setActiveTurn(null);
    }
    this.cleanupTurnArtifacts(trackedTurn.turnId);

    if (finalText) {
      this.emit({
        type: "stdout",
        text: finalText,
        timestamp: nowIso(),
      });
    } else if (status === "failed") {
      const failureText = completedError
        ? `Codex could not complete the request: ${completedError}`
        : "Codex could not complete the request.";
      this.emit({
        type: "stdout",
        text: failureText,
        timestamp: nowIso(),
      });
    }

    if (
      this.state.status !== "stopped" &&
      (!this.activeTurn || this.activeTurn.turnId === trackedTurn.turnId)
    ) {
      const statusMessage =
        status === "interrupted" ? "Codex task interrupted." : undefined;
      this.setStatus("idle", statusMessage);
    }
    this.emit({
      type: "task_complete",
      summary,
      timestamp: nowIso(),
    });
    this.rememberCompletedTurn(trackedTurn.turnId);
  }

  private getTurnFinalMessageMap(turnId: string): Map<string, string> {
    let finalMessages = this.turnFinalMessages.get(turnId);
    if (!finalMessages) {
      finalMessages = new Map<string, string>();
      this.turnFinalMessages.set(turnId, finalMessages);
    }
    return finalMessages;
  }

  private getTurnDeltaMap(turnId: string): Map<string, string> {
    let deltaByItem = this.turnDeltaByItem.get(turnId);
    if (!deltaByItem) {
      deltaByItem = new Map<string, string>();
      this.turnDeltaByItem.set(turnId, deltaByItem);
    }
    return deltaByItem;
  }

  private collectTurnOutput(turnId: string): string | null {
    const finalMessages = Array.from(this.getTurnFinalMessageMap(turnId).values())
      .map((text) => normalizeOutput(text).trim())
      .filter(Boolean);
    if (finalMessages.length > 0) {
      return finalMessages.join("\n\n");
    }

    const deltaFallback = Array.from(this.getTurnDeltaMap(turnId).values())
      .map((text) => normalizeOutput(text).trim())
      .filter(Boolean);
    if (deltaFallback.length === 0) {
      return null;
    }

    return deltaFallback[deltaFallback.length - 1];
  }

  private async stopAppServer(): Promise<void> {
    if (!this.appServer) {
      this.appServerPort = null;
      this.appServerShuttingDown = false;
      return;
    }

    const child = this.appServer;
    this.appServerShuttingDown = true;
    this.appServer = null;
    this.appServerPort = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      child.once("exit", () => finish());
      try {
        child.kill();
      } catch {
        finish();
      }
      const timer = setTimeout(() => finish(), 1_000);
      timer.unref?.();
    });
  }

  private describeAppServerLog(): string {
    const summary = normalizeOutput(this.appServerLog).trim();
    if (!summary) {
      return "";
    }
    return ` Recent app-server log: ${truncatePreview(summary, 220)}`;
  }

  private terminateCodexClient(): void {
    this.shuttingDown = true;

    if (this.pty) {
      try {
        this.pty.kill();
      } catch {
        // Best effort cleanup after embedded client failure.
      }
      return;
    }

    if (this.nativeProcess) {
      try {
        this.nativeProcess.kill();
      } catch {
        // Best effort cleanup after panel client failure.
      }
    }
  }

  private attachLocalInputForwarding(): void {
    if (this.localInputListener || !process.stdin.readable) {
      return;
    }

    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    this.localInputListener = (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!text) {
        return;
      }
      this.writeToPty(text);
    };
    process.stdin.on("data", this.localInputListener);
  }

  private detachLocalInputForwarding(): void {
    if (!this.localInputListener) {
      return;
    }

    process.stdin.off("data", this.localInputListener);
    this.localInputListener = null;
    if (process.stdin.isTTY) {
      process.stdin.pause();
    }
  }

  private renderLocalOutput(rawText: string): void {
    try {
      process.stdout.write(rawText);
    } catch {
      // Best effort local mirroring for the visible Codex panel.
    }
  }

  private hasCompletedTurn(turnId: string): boolean {
    return this.completedTurnIds.has(turnId);
  }

  private rememberCompletedTurn(turnId: string): void {
    if (this.completedTurnIds.has(turnId)) {
      return;
    }

    this.completedTurnIds.add(turnId);
    this.completedTurnOrder.push(turnId);
    while (this.completedTurnOrder.length > CODEX_RECENT_SESSION_KEY_LIMIT) {
      const staleTurnId = this.completedTurnOrder.shift();
      if (staleTurnId) {
        this.completedTurnIds.delete(staleTurnId);
      }
    }
  }
}

class CliPtyAdapter extends AbstractPtyAdapter {
  protected buildSpawnArgs(): string[] {
    const args: string[] = [];
    if (this.options.kind === "claude") {
      args.push("--no-alt-screen");
    }
    if (this.options.profile) {
      args.push("--profile", this.options.profile);
    }
    return args;
  }
}

class ShellAdapter extends AbstractPtyAdapter {
  private pendingShellCommand: string | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;

  protected buildSpawnArgs(): string[] {
    return ["-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", "-"];
  }

  protected afterStart(): void {
    if (this.options.profile) {
      const profilePath = this.escapePowerShellString(
        path.resolve(this.options.profile),
      );
      this.writeToPty(`. "${profilePath}"\r`);
    }
  }

  override async sendInput(text: string): Promise<void> {
    if (isHighRiskShellCommand(text)) {
      this.pendingShellCommand = text;
      const request: ApprovalRequest = {
        source: "shell",
        summary: "High-risk shell command detected. Confirmation is required.",
        commandPreview: truncatePreview(text, 180),
      };
      this.pendingApproval = request;
      this.state.pendingApproval = request;
      this.setStatus("awaiting_approval", "Waiting for shell command approval.");
      this.emit({
        type: "approval_required",
        request,
        timestamp: nowIso(),
      });
      return;
    }

    await super.sendInput(text);
  }

  override async interrupt(): Promise<boolean> {
    if (!this.pty) {
      return false;
    }

    this.writeToPty("\u0003");
    if (this.interruptTimer) {
      clearTimeout(this.interruptTimer);
    }
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      if (this.state.status === "busy") {
        this.setStatus("idle", "Shell command interrupted.");
        this.emit({
          type: "task_complete",
          summary: "Interrupted",
          timestamp: nowIso(),
        });
      }
    }, 1_500);
    return true;
  }

  protected override prepareInput(text: string): string {
    const script = [
      "$__wechatBridgePreviousErrorActionPreference = $ErrorActionPreference",
      "$ErrorActionPreference = 'Continue'",
      "$global:LASTEXITCODE = 0",
      "try {",
      text,
      "} catch {",
      "  Write-Error $_",
      "  $global:LASTEXITCODE = 1",
      "} finally {",
      "  if (-not ($global:LASTEXITCODE -is [int])) { $global:LASTEXITCODE = 0 }",
      '  Write-Output "__WECHAT_BRIDGE_DONE__:$global:LASTEXITCODE"',
      "  $ErrorActionPreference = $__wechatBridgePreviousErrorActionPreference",
      "}",
      "",
    ];
    return `${script.join("\r")}\r`;
  }

  protected override defaultCompletionDelayMs(): number {
    return 15_000;
  }

  protected override async applyApproval(
    action: "confirm" | "deny",
    _pendingApproval: ApprovalRequest,
  ): Promise<boolean> {
    if (!this.pendingApproval) {
      return false;
    }

    if (action === "deny") {
      this.pendingShellCommand = null;
      this.pendingApproval = null;
      this.state.pendingApproval = null;
      this.setStatus("idle", "Shell command denied.");
      this.emit({
        type: "task_complete",
        summary: "Denied",
        timestamp: nowIso(),
      });
      return true;
    }

    const command = this.pendingShellCommand;
    if (!command) {
      return false;
    }

    this.pendingShellCommand = null;
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    await super.sendInput(command);
    return true;
  }

  protected override handleData(rawText: string): void {
    const text = normalizeOutput(rawText);
    if (!text) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    if (!this.hasAcceptedInput) {
      return;
    }

    const match = text.match(/__WECHAT_BRIDGE_DONE__:(-?\d+)/);
    const visibleText = this.filterShellOutput(
      text.replace(/__WECHAT_BRIDGE_DONE__:-?\d+/g, ""),
    );

    if (visibleText.trim()) {
      this.emit({
        type: "stdout",
        text: visibleText,
        timestamp: nowIso(),
      });
    }

    if (match) {
      this.clearCompletionTimer();
      this.setStatus("idle");
      this.emit({
        type: "task_complete",
        exitCode: Number(match[1]),
        summary: this.currentPreview,
        timestamp: nowIso(),
      });
    }
  }

  private filterShellOutput(text: string): string {
    return text
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return false;
        }
        if (trimmed.startsWith("$__wechatBridge")) {
          return false;
        }
        if (trimmed.startsWith("$ErrorActionPreference")) {
          return false;
        }
        if (trimmed === "try {" || trimmed === "} catch {" || trimmed === "}") {
          return false;
        }
        return true;
      })
      .join("\n");
  }

  private escapePowerShellString(text: string): string {
    return text.replace(/`/g, "``").replace(/"/g, '`"');
  }
}

export function createBridgeAdapter(options: AdapterOptions): BridgeAdapter {
  switch (options.kind) {
    case "codex":
      return options.renderMode === "panel"
        ? new CodexPtyAdapter(options)
        : new CodexPanelProxyAdapter(options);
    case "claude":
      return new CliPtyAdapter(options);
    case "shell":
      return new ShellAdapter(options);
    default:
      throw new Error(`Unsupported adapter: ${options.kind}`);
  }
}
