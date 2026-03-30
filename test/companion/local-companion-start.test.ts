import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  buildBackgroundBridgeArgs,
  buildForegroundClientArgs,
  isSameWorkspaceCwd,
  normalizeComparablePath,
  parseCliArgs,
  resolveForegroundClientEntryPath,
} from "../../src/companion/local-companion-start.ts";

describe("local-companion-start helpers", () => {
  test("parseCliArgs uses current working directory by default", () => {
    const options = parseCliArgs([]);
    expect(options.adapter).toBe("codex");
    expect(options.cwd).toBe(process.cwd());
    expect(options.timeoutMs).toBe(15000);
  });

  test("parseCliArgs parses adapter, cwd, profile, and timeout", () => {
    const options = parseCliArgs([
      "--adapter",
      "claude",
      "--cwd",
      "./tmp/project",
      "--profile",
      "work",
      "--timeout-ms",
      "25000",
    ]);

    expect(options.adapter).toBe("claude");
    expect(options.cwd).toBe(path.resolve("./tmp/project"));
    expect(options.profile).toBe("work");
    expect(options.timeoutMs).toBe(25000);
  });

  test("buildBackgroundBridgeArgs binds codex background bridge to the launcher lifetime", () => {
    const args = buildBackgroundBridgeArgs("/tmp/wechat-bridge.ts", {
      adapter: "codex",
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

  test("buildBackgroundBridgeArgs can launch claude in the background", () => {
    const args = buildBackgroundBridgeArgs("/tmp/wechat-bridge.ts", {
      adapter: "claude",
      cwd: path.resolve("./tmp/project"),
      timeoutMs: 15000,
    });

    expect(args).toEqual([
      "--no-warnings",
      "--experimental-strip-types",
      "/tmp/wechat-bridge.ts",
      "--adapter",
      "claude",
      "--cwd",
      path.resolve("./tmp/project"),
      "--lifecycle",
      "companion_bound",
    ]);
  });

  test("buildBackgroundBridgeArgs keeps the OpenCode bridge companion_bound", () => {
    const args = buildBackgroundBridgeArgs("/tmp/wechat-bridge.ts", {
      adapter: "opencode",
      cwd: path.resolve("./tmp/project"),
      timeoutMs: 15000,
    });

    expect(args).toEqual([
      "--no-warnings",
      "--experimental-strip-types",
      "/tmp/wechat-bridge.ts",
      "--adapter",
      "opencode",
      "--cwd",
      path.resolve("./tmp/project"),
      "--lifecycle",
      "companion_bound",
    ]);
  });

  test("resolveForegroundClientEntryPath always launches the shared local companion entry", () => {
    expect(resolveForegroundClientEntryPath("codex")).toBe(
      path.resolve(process.cwd(), "src", "companion", "local-companion.ts"),
    );
    expect(resolveForegroundClientEntryPath("opencode")).toBe(
      path.resolve(process.cwd(), "src", "companion", "local-companion.ts"),
    );
  });

  test("buildForegroundClientArgs forwards the adapter for OpenCode too", () => {
    const args = buildForegroundClientArgs("/tmp/local-companion.ts", {
      adapter: "opencode",
      cwd: path.resolve("./tmp/project"),
      timeoutMs: 15000,
    });

    expect(args).toEqual([
      "--no-warnings",
      "--experimental-strip-types",
      "/tmp/local-companion.ts",
      "--adapter",
      "opencode",
      "--cwd",
      path.resolve("./tmp/project"),
    ]);
  });

  test("buildForegroundClientArgs keeps adapter forwarding for local companions", () => {
    const args = buildForegroundClientArgs("/tmp/local-companion.ts", {
      adapter: "claude",
      cwd: path.resolve("./tmp/project"),
      timeoutMs: 15000,
    });

    expect(args).toEqual([
      "--no-warnings",
      "--experimental-strip-types",
      "/tmp/local-companion.ts",
      "--adapter",
      "claude",
      "--cwd",
      path.resolve("./tmp/project"),
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
