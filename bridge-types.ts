export type BridgeAdapterKind = "codex" | "claude" | "shell";
export type BridgeTurnOrigin = "wechat" | "local";
export type BridgeThreadSwitchSource = BridgeTurnOrigin | "restore";
export type BridgeThreadSwitchReason =
  | "local_follow"
  | "local_session_fallback"
  | "local_turn"
  | "wechat_resume"
  | "startup_restore";

export type BridgeWorkerStatus =
  | "starting"
  | "idle"
  | "busy"
  | "awaiting_approval"
  | "stopped"
  | "error";

export type ApprovalSource = "shell" | "cli";

export type ApprovalRequest = {
  source: ApprovalSource;
  summary: string;
  commandPreview: string;
  confirmInput?: string;
  denyInput?: string;
};

export type PendingApproval = ApprovalRequest & {
  code: string;
  createdAt: string;
};

export type BridgeResumeThreadCandidate = {
  threadId: string;
  title: string;
  lastUpdatedAt: string;
  source?: string;
};

export type BridgeState = {
  instanceId: string;
  adapter: BridgeAdapterKind;
  command: string;
  cwd: string;
  profile?: string;
  bridgeStartedAtMs: number;
  authorizedUserId: string;
  ignoredBacklogCount: number;
  sharedThreadId?: string;
  pendingConfirmation?: PendingApproval | null;
  lastActivityAt?: string;
};

export type BridgeAdapterState = {
  kind: BridgeAdapterKind;
  status: BridgeWorkerStatus;
  pid?: number;
  cwd: string;
  command: string;
  profile?: string;
  startedAt?: string;
  lastInputAt?: string;
  lastOutputAt?: string;
  pendingApproval?: ApprovalRequest | null;
  sharedThreadId?: string;
  lastThreadSwitchAt?: string;
  lastThreadSwitchSource?: BridgeThreadSwitchSource;
  lastThreadSwitchReason?: BridgeThreadSwitchReason;
  activeTurnId?: string;
  activeTurnOrigin?: BridgeTurnOrigin;
  pendingApprovalOrigin?: BridgeTurnOrigin;
};

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
      type: "status";
      status: BridgeWorkerStatus;
      message?: string;
      timestamp: string;
    }
  | {
      type: "approval_required";
      request: ApprovalRequest;
      timestamp: string;
    }
  | {
      type: "mirrored_user_input";
      text: string;
      timestamp: string;
      origin: "local";
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
      type: "fatal_error";
      message: string;
      timestamp: string;
    };

export interface BridgeAdapter {
  setEventSink(sink: (event: BridgeEvent) => void): void;
  start(): Promise<void>;
  sendInput(text: string): Promise<void>;
  listResumeThreads(limit?: number): Promise<BridgeResumeThreadCandidate[]>;
  resumeThread(threadId: string): Promise<void>;
  interrupt(): Promise<boolean>;
  reset(): Promise<void>;
  resolveApproval(action: "confirm" | "deny"): Promise<boolean>;
  dispose(): Promise<void>;
  getState(): BridgeAdapterState;
}
