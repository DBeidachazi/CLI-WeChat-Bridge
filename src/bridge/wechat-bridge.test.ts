import { describe, expect, test } from "bun:test";

import {
  formatUserFacingBridgeFatalError,
  parseCliArgs,
  shouldWatchParentProcess,
} from "./wechat-bridge.ts";

describe("wechat-bridge cli helpers", () => {
  test("parseCliArgs keeps persistent lifecycle by default", () => {
    const options = parseCliArgs(["--adapter", "codex"]);

    expect(options.lifecycle).toBe("persistent");
  });

  test("parseCliArgs accepts --lifecycle companion_bound", () => {
    const options = parseCliArgs([
      "--adapter",
      "codex",
      "--lifecycle",
      "companion_bound",
    ]);

    expect(options.lifecycle).toBe("companion_bound");
  });

  test("shouldWatchParentProcess watches attached terminal bridges", () => {
    expect(
      shouldWatchParentProcess({
        startupParentPid: 123,
        attachedToTerminal: true,
        lifecycle: "persistent",
      }),
    ).toBe(true);
  });

  test("shouldWatchParentProcess watches detached companion-bound bridges", () => {
    expect(
      shouldWatchParentProcess({
        startupParentPid: 123,
        attachedToTerminal: false,
        lifecycle: "companion_bound",
      }),
    ).toBe(true);
  });

  test("shouldWatchParentProcess ignores detached persistent bridges", () => {
    expect(
      shouldWatchParentProcess({
        startupParentPid: 123,
        attachedToTerminal: false,
        lifecycle: "persistent",
      }),
    ).toBe(false);
  });

  test("formatUserFacingBridgeFatalError trims verbose app-server log details", () => {
    expect(
      formatUserFacingBridgeFatalError(
        "codex app-server websocket closed unexpectedly. Recent app-server log: codex app-server (WebSockets) listening on: ws://127.0.0.1:12345 readyz: http://127.0.0.1:12345/readyz",
      ),
    ).toBe("Bridge error: codex app-server websocket closed unexpectedly.");
  });
});
