import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import { ensureWorkspaceChannelDir } from "../wechat/channel-config.ts";
import {
  getConfiguredAcpMode,
  getConfiguredModelId,
  shouldAutoApproveAcpPermissions,
  type AcpBridgeAdapterKind,
} from "../config/bridge-config.ts";
import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeAdapterInput,
  BridgeAdapterState,
  BridgeEvent,
  BridgeResumeSessionCandidate,
} from "./bridge-types.ts";
import {
  buildCliEnvironment,
  describeUnknownError,
  isRecord,
  resolveSpawnTarget,
} from "./bridge-adapters.shared.ts";
import {
  buildAcpPromptContent,
  type AcpPromptCapabilities,
} from "./bridge-acp-prompt.ts";
import {
  normalizeOutput,
  nowIso,
  truncatePreview,
} from "./bridge-utils.ts";

type AcpSessionRecord = {
  sessionId: string;
  title: string;
  updatedAt: string;
};

type ManagedTerminal = {
  id: string;
  process: ChildProcessWithoutNullStreams;
  output: string;
  outputByteLimit: number;
  exitStatus?: {
    exitCode?: number | null;
    signal?: string | null;
  };
  waitForExit: Promise<acp.WaitForTerminalExitResponse>;
  resolveWaitForExit: (value: acp.WaitForTerminalExitResponse) => void;
};

type PendingPermissionRequest = {
  request: ApprovalRequest;
  params: acp.RequestPermissionRequest;
  resolve: (response: acp.RequestPermissionResponse) => void;
};

const DEFAULT_TERMINAL_OUTPUT_LIMIT = 128 * 1024;

function buildSessionCachePath(kind: AcpBridgeAdapterKind, cwd: string): string {
  return path.join(ensureWorkspaceChannelDir(cwd).workspaceDir, `${kind}-acp-sessions.json`);
}

function readSessionCache(cachePath: string): AcpSessionRecord[] {
  try {
    if (!fs.existsSync(cachePath)) {
      return [];
    }

    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((entry): entry is AcpSessionRecord => {
        return (
          isRecord(entry) &&
          typeof entry.sessionId === "string" &&
          typeof entry.title === "string" &&
          typeof entry.updatedAt === "string"
        );
      })
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  } catch {
    return [];
  }
}

function writeSessionCache(cachePath: string, sessions: AcpSessionRecord[]): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(sessions, null, 2), "utf8");
}

function appendBoundedOutput(current: string, chunk: string, byteLimit: number): string {
  const next = `${current}${chunk}`;
  if (Buffer.byteLength(next, "utf8") <= byteLimit) {
    return next;
  }

  let trimmed = next;
  while (trimmed.length > 0 && Buffer.byteLength(trimmed, "utf8") > byteLimit) {
    trimmed = trimmed.slice(Math.max(1, Math.floor(trimmed.length / 16)));
  }
  return trimmed;
}

function pickPermissionOption(
  options: acp.PermissionOption[],
  prefixes: acp.PermissionOptionKind[],
): acp.PermissionOption | null {
  for (const prefix of prefixes) {
    const matched = options.find((option) => option.kind === prefix);
    if (matched) {
      return matched;
    }
  }

  return options[0] ?? null;
}

function buildPermissionRequest(kind: AcpBridgeAdapterKind, params: acp.RequestPermissionRequest): ApprovalRequest {
  const toolCall = params.toolCall;
  const commandPreview = [
    toolCall.title ?? `${kind} tool call`,
    Array.isArray(toolCall.locations) && toolCall.locations.length > 0
      ? toolCall.locations
          .map((location) => `${location.path}${location.line ? `:${location.line}` : ""}`)
          .join(", ")
      : "",
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    source: "cli",
    summary: `${kind} needs permission before continuing a tool call.`,
    commandPreview: truncatePreview(commandPreview || `${kind} ACP tool call`, 180),
    toolName: typeof toolCall.kind === "string" ? toolCall.kind : undefined,
    detailLabel: "Raw input",
    detailPreview:
      toolCall.rawInput === undefined ? undefined : truncatePreview(JSON.stringify(toolCall.rawInput), 300),
  };
}

