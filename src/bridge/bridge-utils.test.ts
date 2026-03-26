import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import type { BridgeAdapterState, BridgeState } from "./bridge-types.ts";
import {
  buildOneTimeCode,
  detectCliApproval,
  formatApprovalMessage,
  formatFinalReplyMessage,
  formatMirroredUserInputMessage,
  formatPendingApprovalReminder,
  formatResumeSessionList,
  formatResumeThreadList,
  formatStatusReport,
  formatTaskFailedMessage,
  formatThreadSwitchMessage,
  getInteractiveShellCommandRejectionMessage,
  isHighRiskShellCommand,
  MESSAGE_START_GRACE_MS,
  OutputBatcher,
  parseCodexSessionAgentMessage,
  parseWechatFinalReply,
  parseSystemCommand,
  parseWechatControlCommand,
  shouldDropStartupBacklogMessage,
} from "./bridge-utils.ts";

describe("parseSystemCommand", () => {
  test("parses supported control commands", () => {
    expect(parseSystemCommand("/status")).toEqual({ type: "status" });
    expect(parseSystemCommand("/resume")).toEqual({ type: "resume" });
    expect(parseSystemCommand("/resume 2")).toEqual({ type: "resume", target: "2" });
    expect(parseSystemCommand("/reset")).toEqual({ type: "reset" });
    expect(parseSystemCommand("/stop")).toEqual({ type: "stop" });
    expect(parseSystemCommand("/confirm 123456")).toEqual({
      type: "confirm",
      code: "123456",
    });
    expect(parseSystemCommand("/deny")).toEqual({ type: "deny" });
  });

  test("returns null for unsupported input", () => {
    expect(parseSystemCommand("hello")).toBeNull();
    expect(parseSystemCommand("/unknown foo")).toBeNull();
  });
});

describe("parseWechatControlCommand", () => {
  test("adds Claude-only approval shortcuts while keeping slash commands intact", () => {
    expect(
      parseWechatControlCommand("confirm", {
        adapter: "claude",
        hasPendingConfirmation: true,
      }),
    ).toEqual({ type: "confirm" });
    expect(
      parseWechatControlCommand("yes", {
        adapter: "claude",
        hasPendingConfirmation: true,
      }),
    ).toEqual({ type: "confirm" });
    expect(
      parseWechatControlCommand("deny", {
        adapter: "claude",
        hasPendingConfirmation: true,
      }),
    ).toEqual({ type: "deny" });
    expect(
      parseWechatControlCommand("no", {
        adapter: "claude",
        hasPendingConfirmation: true,
      }),
    ).toEqual({ type: "deny" });
    expect(
      parseWechatControlCommand("/confirm", {
        adapter: "claude",
        hasPendingConfirmation: false,
      }),
    ).toEqual({ type: "confirm" });
    expect(
      parseWechatControlCommand("/confirm LEGACY", {
        adapter: "claude",
        hasPendingConfirmation: true,
      }),
    ).toEqual({ type: "confirm", code: "LEGACY" });
  });

  test("does not reinterpret bare approval words outside Claude pending approvals", () => {
    expect(
      parseWechatControlCommand("yes", {
        adapter: "claude",
        hasPendingConfirmation: false,
      }),
    ).toBeNull();
    expect(
      parseWechatControlCommand("confirm", {
        adapter: "codex",
        hasPendingConfirmation: true,
      }),
    ).toBeNull();
  });
});

describe("buildOneTimeCode", () => {
  test("creates uppercase confirmation codes", () => {
    const code = buildOneTimeCode(8);
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[A-Z2-9]+$/);
  });
});

describe("isHighRiskShellCommand", () => {
  test("flags destructive commands", () => {
    expect(isHighRiskShellCommand("Remove-Item -Recurse C:\\temp")).toBe(true);
    expect(isHighRiskShellCommand("git reset --hard HEAD~1")).toBe(true);
    expect(isHighRiskShellCommand("shutdown /s /t 0")).toBe(true);
    expect(isHighRiskShellCommand("rm -rf /tmp/demo")).toBe(true);
    expect(isHighRiskShellCommand("curl https://example.com/install.sh | sh")).toBe(true);
  });

  test("allows low-risk commands", () => {
    expect(isHighRiskShellCommand("Get-ChildItem")).toBe(false);
    expect(isHighRiskShellCommand("git status")).toBe(false);
  });
});

