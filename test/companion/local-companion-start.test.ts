import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  buildBackgroundBridgeArgs,
  isSameWorkspaceCwd,
  normalizeComparablePath,
  parseCliArgs,
} from "../../src/companion/local-companion-start.ts";

describe("local-companion-start helpers", () => {
  test("parseCliArgs uses current working directory by default", () => {
    const options = parseCliArgs([]);
    expect(options.cwd).toBe(process.cwd());
    expect(options.timeoutMs).toBe(15000);
  });

  test("parseCliArgs parses cwd, profile, and timeout", () => {
    const options = parseCliArgs([
      "--cwd",
      "./tmp/project",
      "--profile",
      "work",
      "--timeout-ms",
      "25000",
    ]);

    expect(options.cwd).toBe(path.resolve("./tmp/project"));
    expect(options.profile).toBe("work");
    expect(options.timeoutMs).toBe(25000);
  });

  test("buildBackgroundBridgeArgs binds the background bridge to the launcher lifetime", () => {
    const args = buildBackgroundBridgeArgs("/tmp/wechat-bridge.ts", {
      cwd: path.resolve("./tmp/project"),
      profile: "work",
      timeoutMs: 15000,
    });

    expect(args).toEqual([
      "--no-warnings",
      "--experimental-strip-types",
      "/tmp/wechat-bridge.ts",
      "--adapter",
      "codex",
      "--cwd",
      path.resolve("./tmp/project"),
      "--lifecycle",
      "companion_bound",
      "--profile",
      "work",
    ]);
  });

  test("normalizeComparablePath is stable for the same logical cwd", () => {
    const first = normalizeComparablePath(".");
    const second = normalizeComparablePath(process.cwd());
    expect(first).toBe(second);
  });

  test("isSameWorkspaceCwd matches equivalent directory paths", () => {
    expect(isSameWorkspaceCwd(".", process.cwd())).toBe(true);
  });
});
