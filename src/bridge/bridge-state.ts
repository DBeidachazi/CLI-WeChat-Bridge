import fs from "node:fs";

import {
  BRIDGE_LOCK_FILE,
  BRIDGE_LOG_FILE,
  BRIDGE_STATE_FILE,
  ensureWorkspaceChannelDir,
  ensureChannelDataDir,
} from "../wechat/channel-config.ts";
import type {
  BridgeAdapterKind,
  BridgeLifecycleMode,
  BridgeState,
  PendingApproval,
} from "./bridge-types.ts";
import { buildInstanceId } from "./bridge-utils.ts";

type BridgeStateOptions = {
  adapter: BridgeAdapterKind;
  command: string;
  cwd: string;
  profile?: string;
  lifecycle: BridgeLifecycleMode;
  authorizedUserId: string;
};

export type BridgeLockPayload = {
  pid: number;
  parentPid: number;
  instanceId: string;
  adapter: BridgeAdapterKind;
  command: string;
  cwd: string;
  startedAt: string;
  lifecycle: BridgeLifecycleMode;
  legacyLifecycleFallback?: true;
};

const ORPHAN_LOCK_RECLAIM_TIMEOUT_MS = 2_000;
const ORPHAN_LOCK_RECLAIM_POLL_MS = 100;

function cloneState(state: BridgeState): BridgeState {
  return JSON.parse(JSON.stringify(state)) as BridgeState;
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

function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }

  // Rare startup-only reclaim path; blocking briefly here keeps the lock flow simple.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForProcessExitSync(
  pid: number,
  timeoutMs: number,
  isProcessAlive: (pid: number) => boolean = isPidAlive,
): boolean {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    sleepSync(Math.min(ORPHAN_LOCK_RECLAIM_POLL_MS, deadline - Date.now()));
  }

  return !isProcessAlive(pid);
}

export function normalizeBridgeLockPayload(value: unknown): BridgeLockPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.pid !== "number" ||
    typeof record.instanceId !== "string" ||
    typeof record.adapter !== "string" ||
    typeof record.command !== "string" ||
    typeof record.cwd !== "string" ||
    typeof record.startedAt !== "string"
  ) {
    return null;
  }

  const adapter =
    record.adapter === "codex" || record.adapter === "claude" || record.adapter === "shell"
      ? record.adapter
      : null;
  if (!adapter) {
    return null;
  }

  const hasExplicitLifecycle =
    record.lifecycle === "persistent" || record.lifecycle === "companion_bound";

  return {
    pid: record.pid,
    parentPid: typeof record.parentPid === "number" ? record.parentPid : 0,
    instanceId: record.instanceId,
    adapter,
    command: record.command,
    cwd: record.cwd,
    startedAt: record.startedAt,
    lifecycle: record.lifecycle === "companion_bound" ? "companion_bound" : "persistent",
    legacyLifecycleFallback: hasExplicitLifecycle ? undefined : true,
  };
}

export function readBridgeLockFile(): BridgeLockPayload | null {
  try {
    if (!fs.existsSync(BRIDGE_LOCK_FILE)) {
      return null;
    }
    return normalizeBridgeLockPayload(JSON.parse(fs.readFileSync(BRIDGE_LOCK_FILE, "utf-8")));
  } catch {
    return null;
  }
}

export function shouldAutoReclaimBridgeLock(
  lock: BridgeLockPayload,
  isProcessAlive: (pid: number) => boolean = isPidAlive,
): boolean {
  return (
    (lock.lifecycle === "companion_bound" ||
      (lock.legacyLifecycleFallback === true && lock.adapter === "codex")) &&
    lock.parentPid > 1 &&
    !isProcessAlive(lock.parentPid)
  );
}

function buildLockConflictError(lock: BridgeLockPayload): Error {
  return new Error(
    `Another bridge instance is already running (pid=${lock.pid}, instanceId=${lock.instanceId}, adapter=${lock.adapter}, cwd=${lock.cwd}, startedAt=${lock.startedAt}, lifecycle=${lock.lifecycle}). Stop it before starting a new bridge.`,
  );
}

function tryTerminateOrphanedBridge(lock: BridgeLockPayload): boolean {
  try {
    process.kill(lock.pid);
  } catch {
    if (isPidAlive(lock.pid)) {
      return false;
    }
  }

  return waitForProcessExitSync(lock.pid, ORPHAN_LOCK_RECLAIM_TIMEOUT_MS);
}

export class BridgeStateStore {
  private state: BridgeState;
  private readonly lockPayload: BridgeLockPayload;
  private readonly bridgeStartedAtMs: number;
  private readonly instanceId: string;
  private readonly stateFilePath: string;

