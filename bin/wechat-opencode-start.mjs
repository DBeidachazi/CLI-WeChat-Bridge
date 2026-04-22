#!/usr/bin/env node

import { runTsEntry } from "./_run-entry.mjs";

runTsEntry("src/companion/local-companion-start.ts", ["--adapter", "opencode"]);
