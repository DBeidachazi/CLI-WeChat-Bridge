import type {
  ApprovalRequest,
  BridgeAdapterKind,
  BridgeAdapterState,
  BridgeResumeSessionCandidate,
  BridgeResumeThreadCandidate,
  BridgeSessionSwitchReason,
  BridgeSessionSwitchSource,
  BridgeState,
  BridgeThreadSwitchReason,
  BridgeThreadSwitchSource,
  PendingApproval,
} from "./bridge-types.ts";

const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export type SystemCommand =
  | { type: "status" }
  | { type: "resume"; target?: string }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "confirm"; code: string }
  | { type: "deny" };

export const MESSAGE_START_GRACE_MS = 5_000;

type CodexSessionJsonLine = {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    phase?: string;
    message?: string;
  };
};

export type CodexSessionAgentMessage = {
  timestamp?: string;
  phase?: string;
  message: string;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

export function normalizeOutput(text: string): string {
  return stripAnsi(text)
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function truncatePreview(text: string, maxLength = 140): string {
  const normalized = normalizeOutput(text).trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "(empty)";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function buildOneTimeCode(length = 6): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  while (code.length < length) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export function buildInstanceId(): string {
  return `bridge-${Date.now().toString(36)}-${buildOneTimeCode(6).toLowerCase()}`;
}

export function parseSystemCommand(text: string): SystemCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const argument = rest.join(" ").trim();

  switch (command) {
    case "/status":
      return { type: "status" };
    case "/resume":
      return argument ? { type: "resume", target: argument } : { type: "resume" };
    case "/stop":
      return { type: "stop" };
    case "/reset":
      return { type: "reset" };
    case "/confirm":
      return argument ? { type: "confirm", code: argument } : null;
    case "/deny":
      return { type: "deny" };
    default:
      return null;
  }
}

export function parseCodexSessionAgentMessage(
  line: string,
): CodexSessionAgentMessage | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: CodexSessionJsonLine;
  try {
    parsed = JSON.parse(trimmed) as CodexSessionJsonLine;
  } catch {
    return null;
  }

  if (parsed.type !== "event_msg" || parsed.payload?.type !== "agent_message") {
    return null;
  }

  const message =
    typeof parsed.payload.message === "string"
      ? normalizeOutput(parsed.payload.message).trim()
      : "";
  if (!message) {
    return null;
  }

  return {
    timestamp: parsed.timestamp,
    phase: typeof parsed.payload.phase === "string" ? parsed.payload.phase : undefined,
    message,
  };
}

const HIGH_RISK_PATTERNS = [
  /\bremove-item\b/i,
  /\brd\b/i,
  /\brmdir\b/i,
  /\bdel\b/i,
  /\berase\b/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\bstop-computer\b/i,
  /\brestart-computer\b/i,
  /\bstop-process\b/i,
  /\btaskkill\b/i,
  /\breg\s+delete\b/i,
  /\bsc\s+delete\b/i,
  /\bdiskpart\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-f/i,
  /\bset-executionpolicy\b/i,
  /\bstart-process\b.*\b-verb\s+runas\b/i,
  /\b(?:invoke-expression|iex)\b/i,
  /\bcurl\b.*\|\s*(?:iex|powershell)\b/i,
  /\binvoke-webrequest\b.*\|\s*(?:iex|powershell)\b/i,
  /\brm\b\s+-[A-Za-z-]*r[A-Za-z-]*/i,
  /\bsudo\b/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bdd\b/i,
  /\breboot\b/i,
  /\bsystemctl\b/i,
  /\blaunchctl\b/i,
  /\bcurl\b.*\|\s*(?:sh|bash|zsh)\b/i,
  /\bwget\b.*\|\s*(?:sh|bash|zsh)\b/i,
];

export function isHighRiskShellCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function detectCliApproval(text: string): ApprovalRequest | null {
  const normalized = normalizeOutput(text);
  const compact = normalized.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }

  const approvalPatterns: Array<{
    pattern: RegExp;
    confirmInput?: string;
    denyInput?: string;
  }> = [
    { pattern: /\bdo you want to allow\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\bapprove\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\ballow this\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\b\(y\/n\)\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\byes\/no\b/i, confirmInput: "yes\r", denyInput: "no\r" },
    { pattern: /\bpress enter to continue\b/i, confirmInput: "\r" },
    { pattern: /\bconfirm to continue\b/i, confirmInput: "y\r", denyInput: "n\r" },
  ];

  const matched = approvalPatterns.find(({ pattern }) => pattern.test(compact));
  if (!matched) {
    return null;
  }

  const preview = truncatePreview(compact, 160);
  return {
    source: "cli",
    summary: "CLI approval is required before the session can continue.",
    commandPreview: preview,
    confirmInput: matched.confirmInput,
    denyInput: matched.denyInput,
  };
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0s";
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (!minutes) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

export function summarizeOutput(text: string, maxLength = 280): string {
  const normalized = normalizeOutput(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!normalized.length) {
    return "(no output)";
  }

  const summary = normalized.slice(-6).join("\n");
  if (summary.length <= maxLength) {
    return summary;
  }

  return summary.slice(summary.length - maxLength);
}

export function formatStatusReport(
  bridgeState: BridgeState,
  adapterState: BridgeAdapterState,
): string {
  const pending = bridgeState.pendingConfirmation;
  const persistedSharedSessionId =
    bridgeState.sharedSessionId ?? bridgeState.sharedThreadId;
  const sharedSessionId =
    adapterState.sharedSessionId ?? adapterState.sharedThreadId;
  const lastSessionSwitchAt =
    adapterState.lastSessionSwitchAt ?? adapterState.lastThreadSwitchAt;
  const lastSessionSwitchSource =
    adapterState.lastSessionSwitchSource ?? adapterState.lastThreadSwitchSource;
  const lastSessionSwitchReason =
    adapterState.lastSessionSwitchReason ?? adapterState.lastThreadSwitchReason;
  const formatEpochMs = (value?: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? new Date(value).toISOString()
      : "(none)";

  return [
    `instance_id: ${bridgeState.instanceId}`,
    `adapter: ${bridgeState.adapter}`,
    `command: ${bridgeState.command}`,
    `cwd: ${bridgeState.cwd}`,
    `profile: ${bridgeState.profile ?? "(none)"}`,
    `bridge_started_at: ${formatEpochMs(bridgeState.bridgeStartedAtMs)}`,
    `authorized_user: ${bridgeState.authorizedUserId}`,
    `ignored_backlog_count: ${bridgeState.ignoredBacklogCount}`,
    `persisted_shared_session_id: ${persistedSharedSessionId ?? "(none)"}`,
    `worker_status: ${adapterState.status}`,
    `worker_pid: ${adapterState.pid ?? "(unknown)"}`,
    `shared_session_id: ${sharedSessionId ?? "(none)"}`,
    `last_session_switch_at: ${lastSessionSwitchAt ?? "(none)"}`,
    `last_session_switch_source: ${lastSessionSwitchSource ?? "(none)"}`,
    `last_session_switch_reason: ${lastSessionSwitchReason ?? "(none)"}`,
    `active_turn_id: ${adapterState.activeTurnId ?? "(none)"}`,
    `active_turn_origin: ${adapterState.activeTurnOrigin ?? "(none)"}`,
    `pending_approval_origin: ${adapterState.pendingApprovalOrigin ?? "(none)"}`,
    `last_activity_at: ${bridgeState.lastActivityAt ?? "(none)"}`,
    `last_input_at: ${adapterState.lastInputAt ?? "(none)"}`,
    `last_output_at: ${adapterState.lastOutputAt ?? "(none)"}`,
    `pending_confirmation: ${pending ? `${pending.source}:${pending.code}` : "(none)"}`,
  ].join("\n");
}

export function formatSessionSwitchMessage(params: {
  adapter: BridgeAdapterKind;
  sessionId: string;
  source: BridgeSessionSwitchSource;
  reason: BridgeSessionSwitchReason;
}): string {
  const shortSessionId = params.sessionId.slice(0, 12);

  if (params.adapter === "claude") {
    switch (params.reason) {
      case "local_follow":
      case "local_session_fallback":
      case "local_turn":
        return `Claude session switched to ${shortSessionId} from the local terminal.`;
      case "wechat_resume":
        return `Claude session switched to ${shortSessionId} from WeChat.`;
      case "startup_restore":
        return `Claude restored shared session ${shortSessionId} on startup.`;
      default:
        return `Claude session switched to ${shortSessionId}.`;
    }
  }

  switch (params.reason) {
    case "local_follow":
    case "local_session_fallback":
    case "local_turn":
      return `Codex thread switched to ${shortSessionId} from the local terminal.`;
    case "wechat_resume":
      return `Codex thread switched to ${shortSessionId} from WeChat.`;
    case "startup_restore":
      return `Codex restored shared thread ${shortSessionId} on startup.`;
    default:
      return `Codex thread switched to ${shortSessionId}.`;
  }
}

export function formatThreadSwitchMessage(params: {
  threadId: string;
  source: BridgeThreadSwitchSource;
  reason: BridgeThreadSwitchReason;
}): string {
  return formatSessionSwitchMessage({
    adapter: "codex",
    sessionId: params.threadId,
    source: params.source,
    reason: params.reason,
  });
}

export function formatResumeSessionList(params: {
  adapter: BridgeAdapterKind;
  candidates: BridgeResumeSessionCandidate[];
  currentSessionId?: string;
}): string {
  const { adapter, candidates, currentSessionId } = params;
  if (candidates.length === 0) {
    return adapter === "codex"
      ? "No saved Codex threads were found for this working directory."
      : "No saved sessions were found for this working directory.";
  }

  const title = adapter === "codex" ? "Recent Codex threads:" : "Recent sessions:";
  const resumeTargetLabel = adapter === "codex" ? "threadId" : "sessionId";
  return [
    title,
    ...candidates.map((candidate, index) => {
      const marker =
        currentSessionId && candidate.sessionId === currentSessionId ? " [current]" : "";
      return `${index + 1}. ${candidate.title} (${candidate.lastUpdatedAt}, ${candidate.sessionId.slice(0, 12)})${marker}`;
    }),
    `Reply with /resume <number> or /resume <${resumeTargetLabel}>.`,
  ].join("\n");
}

export function formatResumeThreadList(
  candidates: BridgeResumeThreadCandidate[],
  currentThreadId?: string,
): string {
  return formatResumeSessionList({
    adapter: "codex",
    candidates: candidates.map((candidate) => ({
      ...candidate,
      sessionId: candidate.sessionId ?? candidate.threadId ?? "",
      threadId: candidate.threadId ?? candidate.sessionId,
    })),
    currentSessionId: currentThreadId,
  });
}

export function formatMirroredUserInputMessage(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  const label =
    adapter === "codex"
      ? "Local Codex input"
      : adapter === "claude"
        ? "Local Claude input"
        : "Local input";
  return `${label}:\n${truncatePreview(text, 500)}`;
}

export function formatFinalReplyMessage(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  if (adapter === "claude") {
    return text;
  }
  const label = adapter === "codex" ? "Codex" : adapter === "claude" ? "Claude" : adapter;
  return `${label} final reply:\n${text}`;
}

export function formatTaskFailedMessage(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  const label = adapter === "codex" ? "Codex" : adapter === "claude" ? "Claude" : adapter;
  return `${label} task failed:\n${text}`;
}

export function formatApprovalMessage(
  pending: PendingApproval,
  adapterState: BridgeAdapterState,
): string {
  return [
    `${pending.source === "shell" ? "Shell" : "CLI"} approval is required.`,
    `adapter: ${adapterState.kind}`,
    `code: ${pending.code}`,
    `summary: ${pending.summary}`,
    `target: ${pending.commandPreview}`,
    "Reply with /confirm <code> to continue or /deny to reject.",
  ].join("\n");
}

export class OutputBatcher {
  private readonly onFlush: (text: string) => Promise<void> | void;
  private readonly flushIntervalMs: number;
  private readonly maxChars: number;
  private buffer = "";
  private recentText = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain = Promise.resolve();

  constructor(
    onFlush: (text: string) => Promise<void> | void,
    flushIntervalMs = 1_000,
    maxChars = 1_200,
  ) {
    this.onFlush = onFlush;
    this.flushIntervalMs = flushIntervalMs;
    this.maxChars = maxChars;
  }

  push(text: string): void {
    const normalized = normalizeOutput(text);
    if (!normalized) {
      return;
    }

    this.buffer += normalized;
    this.recentText = (this.recentText + normalized).slice(-6_000);

    while (this.buffer.length >= this.maxChars) {
      const nextChunk = this.buffer.slice(0, this.maxChars);
      this.buffer = this.buffer.slice(this.maxChars);
      this.enqueueFlush(nextChunk);
    }

    this.ensureFlushTimer();
  }

  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.buffer) {
      await this.flushChain;
      return;
    }

    const chunk = this.buffer;
    this.buffer = "";
    this.enqueueFlush(chunk);
    await this.flushChain;
  }

  clear(): void {
    this.buffer = "";
    this.recentText = "";
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  getRecentSummary(maxLength = 280): string {
    return summarizeOutput(this.recentText, maxLength);
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer || !this.buffer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, this.flushIntervalMs);
  }

  private enqueueFlush(text: string): void {
    const payload = text.trim();
    if (!payload) {
      return;
    }

    this.flushChain = this.flushChain
      .then(() => Promise.resolve(this.onFlush(payload)))
      .catch(() => undefined);
  }
}

export function shouldDropStartupBacklogMessage(
  createdAtMs: number | undefined,
  bridgeStartedAtMs: number,
  graceMs = MESSAGE_START_GRACE_MS,
): boolean {
  if (!Number.isFinite(createdAtMs)) {
    return true;
  }

  return (createdAtMs as number) < bridgeStartedAtMs - graceMs;
}
