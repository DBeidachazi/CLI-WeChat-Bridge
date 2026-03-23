import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildCodexCliArgs,
  buildCodexApprovalRequest,
  extractCodexFinalTextFromItem,
  extractCodexThreadFollowIdFromStatusChanged,
  extractCodexThreadStartedThreadId,
  extractCodexUserMessageText,
  findRecentCodexSessionFileForCwd,
  listCodexResumeThreads,
  matchesCodexSessionMeta,
  resolveSpawnTarget,
  shouldIgnoreCodexSessionReplayEntry,
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

describe("matchesCodexSessionMeta", () => {
  test("matches the expected cwd and thread id", () => {
    const startedAtMs = Date.parse("2026-03-22T15:00:00.000Z");

    expect(
      matchesCodexSessionMeta(
        {
          id: "thread_123",
          cwd: "C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel",
          source: "cli",
          timestamp: "2026-03-22T15:00:02.000Z",
        },
        {
          cwd: "C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel",
          startedAtMs,
          threadId: "thread_123",
        },
      ),
    ).toBe(true);
  });

  test("rejects a session from the same cwd when the source does not match", () => {
    const startedAtMs = Date.parse("2026-03-22T15:00:00.000Z");

    expect(
      matchesCodexSessionMeta(
        {
          id: "thread_123",
          cwd: "C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel",
          source: { custom: "cli" },
          timestamp: "2026-03-22T15:00:02.000Z",
        },
        {
          cwd: "C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel",
          startedAtMs,
          sessionSource: "wechat_bridge",
        },
      ),
    ).toBe(false);
  });

  test("rejects a session that started too far before the bridge session", () => {
    const startedAtMs = Date.parse("2026-03-22T15:00:00.000Z");

    expect(
      matchesCodexSessionMeta(
        {
          id: "thread_999",
          cwd: "C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel",
          source: "wechat_bridge",
          timestamp: "2026-03-22T14:55:00.000Z",
        },
        {
          cwd: "C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel",
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
      expect(candidates[0]?.threadId).toBe("thread_b");
      expect(candidates[0]?.title).toContain("Resume the latest saved thread");
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
