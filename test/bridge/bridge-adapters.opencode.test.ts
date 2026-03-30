import { describe, expect, test } from "bun:test";

import {
  createBridgeAdapter,
  resolveDefaultAdapterCommand,
  getLocalCompanionCommandName,
} from "../../src/bridge/bridge-adapters.ts";
import {
  OpenCodeServerAdapter,
} from "../../src/bridge/bridge-adapters.opencode.ts";
import {
  formatFinalReplyMessage,
  formatMirroredUserInputMessage,
  formatResumeSessionList,
  formatTaskFailedMessage,
} from "../../src/bridge/bridge-utils.ts";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

describe("OpenCode adapter factory", () => {
  test("creates an OpenCodeServerAdapter in embedded render mode", () => {
    const adapter = createBridgeAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "embedded",
    });

    expect(adapter).toBeInstanceOf(OpenCodeServerAdapter);
  });

  test("rejects legacy companion render mode", () => {
    expect(() =>
      createBridgeAdapter({
        kind: "opencode",
        command: "opencode",
        cwd: process.cwd(),
        renderMode: "companion",
      }),
    ).toThrow(
      'OpenCode only supports renderMode "embedded". Start the visible panel with "wechat-opencode".',
    );
  });

  test("rejects missing render mode", () => {
    expect(() =>
      createBridgeAdapter({
        kind: "opencode",
        command: "opencode",
        cwd: process.cwd(),
      }),
    ).toThrow(
      'OpenCode only supports renderMode "embedded". Start the visible panel with "wechat-opencode".',
    );
  });

  test("creates an OpenCodeServerAdapter that accepts initialSharedSessionId option", () => {
    const adapter = createBridgeAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "embedded",
      initialSharedSessionId: "session-initial-123",
    });

    expect(adapter).toBeInstanceOf(OpenCodeServerAdapter);
    // initialSharedSessionId is applied during start() → initializeSessions(),
    // not in the constructor.
    expect(adapter.getState().status).toBe("stopped");
  });
});

/* ------------------------------------------------------------------ */
/*  Constructor & initial state                                       */
/* ------------------------------------------------------------------ */

describe("OpenCodeServerAdapter initial state", () => {
  test("starts in stopped status with correct kind and command", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });

    const state = adapter.getState();
    expect(state.status).toBe("stopped");
    expect(state.kind).toBe("opencode");
    expect(state.command).toBe("opencode");
    expect(state.cwd).toBe(process.cwd());
  });

  test("preserves profile option when provided", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      profile: "wechat",
    });

    expect(adapter.getState().profile).toBe("wechat");
  });
});

/* ------------------------------------------------------------------ */
/*  SSE event handling                                                 */
/* ------------------------------------------------------------------ */

