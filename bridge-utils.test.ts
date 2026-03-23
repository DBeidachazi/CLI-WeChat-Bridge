import { describe, expect, test } from "bun:test";

import type { BridgeAdapterState, BridgeState } from "./bridge-types.ts";
import {
  buildOneTimeCode,
  detectCliApproval,
  formatResumeThreadList,
  formatStatusReport,
  formatThreadSwitchMessage,
  isHighRiskShellCommand,
  MESSAGE_START_GRACE_MS,
  OutputBatcher,
  parseCodexSessionAgentMessage,
  parseSystemCommand,
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
  });

  test("allows low-risk commands", () => {
    expect(isHighRiskShellCommand("Get-ChildItem")).toBe(false);
    expect(isHighRiskShellCommand("git status")).toBe(false);
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
      sharedThreadId: "thread_persisted",
      pendingConfirmation: null,
      lastActivityAt: "2026-03-23T12:00:00.000Z",
    };
    const adapterState: BridgeAdapterState = {
      kind: "codex",
      status: "busy",
      cwd: "C:\\repo",
      command: "codex",
      sharedThreadId: "thread_123",
      lastThreadSwitchAt: "2026-03-23T12:05:00.000Z",
      lastThreadSwitchSource: "local",
      lastThreadSwitchReason: "local_follow",
      activeTurnId: "turn_456",
      activeTurnOrigin: "local",
      pendingApprovalOrigin: "local",
    };

    expect(formatStatusReport(bridgeState, adapterState)).toContain(
      "shared_thread_id: thread_123",
    );
    expect(formatStatusReport(bridgeState, adapterState)).toContain(
      "last_thread_switch_source: local",
    );
    expect(formatStatusReport(bridgeState, adapterState)).toContain(
      "last_thread_switch_reason: local_follow",
    );
    expect(formatStatusReport(bridgeState, adapterState)).toContain(
      "persisted_shared_thread_id: thread_persisted",
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
