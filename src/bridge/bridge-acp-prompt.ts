import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { BridgeInputAttachment, BridgeUserInput } from "./bridge-types.ts";

export type AcpPromptCapabilities = {
  image: boolean;
  audio: boolean;
};

function isPromptInlineAttachmentSupported(
  attachment: BridgeInputAttachment,
  capabilities: AcpPromptCapabilities
): boolean {
  return (
    (attachment.kind === "image" && capabilities.image) ||
    (attachment.kind === "voice" &&
      capabilities.audio &&
      typeof attachment.mimeType === "string" &&
      attachment.mimeType.startsWith("audio/"))
  );
}

function buildAcpPromptAttachmentBlock(
  attachment: BridgeInputAttachment
): Record<string, unknown> | null {
  try {
    const data = fs.readFileSync(attachment.path).toString("base64");
    const uri = pathToFileURL(attachment.path).toString();
    if (attachment.kind === "image") {
      return {
        type: "image",
        mimeType: attachment.mimeType ?? "image/jpeg",
        data,
        uri,
      };
    }
    if (attachment.kind === "voice") {
      return {
        type: "audio",
        mimeType: attachment.mimeType ?? "audio/silk",
        data,
        uri,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function buildAcpResourceLinkBlock(
  attachment: BridgeInputAttachment
): Record<string, unknown> {
  return {
    type: "resource_link",
    uri: pathToFileURL(attachment.path).toString(),
    name: attachment.title ?? path.basename(attachment.path),
    mimeType: attachment.mimeType,
    size: attachment.sizeBytes,
    description: `Inbound WeChat ${attachment.kind} attachment`,
  };
}

export function buildAcpPromptContent(
  input: BridgeUserInput,
  capabilities: AcpPromptCapabilities
): Record<string, unknown>[] {
  const prompt: Record<string, unknown>[] = [
    {
      type: "text",
      text: input.text,
    },
  ];

  for (const attachment of input.attachments ?? []) {
    if (isPromptInlineAttachmentSupported(attachment, capabilities)) {
      const inlineBlock = buildAcpPromptAttachmentBlock(attachment);
      if (inlineBlock) {
        prompt.push(inlineBlock);
        continue;
      }
    }
    prompt.push(buildAcpResourceLinkBlock(attachment));
  }

  return prompt;
}