describe("OpenCode SSE event dispatch", () => {
  function createTestAdapter() {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as Record<string, unknown>);
    });
    const internal = adapter as unknown as {
      state: { status: string; activeTurnOrigin?: string };
      activeSessionId: string | null;
      hasAcceptedInput: boolean;
      currentPreview: string;
      pendingPermission: unknown;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
      shuttingDown: boolean;
    };
    return { adapter, events, internal };
  }

  test("ignores server.connected and server.heartbeat events", () => {
    const { events, internal } = createTestAdapter();

    internal.handleSseEvent({ type: "server.connected" });
    internal.handleSseEvent({ type: "server.heartbeat" });

    expect(events).toHaveLength(0);
  });

  test("ignores events with non-record properties without crashing", () => {
    const { events, internal } = createTestAdapter();

    internal.handleSseEvent({ type: "session.idle", properties: "not a record" });
    internal.handleSseEvent({ type: "session.status", properties: null });
    internal.handleSseEvent({ type: "session.created", properties: 42 });

    expect(events).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  session.idle handling                                             */
/* ------------------------------------------------------------------ */

describe("OpenCode session.idle handling", () => {
  function createBusyAdapter() {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as Record<string, unknown>);
    });
    const internal = adapter as unknown as {
      state: { status: string; activeTurnOrigin?: string };
      activeSessionId: string | null;
      hasAcceptedInput: boolean;
      currentPreview: string;
      pendingPermission: unknown;
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
      shuttingDown: boolean;
      workingNoticeSent: boolean;
    };

    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";
    internal.activeSessionId = "session_idle_1";
    internal.hasAcceptedInput = true;
    internal.currentPreview = "Summarize the repo";

    return { adapter, events, internal };
  }

  test("completes a WeChat turn after session idle with final reply", async () => {
    const { events, internal } = createBusyAdapter();

    internal.handleSseEvent({
      type: "message.part.updated",
      properties: { part: { id: "p_idle_1", type: "text", text: "Final visible answer" } },
    });

    // Real SDK: EventSessionIdle = { type: "session.idle", properties: { sessionID: string } }
    internal.handleSseEvent({
      type: "session.idle",
      properties: { sessionID: "session_idle_1" },
    });

    // Wait for the settle delay (OPENCODE_SESSION_IDLE_SETTLE_MS = 1_500).
    await wait(1_800);

    const statusEvents = events.filter((e) => e.type === "status");
    const taskCompleteEvents = events.filter((e) => e.type === "task_complete");
    const finalReplyEvents = events.filter((e) => e.type === "final_reply");

    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    expect(statusEvents[statusEvents.length - 1]?.status).toBe("idle");
    expect(finalReplyEvents).toHaveLength(1);
    expect(finalReplyEvents[0]?.text).toBe("Final visible answer");
    expect(taskCompleteEvents).toHaveLength(1);
    expect(taskCompleteEvents[0]?.summary).toBe("Summarize the repo");
    expect(internal.outputBatcher.getRecentSummary(500)).toBe("(no output)");
  });

  test("ignores session idle when not in busy status", () => {
    const { events, internal } = createBusyAdapter();
    internal.state.status = "idle";

    internal.handleSseEvent({
      type: "session.idle",
      properties: { sessionID: "session_idle_1" },
    });

    // No events should be emitted for idle→idle transitions.
    expect(events.filter((e) => e.type === "task_complete")).toHaveLength(0);
  });

  test("updates active session when idle arrives for a different session", async () => {
    const { events, internal } = createBusyAdapter();

    internal.handleSseEvent({
      type: "session.idle",
      properties: { sessionID: "session_new_idle" },
    });

    await wait(1_800);

    expect(internal.activeSessionId).toBe("session_new_idle");
  });

  test("clears pending permission after session idle", async () => {
    const { events, internal } = createBusyAdapter();
    internal.state.status = "awaiting_approval";
    internal.pendingPermission = { code: "TESTCODE" };

    internal.handleSseEvent({
      type: "session.idle",
      properties: { sessionID: "session_idle_1" },
    });

    await wait(1_800);

    expect(internal.pendingPermission).toBeNull();
    expect(internal.state.status).toBe("idle");
  });
});

/* ------------------------------------------------------------------ */
/*  session.status handling                                            */
/* ------------------------------------------------------------------ */

