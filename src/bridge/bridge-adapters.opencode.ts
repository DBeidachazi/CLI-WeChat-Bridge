import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";

import {
  type AdapterOptions,
  type EventSink,
  OPENCODE_SERVER_HOST,
  OPENCODE_SERVER_READY_TIMEOUT_MS,
  OPENCODE_SSE_RECONNECT_DELAY_MS,
  OPENCODE_SESSION_IDLE_SETTLE_MS,
  OPENCODE_WECHAT_WORKING_NOTICE_DELAY_MS,
  buildCliEnvironment,
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
  BridgeSessionSwitchReason,
  BridgeSessionSwitchSource,
  BridgeResumeSessionCandidate,
  BridgeTurnOrigin,
  BridgeEvent,
  PendingApproval,
} from "./bridge-types.ts";
import { killProcessTreeSync } from "./bridge-process-reaper.ts";
import {
  buildOneTimeCode,
  normalizeOutput,
  nowIso,
  truncatePreview,
  OutputBatcher,
} from "./bridge-utils.ts";
import {
  buildLocalCompanionToken,
  clearLocalCompanionEndpoint,
  writeLocalCompanionEndpoint,
  type LocalCompanionEndpoint,
} from "../companion/local-companion-link.ts";

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

type OpenCodePendingPermission = {
  sessionId: string;
  permissionId: string;
  code: string;
  createdAt: string;
  request: ApprovalRequest;
};

