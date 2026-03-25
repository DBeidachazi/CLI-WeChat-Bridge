import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildCliEnvironment,
  buildClaudeCliArgs,
  buildCodexCliArgs,
  buildCodexApprovalRequest,
  buildPtySpawnOptions,
  buildShellInputPayload,
  buildShellProfileCommand,
  createBridgeAdapter,
  extractCodexFinalTextFromItem,
  extractCodexThreadFollowIdFromStatusChanged,
  extractCodexThreadStartedThreadId,
  extractCodexUserMessageText,
  findRecentCodexSessionFileForCwd,
  hasClaudeNoAltScreenOption,
  isClaudeInvalidResumeError,
  listCodexResumeThreads,
  matchesCodexSessionMeta,
  resolveDefaultAdapterCommand,
  resolveShellRuntime,
  resolveSpawnTarget,
  shouldAutoCompleteCodexWechatTurnAfterFinalReply,
  shouldIgnoreCodexSessionReplayEntry,
  shouldRecoverCodexStaleBusyState,
} from "./bridge-adapters.ts";

const tempDirectories: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wechat-bridge-adapter-test-"),
  );
  tempDirectories.push(directory);
  return directory;
}

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "", "utf-8");
}

function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (!directory) {
      continue;
    }

    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveSpawnTarget", () => {
  test("keeps an explicit executable path unchanged", () => {
    const tempDir = makeTempDirectory();
    const executableName = process.platform === "win32" ? "tool.exe" : "tool";
    const executablePath = path.join(tempDir, executableName);
    writeFile(executablePath);

    const target = resolveSpawnTarget(executablePath, "shell");

    expect(target.file).toBe(path.resolve(executablePath));
    expect(target.args).toEqual([]);
  });

  test("prefers cmd launcher over ps1 on Windows when vendor exe is missing", () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = makeTempDirectory();
    const npmBinDirectory = path.join(tempDir, "npm");
    const cmdPath = path.join(npmBinDirectory, "codex.cmd");
    const ps1Path = path.join(npmBinDirectory, "codex.ps1");
    writeFile(cmdPath);
    writeFile(ps1Path);

    const target = resolveSpawnTarget("codex", "codex", {
      platform: "win32",
      env: {
        PATH: npmBinDirectory,
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      },
    });

    expect(target.file.toLowerCase()).toBe("c:\\windows\\system32\\cmd.exe");
    expect(target.args).toHaveLength(4);
    expect(target.args[3]).toContain("codex.cmd");
    expect(target.args[3]).not.toContain("codex.ps1");
  });

  test("prefers bundled vendor exe for codex on Windows", () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = makeTempDirectory();
    const npmBinDirectory = path.join(tempDir, "npm");
    const launcherPath = path.join(npmBinDirectory, "codex.cmd");
    const vendorExePath = path.join(
      npmBinDirectory,
      "node_modules",
      "@openai",
      ".codex-test",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "codex",
      "codex.exe",
    );
    writeFile(launcherPath);
    writeFile(vendorExePath);

    const target = resolveSpawnTarget("codex", "codex", {
      platform: "win32",
      env: {
        PATH: npmBinDirectory,
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      },
    });

    expect(target.file).toBe(vendorExePath);
    expect(target.args).toEqual([]);
  });

  test("prefers the installed package vendor exe before hidden staging directories", () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = makeTempDirectory();
    const npmBinDirectory = path.join(tempDir, "npm");
    const launcherPath = path.join(npmBinDirectory, "codex.cmd");
    const packageVendorExePath = path.join(
      npmBinDirectory,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "codex",
      "codex.exe",
    );
    const hiddenVendorExePath = path.join(
      npmBinDirectory,
      "node_modules",
      "@openai",
      ".codex-test",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "codex",
      "codex.exe",
    );
    writeFile(launcherPath);
    writeFile(packageVendorExePath);
    writeFile(hiddenVendorExePath);

    const target = resolveSpawnTarget("codex", "codex", {
      platform: "win32",
      env: {
        PATH: npmBinDirectory,
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      },
    });

    expect(target.file).toBe(packageVendorExePath);
    expect(target.args).toEqual([]);
  });

  test("passes forwarded exec args through the cmd wrapper on Windows", () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = makeTempDirectory();
    const npmBinDirectory = path.join(tempDir, "npm");
    const cmdPath = path.join(npmBinDirectory, "codex.cmd");
    writeFile(cmdPath);

    const target = resolveSpawnTarget("codex", "codex", {
      platform: "win32",
      env: {
        PATH: npmBinDirectory,
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      },
      forwardArgs: ["exec", "--json", "hello"],
    });

    expect(target.file.toLowerCase()).toBe("c:\\windows\\system32\\cmd.exe");
    expect(target.args[3]).toContain("codex.cmd");
    expect(target.args[3]).toContain("exec");
    expect(target.args[3]).toContain("--json");
    expect(target.args[3]).toContain("hello");
  });

  test("launches claude.exe directly on Windows", () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = makeTempDirectory();
    const binDirectory = path.join(tempDir, "bin");
    const claudeExePath = path.join(binDirectory, "claude.exe");
    writeFile(claudeExePath);

    const target = resolveSpawnTarget("claude", "claude", {
      platform: "win32",
      env: {
        PATH: binDirectory,
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      },
    });

    expect(target.file).toBe(claudeExePath);
    expect(target.args).toEqual([]);
  });
});

