import { describe, expect, test } from "bun:test";

import { forwardWechatFinalReply } from "../../src/bridge/bridge-final-reply.ts";

describe("forwardWechatFinalReply", () => {
  test("sends stripped text before attachments in listed order", async () => {
    const calls: string[] = [];

    await forwardWechatFinalReply({
      adapter: "codex",
      rawText: [
        "Artifacts are ready.",
        "```wechat-attachments",
        "image C:\\Users\\unlin\\Desktop\\photo.jpg",
        "file C:\\Users\\unlin\\Desktop\\report.pdf",
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
      "image:C:\\Users\\unlin\\Desktop\\photo.jpg",
      "file:C:\\Users\\unlin\\Desktop\\report.pdf",
    ]);
  });

  test("continues after attachment failures and reports the error in text", async () => {
    const calls: string[] = [];

    await forwardWechatFinalReply({
      adapter: "claude",
      rawText: [
        "```wechat-attachments",
        "image C:\\Users\\unlin\\Desktop\\broken.jpg",
        "file C:\\Users\\unlin\\Desktop\\report.pdf",
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
      "text:Failed to send image attachment: C:\\Users\\unlin\\Desktop\\broken.jpg\nupload failed",
      "file:C:\\Users\\unlin\\Desktop\\report.pdf",
    ]);
  });
});