describe("OpenCode session.status handling", () => {
  test("transitions from idle to busy on running status", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; status?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; status?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "idle";

    // Real SDK: EventSessionStatus = { type: "session.status", properties: { sessionID: string, status: SessionStatus } }
    // SessionStatus = { type: "busy" } | { type: "idle" } | ...
    internal.handleSseEvent({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "running" } },
    });

    expect(internal.state.status).toBe("busy");
    expect(events).toContainEqual(expect.objectContaining({ type: "status", status: "busy" }));
  });

  test("transitions from idle to busy on busy status", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; status?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; status?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "idle";

    internal.handleSseEvent({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "busy" } },
    });

    expect(internal.state.status).toBe("busy");
  });

  test("does not double-transition when already busy", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      state: { status: string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";

    internal.handleSseEvent({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "running" } },
    });

    // No new status event should be emitted.
    expect(events.filter((e) => e.type === "status")).toHaveLength(0);
  });

  test("ignores non-record properties without crashing", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.handleSseEvent({ type: "session.status", properties: null });
    internal.handleSseEvent({ type: "session.status", properties: { notStatus: "idle" } });
    internal.handleSseEvent({ type: "session.status", properties: { status: "flat-string" } });

    expect(events).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  session.error handling                                             */
/* ------------------------------------------------------------------ */

describe("OpenCode session.error handling", () => {
  test("fails the tracked turn for non-abort session errors", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; message?: string; status?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; message?: string; status?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; activeTurnOrigin?: string };
      hasAcceptedInput: boolean;
      currentPreview: string;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";
    internal.hasAcceptedInput = true;
    internal.currentPreview = "Run the failing test suite";

    internal.handleSseEvent({
      type: "session.error",
      properties: {
        sessionID: "session_error_1",
        error: {
          name: "APIError",
          data: { message: "Provider request failed" },
        },
      },
    });

    expect(internal.state.status).toBe("idle");
    expect(internal.state.activeTurnOrigin).toBeUndefined();
    expect(internal.hasAcceptedInput).toBe(false);
    expect(internal.currentPreview).toBe("(idle)");
    expect(events.filter((event) => event.type === "task_failed")).toEqual([
      expect.objectContaining({
        message: "Provider request failed",
      }),
    ]);
  });

  test("settles aborted turns without emitting task_failed", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; activeTurnOrigin?: string };
      hasAcceptedInput: boolean;
      currentPreview: string;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";
    internal.hasAcceptedInput = true;
    internal.currentPreview = "Cancel the current turn";

    internal.handleSseEvent({
      type: "session.error",
      properties: {
        sessionID: "session_abort_1",
        error: {
          name: "MessageAbortedError",
          data: { message: "Session aborted" },
        },
      },
    });

    expect(internal.state.status).toBe("idle");
    expect(internal.state.activeTurnOrigin).toBeUndefined();
    expect(internal.hasAcceptedInput).toBe(false);
    expect(internal.currentPreview).toBe("(idle)");
    expect(events.filter((event) => event.type === "task_failed")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  permission.updated handling                                        */
/* ------------------------------------------------------------------ */

describe("OpenCode permission.updated handling", () => {
  function createPermissionAdapter() {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as Record<string, unknown>);
    });
    const internal = adapter as unknown as {
      client: unknown;
      state: { status: string; activeTurnOrigin?: string; pendingApproval: unknown; pendingApprovalOrigin?: string };
      activeSessionId: string | null;
      pendingPermission: {
        sessionId: string;
        permissionId: string;
        code: string;
        createdAt: string;
        request: Record<string, unknown>;
      } | null;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    // Permission handling requires a non-null client.
    internal.client = {};
    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";
    internal.activeSessionId = "session_perm_1";

    return { adapter, events, internal };
  }

  test("emits approval_required with one-time code", () => {
    const { events, internal } = createPermissionAdapter();

    // Real SDK: EventPermissionUpdated = { type: "permission.updated", properties: Permission }
    // Permission = { id, sessionID, title, type, metadata, ... }
    internal.handleSseEvent({
      type: "permission.updated",
      properties: {
        id: "perm_123",
        sessionID: "session_perm_1",
        type: "bash",
        title: "Run command: rm -rf /tmp/test",
        metadata: { command: "rm -rf /tmp/test" },
      },
    });

    const approvalEvents = events.filter((e) => e.type === "approval_required");
    expect(approvalEvents).toHaveLength(1);

    expect(internal.state.status).toBe("awaiting_approval");
    expect(internal.pendingPermission).not.toBeNull();
    expect(internal.pendingPermission?.sessionId).toBe("session_perm_1");
    expect(internal.pendingPermission?.permissionId).toBe("perm_123");
    expect(internal.pendingPermission?.code).toMatch(/^[A-Z2-9]+$/);
    expect(internal.pendingPermission?.request).toMatchObject({
      source: "cli",
      toolName: "bash",
    });
  });

  test("extracts title and metadata from permission object", () => {
    const { events, internal } = createPermissionAdapter();

    internal.handleSseEvent({
      type: "permission.updated",
      properties: {
        id: "perm_alt_456",
        sessionID: "session_perm_1",
        type: "web_fetch",
        title: "Fetch URL: https://example.com",
        metadata: { command: "curl https://example.com" },
      },
    });

    const approvalEvents = events.filter((e) => e.type === "approval_required");
    expect(approvalEvents).toHaveLength(1);

    expect(internal.pendingPermission?.permissionId).toBe("perm_alt_456");
    expect(internal.pendingPermission?.request.toolName).toBe("web_fetch");
    expect(internal.pendingPermission?.request.commandPreview).toContain("curl https://example.com");
  });

  test("ignores permission events missing required fields", () => {
    const { events, internal } = createPermissionAdapter();

    internal.handleSseEvent({
      type: "permission.updated",
      properties: { type: "bash" },
    });

    expect(events.filter((e) => e.type === "approval_required")).toHaveLength(0);
    expect(internal.pendingPermission).toBeNull();
    expect(internal.state.status).toBe("busy");
  });

  test("works with minimal permission properties", () => {
    const { events, internal } = createPermissionAdapter();

    internal.handleSseEvent({
      type: "permission.updated",
      properties: {
        id: "perm_789",
        sessionID: "session_perm_1",
        title: "Permission request",
        type: "unknown",
        metadata: {},
      },
    });

    const approvalEvents = events.filter((e) => e.type === "approval_required");
    expect(approvalEvents).toHaveLength(1);

    expect(internal.pendingPermission?.request.toolName).toBe("unknown");
  });

  test("accepts v2 permission.asked events", () => {
    const { events, internal } = createPermissionAdapter();

    internal.handleSseEvent({
      type: "permission.asked",
      properties: {
        id: "perm_req_123",
        sessionID: "session_perm_1",
        permission: "bash",
        patterns: ["npm test"],
        metadata: { command: "npm test" },
      },
    });

    const approvalEvents = events.filter((e) => e.type === "approval_required");
    expect(approvalEvents).toHaveLength(1);
    expect(internal.pendingPermission?.permissionId).toBe("perm_req_123");
    expect(internal.pendingPermission?.request).toMatchObject({
      toolName: "bash",
      commandPreview: "npm test",
    });
  });
});

