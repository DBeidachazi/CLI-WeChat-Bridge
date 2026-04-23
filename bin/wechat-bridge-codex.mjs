#!/usr/bin/env node

import { runTsEntry } from "./_run-entry.mjs";

runTsEntry("src/bridge/wechat-bridge.ts", ["--adapter", "codex"]);
