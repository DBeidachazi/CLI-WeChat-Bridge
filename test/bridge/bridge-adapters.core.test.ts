import { describe, expect, test } from "bun:test";

import { shouldStopBridgeAfterCompanionDisconnect } from "../../src/bridge/bridge-adapters.core.ts";

describe("local companion proxy lifecycle", () => {
  test("persistent bridges stay alive after companion disconnect", () => {
    expect(shouldStopBridgeAfterCompanionDisconnect("persistent")).toBe(false);
  });

  test("companion-bound bridges stop after companion disconnect", () => {
    expect(shouldStopBridgeAfterCompanionDisconnect("companion_bound")).toBe(true);
  });

  test("undefined lifecycle keeps the historical persistent behavior", () => {
    expect(shouldStopBridgeAfterCompanionDisconnect(undefined)).toBe(false);
  });
});