describe("resolveDefaultAdapterCommand", () => {
  test("keeps codex and claude defaults unchanged", () => {
    expect(resolveDefaultAdapterCommand("codex", { platform: "linux" })).toBe("codex");
    expect(resolveDefaultAdapterCommand("claude", { platform: "darwin" })).toBe("claude");
  });

  test("keeps the Windows shell default unchanged", () => {
    expect(resolveDefaultAdapterCommand("shell", { platform: "win32" })).toBe("powershell.exe");
  });

  test("selects the first available non-Windows shell in priority order", () => {
    const tempDir = makeTempDirectory();
    const binDirectory = path.join(tempDir, "bin");
    const zshPath = path.join(binDirectory, "zsh");
    writeFile(zshPath);

    expect(
      resolveDefaultAdapterCommand("shell", {
        platform: "linux",
        env: { PATH: binDirectory },
      }),
    ).toBe("zsh");
  });

  test("throws a helpful error when no non-Windows shell is available", () => {
    expect(() =>
      resolveDefaultAdapterCommand("shell", {
        platform: "linux",
        env: { PATH: "" },
      }),
    ).toThrow("Tried: pwsh, bash, zsh, sh");
  });
});

describe("buildCliEnvironment", () => {
  test("keeps the curated Windows CLI environment for codex and claude", () => {
    const env = buildCliEnvironment("codex", {
      platform: "win32",
      env: {
        PATH: "C:\\tools",
        USERPROFILE: "C:\\Users\\tester",
        FOO: "bar",
      },
    });

    expect(env.PATH).toBe("C:\\tools");
    expect(env.HOME).toBe("C:\\Users\\tester");
    expect(env.FOO).toBeUndefined();
  });

  test("passes through the non-Windows CLI environment", () => {
    const env = buildCliEnvironment("claude", {
      platform: "linux",
      env: {
        PATH: "/usr/bin",
        HOME: "/home/tester",
        FOO: "bar",
      },
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/tester");
    expect(env.FOO).toBe("bar");
  });
});

describe("buildPtySpawnOptions", () => {
  test("enables ConPTY only on Windows", () => {
    expect(
      buildPtySpawnOptions({
        cwd: "C:\\repo",
        env: { TERM: "xterm-256color" },
        platform: "win32",
      }).useConpty,
    ).toBe(true);

    expect(
      buildPtySpawnOptions({
        cwd: "/repo",
        env: { TERM: "xterm-256color" },
        platform: "linux",
      }).useConpty,
    ).toBeUndefined();
  });
});

describe("resolveShellRuntime", () => {
  test("builds non-Windows PowerShell launch args", () => {
    expect(resolveShellRuntime("pwsh", { platform: "linux" })).toEqual({
      family: "powershell",
      launchArgs: ["-NoLogo", "-Command", "-"],
    });
  });

  test("builds POSIX shell launch args", () => {
    expect(resolveShellRuntime("/bin/bash", { platform: "darwin" })).toEqual({
      family: "posix",
      launchArgs: ["-i"],
    });
  });

  test("rejects unsupported shell executables", () => {
    expect(() => resolveShellRuntime("fish", { platform: "linux" })).toThrow(
      "Unsupported shell executable",
    );
  });
});

describe("shell helpers", () => {
  test("builds a PowerShell profile source command", () => {
    expect(buildShellProfileCommand("C:\\profiles\\wechat.ps1", "powershell")).toContain(
      'C:\\profiles\\wechat.ps1',
    );
  });

  test("quotes POSIX shell profile paths safely", () => {
    const command = buildShellProfileCommand("/tmp/it's-profile.sh", "posix");
    expect(command.startsWith(". '")).toBe(true);
    expect(command).toContain(`it'"'"'s-profile.sh'`);
  });

  test("builds shell input payloads with a completion sentinel", () => {
    expect(buildShellInputPayload("Get-ChildItem", "powershell")).toContain(
      "__WECHAT_BRIDGE_DONE__",
    );
    expect(buildShellInputPayload("ls", "posix")).toContain(
      "printf '__WECHAT_BRIDGE_DONE__:%s\\n'",
    );
  });
});

describe("matchesCodexSessionMeta", () => {
  test("matches the expected cwd and thread id", () => {
    const startedAtMs = Date.parse("2026-03-22T15:00:00.000Z");
    const cwd = "C:\\workspace\\wechat-bridge";

    expect(
      matchesCodexSessionMeta(
        {
          id: "thread_123",
          cwd,
          source: "cli",
          timestamp: "2026-03-22T15:00:02.000Z",
        },
        {
          cwd,
          startedAtMs,
          threadId: "thread_123",
        },
      ),
    ).toBe(true);
  });

  test("rejects a session from the same cwd when the source does not match", () => {
    const startedAtMs = Date.parse("2026-03-22T15:00:00.000Z");
    const cwd = "C:\\workspace\\wechat-bridge";

    expect(
      matchesCodexSessionMeta(
        {
          id: "thread_123",
          cwd,
          source: { custom: "cli" },
          timestamp: "2026-03-22T15:00:02.000Z",
        },
        {
          cwd,
          startedAtMs,
          sessionSource: "wechat_bridge",
        },
      ),
    ).toBe(false);
  });

  test("rejects a session that started too far before the bridge session", () => {
    const startedAtMs = Date.parse("2026-03-22T15:00:00.000Z");
    const cwd = "C:\\workspace\\wechat-bridge";

    expect(
      matchesCodexSessionMeta(
        {
          id: "thread_999",
          cwd,
          source: "wechat_bridge",
          timestamp: "2026-03-22T14:55:00.000Z",
        },
        {
          cwd,
          startedAtMs,
          sessionSource: "wechat_bridge",
        },
      ),
    ).toBe(false);
  });
});

describe("buildCodexApprovalRequest", () => {
  test("formats command execution approvals for WeChat", () => {
    const request = buildCodexApprovalRequest(
      "item/commandExecution/requestApproval",
      {
        command: "git push origin main",
        cwd: "C:\\repo",
        reason: "Network access is required to push this branch.",
      },
    );

    expect(request).toEqual({
      source: "cli",
      summary:
        "Codex needs approval before running a command: Network access is required to push this branch.",
      commandPreview: "git push origin main (C:\\repo)",
    });
  });

  test("formats file change approvals for WeChat", () => {
    const request = buildCodexApprovalRequest(
      "item/fileChange/requestApproval",
      {
        grantRoot: "C:\\repo\\generated",
        reason: "Extra write access is required for generated assets.",
      },
    );

    expect(request).toEqual({
      source: "cli",
      summary:
        "Codex needs approval before applying a file change: Extra write access is required for generated assets.",
      commandPreview: "C:\\repo\\generated",
    });
  });
});

describe("buildCodexCliArgs", () => {
  test("builds the standard remote tui args", () => {
    expect(
      buildCodexCliArgs("ws://127.0.0.1:8123", {
        profile: "wechat",
        inlineMode: false,
      }),
    ).toEqual([
      "--enable",
      "tui_app_server",
      "--remote",
      "ws://127.0.0.1:8123",
      "--profile",
      "wechat",
    ]);
  });

  test("builds a real codex resume command for panel thread switching", () => {
    expect(
      buildCodexCliArgs("ws://127.0.0.1:8123", {
        resumeThreadId: "thread_123",
        profile: "wechat",
      }),
    ).toEqual([
      "resume",
      "thread_123",
      "--enable",
      "tui_app_server",
      "--remote",
      "ws://127.0.0.1:8123",
      "--profile",
      "wechat",
    ]);
  });

  test("keeps inline mode for embedded codex rendering", () => {
    expect(
      buildCodexCliArgs("ws://127.0.0.1:8123", {
        inlineMode: true,
      }),
    ).toEqual([
      "--enable",
      "tui_app_server",
      "--remote",
      "ws://127.0.0.1:8123",
      "--no-alt-screen",
    ]);
  });
});

describe("Claude CLI compatibility", () => {
  test("detects whether the installed help text exposes --no-alt-screen", () => {
    expect(
      hasClaudeNoAltScreenOption(`Options:\n  --settings <file>\n  --no-alt-screen\n`),
    ).toBe(true);
    expect(
      hasClaudeNoAltScreenOption(`Options:\n  --settings <file>\n  --resume [value]\n`),
    ).toBe(false);
  });

  test("builds Claude companion args without unsupported alt-screen flags", () => {
    expect(
      buildClaudeCliArgs({
        settingsFilePath: "/tmp/claude-settings.json",
        resumeConversationId: "session_123",
        profile: "wechat",
      }),
    ).toEqual([
      "--settings",
      "/tmp/claude-settings.json",
      "--resume",
      "session_123",
      "--profile",
      "wechat",
    ]);
  });

  test("keeps --no-alt-screen only when a compatible Claude build exposes it", () => {
    expect(
      buildClaudeCliArgs({
        settingsFilePath: "/tmp/claude-settings.json",
        includeNoAltScreen: true,
      }),
    ).toEqual(["--no-alt-screen", "--settings", "/tmp/claude-settings.json"]);
  });

  test("recognizes Claude invalid resume errors", () => {
    expect(
      isClaudeInvalidResumeError(
        "No conversation found with session ID: 019d1b3c-bf74-7e31-b105-2f28e27fa969",
      ),
    ).toBe(true);
    expect(isClaudeInvalidResumeError("Claude is ready.")).toBe(false);
  });

  test("keeps Claude runtime session and resume conversation ids separate", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
      initialSharedSessionId: "runtime-session-123",
      initialResumeConversationId: "resume-conversation-456",
      initialTranscriptPath: "/tmp/resume-conversation-456.jsonl",
    });

    expect(adapter.getState()).toMatchObject({
      sharedSessionId: "runtime-session-123",
      activeRuntimeSessionId: "runtime-session-123",
      resumeConversationId: "resume-conversation-456",
      transcriptPath: "/tmp/resume-conversation-456.jsonl",
    });
  });

  test("suppresses raw Claude PTY output and waits for structured approval hooks", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleData("Thinking...\r\nReviewing files...\r\n");

    expect(events).toEqual([]);

    adapter.handleData("Do you want to allow this? (y/n)\r\n");

    expect(events).toEqual([]);

    adapter.handleClaudePermissionRequest(
      "request-123",
      {
        tool_name: "Bash",
        tool_input: {
          command: "dir",
        },
      },
      {
        end() {},
        destroy() {},
      } as any,
    );

    expect(events.map((event) => event.type)).toEqual(["status", "approval_required"]);
    expect(adapter.pendingApproval).toMatchObject({
      summary: "Claude permission is required for Bash.",
      commandPreview: "Bash: dir",
      confirmInput: "y\r",
      denyInput: "n\r",
    });

    adapter.flushPendingClaudeHookApprovals();
  });

  test("keeps structured Claude approvals actionable until they are resolved", async () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const socketPayloads: string[] = [];
    adapter.setEventSink(() => undefined);
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleClaudePermissionRequest(
      "request-persist",
      {
        tool_name: "Bash",
        tool_input: {
          command: "npm test",
        },
      },
      {
        end(payload: string) {
          socketPayloads.push(payload);
        },
        destroy() {},
      } as any,
    );

    await wait(25);
    const resolved = await adapter.resolveApproval("confirm");

    expect(resolved).toBe(true);
    expect(socketPayloads).toHaveLength(1);
    const response = JSON.parse(socketPayloads[0].trim()) as {
      requestId: string;
      stdout: string;
    };
    expect(response.requestId).toBe("request-persist");
    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
        },
      },
    });
  });

  test("clears stale Claude remote approvals when the hook request is lost without a terminal fallback", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string; text?: string; level?: string }> = [];
    adapter.setEventSink((event: { type: string; text?: string; level?: string }) =>
      events.push(event),
    );
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleClaudePermissionRequest(
      "request-lost",
      {
        tool_name: "WebFetch",
        tool_input: {
          url: "https://example.com",
        },
      },
      {
        end() {},
        destroy() {},
      } as any,
    );

    adapter.handleClosedClaudeHookApproval("request-lost");

    expect(adapter.pendingApproval).toBeNull();
    expect(adapter.getState().pendingApproval).toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "notice",
        level: "warning",
      }),
    );
  });

  test("emits a single notice for long-running Claude WeChat turns", async () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string; text?: string; level?: string }> = [];
    adapter.setEventSink((event: { type: string; text?: string; level?: string }) =>
      events.push(event),
    );
    adapter.renderLocalOutput = () => undefined;
    adapter.pty = {
      pid: 1234,
      write() {},
      kill() {},
    };
    adapter.workingNoticeDelayMs = 5;

    await adapter.sendInput("Review the failing Claude bridge tests");
    await wait(20);

    const noticeEvents = events.filter((event) => event.type === "notice");
    expect(noticeEvents).toHaveLength(1);
    expect(noticeEvents[0]).toMatchObject({
      level: "info",
      text: "Claude is still working on:\nReview the failing Claude bridge tests",
    });

    await wait(20);
    expect(events.filter((event) => event.type === "notice")).toHaveLength(1);

    await adapter.dispose();
  });

  test("cancels the pending Claude working notice when a structured approval is requested", async () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.pty = {
      pid: 1234,
      write() {},
      kill() {},
    };
    adapter.workingNoticeDelayMs = 20;

    await adapter.sendInput("Run the risky shell command");
    adapter.handleData("Do you want to allow this? (y/n)\r\n");
    adapter.handleClaudePermissionRequest(
      "request-456",
      {
        tool_name: "Bash",
        tool_input: {
          command: "rm -rf build",
        },
      },
      {
        end() {},
        destroy() {},
      } as any,
    );
    await wait(35);

    expect(events.filter((event) => event.type === "notice")).toHaveLength(0);
    expect(events.filter((event) => event.type === "approval_required")).toHaveLength(1);

    adapter.flushPendingClaudeHookApprovals();
    await adapter.dispose();
  });

  test("cancels the pending Claude working notice once the final reply arrives", async () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.pty = {
      pid: 1234,
      write() {},
      kill() {},
    };
    adapter.workingNoticeDelayMs = 20;

    await adapter.sendInput("Summarize the repo state");
    adapter.handleClaudeStop({ last_assistant_message: "Done." });
    await wait(35);

    expect(events.filter((event) => event.type === "notice")).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual([
      "status",
      "status",
      "final_reply",
      "task_complete",
    ]);

    await adapter.dispose();
  });
});

