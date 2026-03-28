import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { spawn as spawnPty } from "node-pty";
import type { IPty } from "node-pty";

import {
  type AdapterOptions,
  type EventSink,
  OPENCODE_SERVER_HOST,
  OPENCODE_SERVER_READY_TIMEOUT_MS,
  OPENCODE_SSE_RECONNECT_DELAY_MS,
  OPENCODE_SESSION_IDLE_SETTLE_MS,
  OPENCODE_WECHAT_WORKING_NOTICE_DELAY_MS,
  buildCliEnvironment,
  buildPtySpawnOptions,
  isRecord,
  describeUnknownError,
  resolveSpawnTarget,
  reserveLocalPort,
  waitForTcpPort,
  delay,
} from "./bridge-adapters.shared.ts";
import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeAdapterState,
  BridgeResumeSessionCandidate,
  BridgeEvent,
} from "./bridge-types.ts";
import {
  normalizeOutput,
  nowIso,
  truncatePreview,
  buildOneTimeCode,
  OutputBatcher,
} from "./bridge-utils.ts";

/* ------------------------------------------------------------------ */
/*  Types for @opencode-ai/sdk (loose to avoid hard import-time deps) */
/* ------------------------------------------------------------------ */

/**
 * The real @opencode-ai/sdk OpencodeClient uses hey-api generated methods
 * that return { data, error, request, response }.  We define a minimal
 * interface so the adapter can call methods without importing the SDK at
 * compile-time (the SDK is loaded dynamically via createSdkClient).
 */
type SdkResult<T> =
  | { data: T; error: undefined; request: unknown; response: unknown }
  | { data: undefined; error: unknown; request: unknown; response: unknown };

type SdkSession = {
  id: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  version: string;
  time: { created: number; updated: number; compacting?: number };
  share?: { url: string };
};

type SdkSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

type SdkPermission = {
  id: string;
  type: string;
  pattern?: string | Array<string>;
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { created: number };
};

type SdkPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
} & Record<string, unknown>;

type OpenCodeSdkClient = {
  session: {
    list(options?: Record<string, unknown>): Promise<SdkResult<SdkSession[]>>;
    create(options: { body?: Record<string, unknown>; query?: Record<string, unknown> }): Promise<SdkResult<SdkSession>>;
    get(options: { path: { id: string }; query?: Record<string, unknown> }): Promise<SdkResult<SdkSession>>;
    abort(options: { path: { id: string } }): Promise<SdkResult<unknown>>;
    promptAsync(options: {
      path: { id: string };
      body: { parts: Array<{ type: string; text: string }> };
      query?: Record<string, unknown>;
    }): Promise<SdkResult<void>>;
  };
  postSessionIdPermissionsPermissionId(options: {
    path: { id: string; permissionID: string };
    body: { response: string };
    query?: Record<string, unknown>;
  }): Promise<SdkResult<boolean>>;
  event: {
    subscribe(options?: Record<string, unknown>): Promise<{
      stream: AsyncIterable<SdkEvent>;
    }>;
  };
};

type SdkEvent = {
  type: string;
  properties?: unknown;
};

/* ------------------------------------------------------------------ */
/*  Adapter                                                            */
/* ------------------------------------------------------------------ */

export class OpenCodeServerAdapter implements BridgeAdapter {
  private readonly options: AdapterOptions;
  private readonly state: BridgeAdapterState;
  private eventSink: EventSink = () => undefined;

  private serverProcess: ChildProcess | null = null;
  private serverPort = 0;
  private client: OpenCodeSdkClient | null = null;
  private sseAbortController: AbortController | null = null;
  private sseLoopPromise: Promise<void> | null = null;
  private attachPty: IPty | null = null;
  private activeSessionId: string | null = null;
  private outputBatcher: OutputBatcher;
  private shuttingDown = false;
  private hasAcceptedInput = false;
  private currentPreview = "(idle)";
  private workingNoticeDelayMs: number;
  private workingNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private workingNoticeSent = false;
  private lastBusyAtMs = 0;

  private pendingPermission: {
    sessionId: string;
    permissionId: string;
    code: string;
    createdAt: string;
    request: ApprovalRequest;
  } | null = null;

