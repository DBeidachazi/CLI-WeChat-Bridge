import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { forwardWechatFinalReply } from "../../src/bridge/bridge-final-reply.ts";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const target = tempPaths.pop();
    if (!target) {
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe("forwardWechatFinalReply", () => {
  test("sends stripped text before attachments in listed order", async () => {
    const calls: string[] = [];
    const imagePath = "/tmp/wechat-bridge-photo.jpg";
    const filePath = "/tmp/wechat-bridge-report.pdf";

    await forwardWechatFinalReply({
      adapter: "codex",
      rawText: [
        "Artifacts are ready.",
        "```wechat-attachments",
        `image ${imagePath}`,
        `file ${filePath}`,
        "```",
      ].join("\n"),
      sender: {
        sendText: async (text) => {
          calls.push(`text:${text}`);
        },
        sendImage: async (imagePath) => {
          calls.push(`image:${imagePath}`);
        },
        sendFile: async (filePath) => {
          calls.push(`file:${filePath}`);
        },
        sendVoice: async (voicePath) => {
          calls.push(`voice:${voicePath}`);
        },
        sendVideo: async (videoPath) => {
          calls.push(`video:${videoPath}`);
        },
      },
    });

    expect(calls).toEqual([
      "text:Artifacts are ready.",
      `image:${imagePath}`,
      `file:${filePath}`,
    ]);
  });

  test("continues after attachment failures and reports the error in text", async () => {
    const calls: string[] = [];
    const imagePath = "/tmp/wechat-bridge-broken.jpg";
    const filePath = "/tmp/wechat-bridge-report.pdf";

    await forwardWechatFinalReply({
      adapter: "claude",
      rawText: [
        "```wechat-attachments",
        `image ${imagePath}`,
        `file ${filePath}`,
        "```",
      ].join("\n"),
      sender: {
        sendText: async (text) => {
          calls.push(`text:${text}`);
        },
        sendImage: async () => {
          throw new Error("upload failed");
        },
        sendFile: async (filePath) => {
          calls.push(`file:${filePath}`);
        },
        sendVoice: async (voicePath) => {
          calls.push(`voice:${voicePath}`);
        },
        sendVideo: async (videoPath) => {
          calls.push(`video:${videoPath}`);
        },
      },
    });

    expect(calls).toEqual([
      `text:Failed to send image attachment: ${imagePath}\nupload failed`,
      `file:${filePath}`,
    ]);
  });

  test("keeps inline local text file paths in visible text when they are not promoted to attachments", async () => {
    const calls: string[] = [];
    const filePath = "/tmp/wechat-bridge-summary.txt";

    await forwardWechatFinalReply({
      adapter: "codex",
      rawText: [`Saved note to \`${filePath}\`.`, "Review it."].join("\n"),
      sender: {
        sendText: async (text) => {
          calls.push(`text:${text}`);
        },
        sendImage: async (imagePath) => {
          calls.push(`image:${imagePath}`);
        },
        sendFile: async (filePath) => {
          calls.push(`file:${filePath}`);
        },
        sendVoice: async (voicePath) => {
          calls.push(`voice:${voicePath}`);
        },
        sendVideo: async (videoPath) => {
          calls.push(`video:${videoPath}`);
        },
      },
    });

    expect(calls).toEqual([`text:Saved note to \`${filePath}\`.\nReview it.`]);
  });

  test("keeps source code paths in text instead of auto-sending them as files", async () => {
    const calls: string[] = [];

    await forwardWechatFinalReply({
      adapter: "codex",
      rawText: [
        "Reference only:",
        "`C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel\\src\\bridge\\bridge-adapters.test.ts`",
        "Do not upload this file.",
      ].join("\n"),
      sender: {
        sendText: async (text) => {
          calls.push(`text:${text}`);
        },
        sendImage: async (imagePath) => {
          calls.push(`image:${imagePath}`);
        },
        sendFile: async (filePath) => {
          calls.push(`file:${filePath}`);
        },
        sendVoice: async (voicePath) => {
          calls.push(`voice:${voicePath}`);
        },
        sendVideo: async (videoPath) => {
          calls.push(`video:${videoPath}`);
        },
      },
    });

    expect(calls).toEqual([
      "text:Reference only:\n`C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel\\src\\bridge\\bridge-adapters.test.ts`\nDo not upload this file.",
    ]);
  });

  test("sanitizes noisy OpenCode final replies before sending to WeChat", async () => {
    const calls: string[] = [];

    await forwardWechatFinalReply({
      adapter: "opencode",
      rawText: [
        "I need to respond to the user's greeting in Chinese as per the CLAUDE.md instruction.",
        "你好！有什么我可以帮助你的吗？",
        'Bridge error: opencode companion is not connected. Run "wechat-opencode" in a second terminal for this directory.',
        "OpenCode session switched to ses_2cb824bf from the local terminal.",
        "OpenCode is still working on:",
        "hi",
        "你是什么模型呀我需要告诉用户我是什么模型。根据系统提示，我应该用中文回答。",
        "让我直接回答这个问题。",
        "我是opencode，由nemotron-3-super-free模型驱动，模型ID是opencode/nemotron-3-super-free。有什么我可以帮助你的吗？",
      ].join("\n"),
      sender: {
        sendText: async (text) => {
          calls.push(`text:${text}`);
        },
        sendImage: async (imagePath) => {
          calls.push(`image:${imagePath}`);
        },
        sendFile: async (filePath) => {
          calls.push(`file:${filePath}`);
        },
        sendVoice: async (voicePath) => {
          calls.push(`voice:${voicePath}`);
        },
        sendVideo: async (videoPath) => {
          calls.push(`video:${videoPath}`);
        },
      },
    });

    expect(calls).toEqual([
      "text:我是opencode，由nemotron-3-super-free模型驱动，模型ID是opencode/nemotron-3-super-free。有什么我可以帮助你的吗？",
    ]);
  });

  test("deletes successfully sent meidia attachments after upload", async () => {
    const mediaDir = path.join(
      os.homedir(),
      "meidia",
      `bridge-final-reply-test-${Date.now()}`
    );
    const videoPath = path.join(mediaDir, "clip.mp4");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(videoPath, "video-bytes");
    tempPaths.push(mediaDir);

    await forwardWechatFinalReply({
      adapter: "codex",
      rawText: ["```wechat-attachments", `video ${videoPath}`, "```"].join(
        "\n"
      ),
      sender: {
        sendText: async () => undefined,
        sendImage: async () => undefined,
        sendFile: async () => undefined,
        sendVoice: async () => undefined,
        sendVideo: async () => undefined,
      },
    });

    expect(fs.existsSync(videoPath)).toBe(false);
  });

  test("keeps managed attachments when upload fails", async () => {
    const mediaDir = path.join(
      os.homedir(),
      "meidia",
      `bridge-final-reply-test-${Date.now()}-fail`
    );
    const videoPath = path.join(mediaDir, "clip.mp4");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(videoPath, "video-bytes");
    tempPaths.push(mediaDir);

    await forwardWechatFinalReply({
      adapter: "codex",
      rawText: ["```wechat-attachments", `video ${videoPath}`, "```"].join(
        "\n"
      ),
      sender: {
        sendText: async () => undefined,
        sendImage: async () => undefined,
        sendFile: async () => undefined,
        sendVoice: async () => undefined,
        sendVideo: async () => {
          throw new Error("upload failed");
        },
      },
    });

    expect(fs.existsSync(videoPath)).toBe(true);
  });
});