function readAgentPromptCapabilities(
  initializeResponse: unknown,
): AcpPromptCapabilities {
  if (!isRecord(initializeResponse)) {
    return { image: false, audio: false };
  }

  const agentCapabilities = isRecord(initializeResponse.agentCapabilities)
    ? initializeResponse.agentCapabilities
    : null;
  const promptCapabilities =
    agentCapabilities && isRecord(agentCapabilities.promptCapabilities)
      ? agentCapabilities.promptCapabilities
      : null;

  return {
    image: promptCapabilities?.image === true,
    audio: promptCapabilities?.audio === true,
  };
}

function shouldResetSessionAfterTaskFailure(
  kind: AcpBridgeAdapterKind,
  errorMessage: string,
): boolean {
  if (kind !== "gemini") {
    return false;
  }

  return /provided image is not valid/i.test(errorMessage);
}

export class AcpCliAdapter implements BridgeAdapter {
  private readonly options: {
    kind: AcpBridgeAdapterKind;
    command: string;
    cwd: string;
    profile?: string;
    initialSharedSessionId?: string;
  };
  private readonly state: BridgeAdapterState;
  private readonly sessionCachePath: string;
  private eventSink: (event: BridgeEvent) => void = () => undefined;
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private currentSessionId: string | null = null;
  private currentAssistantText = "";
  private currentPromptPromise: Promise<void> | null = null;
  private pendingPermission: PendingPermissionRequest | null = null;
  private readonly terminals = new Map<string, ManagedTerminal>();
  private promptCapabilities: AcpPromptCapabilities = {
    image: false,
    audio: false,
  };
  private shuttingDown = false;

  constructor(options: {
    kind: AcpBridgeAdapterKind;
    command: string;
    cwd: string;
    profile?: string;
    initialSharedSessionId?: string;
  }) {
    this.options = options;
    this.state = {
      kind: options.kind,
      status: "stopped",
      cwd: options.cwd,
      command: options.command,
      profile: options.profile,
    };
    this.sessionCachePath = buildSessionCachePath(options.kind, options.cwd);
  }

  setEventSink(sink: (event: BridgeEvent) => void): void {
    this.eventSink = sink;
  }