  constructor(options: AdapterOptions) {
    this.options = options;
    this.state = {
      kind: options.kind,
      status: "stopped",
      cwd: options.cwd,
      command: options.command,
      profile: options.profile,
    };
    this.outputBatcher = new OutputBatcher((text) =>
      this.flushOutputBatch(text),
    );
    this.workingNoticeDelayMs = OPENCODE_WECHAT_WORKING_NOTICE_DELAY_MS;
  }

  /* ---- BridgeAdapter interface ---- */

  setEventSink(sink: EventSink): void {
    this.eventSink = sink;
  }

  getState(): BridgeAdapterState {
    return JSON.parse(JSON.stringify(this.state)) as BridgeAdapterState;
  }

  async start(): Promise<void> {
    if (this.serverProcess) {
      return;
    }

    this.shuttingDown = false;
    this.setStatus("starting", "Starting OpenCode server...");

    try {
      this.serverPort = await reserveLocalPort();
      await this.startServerProcess();

      await waitForTcpPort(
        OPENCODE_SERVER_HOST,
        this.serverPort,
        OPENCODE_SERVER_READY_TIMEOUT_MS,
      );

      await this.createSdkClient();
      await this.checkHealth();
      await this.initializeSessions();
      this.startSseListener();
      this.spawnAttachProcess();

      this.state.pid = this.serverProcess!.pid;
      this.state.startedAt = nowIso();
      this.setStatus("idle", "OpenCode adapter is ready.");
    } catch (err) {
      this.state.status = "error";
      this.emit({
        type: "fatal_error",
        message: `Failed to start OpenCode: ${describeUnknownError(err)}`,
        timestamp: nowIso(),
      });
      await this.dispose();
      throw err;
    }
  }

