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

type ClaudeHookScriptParams = {
  platform?: NodeJS.Platform;
  runtimeExecPath: string;
  hookEntryPath: string;
  hookPort: number;
  hookToken: string;
};

function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quotePosixCommandArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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

export function buildClaudeHookScript(params: ClaudeHookScriptParams): string {
  if (params.platform === "win32") {
    return [
      "@echo off",
      "setlocal",
      `set "CLAUDE_WECHAT_HOOK_PORT=${params.hookPort}"`,
      `set "CLAUDE_WECHAT_HOOK_TOKEN=${params.hookToken}"`,
      // Claude reads hook decisions from stdout, so only stderr can be discarded here.
      `${quoteWindowsCommandArg(params.runtimeExecPath)} --no-warnings --experimental-strip-types ${quoteWindowsCommandArg(params.hookEntryPath)} 2>nul`,
      "exit /b 0",
    ].join("\r\n");
  }

  return [
    "#!/bin/sh",
    `export CLAUDE_WECHAT_HOOK_PORT=${quotePosixCommandArg(String(params.hookPort))}`,
    `export CLAUDE_WECHAT_HOOK_TOKEN=${quotePosixCommandArg(params.hookToken)}`,
    // Claude reads hook decisions from stdout, so only stderr can be discarded here.
    `${quotePosixCommandArg(params.runtimeExecPath)} --no-warnings --experimental-strip-types ${quotePosixCommandArg(params.hookEntryPath)} 2>/dev/null || true`,
    "exit 0",
  ].join("\n");
}

function summarizeClaudePlan(plan: string): string {
  const lines = normalizeOutput(plan)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "(empty plan)";
  }

  const heading = lines
    .find((line) => /^#+\s+/.test(line))
    ?.replace(/^#+\s+/, "")
    .trim();
  const description = lines.find(
    (line) =>
      !/^#+\s+/.test(line) &&
      !/^[-*]\s+/.test(line) &&
      !/^\d+\.\s+/.test(line),
  );

  return truncatePreview([heading, description].filter(Boolean).join(" - ") || lines[0], 180);
}

function summarizeClaudeToolInput(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): {
  detailLabel: string;
  detailPreview: string;
} {
  if (!toolInput) {
    return {
      detailLabel: "details",
      detailPreview: "(no input)",
    };
  }

  if (toolName === "ExitPlanMode" && typeof toolInput.plan === "string") {
    return {
      detailLabel: "plan",
      detailPreview: summarizeClaudePlan(toolInput.plan),
    };
  }

  if (typeof toolInput.command === "string" && toolInput.command.trim()) {
    return {
      detailLabel: "command",
      detailPreview: toolInput.command.trim(),
    };
  }

  if (typeof toolInput.file_path === "string" && toolInput.file_path.trim()) {
    return {
      detailLabel: "path",
      detailPreview: toolInput.file_path.trim(),
    };
  }

  if (typeof toolInput.pattern === "string" && toolInput.pattern.trim()) {
    return {
      detailLabel: "pattern",
      detailPreview: toolInput.pattern.trim(),
    };
  }

  if (typeof toolInput.url === "string" && toolInput.url.trim()) {
    return {
      detailLabel: "url",
      detailPreview: toolInput.url.trim(),
    };
  }

  return {
    detailLabel: "details",
    detailPreview: truncatePreview(JSON.stringify(toolInput), 180),
  };
}

export function buildClaudePermissionApprovalRequest(
  payload: ClaudeHookPayload,
): ApprovalRequest {
  const toolName =
    typeof payload.tool_name === "string" && payload.tool_name.trim()
      ? payload.tool_name.trim()
      : "Tool";
  const { detailLabel, detailPreview } = summarizeClaudeToolInput(toolName, payload.tool_input);

  return {
    source: "cli",
    summary: `Claude permission is required for ${toolName}.`,
    commandPreview: `${toolName}: ${detailPreview}`,
    toolName,
    detailLabel,
    detailPreview,
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
