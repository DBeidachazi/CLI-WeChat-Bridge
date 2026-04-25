export type BridgeAdapterKind =
  | "codex"
  | "claude"
  | "opencode"
  | "gemini"
  | "copilot"
  | "shell";
export type BridgeLifecycleMode = "persistent" | "companion_bound";
export type BridgeTurnOrigin = "wechat" | "local";
export type BridgeSessionSwitchSource = BridgeTurnOrigin | "restore";
export type BridgeSessionSwitchReason =
  | "local_follow"
  | "local_session_fallback"
  | "local_turn"
  | "wechat_resume"
  | "startup_restore";
export type BridgeThreadSwitchSource = BridgeSessionSwitchSource;
export type BridgeThreadSwitchReason = BridgeSessionSwitchReason;

export type BridgeWorkerStatus =
  | "starting"
  | "idle"
  | "busy"
  | "awaiting_approval"
  | "stopped"
  | "error";

export type BridgeNoticeLevel = "info" | "warning";

export type ApprovalSource = "shell" | "cli";

export interface ApprovalRequest {
  commandPreview: string;
  confirmInput?: string;
  denyInput?: string;
  detailLabel?: string;
  detailPreview?: string;
  requestId?: string;
  source: ApprovalSource;
  summary: string;
  toolName?: string;
}

export type PendingApproval = ApprovalRequest & {
  code: string;
  createdAt: string;
};

export interface BridgeResumeSessionCandidate {
  lastUpdatedAt: string;
  sessionId: string;
  source?: string;
  threadId?: string;
  title: string;
}

export type BridgeResumeThreadCandidate = BridgeResumeSessionCandidate;

export type BridgeInputAttachmentKind = "image" | "voice" | "file" | "video";

export interface BridgeInputAttachment {
  kind: BridgeInputAttachmentKind;
  mimeType?: string;
  path: string;
  sizeBytes?: number;
  title?: string;
}

export interface BridgeUserInput {
  attachments?: BridgeInputAttachment[];
  text: string;
}

export type BridgeAdapterInput = BridgeUserInput | string;

export interface BridgeState {
  adapter: BridgeAdapterKind;
  authorizedUserId: string;
  bridgeStartedAtMs: number;
  command: string;
  cwd: string;
  ignoredBacklogCount: number;
  instanceId: string;
  lastActivityAt?: string;
  pendingConfirmation?: PendingApproval | null;
  profile?: string;
  resumeConversationId?: string;
  sharedSessionId?: string;
  sharedThreadId?: string;
  transcriptPath?: string;
}

export interface BridgeAdapterState {
  activeRuntimeSessionId?: string;
  activeTurnId?: string;
  activeTurnOrigin?: BridgeTurnOrigin;
  command: string;
  cwd: string;
  kind: BridgeAdapterKind;
  lastInputAt?: string;
  lastOutputAt?: string;
  lastSessionSwitchAt?: string;
  lastSessionSwitchReason?: BridgeSessionSwitchReason;
  lastSessionSwitchSource?: BridgeSessionSwitchSource;
  lastThreadSwitchAt?: string;
  lastThreadSwitchReason?: BridgeThreadSwitchReason;
  lastThreadSwitchSource?: BridgeThreadSwitchSource;
  pendingApproval?: ApprovalRequest | null;
  pendingApprovalOrigin?: BridgeTurnOrigin;
  pid?: number;
  profile?: string;
  resumeConversationId?: string;
  sharedSessionId?: string;
  sharedThreadId?: string;
  startedAt?: string;
  status: BridgeWorkerStatus;
  transcriptPath?: string;
}

export type BridgeEvent =
  | {
      type: "stdout";
      text: string;
      timestamp: string;
    }
  | {
      type: "stderr";
      text: string;
      timestamp: string;
    }
  | {
      type: "final_reply";
      text: string;
      timestamp: string;
    }
  | {
      type: "status";
      status: BridgeWorkerStatus;
      message?: string;
      timestamp: string;
    }
  | {
      type: "notice";
      text: string;
      level: BridgeNoticeLevel;
      timestamp: string;
    }
  | {
      type: "approval_required";
      request: ApprovalRequest | PendingApproval;
      timestamp: string;
    }
  | {
      type: "mirrored_user_input";
      text: string;
      timestamp: string;
      origin: "local";
    }
  | {
      type: "session_switched";
      sessionId: string;
      source: BridgeSessionSwitchSource;
      reason: BridgeSessionSwitchReason;
      timestamp: string;
    }
  | {
      type: "thread_switched";
      threadId: string;
      source: BridgeThreadSwitchSource;
      reason: BridgeThreadSwitchReason;
      timestamp: string;
    }
  | {
      type: "task_complete";
      exitCode?: number;
      summary?: string;
      timestamp: string;
    }
  | {
      type: "task_failed";
      message: string;
      timestamp: string;
    }
  | {
      type: "fatal_error";
      message: string;
      timestamp: string;
    }
  | {
      type: "shutdown_requested";
      reason: "companion_closed" | "companion_reconnect_timeout";
      message: string;
      exitCode?: number;
      timestamp: string;
    };

export interface BridgeAdapter {
  dispose(): Promise<void>;
  getState(): BridgeAdapterState;
  interrupt(): Promise<boolean>;
  listResumeSessions(limit?: number): Promise<BridgeResumeSessionCandidate[]>;
  reset(): Promise<void>;
  resolveApproval(action: "confirm" | "deny"): Promise<boolean>;
  resumeSession(sessionId: string): Promise<void>;
  sendInput(input: BridgeAdapterInput): Promise<void>;
  setEventSink(sink: (event: BridgeEvent) => void): void;
  start(): Promise<void>;
}