/* ------------------------------------------------------------------ */
/*  session.created handling                                           */
/* ------------------------------------------------------------------ */

describe("OpenCode session.created handling", () => {
  test("emits session_switched for local session creation", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; sessionId?: string; source?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; sessionId?: string; source?: string });
    });
    const internal = adapter as unknown as {
      state: {
        sharedSessionId?: string;
        sharedThreadId?: string;
        activeRuntimeSessionId?: string;
        lastSessionSwitchSource?: string;
        lastSessionSwitchReason?: string;
      };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    // Real SDK: EventSessionCreated = { type: "session.created", properties: { info: Session } }
    internal.handleSseEvent({
      type: "session.created",
      properties: { info: { id: "session_new_1", title: "Test session" } },
    });

    expect(internal.activeSessionId).toBe("session_new_1");
    expect(internal.state.sharedSessionId).toBe("session_new_1");
    expect(internal.state.sharedThreadId).toBe("session_new_1");
    expect(internal.state.activeRuntimeSessionId).toBe("session_new_1");
    expect(internal.state.lastSessionSwitchSource).toBe("local");
    expect(internal.state.lastSessionSwitchReason).toBe("local_follow");

    const switchEvents = events.filter((e) => e.type === "session_switched");
    expect(switchEvents).toHaveLength(1);
    expect(switchEvents[0]).toMatchObject({
      sessionId: "session_new_1",
      source: "local",
      reason: "local_follow",
    });
  });

  test("ignores session.created with missing session ID", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.handleSseEvent({ type: "session.created", properties: {} });
    internal.handleSseEvent({ type: "session.created", properties: { tool: "bash" } });
    internal.handleSseEvent({ type: "session.created", properties: { info: {} } });
    internal.handleSseEvent({ type: "session.created", properties: { info: { title: "no id" } } });

    expect(events.filter((e) => e.type === "session_switched")).toHaveLength(0);
  });

  test("updates the tracked session on session.updated", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; sessionId?: string; source?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; sessionId?: string; source?: string });
    });
    const internal = adapter as unknown as {
      state: { sharedSessionId?: string; sharedThreadId?: string; activeRuntimeSessionId?: string };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.activeSessionId = "session_old";

    internal.handleSseEvent({
      type: "session.updated",
      properties: { sessionID: "session_new_2", info: { id: "session_new_2", title: "Updated session" } },
    });

    expect(internal.activeSessionId).toBe("session_new_2");
    expect(internal.state.sharedSessionId).toBe("session_new_2");
    expect(internal.state.sharedThreadId).toBe("session_new_2");
    expect(internal.state.activeRuntimeSessionId).toBe("session_new_2");
    expect(events.filter((e) => e.type === "session_switched")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  local TUI tracking                                                 */
/* ------------------------------------------------------------------ */

describe("OpenCode local TUI tracking", () => {
  test("mirrors a submitted local prompt as a local turn", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string; origin?: string; status?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string; origin?: string; status?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; activeTurnOrigin?: string; lastInputAt?: string };
      currentPreview: string;
      hasAcceptedInput: boolean;
      pendingLocalPrompt: string;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.handleSseEvent({ type: "tui.prompt.append", properties: { text: "Review " } });
    internal.handleSseEvent({ type: "tui.prompt.append", properties: { text: "the bridge flow" } });
    internal.handleSseEvent({ type: "tui.command.execute", properties: { command: "prompt.submit" } });

    expect(internal.pendingLocalPrompt).toBe("");
    expect(internal.hasAcceptedInput).toBe(true);
    expect(internal.currentPreview).toBe("Review the bridge flow");
    expect(internal.state.status).toBe("busy");
    expect(internal.state.activeTurnOrigin).toBe("local");
    expect(typeof internal.state.lastInputAt).toBe("string");

    const mirroredEvents = events.filter((event) => event.type === "mirrored_user_input");
    expect(mirroredEvents).toHaveLength(1);
    expect(mirroredEvents[0]).toMatchObject({
      text: "Review the bridge flow",
      origin: "local",
    });
  });

  test("clears the buffered local prompt before submit", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; activeTurnOrigin?: string };
      pendingLocalPrompt: string;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.handleSseEvent({ type: "tui.prompt.append", properties: { text: "temporary draft" } });
    internal.handleSseEvent({ type: "tui.command.execute", properties: { command: "prompt.clear" } });
    internal.handleSseEvent({ type: "tui.command.execute", properties: { command: "prompt.submit" } });

    expect(internal.pendingLocalPrompt).toBe("");
    expect(internal.state.status).toBe("stopped");
    expect(internal.state.activeTurnOrigin).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  test("tracks local TUI session selections as local session switches", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; sessionId?: string; source?: string; reason?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as { type: string; sessionId?: string; source?: string; reason?: string },
      );
    });
    const internal = adapter as unknown as {
      state: { sharedSessionId?: string; sharedThreadId?: string; activeRuntimeSessionId?: string };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.activeSessionId = "session_old_local";
    internal.handleSseEvent({
      type: "tui.session.select",
      properties: { sessionID: "session_selected_local" },
    });

    expect(internal.activeSessionId).toBe("session_selected_local");
    expect(internal.state.sharedSessionId).toBe("session_selected_local");
    expect(internal.state.sharedThreadId).toBe("session_selected_local");
    expect(internal.state.activeRuntimeSessionId).toBe("session_selected_local");
    expect(events.filter((event) => event.type === "session_switched")).toEqual([
      expect.objectContaining({
        sessionId: "session_selected_local",
        source: "local",
        reason: "local_follow",
      }),
    ]);
  });
});