describe("extractCodexThreadFollowIdFromStatusChanged", () => {
  test("accepts idle thread status notifications from the local panel", () => {
    expect(
      extractCodexThreadFollowIdFromStatusChanged({
        threadId: "thread_idle_123",
        status: {
          type: "idle",
        },
      }),
    ).toBe("thread_idle_123");
  });

  test("rejects notLoaded thread status notifications", () => {
    expect(
      extractCodexThreadFollowIdFromStatusChanged({
        threadId: "thread_not_loaded",
        status: {
          type: "notLoaded",
        },
      }),
    ).toBeNull();
  });
});

describe("extractCodexThreadStartedThreadId", () => {
  test("extracts the thread id from thread-started notifications", () => {
    expect(
      extractCodexThreadStartedThreadId({
        thread: {
          id: "thread_started_123",
          cwd: "C:\\repo",
          status: {
            type: "idle",
          },
        },
      }),
    ).toBe("thread_started_123");
  });

  test("returns null when the thread payload is missing", () => {
    expect(extractCodexThreadStartedThreadId({})).toBeNull();
  });
});

describe("shouldIgnoreCodexSessionReplayEntry", () => {
  test("skips historical entries before the thread-switch cutoff", () => {
    const cutoff = Date.parse("2026-03-23T10:00:00.000Z");

    expect(
      shouldIgnoreCodexSessionReplayEntry("2026-03-23T09:59:59.000Z", cutoff),
    ).toBe(true);
  });

  test("keeps entries written after the thread-switch cutoff", () => {
    const cutoff = Date.parse("2026-03-23T10:00:00.000Z");

    expect(
      shouldIgnoreCodexSessionReplayEntry("2026-03-23T10:00:01.000Z", cutoff),
    ).toBe(false);
  });

  test("treats missing timestamps as replay while the cutoff is active", () => {
    const cutoff = Date.parse("2026-03-23T10:00:00.000Z");

    expect(shouldIgnoreCodexSessionReplayEntry(undefined, cutoff)).toBe(true);
    expect(shouldIgnoreCodexSessionReplayEntry(undefined, null)).toBe(false);
  });
});

