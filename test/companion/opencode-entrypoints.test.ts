import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("OpenCode CLI entrypoints", () => {
  test("wechat-opencode opens the native panel directly", () => {
    const source = readRepoFile("bin/wechat-opencode.mjs");

    expect(source).toContain('runTsEntry("src/companion/opencode-panel.ts")');
    expect(source).not.toContain("local-companion-start.ts");
  });

  test("wechat-bridge-opencode stays a bridge-only entrypoint", () => {
    const source = readRepoFile("bin/wechat-bridge-opencode.mjs");

    expect(source).toContain('runTsEntry("src/bridge/wechat-bridge.ts", ["--adapter", "opencode"])');
  });

  test("wechat-opencode-start keeps the bridge bootstrap flow", () => {
    const source = readRepoFile("bin/wechat-opencode-start.mjs");

    expect(source).toContain('runTsEntry("src/companion/local-companion-start.ts", ["--adapter", "opencode"])');
  });

  test("opencode-panel guidance points standalone attach users at the bridge command", () => {
    const source = readRepoFile("src/companion/opencode-panel.ts");

    expect(source).toContain('Starts the visible OpenCode panel and attaches it to the running "wechat-bridge-opencode" instance');
    expect(source).toContain('Start "wechat-bridge-opencode" in that directory first, or use "wechat-opencode-start" to bootstrap both.');
  });

  test("package scripts no longer expose the broken opencode companion alias", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["opencode:panel"]).toContain("src/companion/opencode-panel.ts");
    expect(packageJson.scripts?.["opencode:start"]).toContain("local-companion-start.ts --adapter opencode");
    expect(packageJson.scripts?.["opencode:companion"]).toBeUndefined();
  });
});