/* ------------------------------------------------------------------ */
/*  message.part.updated handling                                      */
/* ------------------------------------------------------------------ */

describe("OpenCode message.part.updated handling", () => {
  test("forwards text content via delta when busy", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";

    // Real SDK: EventMessagePartUpdated = { type: "message.part.updated", properties: { part: Part, delta?: string } }
    internal.handleSseEvent({
      type: "message.part.updated",
      properties: { part: { id: "p1", type: "text" }, delta: "Hello from OpenCode" },
    });

    // Output goes through OutputBatcher (1 second delay), so immediate flush
    // won't produce events yet. But lastOutputAt should be updated.
    expect(internal.state.lastOutputAt).toBeTruthy();
  });

  test("extracts text from part.text when no delta", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";

    internal.handleSseEvent({
      type: "message.part.updated",
      properties: { part: { id: "p2", type: "text", text: "Content from part" } },
    });

    expect(internal.state.lastOutputAt).toBeTruthy();
  });

  test("accepts v2 message.part.delta events", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";

    internal.handleSseEvent({
      type: "message.part.delta",
      properties: { sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: "Hello delta" },
    });

    expect(internal.state.lastOutputAt).toBeTruthy();
  });

  test("ignores message updates when not busy", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "idle";

    internal.handleSseEvent({
      type: "message.part.updated",
      properties: { part: { id: "p3", type: "text" }, delta: "Should be ignored" },
    });

    expect(internal.state.lastOutputAt).toBeUndefined();
  });

  test("ignores reasoning parts", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";

    internal.handleSseEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_reasoning_1",
          type: "reasoning",
          text: "The user gave a 👌🏻 emoji which seems like an acknowledgment.",
        },
      },
    });

    await internal.outputBatcher.flushNow();

    expect(internal.state.lastOutputAt).toBeUndefined();
    expect(events.filter((event) => event.type === "stdout")).toHaveLength(0);
    expect(internal.outputBatcher.getRecentSummary(500)).toBe("(no output)");
  });

  test("ignores non-text message.part.delta fields", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";

    internal.handleSseEvent({
      type: "message.part.delta",
      properties: {
        sessionID: "s1",
        messageID: "m1",
        partID: "p_reasoning_delta_1",
        field: "reasoning_content",
        delta: "I'll respond briefly to acknowledge their input.",
      },
    });

    await internal.outputBatcher.flushNow();

    expect(internal.state.lastOutputAt).toBeUndefined();
    expect(events.filter((event) => event.type === "stdout")).toHaveLength(0);
    expect(internal.outputBatcher.getRecentSummary(500)).toBe("(no output)");
  });

  test("deduplicates accumulated message.part.updated snapshots", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";

    internal.handleSseEvent({
      type: "message.part.updated",
      properties: { part: { id: "p_text_1", type: "text", text: "Hello" } },
    });
    internal.handleSseEvent({
      type: "message.part.updated",
      properties: { part: { id: "p_text_1", type: "text", text: "Hello world" } },
    });
    internal.handleSseEvent({
      type: "message.part.updated",
      properties: { part: { id: "p_text_1", type: "text", text: "Hello world" } },
    });

    await internal.outputBatcher.flushNow();

    expect(events.filter((event) => event.type === "stdout").map((event) => event.text).join("")).toBe("Hello world");
    expect(internal.outputBatcher.getRecentSummary(500)).toBe("Hello world");
  });

  test("does not duplicate text when a delta is followed by a full snapshot", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";

    internal.handleSseEvent({
      type: "message.part.delta",
      properties: { sessionID: "s1", messageID: "m1", partID: "p_text_2", field: "text", delta: "Hello" },
    });
    internal.handleSseEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_text_2",
          type: "text",
          text: "Hello world",
        },
      },
    });

    await internal.outputBatcher.flushNow();

    expect(events.filter((event) => event.type === "stdout").map((event) => event.text).join("")).toBe("Hello world");
    expect(internal.outputBatcher.getRecentSummary(500)).toBe("Hello world");
  });

  test("ignores message.updated events (not used for text)", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";

    internal.handleSseEvent({
      type: "message.updated",
      properties: { info: { id: "m1", text: "Hello" } },
    });

    expect(internal.state.lastOutputAt).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Working notice                                                     */
/* ------------------------------------------------------------------ */

describe("OpenCode working notice", () => {
  test("emits a single notice for long-running WeChat turns", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string; level?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string; level?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; activeTurnOrigin?: string };
      hasAcceptedInput: boolean;
      pendingPermission: unknown;
      currentPreview: string;
      workingNoticeDelayMs: number;
      armWechatWorkingNotice(): void;
    };

    internal.workingNoticeDelayMs = 5;
    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";
    internal.hasAcceptedInput = true;
    internal.currentPreview = "Review the failing tests";
    internal.pendingPermission = null;

    // The working notice is armed by sendInput(), simulate it directly.
    internal.armWechatWorkingNotice();

    await wait(20);

    const noticeEvents = events.filter((e) => e.type === "notice");
    expect(noticeEvents).toHaveLength(1);
    expect(noticeEvents[0]).toMatchObject({
      level: "info",
      text: "OpenCode is still working on:\nReview the failing tests",
    });

    await wait(20);
    expect(events.filter((e) => e.type === "notice")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  dispose                                                            */
/* ------------------------------------------------------------------ */

describe("OpenCode dispose", () => {
  test("transitions to stopped and clears state", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const internal = adapter as unknown as {
      state: { status: string; pendingApproval: unknown; pendingApprovalOrigin?: string };
      shuttingDown: boolean;
      pendingPermission: unknown;
    };

    internal.state.status = "busy";

    await adapter.dispose();

    expect(adapter.getState().status).toBe("stopped");
    expect(internal.shuttingDown).toBe(true);
    expect(internal.pendingPermission).toBeNull();
    expect(adapter.getState().pendingApproval).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Shared utilities                                                   */
/* ------------------------------------------------------------------ */

describe("OpenCode shared utilities", () => {
  test("resolveDefaultAdapterCommand returns opencode for opencode kind", () => {
    expect(resolveDefaultAdapterCommand("opencode", { platform: "win32" })).toBe("opencode");
    expect(resolveDefaultAdapterCommand("opencode", { platform: "linux" })).toBe("opencode");
    expect(resolveDefaultAdapterCommand("opencode", { platform: "darwin" })).toBe("opencode");
  });

  test("getLocalCompanionCommandName returns wechat-opencode for opencode", () => {
    expect(getLocalCompanionCommandName("opencode")).toBe("wechat-opencode");
  });
});

/* ------------------------------------------------------------------ */
/*  Adapter-aware message formatting                                   */
/* ------------------------------------------------------------------ */

describe("OpenCode message formatting", () => {
  test("formats mirrored OpenCode input without Claude/Codex wording", () => {
    expect(formatMirroredUserInputMessage("opencode", "Review the bridge tests")).toContain(
      "Local OpenCode input",
    );
  });

  test("formats final reply and failure messages by adapter", () => {
    expect(formatFinalReplyMessage("opencode", "Done")).toBe("Done");
    expect(formatTaskFailedMessage("opencode", "Boom")).toBe("OpenCode task failed:\nBoom");
  });

  test("formats OpenCode session resume list with session wording", () => {
    const output = formatResumeSessionList({
      adapter: "opencode",
      candidates: [
        {
          sessionId: "session_1",
          title: "Continue the OpenCode bridge refactor",
          lastUpdatedAt: "2026-03-28T10:00:00.000Z",
        },
      ],
      currentSessionId: "session_1",
    });

    expect(output).toContain("Recent OpenCode sessions:");
    expect(output).toContain("session_1");
    expect(output).toContain("[current]");
  });
});