describe("shouldRecoverCodexStaleBusyState", () => {
  test("recovers when busy is set without any tracked turn context", () => {
    expect(
      shouldRecoverCodexStaleBusyState({
        status: "busy",
        pendingTurnStart: false,
        hasActiveTurn: false,
        hasPendingApproval: false,
      }),
    ).toBe(true);
  });

  test("does not recover when a turn is still active or pending", () => {
    expect(
      shouldRecoverCodexStaleBusyState({
        status: "busy",
        pendingTurnStart: true,
        hasActiveTurn: false,
        hasPendingApproval: false,
      }),
    ).toBe(false);

    expect(
      shouldRecoverCodexStaleBusyState({
        status: "busy",
        pendingTurnStart: false,
        hasActiveTurn: true,
        hasPendingApproval: false,
      }),
    ).toBe(false);

    expect(
      shouldRecoverCodexStaleBusyState({
        status: "busy",
        pendingTurnStart: false,
        hasActiveTurn: false,
        hasPendingApproval: true,
      }),
    ).toBe(false);

    expect(
      shouldRecoverCodexStaleBusyState({
        status: "busy",
        pendingTurnStart: false,
        hasActiveTurn: false,
        hasPendingApproval: false,
        activeTurnId: "turn_123",
      }),
    ).toBe(false);
  });
});

