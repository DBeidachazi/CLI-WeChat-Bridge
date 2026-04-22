import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { buildAcpPromptContent } from "../../src/bridge/bridge-acp-prompt.ts";

const tempDirectories: string[] = [];

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wechat-bridge-acp-test-"),
  );
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (!directory) {
      continue;
    }

    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("buildAcpPromptContent", () => {
  test("inlines supported images and falls back to resource links for unsupported media", () => {
    const tempDir = makeTempDirectory();
    const imagePath = path.join(tempDir, "photo.png");
    const filePath = path.join(tempDir, "report.pdf");
    fs.writeFileSync(imagePath, Buffer.from("image-bytes"));
    fs.writeFileSync(filePath, Buffer.from("pdf-bytes"));

    const blocks = buildAcpPromptContent(
      {
        text: "Check these WeChat attachments.",
        attachments: [
          {
            kind: "image",
            path: imagePath,
            mimeType: "image/png",
          },
          {
            kind: "file",
            path: filePath,
            mimeType: "application/pdf",
            title: "report.pdf",
          },
        ],
      },
      {
        image: true,
        audio: false,
      },
    );

    expect(blocks[0]).toMatchObject({
      type: "text",
      text: "Check these WeChat attachments.",
    });
    expect(blocks[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(blocks[2]).toMatchObject({
      type: "resource_link",
      name: "report.pdf",
      mimeType: "application/pdf",
    });
  });
});