  async start(): Promise<void> {
    if (this.child && this.connection) {
      return;
    }

    this.shuttingDown = false;
    this.setStatus("starting", `Starting ${this.options.kind} ACP adapter...`);

    const spawnTarget = resolveSpawnTarget(this.options.command, this.options.kind);
    const env = buildCliEnvironment(this.options.kind);
    const child = spawn(spawnTarget.file, spawnTarget.args, {
      cwd: this.options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error(`${this.options.kind} ACP process did not expose stdio pipes.`);
    }

    this.child = child;
    this.state.pid = child.pid ?? undefined;
    this.state.startedAt = nowIso();
    child.stderr.on("data", (chunk) => this.handleChildStderr(chunk));
    child.once("exit", (code, signal) => {
      this.handleProcessExit(code, signal);
    });

    try {
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout),
      );
      this.connection = new acp.ClientSideConnection(() => this.buildClient(), stream);
      const initializeResponse = await this.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: {
          name: "cli-wechat-bridge",
          title: "CLI WeChat Bridge",
          version: "0.9.0",
        },
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
      });
      this.promptCapabilities = readAgentPromptCapabilities(initializeResponse as unknown);

      if (this.options.initialSharedSessionId) {
        await this.restoreSession(this.options.initialSharedSessionId, true);
      } else {
        await this.createSession();
      }

      this.setStatus("idle", `${this.options.kind} ACP adapter is ready.`);
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async sendInput(input: BridgeAdapterInput): Promise<void> {
    if (!this.connection) {
      throw new Error(`${this.options.kind} ACP adapter is not running.`);
    }
    if (!this.currentSessionId) {
      await this.createSession();
    }
    if (!this.currentSessionId) {
      throw new Error(`${this.options.kind} session is not available.`);
    }
    if (this.currentPromptPromise) {
      throw new Error(`${this.options.kind} is still working. Wait for the current reply or use /stop.`);
    }
    if (this.pendingPermission) {
      throw new Error(`${this.options.kind} is waiting for a permission decision.`);
    }

    const sessionId = this.currentSessionId;
    const normalizedInput = typeof input === "string" ? { text: input } : input;
    const text = normalizedInput.text;
    this.state.lastInputAt = nowIso();
    this.currentAssistantText = "";
    this.setStatus("busy");

    this.currentPromptPromise = (async () => {
      try {
        const response = await this.connection!.prompt({
          sessionId,
          prompt: buildAcpPromptContent(normalizedInput, this.promptCapabilities) as acp.ContentBlock[],
        });

        const finalText = normalizeOutput(this.currentAssistantText).trim();
        if (finalText) {
          this.emit({
            type: "final_reply",
            text: finalText,
            timestamp: nowIso(),
          });
        }

        this.rememberSession({
          sessionId,
          title: truncatePreview(finalText || text, 120),
        });
        this.setStatus("idle");
        this.emit({
          type: "task_complete",
          summary: truncatePreview(text, 120),
          timestamp: nowIso(),
        });
        if (response.stopReason === "cancelled") {
          this.emit({
            type: "notice",
            level: "warning",
            text: `${this.options.kind} cancelled the active turn.`,
            timestamp: nowIso(),
          });
        }
      } catch (error) {
        if (this.shuttingDown) {
          return;
        }

        const errorMessage = describeUnknownError(error);
        let sessionResetSuffix = "";
        if (shouldResetSessionAfterTaskFailure(this.options.kind, errorMessage)) {
          try {
            await this.createSession(true);
            sessionResetSuffix =
              "\nThe Gemini session was reset after the invalid image error. Use /reset or /new if you want to clear the conversation explicitly.";
            this.setStatus("idle");
          } catch (resetError) {
            sessionResetSuffix = `\nAutomatic Gemini session reset also failed: ${describeUnknownError(resetError)}`;
            this.setStatus("error");
          }
        } else {
          this.setStatus("error");
        }

        this.emit({
          type: "task_failed",
          message: `${errorMessage}${sessionResetSuffix}`,
          timestamp: nowIso(),
        });
      } finally {
        this.currentPromptPromise = null;
        if (this.state.status !== "error") {
          this.setStatus("idle");
        }
      }
    })();
  }

  async listResumeSessions(limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    const remote = await this.listRemoteSessions();
    const merged = new Map<string, AcpSessionRecord>();
    for (const session of readSessionCache(this.sessionCachePath)) {
      merged.set(session.sessionId, session);
    }
    for (const session of remote) {
      const previous = merged.get(session.sessionId);
      if (!previous || Date.parse(session.updatedAt) > Date.parse(previous.updatedAt)) {
        merged.set(session.sessionId, session);
      }
    }

    return Array.from(merged.values())
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, Math.max(1, limit))
      .map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        lastUpdatedAt: session.updatedAt,
      }));
  }

  async resumeSession(sessionId: string): Promise<void> {
    if (this.currentPromptPromise) {
      throw new Error(`${this.options.kind} is still working. Wait for the current reply or use /stop.`);
    }

    await this.restoreSession(sessionId, false);
  }

  async interrupt(): Promise<boolean> {
    if (!this.connection || !this.currentSessionId) {
      return false;
    }

    if (this.pendingPermission) {
      this.pendingPermission.resolve({
        outcome: {
          outcome: "cancelled",
        },
      });
      this.pendingPermission = null;
      this.state.pendingApproval = null;
      this.setStatus("busy");
      return true;
    }

    if (!this.currentPromptPromise) {
      return false;
    }

    await this.connection.cancel({
      sessionId: this.currentSessionId,
    });
    return true;
  }

  async reset(): Promise<void> {
    if (this.currentPromptPromise) {
      await this.interrupt();
    }

    await this.createSession(true);
  }

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    if (!this.pendingPermission) {
      return false;
    }

    const option = pickPermissionOption(
      this.pendingPermission.params.options,
      action === "confirm"
        ? ["allow_always", "allow_once"]
        : ["reject_always", "reject_once"],
    );
    if (!option) {
      this.pendingPermission.resolve({
        outcome: {
          outcome: "cancelled",
        },
      });
    } else {
      this.pendingPermission.resolve({
        outcome: {
          outcome: "selected",
          optionId: option.optionId,
        },
      });
    }

    this.pendingPermission = null;
    this.state.pendingApproval = null;
    this.setStatus("busy");
    return true;
  }

  async dispose(): Promise<void> {
    this.shuttingDown = true;
    if (this.pendingPermission) {
      this.pendingPermission.resolve({
        outcome: {
          outcome: "cancelled",
        },
      });
      this.pendingPermission = null;
    }

    for (const terminal of this.terminals.values()) {
      try {
        terminal.process.kill();
      } catch {
        // Best effort cleanup.
      }
    }
    this.terminals.clear();

    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // Best effort cleanup.
      }
    }

    this.child = null;
    this.connection = null;
    this.currentPromptPromise = null;
    this.state.status = "stopped";
    this.state.pid = undefined;
    this.state.pendingApproval = null;
  }

  getState(): BridgeAdapterState {
    return JSON.parse(JSON.stringify(this.state)) as BridgeAdapterState;
  }

  private buildClient(): acp.Client {
    return {
      requestPermission: async (params) => {
        return await this.handlePermissionRequest(params);
      },
      sessionUpdate: async (params) => {
        await this.handleSessionUpdate(params);
      },
      readTextFile: async (params) => {
        const content = await fsPromises.readFile(params.path, "utf8");
        const lines = content.split("\n");
        const startIndex = Math.max(0, (params.line ?? 1) - 1);
        const limited =
          typeof params.limit === "number" && params.limit > 0
            ? lines.slice(startIndex, startIndex + params.limit)
            : lines.slice(startIndex);
        return {
          content: limited.join("\n"),
        };
      },
      writeTextFile: async (params) => {
        await fsPromises.mkdir(path.dirname(params.path), { recursive: true });
        await fsPromises.writeFile(params.path, params.content, "utf8");
        return {};
      },
      createTerminal: async (params) => {
        return await this.createTerminal(params);
      },
      terminalOutput: async (params) => {
        const terminal = this.terminals.get(params.terminalId);
        if (!terminal) {
          throw new Error(`Unknown terminal: ${params.terminalId}`);
        }
        return {
          output: terminal.output,
          truncated: Buffer.byteLength(terminal.output, "utf8") >= terminal.outputByteLimit,
          exitStatus: terminal.exitStatus,
        };
      },
      waitForTerminalExit: async (params) => {
        const terminal = this.terminals.get(params.terminalId);
        if (!terminal) {
          throw new Error(`Unknown terminal: ${params.terminalId}`);
        }
        return await terminal.waitForExit;
      },
      releaseTerminal: async (params) => {
        const terminal = this.terminals.get(params.terminalId);
        if (!terminal) {
          return {};
        }
        try {
          terminal.process.kill();
        } catch {
          // Ignore already-exited terminals.
        }
        this.terminals.delete(params.terminalId);
        return {};
      },
      killTerminal: async (params) => {
        const terminal = this.terminals.get(params.terminalId);
        if (!terminal) {
          return {};
        }
        try {
          terminal.process.kill();
        } catch {
          // Ignore already-exited terminals.
        }
        return {};
      },
    };
  }

  private async handlePermissionRequest(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const allowOption = pickPermissionOption(params.options, ["allow_always", "allow_once"]);
    if (!allowOption) {
      return {
        outcome: {
          outcome: "cancelled",
        },
      };
    }

    if (shouldAutoApproveAcpPermissions()) {
      return {
        outcome: {
          outcome: "selected",
          optionId: allowOption.optionId,
        },
      };
    }

    return await new Promise<acp.RequestPermissionResponse>((resolve) => {
      const request = buildPermissionRequest(this.options.kind, params);
      this.pendingPermission = {
        request,
        params,
        resolve,
      };
      this.state.pendingApproval = request;
      this.setStatus("awaiting_approval");
      this.emit({
        type: "approval_required",
        request,
        timestamp: nowIso(),
      });
    });
  }

  private async handleSessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.state.lastOutputAt = nowIso();

    const update = params.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          this.currentAssistantText += update.content.text;
        }
        break;
      case "tool_call":
        this.emitNotice(`${this.options.kind} tool: ${update.title}${update.status ? ` (${update.status})` : ""}`);
        break;
      case "tool_call_update":
        this.emitNotice(
          `${this.options.kind} tool update: ${update.title ?? update.toolCallId}${update.status ? ` (${update.status})` : ""}`,
        );
        break;
      case "plan":
        this.emitNotice(
          update.entries
            .map((entry) => `${entry.status}: ${entry.content}`)
            .join("\n"),
        );
        break;
      case "session_info_update":
        if (typeof update.title === "string" && params.sessionId) {
          this.rememberSession({
            sessionId: params.sessionId,
            title: update.title,
          });
        }
        break;
      case "current_mode_update":
        this.emitNotice(`${this.options.kind} mode switched to ${update.currentModeId}.`);
        break;
      default:
        break;
    }
  }

  private handleChildStderr(chunk: string | Buffer): void {
    const text = normalizeOutput(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    if (!text) {
      return;
    }

    this.emit({
      type: "stderr",
      text,
      timestamp: nowIso(),
    });
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    const shuttingDown = this.shuttingDown;
    this.child = null;
    this.connection = null;
    this.state.pid = undefined;
    this.state.pendingApproval = null;
    this.currentPromptPromise = null;
    this.pendingPermission = null;

    if (shuttingDown) {
      this.setStatus("stopped", `${this.options.kind} ACP adapter stopped.`);
      return;
    }

    const label =
      typeof code === "number"
        ? `code ${code}`
        : signal
          ? `signal ${signal}`
          : "an unknown reason";
    this.setStatus("error");
    this.emit({
      type: "fatal_error",
      message: `${this.options.kind} ACP process exited unexpectedly with ${label}.`,
      timestamp: nowIso(),
    });
  }

  private async createSession(notify = false): Promise<void> {
    if (!this.connection) {
      throw new Error(`${this.options.kind} ACP connection is not ready.`);
    }

    const response = await this.connection.newSession({
      cwd: this.options.cwd,
      mcpServers: [],
    });
    this.currentSessionId = response.sessionId;
    this.state.sharedSessionId = response.sessionId;
    this.state.activeRuntimeSessionId = response.sessionId;
    this.rememberSession({
      sessionId: response.sessionId,
      title: response.sessionId,
    });
    await this.applySessionPreferences(response.sessionId);

    if (notify) {
      this.emit({
        type: "session_switched",
        sessionId: response.sessionId,
        source: "wechat",
        reason: "wechat_resume",
        timestamp: nowIso(),
      });
    }
  }

  private async restoreSession(sessionId: string, startup: boolean): Promise<void> {
    if (!this.connection) {
      throw new Error(`${this.options.kind} ACP connection is not ready.`);
    }

    const trimmed = sessionId.trim();
    if (!trimmed) {
      throw new Error("A session id is required to resume.");
    }

    try {
      await this.connection.unstable_resumeSession({
        sessionId: trimmed,
        cwd: this.options.cwd,
        mcpServers: [],
      });
    } catch {
      await this.connection.loadSession({
        sessionId: trimmed,
        cwd: this.options.cwd,
        mcpServers: [],
      });
    }

    this.currentSessionId = trimmed;
    this.state.sharedSessionId = trimmed;
    this.state.activeRuntimeSessionId = trimmed;
    this.rememberSession({
      sessionId: trimmed,
      title: trimmed,
    });

    this.emit({
      type: "session_switched",
      sessionId: trimmed,
      source: startup ? "restore" : "wechat",
      reason: startup ? "startup_restore" : "wechat_resume",
      timestamp: nowIso(),
    });
    await this.applySessionPreferences(trimmed);
  }

  private async applySessionPreferences(sessionId: string): Promise<void> {
    if (!this.connection) {
      return;
    }

    const desiredMode = getConfiguredAcpMode(this.options.kind);
    if (desiredMode) {
      try {
        await this.connection.setSessionMode({
          sessionId,
          modeId: desiredMode,
        });
      } catch {
        try {
          await this.connection.setSessionConfigOption({
            sessionId,
            configId: "mode",
            value: desiredMode,
          });
        } catch {
          // Ignore unsupported mode configuration.
        }
      }
    }

    const desiredModel = getConfiguredModelId(this.options.kind);
    if (desiredModel) {
      try {
        await this.connection.unstable_setSessionModel({
          sessionId,
          modelId: desiredModel,
        });
      } catch {
        try {
          await this.connection.setSessionConfigOption({
            sessionId,
            configId: "model",
            value: desiredModel,
          });
        } catch {
          // Ignore unsupported model configuration.
        }
      }
    }
  }

  private async listRemoteSessions(): Promise<AcpSessionRecord[]> {
    if (!this.connection) {
      return [];
    }

    try {
      const response = await this.connection.listSessions({
        cwd: this.options.cwd,
      });
      return response.sessions.map((session) => ({
        sessionId: session.sessionId,
        title: session.title ?? session.sessionId,
        updatedAt: session.updatedAt ?? nowIso(),
      }));
    } catch {
      return [];
    }
  }

  private rememberSession(params: {
    sessionId: string;
    title: string;
  }): void {
    const current = readSessionCache(this.sessionCachePath);
    const next = new Map(current.map((session) => [session.sessionId, session]));
    next.set(params.sessionId, {
      sessionId: params.sessionId,
      title: truncatePreview(params.title, 120),
      updatedAt: nowIso(),
    });
    writeSessionCache(
      this.sessionCachePath,
      Array.from(next.values()).sort(
        (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      ),
    );
  }

  private async createTerminal(
    params: acp.CreateTerminalRequest,
  ): Promise<acp.CreateTerminalResponse> {
    const terminalId = crypto.randomUUID();
    const spawnTarget = resolveSpawnTarget(params.command, this.options.kind, {
      forwardArgs: params.args ?? [],
    });
    const env = {
      ...buildCliEnvironment(this.options.kind),
      ...Object.fromEntries((params.env ?? []).map((entry) => [entry.name, entry.value])),
    };
    const child = spawn(spawnTarget.file, spawnTarget.args, {
      cwd: params.cwd ?? this.options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    if (!child.stdout || !child.stderr) {
      throw new Error("Failed to create ACP terminal with piped stdio.");
    }

    let resolveWaitForExit: (value: acp.WaitForTerminalExitResponse) => void = () => undefined;
    const waitForExit = new Promise<acp.WaitForTerminalExitResponse>((resolve) => {
      resolveWaitForExit = resolve;
    });

    const terminal: ManagedTerminal = {
      id: terminalId,
      process: child,
      output: "",
      outputByteLimit: params.outputByteLimit ?? DEFAULT_TERMINAL_OUTPUT_LIMIT,
      waitForExit,
      resolveWaitForExit,
    };
    const onChunk = (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      terminal.output = appendBoundedOutput(terminal.output, text, terminal.outputByteLimit);
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.once("exit", (code, signal) => {
      terminal.exitStatus = {
        exitCode: typeof code === "number" ? code : null,
        signal: signal ?? null,
      };
      terminal.resolveWaitForExit(terminal.exitStatus);
    });

    this.terminals.set(terminalId, terminal);
    return {
      terminalId,
    };
  }

  private emit(event: BridgeEvent): void {
    this.eventSink(event);
  }

  private emitNotice(text: string): void {
    const normalized = normalizeOutput(text).trim();
    if (!normalized) {
      return;
    }

    this.emit({
      type: "notice",
      level: "info",
      text: normalized,
      timestamp: nowIso(),
    });
  }

  private setStatus(status: BridgeAdapterState["status"], message?: string): void {
    this.state.status = status;
    this.emit({
      type: "status",
      status,
      message,
      timestamp: nowIso(),
    });
  }
}