describe("shouldAutoCompleteCodexWechatTurnAfterFinalReply", () => {
  test("auto-completes a settled WeChat turn once final output is available", () => {
    expect(
      shouldAutoCompleteCodexWechatTurnAfterFinalReply({
        candidateTurnId: "turn_123",
        activeTurnId: "turn_123",
        activeTurnOrigin: "wechat",
        pendingTurnStart: false,
        hasPendingApproval: false,
        hasFinalOutput: true,
        hasCompletedTurn: false,
        lastActivityAtMs: 1_000,
        nowMs: 2_100,
        settleDelayMs: 1_000,
      }),
    ).toBe(true);
  });

  test("does not auto-complete local, incomplete, or still-active turns", () => {
    expect(
      shouldAutoCompleteCodexWechatTurnAfterFinalReply({
        candidateTurnId: "turn_123",
        activeTurnId: "turn_123",
        activeTurnOrigin: "local",
        pendingTurnStart: false,
        hasPendingApproval: false,
        hasFinalOutput: true,
        hasCompletedTurn: false,
        lastActivityAtMs: 1_000,
        nowMs: 2_100,
        settleDelayMs: 1_000,
      }),
    ).toBe(false);

    expect(
      shouldAutoCompleteCodexWechatTurnAfterFinalReply({
        candidateTurnId: "turn_123",
        activeTurnId: "turn_123",
        activeTurnOrigin: "wechat",
        pendingTurnStart: false,
        hasPendingApproval: true,
        hasFinalOutput: true,
        hasCompletedTurn: false,
        lastActivityAtMs: 1_000,
        nowMs: 2_100,
        settleDelayMs: 1_000,
      }),
    ).toBe(false);

    expect(
      shouldAutoCompleteCodexWechatTurnAfterFinalReply({
        candidateTurnId: "turn_123",
        activeTurnId: "turn_123",
        activeTurnOrigin: "wechat",
        pendingTurnStart: false,
        hasPendingApproval: false,
        hasFinalOutput: true,
        hasCompletedTurn: false,
        lastActivityAtMs: 1_500,
        nowMs: 2_100,
        settleDelayMs: 1_000,
      }),
    ).toBe(false);
  });
});