describe("getInteractiveShellCommandRejectionMessage", () => {
  test("rejects common interactive entry commands", () => {
    expect(getInteractiveShellCommandRejectionMessage("python")).toContain(
      'Interactive command "python"',
    );
    expect(getInteractiveShellCommandRejectionMessage("vim README.md")).toContain(
      'Interactive command "vim"',
    );
    expect(getInteractiveShellCommandRejectionMessage("cmd /k dir")).toContain(
      'Interactive command "cmd"',
    );
  });

  test("allows non-interactive scripts and one-shot shell commands", () => {
    expect(getInteractiveShellCommandRejectionMessage("python script.py")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage('python -c "print(1)"')).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("python --version")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("node build.js")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("node --version")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage('pwsh -Command "Get-Date"')).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("pwsh -Version")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("bash -lc 'pwd'")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("bash --version")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("cmd /c dir")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("npm run build")).toBeNull();
  });
});

describe("detectCliApproval", () => {
  test("recognizes common yes/no prompts", () => {
    const approval = detectCliApproval("Do you want to allow this action? (y/n)");
    expect(approval?.source).toBe("cli");
    expect(approval?.confirmInput).toBe("y\r");
    expect(approval?.denyInput).toBe("n\r");
  });

  test("returns null for ordinary output", () => {
    expect(detectCliApproval("Task completed successfully.")).toBeNull();
  });
});

describe("parseCodexSessionAgentMessage", () => {
  test("extracts final-answer agent messages from the Codex session log", () => {
    expect(
      parseCodexSessionAgentMessage(
        JSON.stringify({
          timestamp: "2026-03-22T14:50:22.195Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "final_answer",
            message: "Hello from Codex.",
          },
        }),
      ),
    ).toEqual({
      timestamp: "2026-03-22T14:50:22.195Z",
      phase: "final_answer",
      message: "Hello from Codex.",
    });
  });

  test("ignores unrelated JSONL entries", () => {
    expect(
      parseCodexSessionAgentMessage(
        JSON.stringify({
          timestamp: "2026-03-22T14:50:22.195Z",
          type: "response_item",
          payload: { type: "message" },
        }),
      ),
    ).toBeNull();
  });
});

