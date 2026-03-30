import { describe, expect, test } from "bun:test";

import {
  isOpencodeServeCommandLine,
  isWechatBridgeCommandLine,
  parsePosixBridgeProcessProbeOutput,
  parseWindowsBridgeProcessProbeOutput,
} from "../../src/bridge/bridge-process-reaper.ts";

describe("bridge peer process reaper", () => {
  test("detects wechat-bridge command lines", () => {
    expect(
      isWechatBridgeCommandLine(
        '"C:\\Program Files\\nodejs\\node.exe" --no-warnings --experimental-strip-types C:\\repo\\src\\bridge\\wechat-bridge.ts --adapter opencode --cwd C:\\Users\\unlin',
      ),
    ).toBe(true);
    expect(
      isWechatBridgeCommandLine(
        '"C:\\Program Files\\nodejs\\node.exe" --no-warnings --experimental-strip-types C:\\repo\\src\\companion\\local-companion-start.ts --adapter opencode',
      ),
    ).toBe(false);
  });

  test("detects opencode serve command lines", () => {
    expect(isOpencodeServeCommandLine("opencode serve --port 12345 --hostname 127.0.0.1")).toBe(true);
    expect(isOpencodeServeCommandLine("opencode.exe serve --port 12345")).toBe(true);
    expect(isOpencodeServeCommandLine("opencode.cmd serve --port 12345")).toBe(true);
    expect(isOpencodeServeCommandLine("opencode.bat serve --port 12345")).toBe(true);
    expect(isOpencodeServeCommandLine("/usr/local/bin/opencode serve --port 12345")).toBe(true);
    expect(isOpencodeServeCommandLine("opencode chat")).toBe(false);
    expect(isOpencodeServeCommandLine("node server.js --port 12345")).toBe(false);
    expect(isOpencodeServeCommandLine("")).toBe(false);
  });

  test("parses Windows process probe output and filters non-bridge rows", () => {
    const output = JSON.stringify([
      {
        ProcessId: 101,
        ParentProcessId: 1,
        Name: "node.exe",
        CommandLine:
          '"C:\\Program Files\\nodejs\\node.exe" --no-warnings --experimental-strip-types C:\\repo\\src\\bridge\\wechat-bridge.ts --adapter opencode --cwd C:\\Users\\unlin',
      },
      {
        ProcessId: 202,
        ParentProcessId: 1,
        Name: "node.exe",
        CommandLine:
          '"C:\\Program Files\\nodejs\\node.exe" --no-warnings --experimental-strip-types C:\\repo\\src\\companion\\local-companion-start.ts --adapter opencode',
      },
      {
        ProcessId: 303,
        ParentProcessId: 1,
        Name: "node.exe",
        CommandLine:
          '"C:\\Program Files\\nodejs\\node.exe" --no-warnings --experimental-strip-types C:\\repo\\src\\bridge\\wechat-bridge.ts --adapter codex --cwd C:\\repo',
      },
    ]);

    expect(parseWindowsBridgeProcessProbeOutput(output, 303)).toEqual([
      {
        pid: 101,
        parentPid: 1,
        name: "node.exe",
        commandLine:
          '"C:\\Program Files\\nodejs\\node.exe" --no-warnings --experimental-strip-types C:\\repo\\src\\bridge\\wechat-bridge.ts --adapter opencode --cwd C:\\Users\\unlin',
      },
    ]);
  });

  test("parses POSIX process probe output and ignores the current pid", () => {
    const output = [
      '101 node --no-warnings --experimental-strip-types /repo/src/bridge/wechat-bridge.ts --adapter opencode --cwd /tmp/work',
      '202 node --no-warnings --experimental-strip-types /repo/src/companion/local-companion-start.ts --adapter opencode',
      '303 node --no-warnings --experimental-strip-types /repo/src/bridge/wechat-bridge.ts --adapter codex --cwd /repo',
    ].join("\n");

    expect(parsePosixBridgeProcessProbeOutput(output, 303)).toEqual([
      {
        pid: 101,
        commandLine:
          'node --no-warnings --experimental-strip-types /repo/src/bridge/wechat-bridge.ts --adapter opencode --cwd /tmp/work',
      },
    ]);
  });
});