describe("Codex panel completion recovery", () => {
  test("session task_complete clears the in-memory active turn and returns to idle", () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.activeTurn = {
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    };
    adapter.state.status = "busy";
    adapter.state.activeTurnId = "turn_1";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleSessionLogLine(
      JSON.stringify({
        timestamp: "2026-03-23T10:00:00.000Z",
        payload: {
          type: "task_complete",
          turn_id: "turn_1",
          last_agent_message: "done",
        },
      }),
    );

    expect(adapter.activeTurn).toBeNull();
    expect(adapter.state.status).toBe("idle");
    expect(adapter.state.activeTurnId).toBeUndefined();
    expect(adapter.state.activeTurnOrigin).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(["status", "stdout", "task_complete"]);
  });

  test("sendInput recovers a stale hidden active turn before starting the next WeChat turn", async () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;

    adapter.nativeProcess = {};
    adapter.activeTurn = {
      threadId: "thread_1",
      turnId: "turn_stale",
      origin: "wechat",
    };
    adapter.state.status = "idle";
    adapter.state.activeTurnId = undefined;
    adapter.state.activeTurnOrigin = undefined;
    adapter.pendingTurnStart = false;
    adapter.pendingApproval = null;
    adapter.pendingApprovalRequest = null;
    adapter.ensureThreadStarted = async () => "thread_1";
    adapter.sendRpcRequest = async (method: string) => {
      expect(method).toBe("turn/start");
      return {
        turn: {
          id: "turn_2",
        },
      };
    };

    await adapter.sendInput("hello");

    expect(adapter.activeTurn).toEqual({
      threadId: "thread_1",
      turnId: "turn_2",
      origin: "wechat",
    });
    expect(adapter.state.activeTurnId).toBe("turn_2");
    expect(adapter.state.activeTurnOrigin).toBe("wechat");
  });
});

