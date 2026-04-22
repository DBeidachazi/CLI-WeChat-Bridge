import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotEnv } from "dotenv";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(MODULE_DIR, "..", "..");

declare global {
  // eslint-disable-next-line no-var
  var __CLI_WECHAT_BRIDGE_ENV_LOADED__: boolean | undefined;
}

export const ENV_FILE_PATH =
  process.env.CLI_WECHAT_BRIDGE_ENV_FILE?.trim()
    ? path.resolve(process.env.CLI_WECHAT_BRIDGE_ENV_FILE.trim())
    : path.join(PROJECT_DIR, ".env");

if (!globalThis.__CLI_WECHAT_BRIDGE_ENV_LOADED__) {
  if (fs.existsSync(ENV_FILE_PATH)) {
    loadDotEnv({
      path: ENV_FILE_PATH,
      override: false,
      quiet: true,
    });
  }

  globalThis.__CLI_WECHAT_BRIDGE_ENV_LOADED__ = true;
}

export const PROJECT_ROOT = PROJECT_DIR;
