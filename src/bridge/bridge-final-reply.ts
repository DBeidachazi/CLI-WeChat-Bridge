import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BridgeAdapterKind } from "./bridge-types.ts";
import {
  formatFinalReplyMessage,
  parseWechatFinalReply,
  sanitizeWechatFinalReplyText,
} from "./bridge-utils.ts";

export interface WechatFinalReplySender {
  sendFile: (filePath: string) => Promise<unknown>;
  sendImage: (imagePath: string) => Promise<unknown>;
  sendText: (text: string) => Promise<void>;
  sendVideo: (videoPath: string) => Promise<unknown>;
  sendVoice: (voicePath: string) => Promise<unknown>;
}

const AUTO_CLEANUP_MEDIA_DIR = path.join(os.homedir(), "meidia");

function shouldAutoCleanupAttachment(filePath: string): boolean {
  const normalizedPath = path.resolve(filePath);
  const mediaRoot = path.resolve(AUTO_CLEANUP_MEDIA_DIR);

  return (
    normalizedPath === mediaRoot ||
    normalizedPath.startsWith(`${mediaRoot}${path.sep}`)
  );
}

function cleanupManagedAttachment(filePath: string): void {
  if (!shouldAutoCleanupAttachment(filePath)) {
    return;
  }
  if (!fs.existsSync(filePath)) {
    return;
  }
  if (!fs.statSync(filePath).isFile()) {
    return;
  }

  fs.rmSync(filePath, { force: true });
}

export async function forwardWechatFinalReply(params: {
  adapter: BridgeAdapterKind;
  rawText: string;
  sender: WechatFinalReplySender;
}): Promise<void> {
  const { adapter, rawText, sender } = params;
  const parsed = parseWechatFinalReply(rawText);
  const visibleText = formatFinalReplyMessage(
    adapter,
    sanitizeWechatFinalReplyText(adapter, parsed.visibleText)
  ).trim();

  if (visibleText) {
    await sender.sendText(visibleText);
  }

  for (const attachment of parsed.attachments) {
    try {
      switch (attachment.kind) {
        case "image":
          await sender.sendImage(attachment.path);
          break;
        case "file":
          await sender.sendFile(attachment.path);
          break;
        case "voice":
          await sender.sendVoice(attachment.path);
          break;
        case "video":
          await sender.sendVideo(attachment.path);
          break;
      }

      cleanupManagedAttachment(attachment.path);
    } catch (error) {
      const errorText =
        error instanceof Error
          ? error.message
          : String(error ?? "unknown error");
      await sender.sendText(
        `Failed to send ${attachment.kind} attachment: ${attachment.path}\n${errorText}`
      );
    }
  }
}
