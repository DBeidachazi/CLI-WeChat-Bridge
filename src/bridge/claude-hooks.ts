import type { ApprovalRequest } from "./bridge-types.ts";
import { normalizeOutput, truncatePreview } from "./bridge-utils.ts";

export type ClaudeHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PermissionRequest"
  | "Notification"
  | "Stop"
  | "StopFailure";

export type ClaudeHookPayload = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: ClaudeHookEventName | string;
  source?: string;
  prompt?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  permission_suggestions?: unknown[];
  notification_type?: string;
  message?: string;
  title?: string;
  last_assistant_message?: string;
  error?: string;
  error_details?: string;
  stop_hook_active?: boolean;
};

export type PendingInjectedClaudePrompt = {
  normalizedText: string;
  createdAtMs: number;
};

export type ClaudePermissionDecisionAction = "confirm" | "deny";

export function parseClaudeHookPayload(raw: string): ClaudeHookPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as ClaudeHookPayload;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function extractClaudeResumeConversationId(
  transcriptPath: string | undefined,
): string | null {
  if (typeof transcriptPath !== "string") {
    return null;
  }

  const trimmed = transcriptPath.trim();
  if (!trimmed) {
    return null;
  }

  const segments = trimmed.split(/[\\/]+/);
  const fileName = segments[segments.length - 1] ?? "";
  if (!fileName.toLowerCase().endsWith(".jsonl")) {
    return null;
  }

  const conversationId = fileName.slice(0, -".jsonl".length).trim();
  return conversationId || null;
}

export function buildClaudeHookSettings(command: string): Record<string, unknown> {
  const hook = {
    hooks: [
      {
        type: "command",
        command,
      },
    ],
  };

  return {
    hooks: {
      SessionStart: [hook],
      UserPromptSubmit: [hook],
      PermissionRequest: [hook],
      Notification: [
        {
          matcher: "permission_prompt",
          hooks: hook.hooks,
        },
      ],
      Stop: [hook],
      StopFailure: [hook],
    },
  };
}

function summarizeClaudeToolInput(toolInput: Record<string, unknown> | undefined): string {
  if (!toolInput) {
    return "(no input)";
  }

  if (typeof toolInput.command === "string" && toolInput.command.trim()) {
    return toolInput.command.trim();
  }

  if (typeof toolInput.file_path === "string" && toolInput.file_path.trim()) {
    return toolInput.file_path.trim();
  }

  if (typeof toolInput.pattern === "string" && toolInput.pattern.trim()) {
    return toolInput.pattern.trim();
  }

  if (typeof toolInput.url === "string" && toolInput.url.trim()) {
    return toolInput.url.trim();
  }

  return truncatePreview(JSON.stringify(toolInput), 180);
}

export function buildClaudePermissionApprovalRequest(
  payload: ClaudeHookPayload,
): ApprovalRequest {
  const toolName =
    typeof payload.tool_name === "string" && payload.tool_name.trim()
      ? payload.tool_name.trim()
      : "Tool";
  const target = summarizeClaudeToolInput(payload.tool_input);

  return {
    source: "cli",
    summary: `Claude permission is required for ${toolName}.`,
    commandPreview: `${toolName}: ${target}`,
  };
}

export function buildClaudePermissionDecisionHookOutput(
  action: ClaudePermissionDecisionAction,
): string {
  const decision =
    action === "confirm"
      ? {
          behavior: "allow",
        }
      : {
          behavior: "deny",
          message: "Permission denied from WeChat bridge.",
          interrupt: false,
        };

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision,
    },
  });
}

export function normalizeClaudeAssistantMessage(payload: ClaudeHookPayload): string {
  const text =
    typeof payload.last_assistant_message === "string"
      ? normalizeOutput(payload.last_assistant_message).trim()
      : "";
  return text || "(no final reply)";
}

export function buildClaudeFailureMessage(payload: ClaudeHookPayload): string {
  const details = [
    typeof payload.last_assistant_message === "string"
      ? normalizeOutput(payload.last_assistant_message).trim()
      : "",
    typeof payload.error_details === "string"
      ? normalizeOutput(payload.error_details).trim()
      : "",
    typeof payload.error === "string" ? payload.error.trim() : "",
  ].filter(Boolean);

  return truncatePreview(details.join(" | ") || "Claude reported an unknown error.", 500);
}

export function findInjectedClaudePromptIndex(
  prompt: string,
  pendingInputs: PendingInjectedClaudePrompt[],
  nowMs = Date.now(),
  maxAgeMs = 15_000,
): number {
  const normalizedPrompt = normalizeOutput(prompt).trim();
  if (!normalizedPrompt) {
    return -1;
  }

  return pendingInputs.findIndex((candidate) => {
    if (nowMs - candidate.createdAtMs > maxAgeMs) {
      return false;
    }
    return candidate.normalizedText === normalizedPrompt;
  });
}