const OPENCODE_DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.WECHAT_OPENCODE_DEBUG ?? "",
);

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
  private activeSessionId: string | null = null;
  private outputBatcher: OutputBatcher;
  private shuttingDown = false;
  private hasAcceptedInput = false;
  private currentPreview = "(idle)";
  private workingNoticeDelayMs: number;
  private workingNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private workingNoticeSent = false;
  private lastBusyAtMs = 0;
  private pendingLocalPrompt = "";
  private readonly loggedUnknownEventTypes = new Set<string>();
  private readonly emittedTextByPartId = new Map<string, string>();
  private readonly endpointToken = buildLocalCompanionToken();
  private endpoint: LocalCompanionEndpoint | null = null;

  private pendingPermission: OpenCodePendingPermission | null = null;

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

      this.state.pid = this.serverProcess!.pid;
      this.state.startedAt = nowIso();
      this.publishLocalEndpoint();
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

    this.outputBatcher.clear();
    this.clearStreamedPartState();

    const sessionId = await this.ensureSession();
    this.assignActiveSession(sessionId);

    try {
      const result = await this.client.session.promptAsync({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: normalized }] },
      });
      if (result.error !== undefined) {
        throw new Error(`SDK error: ${describeUnknownError(result.error)}`);
      }
    } catch (err) {
      throw new Error(`Failed to send prompt: ${describeUnknownError(err)}`);
    }

    this.beginTrackedTurn(normalized, "wechat");
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
      const sessions = result.data ?? [];
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
      this.assignActiveSession(session.id);
      this.recordSessionSwitch(session.id, "wechat", "wechat_resume", true);
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
    this.pendingLocalPrompt = "";
    this.clearPendingPermissionState();
    this.activeSessionId = null;
    this.state.sharedSessionId = undefined;
    this.state.sharedThreadId = undefined;
    this.state.activeRuntimeSessionId = undefined;
    this.state.lastSessionSwitchAt = undefined;
    this.state.lastSessionSwitchSource = undefined;
    this.state.lastSessionSwitchReason = undefined;
    this.hasAcceptedInput = false;
    this.currentPreview = "(idle)";
    this.outputBatcher.clear();
    this.clearStreamedPartState();
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
    this.clearPendingPermissionState();
    this.setStatus("busy");
    return true;
  }

  async dispose(): Promise<void> {
    this.shuttingDown = true;
    this.clearWechatWorkingNotice(true);
    this.pendingLocalPrompt = "";
    this.clearLocalEndpoint();
    this.outputBatcher.clear();
    this.clearStreamedPartState();

    this.clearPendingPermissionState();

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

    // Stop server process
    if (this.serverProcess) {
      const proc = this.serverProcess;
      this.serverProcess = null;
      try {
        killProcessTreeSync(proc.pid!);
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
        this.logDebug(`[opencode-serve:out] ${text}`);
      }
    });

    server.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this.logDebug(`[opencode-serve:err] ${text}`);
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
        this.assignActiveSession(latest.id);
      }
    } catch {
      // Session listing is optional at startup.
    }

    if (this.options.initialSharedSessionId) {
      const restoredSessionId = this.options.initialSharedSessionId;
      const changed = this.assignActiveSession(restoredSessionId);
      if (changed) {
        this.recordSessionSwitch(restoredSessionId, "restore", "startup_restore");
      }
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
        this.logDebug(
          `[opencode-adapter:sse] Stream error: ${describeUnknownError(err)}`,
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

      case "session.error": {
        this.handleSessionError(isRecord(event.properties) ? event.properties : undefined);
        return;
      }

      case "permission.updated":
      case "permission.asked": {
        this.handlePermissionRequest(event.properties);
        return;
      }

      case "session.created": {
        this.handleSessionCreated(event.properties);
        return;
      }

      case "session.updated": {
        this.handleSessionUpdated(event.properties);
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

      case "message.part.delta": {
        this.handleMessagePartDelta(event.properties);
        return;
      }

      case "message.part.removed": {
        this.handleMessagePartRemoved(event.properties);
        return;
      }

      case "tui.prompt.append": {
        this.handleTuiPromptAppend(event.properties);
        return;
      }

      case "tui.command.execute": {
        this.handleTuiCommandExecute(event.properties);
        return;
      }

      case "tui.session.select": {
        this.handleTuiSessionSelect(event.properties);
        return;
      }

      case "session.diff":
      case "session.diff.delta":
      case "session.deleted":
      case "message.removed":
      case "permission.replied":
      case "tui.toast.show":
        return;

      default:
        this.logUnknownEvent(type);
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

    this.assignActiveSession(sessionId);

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
      this.pendingLocalPrompt = "";
      this.clearPendingPermissionState();
      this.state.activeTurnOrigin = undefined;
      this.hasAcceptedInput = false;
      const completedPreview = this.currentPreview;

      void this.outputBatcher.flushNow()
        .catch(() => undefined)
        .then(() => {
          const summary = this.outputBatcher.getRecentSummary(500);
          this.setStatus("idle");
          if (summary && summary !== "(no output)") {
            this.emit({
              type: "final_reply",
              text: summary,
              timestamp: nowIso(),
            });
          }

          this.emit({
            type: "task_complete",
            summary: completedPreview,
            timestamp: nowIso(),
          });
          this.currentPreview = "(idle)";
          this.outputBatcher.clear();
          this.clearStreamedPartState();
        });
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
        this.outputBatcher.clear();
        this.clearStreamedPartState();
        this.lastBusyAtMs = Date.now();
        this.setStatus(
          "busy",
          this.state.activeTurnOrigin === "local"
            ? "OpenCode is busy with a local terminal turn."
            : undefined,
        );
      }
    }
  }

  private handlePermissionRequest(properties: unknown): void {
    if (!isRecord(properties) || !this.client) {
      return;
    }

    const pendingPermission = this.buildPendingPermission(properties);
    if (!pendingPermission) {
      return;
    }

    this.clearWechatWorkingNotice();
    const approval = this.toPendingApproval(pendingPermission);
    this.pendingPermission = pendingPermission;
    this.state.pendingApproval = approval;
    this.state.pendingApprovalOrigin = this.state.activeTurnOrigin;
    this.setStatus("awaiting_approval", "OpenCode approval is required.");
    this.emit({
      type: "approval_required",
      request: approval,
      timestamp: nowIso(),
    });
  }

  private clearPendingPermissionState(): void {
    this.pendingPermission = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
  }

  private toPendingApproval(pendingPermission: OpenCodePendingPermission): PendingApproval {
    return {
      ...pendingPermission.request,
      code: pendingPermission.code,
      createdAt: pendingPermission.createdAt,
    };
  }

  private buildPendingPermission(
    properties: Record<string, unknown>,
  ): OpenCodePendingPermission | null {
    const sessionId =
      typeof properties.sessionID === "string"
        ? properties.sessionID
        : this.activeSessionId;
    const permissionId =
      typeof properties.id === "string"
        ? properties.id
        : undefined;

    if (!sessionId || !permissionId) {
      return null;
    }

    const toolName =
      typeof properties.type === "string"
        ? properties.type
        : typeof properties.permission === "string"
          ? properties.permission
          : undefined;
    const title =
      typeof properties.title === "string"
        ? properties.title
        : typeof properties.permission === "string"
          ? `Permission request: ${properties.permission}`
          : undefined;
    const metadata = isRecord(properties.metadata) ? properties.metadata : {};
    const command =
      typeof metadata.command === "string"
        ? metadata.command
        : typeof metadata.detail === "string"
          ? metadata.detail
          : Array.isArray(properties.patterns)
            ? properties.patterns.filter((value): value is string => typeof value === "string").join(", ")
            : undefined;

    return {
      sessionId,
      permissionId,
      code: buildOneTimeCode(),
      createdAt: nowIso(),
      request: {
        source: "cli",
        summary: title ?? `OpenCode needs approval${toolName ? ` for tool: ${toolName}` : ""}.`,
        commandPreview: truncatePreview(command ?? title ?? "Permission request", 180),
        toolName,
        detailPreview: typeof metadata.detail === "string" ? metadata.detail : undefined,
        detailLabel: typeof metadata.label === "string" ? metadata.label : undefined,
        confirmInput: undefined,
        denyInput: undefined,
      },
    };
  }

  private handleSessionCreated(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const sessionId = this.extractSessionId(properties);
    if (!sessionId) {
      return;
    }

    const changed = this.assignActiveSession(sessionId);
    if (!changed) {
      return;
    }

    this.announceLocalSessionSwitch(sessionId);
  }

  private handleSessionUpdated(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const sessionId = this.extractSessionId(properties);
    if (!sessionId) {
      return;
    }

    const changed = this.assignActiveSession(sessionId);
    if (!changed) {
      return;
    }

    this.announceLocalSessionSwitch(sessionId);
  }

  private handleMessagePartUpdated(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    if (this.state.status !== "busy") {
      return;
    }

    const part = isRecord(properties.part) ? properties.part : undefined;
    if (!this.isVisibleTextPart(part)) {
      return;
    }

    const partId = this.extractPartId(properties, part);
    if (!partId) {
      return;
    }

    const partText =
      typeof part.text === "string"
        ? part.text
        : undefined;
    const delta =
      typeof properties.delta === "string"
        ? properties.delta
        : undefined;
    const text = partText
      ? this.consumeVisiblePartSnapshot(partId, partText)
      : delta
        ? this.consumeVisiblePartDelta(partId, delta)
        : "";
    this.pushVisibleOutput(text);
  }

  private handleMessagePartDelta(properties: unknown): void {
    if (!isRecord(properties) || this.state.status !== "busy") {
      return;
    }

    if (properties.field !== "text") {
      return;
    }

    const delta =
      typeof properties.delta === "string"
        ? properties.delta
        : undefined;
    const partId = this.extractPartId(properties);

    if (!delta || !partId) {
      return;
    }

    const text = this.consumeVisiblePartDelta(partId, delta);
    this.pushVisibleOutput(text);
  }

  private handleMessagePartRemoved(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const partId = this.extractPartId(properties);
    if (!partId) {
      return;
    }

    this.emittedTextByPartId.delete(partId);
  }

  private handleTuiPromptAppend(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const text = typeof properties.text === "string" ? properties.text : undefined;
    if (!text) {
      return;
    }

    this.pendingLocalPrompt += text;
  }

  private handleTuiCommandExecute(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const command = typeof properties.command === "string" ? properties.command : undefined;
    if (!command) {
      return;
    }

    switch (command) {
      case "prompt.clear":
        this.pendingLocalPrompt = "";
        return;
      case "prompt.submit":
        this.handleLocalPromptSubmit();
        return;
      default:
        return;
    }
  }

  private handleTuiSessionSelect(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const sessionId = typeof properties.sessionID === "string" ? properties.sessionID : undefined;
    if (!sessionId) {
      return;
    }

    this.pendingLocalPrompt = "";
    const changed = this.assignActiveSession(sessionId);
    if (!changed) {
      return;
    }

    this.recordSessionSwitch(sessionId, "local", "local_follow", true);
  }

  private handleSessionError(properties: Record<string, unknown> | undefined): void {
    if (!isRecord(properties)) {
      return;
    }

    const sessionId =
      typeof properties.sessionID === "string"
        ? properties.sessionID
        : undefined;
    this.assignActiveSession(sessionId);

    const error = isRecord(properties.error) ? properties.error : undefined;
    const errorName = typeof error?.name === "string" ? error.name : undefined;
    const message = this.describeSessionError(error);
    if (!message) {
      return;
    }

    if (!this.hasTrackedTurnState()) {
      this.emit({
        type: "stderr",
        text: `OpenCode session error: ${message}`,
        timestamp: nowIso(),
      });
      return;
    }

    if (errorName === "MessageAbortedError") {
      this.settleTurnState();
      this.setStatus("idle");
      return;
    }

    this.failTrackedTurn(message);
  }

  private handleLocalPromptSubmit(): void {
    const prompt = normalizeOutput(this.pendingLocalPrompt).trim();
    this.pendingLocalPrompt = "";
    if (!prompt) {
      return;
    }

    this.outputBatcher.clear();
    this.clearStreamedPartState();
    this.beginTrackedTurn(prompt, "local", {
      busyMessage: "OpenCode is busy with a local terminal turn.",
      emitMirroredUserInput: true,
    });
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
    this.assignActiveSession(session.id);
    return session.id;
  }

  private beginTrackedTurn(
    text: string,
    origin: BridgeTurnOrigin,
    options: {
      busyMessage?: string;
      emitMirroredUserInput?: boolean;
    } = {},
  ): void {
    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(text);
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = origin;
    this.lastBusyAtMs = Date.now();
    this.clearWechatWorkingNotice(true);
    this.setStatus("busy", options.busyMessage);

    if (options.emitMirroredUserInput && origin === "local") {
      this.emit({
        type: "mirrored_user_input",
        text,
        origin: "local",
        timestamp: nowIso(),
      });
    }

    if (origin === "wechat") {
      this.armWechatWorkingNotice();
    }
  }

  private hasTrackedTurnState(): boolean {
    return (
      this.state.status === "busy" ||
      this.state.status === "awaiting_approval" ||
      this.hasAcceptedInput ||
      this.pendingPermission !== null ||
      this.state.activeTurnOrigin !== undefined ||
      this.currentPreview !== "(idle)"
    );
  }

  private settleTurnState(): void {
    this.clearWechatWorkingNotice(true);
    this.pendingLocalPrompt = "";
    this.clearPendingPermissionState();
    this.state.activeTurnOrigin = undefined;
    this.hasAcceptedInput = false;
    this.currentPreview = "(idle)";
    this.outputBatcher.clear();
    this.clearStreamedPartState();
  }

  private failTrackedTurn(message: string): void {
    if (!this.hasTrackedTurnState()) {
      return;
    }

    this.settleTurnState();
    this.setStatus("idle");
    this.emit({
      type: "task_failed",
      message,
      timestamp: nowIso(),
    });
  }

  private describeSessionError(error: Record<string, unknown> | undefined): string | null {
    if (!error) {
      return "OpenCode reported an unknown session error.";
    }

    const name = typeof error.name === "string" ? error.name : "UnknownError";
    const data = isRecord(error.data) ? error.data : undefined;
    const message = typeof data?.message === "string" ? data.message.trim() : "";
    const providerId = typeof data?.providerID === "string" ? data.providerID : undefined;

    if (name === "ProviderAuthError") {
      return providerId
        ? `Authentication is required for provider "${providerId}".${message ? ` ${message}` : ""}`.trim()
        : message || "Authentication is required for the configured provider.";
    }

    return message || name;
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

  private assignActiveSession(sessionId: string | null | undefined): boolean {
    if (!sessionId) {
      return false;
    }

    const changed = sessionId !== this.activeSessionId;
    this.activeSessionId = sessionId;
    this.state.sharedSessionId = sessionId;
    this.state.sharedThreadId = sessionId;
    this.state.activeRuntimeSessionId = sessionId;
    this.publishLocalEndpoint();
    return changed;
  }

  private extractSessionId(properties: Record<string, unknown>): string | null {
    if (typeof properties.sessionID === "string") {
      return properties.sessionID;
    }

    const info = properties.info;
    if (isRecord(info) && typeof info.id === "string") {
      return info.id;
    }

    return null;
  }

  private announceLocalSessionSwitch(sessionId: string): void {
    this.recordSessionSwitch(sessionId, "local", "local_follow", true);
  }

  private recordSessionSwitch(
    sessionId: string,
    source: BridgeSessionSwitchSource,
    reason: BridgeSessionSwitchReason,
    notify = false,
  ): void {
    const timestamp = nowIso();
    this.state.lastSessionSwitchAt = timestamp;
    this.state.lastSessionSwitchSource = source;
    this.state.lastSessionSwitchReason = reason;
    if (!notify) {
      return;
    }

    this.emit({
      type: "session_switched",
      sessionId,
      source,
      reason,
      timestamp,
    });
  }

  private shouldPublishLocalEndpoint(): boolean {
    return this.options.renderMode === "embedded";
  }

  private publishLocalEndpoint(): void {
    if (!this.shouldPublishLocalEndpoint() || !this.serverPort || !this.state.startedAt) {
      return;
    }

    const sharedSessionId = this.activeSessionId ?? this.state.sharedSessionId;
    const payload: LocalCompanionEndpoint = {
      instanceId: this.endpoint?.instanceId ?? `${process.pid}-${Date.now().toString(36)}`,
      kind: this.options.kind,
      port: this.serverPort,
      token: this.endpointToken,
      renderMode: "embedded",
      bridgeOwnerPid: process.pid,
      serverPort: this.serverPort,
      serverUrl: this.getServerUrl(),
      cwd: this.options.cwd,
      command: this.options.command,
      profile: this.options.profile,
      sharedSessionId,
      sharedThreadId: sharedSessionId,
      startedAt: this.state.startedAt,
    };

    writeLocalCompanionEndpoint(payload);
    this.endpoint = payload;
  }

  private clearLocalEndpoint(): void {
    if (!this.shouldPublishLocalEndpoint()) {
      return;
    }

    clearLocalCompanionEndpoint(this.options.cwd, this.endpoint?.instanceId);
    this.endpoint = null;
  }

  private getServerUrl(): string {
    return `http://${OPENCODE_SERVER_HOST}:${this.serverPort}`;
  }

  private isVisibleTextPart(part: Record<string, unknown> | undefined): part is SdkPart {
    return !!part && part.type === "text" && part.ignored !== true;
  }

  private extractPartId(
    properties: Record<string, unknown>,
    part?: Record<string, unknown> | undefined,
  ): string | null {
    if (typeof properties.partID === "string") {
      return properties.partID;
    }

    if (typeof part?.id === "string") {
      return part.id;
    }

    return null;
  }

  private consumeVisiblePartSnapshot(partId: string, text: string): string {
    const nextText = normalizeOutput(text);
    if (!nextText) {
      return "";
    }

    const previousText = this.emittedTextByPartId.get(partId) ?? "";
    if (nextText === previousText) {
      return "";
    }

    this.emittedTextByPartId.set(partId, nextText);
    if (!previousText) {
      return nextText;
    }

    if (nextText.startsWith(previousText)) {
      return nextText.slice(previousText.length);
    }

    const sharedPrefixLength = this.getSharedPrefixLength(previousText, nextText);
    return nextText.slice(sharedPrefixLength);
  }

  private consumeVisiblePartDelta(partId: string, delta: string): string {
    const nextChunk = normalizeOutput(delta);
    if (!nextChunk) {
      return "";
    }

    const previousText = this.emittedTextByPartId.get(partId) ?? "";
    if (nextChunk === previousText || previousText.endsWith(nextChunk)) {
      return "";
    }

    if (previousText && nextChunk.startsWith(previousText)) {
      this.emittedTextByPartId.set(partId, nextChunk);
      return nextChunk.slice(previousText.length);
    }

    this.emittedTextByPartId.set(partId, `${previousText}${nextChunk}`);
    return nextChunk;
  }

  private pushVisibleOutput(text: string): void {
    if (!text) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    this.outputBatcher.push(text);
  }

  private clearStreamedPartState(): void {
    this.emittedTextByPartId.clear();
  }

  private getSharedPrefixLength(left: string, right: string): number {
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && left[index] === right[index]) {
      index += 1;
    }
    return index;
  }

  private logDebug(message: string): void {
    if (!OPENCODE_DEBUG_ENABLED) {
      return;
    }
    process.stderr.write(`${message}\n`);
  }

  private logUnknownEvent(type: string): void {
    if (!OPENCODE_DEBUG_ENABLED || this.loggedUnknownEventTypes.has(type)) {
      return;
    }
    this.loggedUnknownEventTypes.add(type);
    this.logDebug(`[opencode-adapter:sse] Unknown event: ${type}`);
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
