import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("OpenCode CLI entrypoints", () => {
  test("wechat-opencode launches the shared local companion in opencode mode", () => {
    const source = readRepoFile("bin/wechat-opencode.mjs");

    expect(source).toContain('runTsEntry("src/companion/local-companion.ts", ["--adapter", "opencode"])');
    expect(source).not.toContain("opencode-panel.ts");
  });

  test("wechat-bridge-opencode stays a bridge-only entrypoint", () => {
    const source = readRepoFile("bin/wechat-bridge-opencode.mjs");

    expect(source).toContain('runTsEntry("src/bridge/wechat-bridge.ts", ["--adapter", "opencode"])');
  });

  test("wechat-opencode-start keeps the bridge bootstrap flow", () => {
    const source = readRepoFile("bin/wechat-opencode-start.mjs");

    expect(source).toContain('runTsEntry("src/companion/local-companion-start.ts", ["--adapter", "opencode"])');
  });

  test("package scripts route opencode through the shared companion launcher", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["opencode:panel"]).toContain(
      "src/companion/local-companion.ts --adapter opencode",
    );
    expect(packageJson.scripts?.["opencode:start"]).toContain("local-companion-start.ts --adapter opencode");
    expect(packageJson.scripts?.["opencode:companion"]).toBeUndefined();
  });
});