  constructor(options: BridgeStateOptions) {
    ensureChannelDataDir();
    this.stateFilePath = ensureWorkspaceChannelDir(options.cwd).stateFile;
    this.bridgeStartedAtMs = Date.now();
    this.instanceId = buildInstanceId();
    this.lockPayload = {
      pid: process.pid,
      parentPid: process.ppid,
      instanceId: this.instanceId,
      adapter: options.adapter,
      command: options.command,
      cwd: options.cwd,
      startedAt: new Date(this.bridgeStartedAtMs).toISOString(),
      lifecycle: options.lifecycle,
    };

    this.acquireLock();

    const persisted = this.readStateFile();
    const persistedSharedSessionId =
      persisted?.cwd === options.cwd
        ? persisted.sharedSessionId ?? persisted.sharedThreadId
        : undefined;
    const persistedResumeConversationId =
      options.adapter === "claude" &&
      persisted?.cwd === options.cwd &&
      typeof persisted.resumeConversationId === "string"
        ? persisted.resumeConversationId
        : undefined;
    const persistedTranscriptPath =
      options.adapter === "claude" &&
      persisted?.cwd === options.cwd &&
      typeof persisted.transcriptPath === "string"
        ? persisted.transcriptPath
        : undefined;
    this.state = {
      instanceId: this.instanceId,
      adapter: options.adapter,
      command: options.command,
      cwd: options.cwd,
      profile: options.profile,
      authorizedUserId: options.authorizedUserId,
      bridgeStartedAtMs: this.bridgeStartedAtMs,
      ignoredBacklogCount: 0,
      sharedSessionId: persistedSharedSessionId,
      sharedThreadId:
        options.adapter === "codex" ? persistedSharedSessionId : undefined,
      resumeConversationId: persistedResumeConversationId,
      transcriptPath: persistedTranscriptPath,
      lastActivityAt: persisted?.lastActivityAt,
      pendingConfirmation: null,
    };

    this.save();

    if (persisted?.pendingConfirmation) {
      this.appendLog("Cleared stale pending confirmation from previous bridge session.");
    }
  }

  getState(): BridgeState {
    return cloneState(this.state);
  }

  touchActivity(timestamp = new Date().toISOString()): void {
    this.state.lastActivityAt = timestamp;
    this.save();
  }

  setPendingConfirmation(pending: PendingApproval): void {
    this.state.pendingConfirmation = pending;
    this.save();
  }

  clearPendingConfirmation(): void {
    if (!this.state.pendingConfirmation) {
      return;
    }
    this.state.pendingConfirmation = null;
    this.save();
  }

  incrementIgnoredBacklog(count = 1): void {
    this.state.ignoredBacklogCount += count;
    this.save();
  }

  setSharedSessionId(sessionId: string): void {
    this.state.sharedSessionId = sessionId;
    this.state.sharedThreadId = this.state.adapter === "codex" ? sessionId : undefined;
    this.save();
  }

  setSharedThreadId(threadId: string): void {
    this.setSharedSessionId(threadId);
  }

  clearSharedSessionId(): void {
    if (!this.state.sharedSessionId && !this.state.sharedThreadId) {
      return;
    }
    this.state.sharedSessionId = undefined;
    this.state.sharedThreadId = undefined;
    this.save();
  }

  clearSharedThreadId(): void {
    this.clearSharedSessionId();
  }

  setClaudeResumeState(resumeConversationId?: string, transcriptPath?: string): void {
    if (this.state.adapter !== "claude") {
      return;
    }

    this.state.resumeConversationId = resumeConversationId || undefined;
    this.state.transcriptPath = transcriptPath || undefined;
    this.save();
  }

  clearClaudeResumeState(): void {
    if (
      this.state.adapter !== "claude" ||
      (!this.state.resumeConversationId && !this.state.transcriptPath)
    ) {
      return;
    }

    this.state.resumeConversationId = undefined;
    this.state.transcriptPath = undefined;
    this.save();
  }

  appendLog(message: string): void {
    ensureChannelDataDir();
    fs.appendFileSync(
      BRIDGE_LOG_FILE,
      `[${new Date().toISOString()}] ${message}\n`,
      "utf-8",
    );
  }

  releaseLock(): void {
    try {
      const currentLock = readBridgeLockFile();
      if (currentLock?.pid === process.pid) {
        fs.rmSync(BRIDGE_LOCK_FILE, { force: true });
      }
    } catch {
      // Best effort cleanup.
    }
  }

  private save(): void {
    ensureChannelDataDir();
    fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), "utf-8");
  }

  private acquireLock(): void {
    const existing = readBridgeLockFile();
    if (
      existing &&
      existing.pid !== process.pid &&
      isPidAlive(existing.pid)
    ) {
      if (shouldAutoReclaimBridgeLock(existing)) {
        this.appendLog(
          `lock_reclaim_attempt: pid=${existing.pid} instanceId=${existing.instanceId} adapter=${existing.adapter} cwd=${existing.cwd}`,
        );

        if (tryTerminateOrphanedBridge(existing)) {
          this.appendLog(
            `lock_reclaimed: pid=${existing.pid} instanceId=${existing.instanceId} adapter=${existing.adapter} cwd=${existing.cwd}`,
          );
        } else {
          this.appendLog(
            `lock_reclaim_failed: pid=${existing.pid} instanceId=${existing.instanceId} adapter=${existing.adapter} cwd=${existing.cwd}`,
          );
          throw buildLockConflictError(existing);
        }
      } else {
        this.appendLog(
          `lock_conflict: pid=${existing.pid} instanceId=${existing.instanceId} adapter=${existing.adapter} cwd=${existing.cwd}`,
        );
        throw buildLockConflictError(existing);
      }
    }

    fs.writeFileSync(
      BRIDGE_LOCK_FILE,
      JSON.stringify(this.lockPayload, null, 2),
      "utf-8",
    );
  }

  private readStateFile(): Partial<BridgeState> | null {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        return JSON.parse(
          fs.readFileSync(this.stateFilePath, "utf-8"),
        ) as Partial<BridgeState>;
      }

      if (!fs.existsSync(BRIDGE_STATE_FILE)) {
        return null;
      }

      return JSON.parse(
        fs.readFileSync(BRIDGE_STATE_FILE, "utf-8"),
      ) as Partial<BridgeState>;
    } catch {
      return null;
    }
  }
}
