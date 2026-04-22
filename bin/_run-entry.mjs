#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(BIN_DIR, "..");

export function runTsEntry(relativeEntryPath, extraArgs = []) {
  const entryPath = path.join(PROJECT_DIR, relativeEntryPath);
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-strip-types",
      entryPath,
      ...extraArgs,
      ...process.argv.slice(2),
    ],
    {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    },
  );

  child.once("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });

  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}