describe("findRecentCodexSessionFileForCwd", () => {
  test("finds a recently updated historical thread for the current cwd", () => {
    const homeDirectory = makeTempDirectory();
    process.env.HOME = homeDirectory;
    process.env.USERPROFILE = homeDirectory;

    const cwd = "C:\\repo";
    const sessionFilePath = path.join(
      homeDirectory,
      ".codex",
      "sessions",
      "2025",
      "12",
      "31",
      "historical-thread.jsonl",
    );
    writeTextFile(
      sessionFilePath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "thread_historical_123",
            cwd,
            source: "cli",
            timestamp: "2025-12-31T10:00:00.000Z",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Resume this old thread.",
          },
          timestamp: "2026-03-23T12:00:01.000Z",
        }),
      ].join("\n"),
    );
    const freshMtime = new Date("2026-03-23T12:00:05.000Z");
    fs.utimesSync(sessionFilePath, freshMtime, freshMtime);

    const recent = findRecentCodexSessionFileForCwd(cwd, Date.parse("2026-03-23T12:00:00.000Z"));

    expect(recent).not.toBeNull();
    expect(recent?.threadId).toBe("thread_historical_123");
    expect(recent?.filePath).toBe(sessionFilePath);
  });
});

describe("extractCodexFinalTextFromItem", () => {
  test("returns only final-answer agent messages", () => {
    expect(
      extractCodexFinalTextFromItem({
        type: "agentMessage",
        id: "msg_1",
        phase: "final_answer",
        text: "Final reply",
      }),
    ).toBe("Final reply");
  });

  test("ignores commentary and non-agent items", () => {
    expect(
      extractCodexFinalTextFromItem({
        type: "agentMessage",
        id: "msg_2",
        phase: "commentary",
        text: "Thinking...",
      }),
    ).toBeNull();

    expect(
      extractCodexFinalTextFromItem({
        type: "commandExecution",
        id: "cmd_1",
      }),
    ).toBeNull();
  });
});