  async sendInput(text: string): Promise<void> {
    if (!this.client) {
      throw new Error("OpenCode adapter is not running.");
    }
    if (this.state.status === "busy") {
      throw new Error("OpenCode is still working. Wait for the current reply or use /stop.");
    }
    if (this.pendingPermission) {
      throw new Error("An OpenCode approval request is pending. Reply with /confirm <code> or /deny.");
    }

    const normalized = normalizeOutput(text).trim();
    if (!normalized) {
      return;
    }

    const sessionId = await this.ensureSession();
    this.activeSessionId = sessionId;
    this.state.sharedSessionId = sessionId;
    this.state.activeRuntimeSessionId = sessionId;

    try {
      const result = await this.client.session.promptAsync({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: normalized }] },
      });
      if (result.error !== undefined) {
        throw new Error(`SDK error: ${describeUnknownError(result.error)}`);
      }
    } catch (err) {
      this.emit({
        type: "stderr",
        text: `Failed to send prompt: ${describeUnknownError(err)}`,
        timestamp: nowIso(),
      });
      return;
    }

    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(normalized);
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = "wechat";
    this.lastBusyAtMs = Date.now();
    this.clearWechatWorkingNotice(true);
    this.setStatus("busy");
    this.armWechatWorkingNotice();
  }

  async listResumeSessions(limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    if (!this.client) {
      return [];
    }

    try {
      const result = await this.client.session.list();
      if (result.error !== undefined) {
        return [];
      }
      const sessions = result.data;
      return sessions.slice(0, limit).map((s) => ({
        sessionId: s.id,
        title: truncatePreview(s.title || s.id, 120),
        lastUpdatedAt: new Date(s.time.updated).toISOString(),
      }));
    } catch {
      return [];
    }
  }

  async resumeSession(sessionId: string): Promise<void> {
    if (!this.client) {
      throw new Error("OpenCode adapter is not running.");
    }

    try {
      const session = this.unwrapOrThrow(
        await this.client.session.get({ path: { id: sessionId } }),
      );
      this.activeSessionId = session.id;
      this.state.sharedSessionId = session.id;
      this.state.activeRuntimeSessionId = session.id;

      const timestamp = nowIso();
      this.state.lastSessionSwitchAt = timestamp;
      this.state.lastSessionSwitchSource = "wechat";
      this.state.lastSessionSwitchReason = "wechat_resume";

      this.emit({
        type: "session_switched",
        sessionId: session.id,
        source: "wechat",
        reason: "wechat_resume",
        timestamp,
      });
    } catch (err) {
      throw new Error(`Failed to resume session ${sessionId}: ${describeUnknownError(err)}`);
    }
  }

  async interrupt(): Promise<boolean> {
    if (!this.client || !this.activeSessionId) {
      return false;
    }
    if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
      return false;
    }

    this.clearWechatWorkingNotice(true);

    try {
      await this.client.session.abort({ path: { id: this.activeSessionId } });
    } catch {
      // Best effort abort.
    }

    return true;
  }

  async reset(): Promise<void> {
    this.clearWechatWorkingNotice(true);
    this.pendingPermission = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.activeSessionId = null;
    this.state.sharedSessionId = undefined;
    this.state.activeRuntimeSessionId = undefined;
    this.hasAcceptedInput = false;
    this.currentPreview = "(idle)";
    this.outputBatcher.clear();
    await this.dispose();
    await this.start();
  }

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    if (!this.pendingPermission || !this.client) {
      return false;
    }

    const { sessionId, permissionId } = this.pendingPermission;
    const response = action === "confirm" ? "once" : "reject";

    try {
      const result = await this.client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: permissionId },
        body: { response },
      });
      if (result.error !== undefined) {
        throw new Error(`SDK error: ${describeUnknownError(result.error)}`);
      }
    } catch (err) {
      this.emit({
        type: "stderr",
        text: `Failed to resolve permission: ${describeUnknownError(err)}`,
        timestamp: nowIso(),
      });
      return false;
    }

    this.clearWechatWorkingNotice();
    this.pendingPermission = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.setStatus("busy");
    return true;
  }

  async dispose(): Promise<void> {
    this.shuttingDown = true;
    this.clearWechatWorkingNotice(true);
    this.detachLocalTerminal();
    this.outputBatcher.clear();

    this.pendingPermission = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;

    // Stop SSE listener
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }
    if (this.sseLoopPromise) {
      try {
        await Promise.race([this.sseLoopPromise, delay(3_000)]);
      } catch {
        // Ignore SSE loop errors during shutdown.
      }
      this.sseLoopPromise = null;
    }

    // Stop attach process
    if (this.attachPty) {
      try {
        this.attachPty.kill();
      } catch {
        // Best effort.
      }
      this.attachPty = null;
    }

    // Stop server process
    if (this.serverProcess) {
      const proc = this.serverProcess;
      this.serverProcess = null;
      try {
        proc.kill();
      } catch {
        // Best effort.
      }
    }

    this.client = null;
    this.activeSessionId = null;
    this.state.status = "stopped";
    this.state.pid = undefined;
  }

  /* ---- Server management ---- */

  private async startServerProcess(): Promise<void> {
    const env = buildCliEnvironment(this.options.kind);
    const serverArgs = [
      "serve",
      "--port",
      String(this.serverPort),
      "--hostname",
      OPENCODE_SERVER_HOST,
    ];

    const target = resolveSpawnTarget(this.options.command, this.options.kind, { env });
    this.serverProcess = spawnChildProcess(target.file, [...target.args, ...serverArgs], {
      cwd: this.options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const server = this.serverProcess;

    server.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        process.stderr.write(`[opencode-serve:out] ${text}\n`);
      }
    });

    server.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        process.stderr.write(`[opencode-serve:err] ${text}\n`);
      }
    });

    server.once("exit", (code) => {
      if (this.shuttingDown) {
        return;
      }
      this.emit({
        type: "fatal_error",
        message: `OpenCode server exited unexpectedly (code ${code ?? "unknown"}).`,
        timestamp: nowIso(),
      });
      this.setStatus("stopped");
    });

    server.once("error", (err) => {
      if (this.shuttingDown) {
        return;
      }
      this.emit({
        type: "fatal_error",
        message: `OpenCode server error: ${err.message}`,
        timestamp: nowIso(),
      });
    });
  }

  private async createSdkClient(): Promise<void> {
    try {
      const { createOpencodeClient } = await import("@opencode-ai/sdk");
      this.client = createOpencodeClient({
        baseUrl: `http://${OPENCODE_SERVER_HOST}:${this.serverPort}`,
      }) as unknown as OpenCodeSdkClient;
    } catch (err) {
      throw new Error(
        `Failed to load @opencode-ai/sdk. Make sure it is installed: ${describeUnknownError(err)}`,
      );
    }
  }

  private async checkHealth(): Promise<void> {
    const baseUrl = `http://${OPENCODE_SERVER_HOST}:${this.serverPort}`;
    const response = await fetch(`${baseUrl}/session/status`);
    if (!response.ok) {
      throw new Error(`OpenCode health check failed (HTTP ${response.status}).`);
    }
  }

  private async initializeSessions(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      const result = await this.client.session.list();
      if (result.data && result.data.length > 0) {
        const latest = result.data[0]!;
        this.activeSessionId = latest.id;
        this.state.sharedSessionId = latest.id;
        this.state.activeRuntimeSessionId = latest.id;
      }
    } catch {
      // Session listing is optional at startup.
    }

    if (this.options.initialSharedSessionId) {
      this.activeSessionId = this.options.initialSharedSessionId;
      this.state.sharedSessionId = this.options.initialSharedSessionId;
      this.state.activeRuntimeSessionId = this.options.initialSharedSessionId;
    }
  }

  /* ---- SSE event handling ---- */

  private startSseListener(): void {
    if (!this.client || this.sseLoopPromise) {
      return;
    }

    this.sseAbortController = new AbortController();
    this.sseLoopPromise = this.runSseLoop();
  }

  private async runSseLoop(): Promise<void> {
    while (!this.shuttingDown) {
      try {
        const subscription = await this.client!.event.subscribe();
        const stream = subscription.stream;

        for await (const event of stream) {
          if (this.shuttingDown) {
            break;
          }
          this.handleSseEvent(event);
        }
      } catch (err) {
        if (this.shuttingDown) {
          return;
        }
        process.stderr.write(
          `[opencode-adapter:sse] Stream error: ${describeUnknownError(err)}\n`,
        );
      }

      if (this.shuttingDown) {
        return;
      }

      await delay(OPENCODE_SSE_RECONNECT_DELAY_MS);
    }
  }

  private handleSseEvent(event: SdkEvent): void {
    const { type } = event;

    switch (type) {
      case "server.connected":
      case "server.heartbeat":
        return;

      case "session.idle": {
        this.handleSessionIdle(isRecord(event.properties) ? event.properties : undefined);
        return;
      }

      case "session.status": {
        this.handleSessionStatus(isRecord(event.properties) ? event.properties : undefined);
        return;
      }

      case "permission.updated": {
        this.handlePermissionUpdated(event.properties);
        return;
      }

      case "session.created": {
        this.handleSessionCreated(event.properties);
        return;
      }

      case "message.updated": {
        // Full message update — not used for incremental text extraction.
        // Text output comes from message.part.updated events.
        return;
      }

      case "message.part.updated": {
        this.handleMessagePartUpdated(event.properties);
        return;
      }

      default:
        // Log unknown events for debugging but don't crash.
        process.stderr.write(
          `[opencode-adapter:sse] Unknown event: ${type}\n`,
        );
        return;
    }
  }

  private handleSessionIdle(properties: Record<string, unknown> | undefined): void {
    if (!isRecord(properties)) {
      return;
    }

    const sessionId =
      typeof properties.sessionID === "string"
        ? properties.sessionID
        : this.activeSessionId;

    if (sessionId && sessionId !== this.activeSessionId) {
      this.activeSessionId = sessionId;
      this.state.sharedSessionId = sessionId;
      this.state.activeRuntimeSessionId = sessionId;
    }

    if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
      return;
    }

    // Wait a short settle time before emitting task_complete,
    // in case more events follow the idle signal.
    setTimeout(() => {
      if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
        return;
      }

      this.clearWechatWorkingNotice(true);
      this.pendingPermission = null;
      this.state.pendingApproval = null;
      this.state.pendingApprovalOrigin = undefined;
      this.state.activeTurnOrigin = undefined;
      this.hasAcceptedInput = false;
      this.setStatus("idle");

      this.outputBatcher.flushNow().then(() => {
        const summary = this.outputBatcher.getRecentSummary(500);
        if (summary && summary !== "(no output)") {
          this.emit({
            type: "final_reply",
            text: summary,
            timestamp: nowIso(),
          });
        }
      });

      this.emit({
        type: "task_complete",
        summary: this.currentPreview,
        timestamp: nowIso(),
      });
      this.currentPreview = "(idle)";
    }, OPENCODE_SESSION_IDLE_SETTLE_MS).unref?.();
  }

  private handleSessionStatus(properties: Record<string, unknown> | undefined): void {
    if (!isRecord(properties)) {
      return;
    }

    // properties: { sessionID: string, status: { type: "busy" | "idle" | ... } }
    const status = properties.status;
    if (!isRecord(status)) {
      return;
    }

    const statusType = typeof status.type === "string" ? status.type : undefined;
    if (!statusType) {
      return;
    }

    if (statusType === "busy" || statusType === "running") {
      if (this.state.status === "idle") {
        this.lastBusyAtMs = Date.now();
        this.setStatus("busy");
      }
    }
  }

  private handlePermissionUpdated(properties: unknown): void {
    // properties is a Permission object: { id, sessionID, title, type, metadata, ... }
    if (!isRecord(properties) || !this.client) {
      return;
    }

    const sessionId =
      typeof properties.sessionID === "string"
        ? properties.sessionID
        : this.activeSessionId;
    const permissionId =
      typeof properties.id === "string"
        ? properties.id
        : undefined;

    if (!sessionId || !permissionId) {
      return;
    }

    this.clearWechatWorkingNotice();

    const toolName =
      typeof properties.type === "string"
        ? properties.type
        : undefined;
    const title =
      typeof properties.title === "string"
        ? properties.title
        : undefined;
    const metadata = isRecord(properties.metadata) ? properties.metadata : {};
    const command =
      typeof metadata.command === "string"
        ? metadata.command
        : typeof metadata.detail === "string"
          ? metadata.detail
          : undefined;

    const code = buildOneTimeCode();
    const request: ApprovalRequest = {
      source: "cli",
      summary: title ?? `OpenCode needs approval${toolName ? ` for tool: ${toolName}` : ""}.`,
      commandPreview: truncatePreview(command ?? title ?? "Permission request", 180),
      toolName,
      detailPreview: typeof metadata.detail === "string" ? metadata.detail : undefined,
      detailLabel: typeof metadata.label === "string" ? metadata.label : undefined,
      confirmInput: undefined,
      denyInput: undefined,
    };

    this.pendingPermission = {
      sessionId,
      permissionId,
      code,
      createdAt: nowIso(),
      request,
    };
    this.state.pendingApproval = request;
    this.state.pendingApprovalOrigin = this.state.activeTurnOrigin;
    this.setStatus("awaiting_approval", "OpenCode approval is required.");
    this.emit({
      type: "approval_required",
      request,
      timestamp: nowIso(),
    });
  }

  private handleSessionCreated(properties: unknown): void {
    // properties: { info: Session }
    if (!isRecord(properties)) {
      return;
    }

    const info = properties.info;
    if (!isRecord(info) || typeof info.id !== "string") {
      return;
    }

    const sessionId = info.id;
    this.activeSessionId = sessionId;
    this.state.sharedSessionId = sessionId;
    this.state.activeRuntimeSessionId = sessionId;

    const timestamp = nowIso();
    this.state.lastSessionSwitchAt = timestamp;
    this.state.lastSessionSwitchSource = "local";
    this.state.lastSessionSwitchReason = "local_follow";
    this.emit({
      type: "session_switched",
      sessionId,
      source: "local",
      reason: "local_follow",
      timestamp,
    });
  }

  private handleMessagePartUpdated(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    if (this.state.status !== "busy") {
      return;
    }

    // properties: { part: Part, delta?: string }
    const delta =
      typeof properties.delta === "string"
        ? properties.delta
        : undefined;

    const part = isRecord(properties.part) ? properties.part : undefined;
    const partText =
      typeof part?.text === "string"
        ? part!.text
        : undefined;

    const text = delta ?? partText;
    if (text) {
      this.state.lastOutputAt = nowIso();
      this.outputBatcher.push(text);
    }
  }

  /* ---- Session helpers ---- */

  private unwrapOrThrow<T>(result: SdkResult<T>): T {
    if (result.error !== undefined) {
      throw new Error(`SDK error: ${describeUnknownError(result.error)}`);
    }
    return result.data as T;
  }

  private async ensureSession(): Promise<string> {
    if (this.activeSessionId && this.client) {
      // Verify the session still exists.
      try {
        const result = await this.client.session.get({ path: { id: this.activeSessionId } });
        if (result.error === undefined) {
          return this.activeSessionId;
        }
      } catch {
        // Session doesn't exist anymore, create a new one.
      }
      this.activeSessionId = null;
    }

    if (!this.client) {
      throw new Error("OpenCode SDK client is not initialized.");
    }

    const session = this.unwrapOrThrow(
      await this.client.session.create({ body: {} }),
    );
    this.activeSessionId = session.id;
    this.state.sharedSessionId = session.id;
    this.state.activeRuntimeSessionId = session.id;
    return session.id;
  }

  /* ---- Attach process (local TUI) ---- */

  private spawnAttachProcess(): void {
    const url = `http://${OPENCODE_SERVER_HOST}:${this.serverPort}`;
    const env = buildCliEnvironment(this.options.kind);
    const attachArgs = ["attach", url];

    try {
      const target = resolveSpawnTarget(this.options.command, this.options.kind, { env });
      this.attachPty = spawnPty(target.file, [...target.args, ...attachArgs], {
        ...buildPtySpawnOptions({ cwd: this.options.cwd, env }),
        name: "xterm-color",
      });

      this.attachPty.onData((data: string) => {
        try {
          process.stdout.write(data);
        } catch {
          // Best effort local rendering.
        }
      });

      this.attachPty.onExit(() => {
        this.attachPty = null;
        if (!this.shuttingDown) {
          process.stderr.write(
            "[opencode-adapter] Local TUI (opencode attach) exited. The server is still running.\n",
          );
        }
      });
    } catch (err) {
      process.stderr.write(
        `[opencode-adapter] Failed to spawn opencode attach: ${describeUnknownError(err)}\n`,
      );
    }

    // Set up raw mode for stdin passthrough to the attach PTY.
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (chunk: Buffer | string) => {
        const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        this.attachPty?.write(data);
      });
    }
  }

  private detachLocalTerminal(): void {
    if (this.attachPty) {
      try {
        this.attachPty.kill();
      } catch {
        // Best effort.
      }
      this.attachPty = null;
    }

    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Best effort.
      }
      process.stdin.pause();
    }
  }

  /* ---- Working notice ---- */

  private armWechatWorkingNotice(): void {
    this.clearWechatWorkingNotice();
    if (
      this.workingNoticeSent ||
      !this.hasAcceptedInput ||
      this.state.status !== "busy" ||
      this.pendingPermission ||
      this.state.activeTurnOrigin !== "wechat"
    ) {
      return;
    }

    this.workingNoticeTimer = setTimeout(() => {
      this.workingNoticeTimer = null;
      if (
        this.workingNoticeSent ||
        !this.hasAcceptedInput ||
        this.state.status !== "busy" ||
        this.pendingPermission ||
        this.state.activeTurnOrigin !== "wechat"
      ) {
        return;
      }

      this.workingNoticeSent = true;
      this.emit({
        type: "notice",
        text: `OpenCode is still working on:\n${this.currentPreview}`,
        level: "info",
        timestamp: nowIso(),
      });
    }, this.workingNoticeDelayMs);
    this.workingNoticeTimer.unref?.();
  }

  private clearWechatWorkingNotice(resetSent = false): void {
    if (this.workingNoticeTimer) {
      clearTimeout(this.workingNoticeTimer);
      this.workingNoticeTimer = null;
    }
    if (resetSent) {
      this.workingNoticeSent = false;
    }
  }

  /* ---- Output batching ---- */

  private flushOutputBatch(text: string): void {
    this.emit({
      type: "stdout",
      text,
      timestamp: nowIso(),
    });
  }

  /* ---- Core helpers ---- */

  private emit(event: BridgeEvent): void {
    this.eventSink(event);
  }

  private setStatus(
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
}
