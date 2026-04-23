import { describe, expect, test } from "bun:test";

import {
  buildCompanionReconnectTimeoutMessage,
  getCompanionDisconnectDisposition,
  isExpectedLocalCompanionClose,
  shouldStopBridgeAfterCompanionDisconnect,
} from "../../src/bridge/bridge-adapters.core.ts";

describe("local companion proxy lifecycle", () => {
  test("persistent bridges stay alive after companion disconnect", () => {
    expect(shouldStopBridgeAfterCompanionDisconnect("persistent")).toBe(false);
  });

  test("companion-bound bridges stop after companion disconnect", () => {
    expect(shouldStopBridgeAfterCompanionDisconnect("companion_bound")).toBe(
      true
    );
  });

  test("undefined lifecycle keeps the historical persistent behavior", () => {
    expect(shouldStopBridgeAfterCompanionDisconnect(undefined)).toBe(false);
  });

  test("companion-bound bridges stop immediately after an expected close", () => {
    expect(
      getCompanionDisconnectDisposition({
        kind: "codex",
        lifecycle: "companion_bound",
        expectedClose: true,
        reconnectGraceMs: 15_000,
      })
    ).toEqual({
      action: "shutdown",
      shutdownReason: "companion_closed",
      message:
        "codex companion closed. Stopping transient bridge bound to wechat-codex.",
    });
  });

  test("companion-bound bridges wait through a reconnect window after unexpected disconnects", () => {
    expect(
      getCompanionDisconnectDisposition({
        kind: "codex",
        lifecycle: "companion_bound",
        expectedClose: false,
        reconnectGraceMs: 15_000,
      })
    ).toEqual({
      action: "wait_for_reconnect",
      message:
        "codex companion disconnected unexpectedly. Waiting up to 15s for wechat-codex to reconnect before stopping this transient bridge.",
    });
  });

  test("persistent bridges fall back to manual reconnect after unexpected disconnects", () => {
    expect(
      getCompanionDisconnectDisposition({
        kind: "claude",
        lifecycle: "persistent",
        expectedClose: false,
        reconnectGraceMs: 15_000,
      })
    ).toEqual({
      action: "await_manual_reconnect",
      message:
        'claude companion disconnected unexpectedly. Run "wechat-claude" again in a second terminal for this directory to reconnect.',
    });
  });

  test("expected close detection only treats explicit closing reasons as expected", () => {
    expect(isExpectedLocalCompanionClose("worker_exit")).toBe(true);
    expect(isExpectedLocalCompanionClose("bridge_dispose")).toBe(true);
    expect(isExpectedLocalCompanionClose(null)).toBe(false);
    expect(isExpectedLocalCompanionClose(undefined)).toBe(false);
  });

  test("formats reconnect timeout messages with the grace window", () => {
    expect(
      buildCompanionReconnectTimeoutMessage({
        kind: "codex",
        reconnectGraceMs: 15_000,
      })
    ).toBe(
      "codex companion did not reconnect within 15s. Stopping transient bridge bound to wechat-codex."
    );
  });
});
