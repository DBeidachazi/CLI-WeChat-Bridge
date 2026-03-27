#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  BRIDGE_LOG_FILE,
  CREDENTIALS_FILE,
  migrateLegacyChannelFiles,
} from "../wechat/channel-config.ts";
import {
  readBridgeLockFile,
  shouldAutoReclaimBridgeLock,
  type BridgeLockPayload,
} from "../bridge/bridge-state.ts";
import {
  clearLocalCompanionEndpoint,
  readLocalCompanionEndpoint,
  type LocalCompanionEndpoint,
} from "./local-companion-link.ts";

type LocalCompanionStartCliOptions = {
  cwd: string;
  profile?: string;
  timeoutMs: number;
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

function log(message: string): void {
  process.stderr.write(`[codex-start] ${message}\n`);
}

export function normalizeComparablePath(cwd: string): string {
  const normalized = path.resolve(cwd);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isSameWorkspaceCwd(left: string, right: string): boolean {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

export function parseCliArgs(argv: string[]): LocalCompanionStartCliOptions {
  let cwd = process.cwd();
  let profile: string | undefined;
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: wechat-codex-start [--cwd <path>] [--profile <name-or-path>] [--timeout-ms <ms>]",
          "",
          "Starts or reuses a transient Codex bridge for the current directory, waits for the local companion endpoint, then opens the visible Codex companion.",
          "Closing the visible Codex companion also stops that transient bridge.",
          "",
        ].join("\n"),
      );
      process.exit(0);
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

  return { cwd, profile, timeoutMs };
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

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !isPidAlive(pid);
}

async function stopExistingBridge(lock: BridgeLockPayload): Promise<void> {
  const { pid, cwd } = lock;
  log(`Stopping existing bridge for ${cwd} (pid=${pid})...`);

  try {
    process.kill(pid);
  } catch (error) {
    if (isPidAlive(pid)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to stop existing bridge pid=${pid}: ${message}`);
    }
  }

  if (!(await waitForProcessExit(pid, 10_000))) {
    throw new Error(`Timed out waiting for existing bridge pid=${pid} to exit.`);
  }

  clearLocalCompanionEndpoint(cwd);
  log(`Cleared stale local companion endpoint for previous workspace ${cwd}.`);
}

async function isEndpointReachable(endpoint: LocalCompanionEndpoint): Promise<boolean> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({
      host: "127.0.0.1",
      port: endpoint.port,
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

async function readUsableEndpoint(cwd: string): Promise<LocalCompanionEndpoint | null> {
  const endpoint = readLocalCompanionEndpoint(cwd);
  if (!endpoint || endpoint.kind !== "codex") {
    return null;
  }

  if (await isEndpointReachable(endpoint)) {
    return endpoint;
  }

  clearLocalCompanionEndpoint(cwd);
  log(`Removed stale local companion endpoint for ${cwd}.`);
  return null;
}

export function buildBackgroundBridgeArgs(
  entryPath: string,
  options: LocalCompanionStartCliOptions,
): string[] {
  const args = [
    "--no-warnings",
    "--experimental-strip-types",
    entryPath,
    "--adapter",
    "codex",
    "--cwd",
    options.cwd,
    "--lifecycle",
    "companion_bound",
  ];

  if (options.profile) {
    args.push("--profile", options.profile);
  }

  return args;
}

function startBridgeInBackground(options: LocalCompanionStartCliOptions): void {
  const entryPath = path.resolve(MODULE_DIR, "..", "bridge", "wechat-bridge.ts");
  const args = buildBackgroundBridgeArgs(entryPath, options);

  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  child.unref();
}

async function waitForEndpoint(
  cwd: string,
  timeoutMs: number,
): Promise<LocalCompanionEndpoint> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const endpoint = await readUsableEndpoint(cwd);
    if (endpoint) {
      return endpoint;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for the Codex bridge endpoint for ${cwd}. Check ${BRIDGE_LOG_FILE}.`,
  );
}

async function ensureBridgeReady(options: LocalCompanionStartCliOptions): Promise<void> {
  const lock = readBridgeLockFile();
  if (lock && isPidAlive(lock.pid)) {
    if (shouldAutoReclaimBridgeLock(lock)) {
      await stopExistingBridge(lock);
      log(`Starting replacement bridge in background for ${options.cwd}...`);
      startBridgeInBackground(options);
      await waitForEndpoint(options.cwd, options.timeoutMs);
      return;
    }

    if (!isSameWorkspaceCwd(lock.cwd, options.cwd)) {
      await stopExistingBridge(lock);
      log(`Starting replacement bridge in background for ${options.cwd}...`);
      startBridgeInBackground(options);
      await waitForEndpoint(options.cwd, options.timeoutMs);
      return;
    }

    log(`Found running bridge for ${options.cwd}. Waiting for endpoint...`);
    await waitForEndpoint(options.cwd, options.timeoutMs);
    return;
  }

  const existingEndpoint = await readUsableEndpoint(options.cwd);
  if (existingEndpoint) {
    log(`Reusing running bridge for ${options.cwd}.`);
    return;
  }

  log(`Starting bridge in background for ${options.cwd}...`);
  startBridgeInBackground(options);
  await waitForEndpoint(options.cwd, options.timeoutMs);
}

async function runCompanion(options: LocalCompanionStartCliOptions): Promise<number> {
  const entryPath = path.resolve(MODULE_DIR, "local-companion.ts");
  const args = [
    "--no-warnings",
    "--experimental-strip-types",
    entryPath,
    "--adapter",
    "codex",
    "--cwd",
    options.cwd,
  ];

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

async function main(): Promise<void> {
  migrateLegacyChannelFiles(log);
  const options = parseCliArgs(process.argv.slice(2));

  if (!fs.existsSync(CREDENTIALS_FILE)) {
    throw new Error(`Missing WeChat credentials. Run "bun run setup" first. (${CREDENTIALS_FILE})`);
  }

  await ensureBridgeReady(options);
  const exitCode = await runCompanion(options);
  process.exit(exitCode);
}

const isDirectRun = Boolean((import.meta as ImportMeta & { main?: boolean }).main);
if (isDirectRun) {
  main().catch((error) => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