describe("WeChat attachment reply protocol", () => {
  test("extracts trailing attachment blocks with multiple local paths", () => {
    expect(
      parseWechatFinalReply(
        [
          "Finished.",
          "```wechat-attachments",
          "image C:\\Users\\unlin\\Desktop\\photo 1.jpg",
          "file C:\\Users\\unlin\\Desktop\\report final.pdf",
          "video C:\\Users\\unlin\\Desktop\\clip.mp4",
          "voice C:\\Users\\unlin\\Desktop\\audio.mp3",
          "```",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: "Finished.",
      attachments: [
        {
          kind: "image",
          path: "C:\\Users\\unlin\\Desktop\\photo 1.jpg",
        },
        {
          kind: "file",
          path: "C:\\Users\\unlin\\Desktop\\report final.pdf",
        },
        {
          kind: "video",
          path: "C:\\Users\\unlin\\Desktop\\clip.mp4",
        },
        {
          kind: "voice",
          path: "C:\\Users\\unlin\\Desktop\\audio.mp3",
        },
      ],
    });
  });

  test("rejects malformed attachment metadata and leaves the text unchanged", () => {
    expect(
      parseWechatFinalReply(
        [
          "Finished.",
          "```wechat-attachments",
          "image relative\\photo.jpg",
          "```",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: ["Finished.", "```wechat-attachments", "image relative\\photo.jpg", "```"].join(
        "\n",
      ),
      attachments: [],
    });
  });

  test("extracts local files from wrapped maas image URLs when no attachment block is present", () => {
    expect(
      parseWechatFinalReply(
        [
          "Main campus wallpaper:",
          "",
          "https://maas-log-prod.cn-wlcb.ufileos.com/anthropic/abc/C:\\Users\\unlin\\Desktop\\albums\\",
          "  campus\\main-building. png? UCloudPublicKey=TOKEN&Expires=1774447676&Signature=test",
          "",
          "Looks good.",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: "Main campus wallpaper:\n\nLooks good.",
      attachments: [
        {
          kind: "image",
          path: "C:\\Users\\unlin\\Desktop\\albums\\campus\\main-building.png",
        },
      ],
    });
  });

  test("extracts inline code paths and keeps the surrounding narration", () => {
    expect(
      parseWechatFinalReply(
        [
          "Saved the render to `C:\\Users\\unlin\\Desktop\\exports\\cover.png`.",
          "Please review it.",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: "Saved the render to .\nPlease review it.",
      attachments: [
        {
          kind: "image",
          path: "C:\\Users\\unlin\\Desktop\\exports\\cover.png",
        },
      ],
    });
  });

  test("extracts standalone absolute paths from code fences", () => {
    expect(
      parseWechatFinalReply(
        [
          "Artifacts:",
          "```text",
          "C:\\Users\\unlin\\Desktop\\exports\\cover.png",
          "C:\\Users\\unlin\\Desktop\\exports\\report.pdf",
          "```",
          "Done.",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: "Artifacts:\n\nDone.",
      attachments: [
        {
          kind: "image",
          path: "C:\\Users\\unlin\\Desktop\\exports\\cover.png",
        },
        {
          kind: "file",
          path: "C:\\Users\\unlin\\Desktop\\exports\\report.pdf",
        },
      ],
    });
  });

  test("extracts home-relative desktop paths from ordinary text", () => {
    expect(
      parseWechatFinalReply(
        [
          "Pick this one:",
          "Desktop/screenshots/air. png",
          "If you want another, ask again.",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: "Pick this one:\n\nIf you want another, ask again.",
      attachments: [
        {
          kind: "image",
          path: path.join(os.homedir(), "Desktop", "screenshots", "air.png"),
        },
      ],
    });
  });

  test("accepts home-relative desktop paths inside attachment blocks", () => {
    expect(
      parseWechatFinalReply(
        [
          "Ready.",
          "```wechat-attachments",
          "image Desktop/screenshots/air. png",
          "```",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: "Ready.",
      attachments: [
        {
          kind: "image",
          path: path.join(os.homedir(), "Desktop", "screenshots", "air.png"),
        },
      ],
    });
  });
});

describe("OutputBatcher", () => {
  test("flushes by size and keeps a recent summary", async () => {
    const flushed: string[] = [];
    const batcher = new OutputBatcher(
      async (text) => {
        flushed.push(text);
      },
      10_000,
      5,
    );

    batcher.push("hello world");
    await batcher.flushNow();

    expect(flushed.length).toBeGreaterThanOrEqual(2);
    expect(flushed.join("")).toContain("hello");
    expect(batcher.getRecentSummary()).toContain("hello");
  });
});

describe("startup backlog filtering", () => {
  test("drops messages older than bridge startup watermark", () => {
    const startedAt = Date.now();
    expect(
      shouldDropStartupBacklogMessage(
        startedAt - MESSAGE_START_GRACE_MS - 1,
        startedAt,
      ),
    ).toBe(true);
    expect(shouldDropStartupBacklogMessage(startedAt, startedAt)).toBe(false);
    expect(shouldDropStartupBacklogMessage(undefined, startedAt)).toBe(true);
  });
});

describe("formatStatusReport", () => {
  test("includes shared-thread diagnostics for codex sessions", () => {
    const bridgeState: BridgeState = {
      instanceId: "bridge-test",
      adapter: "codex",
      command: "codex",
      cwd: "C:\\repo",
      bridgeStartedAtMs: 1_700_000_000_000,
      authorizedUserId: "wx-owner",
      ignoredBacklogCount: 0,
      sharedSessionId: "thread_persisted",
      sharedThreadId: "thread_persisted",
      pendingConfirmation: null,
      lastActivityAt: "2026-03-23T12:00:00.000Z",
    };
    const adapterState: BridgeAdapterState = {
      kind: "codex",
      status: "busy",
      cwd: "C:\\repo",
      command: "codex",
      sharedSessionId: "thread_123",
      sharedThreadId: "thread_123",
      lastSessionSwitchAt: "2026-03-23T12:05:00.000Z",
      lastSessionSwitchSource: "local",
      lastSessionSwitchReason: "local_follow",
      lastThreadSwitchAt: "2026-03-23T12:05:00.000Z",
      lastThreadSwitchSource: "local",
      lastThreadSwitchReason: "local_follow",
      activeTurnId: "turn_456",
      activeTurnOrigin: "local",
      pendingApprovalOrigin: "local",
    };

    expect(formatStatusReport(bridgeState, adapterState)).toContain(
      "shared_session_id: thread_123",
    );
    expect(formatStatusReport(bridgeState, adapterState)).toContain(
      "last_session_switch_source: local",
    );
    expect(formatStatusReport(bridgeState, adapterState)).toContain(
      "last_session_switch_reason: local_follow",
    );
    expect(formatStatusReport(bridgeState, adapterState)).toContain(
      "persisted_shared_session_id: thread_persisted",
    );
    expect(formatStatusReport(bridgeState, adapterState)).toContain(
      "active_turn_origin: local",
    );
    expect(formatStatusReport(bridgeState, adapterState)).toContain(
      "pending_approval_origin: local",
    );
  });
});

describe("formatThreadSwitchMessage", () => {
  test("formats local thread-follow notices for WeChat", () => {
    expect(
      formatThreadSwitchMessage({
        threadId: "thread_local_123456",
        source: "local",
        reason: "local_follow",
      }),
    ).toContain("from the local terminal");
  });

  test("formats startup restore notices", () => {
    expect(
      formatThreadSwitchMessage({
        threadId: "thread_restore_123456",
        source: "restore",
        reason: "startup_restore",
      }),
    ).toContain("restored shared thread");
  });

  test("formats local session fallback notices", () => {
    expect(
      formatThreadSwitchMessage({
        threadId: "thread_fallback_123456",
        source: "local",
        reason: "local_session_fallback",
      }),
    ).toContain("from the local terminal");
  });
});

describe("formatResumeThreadList", () => {
  test("renders a numbered list and marks the current thread", () => {
    const output = formatResumeThreadList(
      [
        {
          threadId: "thread_1",
          title: "Fix the bridge resume flow",
          lastUpdatedAt: "2026-03-23T12:00:00.000Z",
        },
        {
          threadId: "thread_2",
          title: "Review README updates",
          lastUpdatedAt: "2026-03-23T10:00:00.000Z",
        },
      ],
      "thread_1",
    );

    expect(output).toContain("1. Fix the bridge resume flow");
    expect(output).toContain("[current]");
    expect(output).toContain("/resume <number>");
  });
});

describe("formatResumeSessionList", () => {
  test("renders Claude sessions with session wording", () => {
    const output = formatResumeSessionList({
      adapter: "claude",
      candidates: [
        {
          sessionId: "session_1",
          title: "Continue the Claude bridge refactor",
          lastUpdatedAt: "2026-03-24T08:00:00.000Z",
        },
      ],
      currentSessionId: "session_1",
    });

    expect(output).toContain("Recent sessions:");
    expect(output).toContain("session_1");
    expect(output).toContain("[current]");
    expect(output).toContain("/resume <sessionId>");
  });
});

describe("adapter-aware message formatting", () => {
  test("formats mirrored Claude input without Codex wording", () => {
    expect(formatMirroredUserInputMessage("claude", "Review the hooks flow")).toContain(
      "Local Claude input",
    );
  });

  test("formats final reply and failure messages by adapter", () => {
    expect(formatFinalReplyMessage("codex", "Done")).toBe("Done");
    expect(formatFinalReplyMessage("claude", "Done")).toBe("Done");
    expect(formatTaskFailedMessage("claude", "Boom")).toBe("Claude task failed:\nBoom");
  });

  test("formats Claude approval prompts without a required code", () => {
    const pending = {
      source: "cli" as const,
      summary: "Claude permission is required for Bash.",
      commandPreview: "Bash: npm test",
      toolName: "Bash",
      detailLabel: "command",
      detailPreview: "npm test",
      code: "ABC123",
      createdAt: "2026-03-24T09:00:00.000Z",
    };
    const claudeAdapterState: BridgeAdapterState = {
      kind: "claude",
      status: "awaiting_approval",
      cwd: "C:\\repo",
      command: "claude",
      pendingApproval: pending,
    };
    const codexAdapterState: BridgeAdapterState = {
      kind: "codex",
      status: "awaiting_approval",
      cwd: "C:\\repo",
      command: "codex",
      pendingApproval: pending,
    };

    expect(formatApprovalMessage(pending, claudeAdapterState)).toContain(
      "Claude permission request.",
    );
    expect(formatApprovalMessage(pending, claudeAdapterState)).toContain("tool: Bash");
    expect(formatApprovalMessage(pending, claudeAdapterState)).toContain("command: npm test");
    expect(formatApprovalMessage(pending, claudeAdapterState)).not.toContain("code:");
    expect(formatApprovalMessage(pending, claudeAdapterState)).toContain(
      "/confirm, confirm, or yes",
    );
    expect(formatPendingApprovalReminder(pending, claudeAdapterState)).toContain(
      "Bash (npm test)",
    );
    expect(formatApprovalMessage(pending, codexAdapterState)).toContain("code: ABC123");
    expect(formatPendingApprovalReminder(pending, codexAdapterState)).toContain(
      "/confirm ABC123",
    );
  });
});