describe("extractCodexUserMessageText", () => {
  test("extracts plain text user input", () => {
    expect(
      extractCodexUserMessageText({
        type: "userMessage",
        id: "msg_1",
        content: [
          {
            type: "text",
            text: "List the files in this directory.",
            text_elements: [],
          },
        ],
      }),
    ).toBe("List the files in this directory.");
  });

  test("summarizes non-text inputs for mirrored local prompts", () => {
    expect(
      extractCodexUserMessageText({
        type: "userMessage",
        id: "msg_2",
        content: [
          {
            type: "mention",
            name: "repo",
            path: "app://repo",
          },
          {
            type: "localImage",
            path: "C:\\repo\\diagram.png",
          },
        ],
      }),
    ).toBe("[mention: repo]\n[local image: C:\\repo\\diagram.png]");
  });
});

describe("listCodexResumeThreads", () => {
  test("lists the latest saved threads for the current working directory", () => {
    const homeDirectory = makeTempDirectory();
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;

    process.env.HOME = homeDirectory;
    process.env.USERPROFILE = homeDirectory;

    try {
      const sessionsRoot = path.join(homeDirectory, ".codex", "sessions", "2026", "03", "23");
      const repoCwd = "C:\\repo";
      const otherCwd = "C:\\other";

      writeTextFile(
        path.join(sessionsRoot, "thread-a.jsonl"),
        [
          JSON.stringify({
            timestamp: "2026-03-23T10:00:00.000Z",
            type: "session_meta",
            payload: {
              id: "thread_a",
              timestamp: "2026-03-23T10:00:00.000Z",
              cwd: repoCwd,
              source: "cli",
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-23T10:01:00.000Z",
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "Inspect the current bridge implementation.",
            },
          }),
        ].join("\n"),
      );

      writeTextFile(
        path.join(sessionsRoot, "thread-b.jsonl"),
        [
          JSON.stringify({
            timestamp: "2026-03-23T11:00:00.000Z",
            type: "session_meta",
            payload: {
              id: "thread_b",
              timestamp: "2026-03-23T11:00:00.000Z",
              cwd: repoCwd,
              source: "cli",
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-23T11:02:00.000Z",
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "Resume the latest saved thread.",
            },
          }),
        ].join("\n"),
      );

      writeTextFile(
        path.join(sessionsRoot, "thread-other.jsonl"),
        [
          JSON.stringify({
            timestamp: "2026-03-23T12:00:00.000Z",
            type: "session_meta",
            payload: {
              id: "thread_other",
              timestamp: "2026-03-23T12:00:00.000Z",
              cwd: otherCwd,
              source: "cli",
            },
          }),
        ].join("\n"),
      );

      const candidates = listCodexResumeThreads(repoCwd, 10);
      expect(candidates).toHaveLength(2);
      expect(candidates[0]?.sessionId).toBe("thread_b");
      expect(candidates[0]?.threadId).toBe("thread_b");
      expect(candidates[0]?.title).toContain("Resume the latest saved thread");
      expect(candidates[1]?.sessionId).toBe("thread_a");
      expect(candidates[1]?.threadId).toBe("thread_a");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }

      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    }
  });
});
