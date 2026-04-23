import fs from "node:fs";

import "./env.ts";

import type { BridgeAdapterKind } from "../bridge/bridge-types.ts";

export const COMPANION_BRIDGE_ADAPTERS = [
  "codex",
  "claude",
  "opencode",
  "gemini",
  "copilot",
] as const;
export const ALL_BRIDGE_ADAPTERS = [
  ...COMPANION_BRIDGE_ADAPTERS,
  "shell",
] as const;

export type CompanionBridgeAdapterKind =
  (typeof COMPANION_BRIDGE_ADAPTERS)[number];
export type AcpBridgeAdapterKind = Extract<
  BridgeAdapterKind,
  "gemini" | "copilot"
>;

export type CodexApprovalPolicy =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never";
export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

const DEFAULT_CODEX_MODEL = "gpt-5.4-mini";
const DEFAULT_GEMINI_MODEL = "auto-gemini-3";
const DEFAULT_COPILOT_MODEL = "gpt-5.4-mini";
const DEFAULT_COPILOT_MODE =
  "https://agentclientprotocol.com/protocol/session-modes#autopilot";

function readEnv(key: string): string | undefined {
  const value = process.env[key];
  if (typeof value !== "string") {
    return;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function readBooleanEnv(key: string, fallback: boolean): boolean {
  const value = readEnv(key);
  if (!value) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }

  return fallback;
}

function readIntegerEnv(key: string, fallback: number): number {
  const value = readEnv(key);
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBridgeAdapterEnv(
  key: string,
  fallback: BridgeAdapterKind
): BridgeAdapterKind {
  const value = readEnv(key);
  if (!value) {
    return fallback;
  }

  return isBridgeAdapterKind(value) ? value : fallback;
}

function buildDefaultSpawnCommand(kind: BridgeAdapterKind): string {
  switch (kind) {
    case "codex":
      return `codex --model ${getConfiguredModelId("codex") ?? DEFAULT_CODEX_MODEL} --dangerously-bypass-approvals-and-sandbox`;
    case "claude":
      return "claude";
    case "opencode":
      return "opencode";
    case "gemini":
      return "gemini --acp";
    case "copilot":
      return "copilot --acp --stdio";
    case "shell":
      return process.platform === "win32" ? "powershell.exe" : "bash";
  }
}

export function isBridgeAdapterKind(value: string): value is BridgeAdapterKind {
  return (ALL_BRIDGE_ADAPTERS as readonly string[]).includes(value);
}

export function isCompanionBridgeAdapterKind(
  value: BridgeAdapterKind
): value is CompanionBridgeAdapterKind {
  return (COMPANION_BRIDGE_ADAPTERS as readonly string[]).includes(value);
}

export function isAcpBridgeAdapterKind(
  value: BridgeAdapterKind
): value is AcpBridgeAdapterKind {
  return value === "gemini" || value === "copilot";
}

export function envKeyForSpawnCommand(kind: BridgeAdapterKind): string {
  return `WECHAT_BRIDGE_SPAWN_${kind.toUpperCase()}`;
}

export function envKeyForInstallCommand(
  kind: CompanionBridgeAdapterKind
): string {
  return `WECHAT_BRIDGE_INSTALL_${kind.toUpperCase()}`;
}

export function getConfiguredSpawnCommand(kind: BridgeAdapterKind): string {
  return readEnv(envKeyForSpawnCommand(kind)) ?? buildDefaultSpawnCommand(kind);
}

export function getConfiguredInstallCommand(
  kind: CompanionBridgeAdapterKind
): string | undefined {
  return readEnv(envKeyForInstallCommand(kind));
}

export function getConfiguredModelId(
  kind: BridgeAdapterKind
): string | undefined {
  const perAdapter = readEnv(`WECHAT_BRIDGE_${kind.toUpperCase()}_MODEL`);
  if (perAdapter) {
    return perAdapter;
  }

  const shared = readEnv("WECHAT_BRIDGE_DEFAULT_MODEL");
  if (shared && (kind === "codex" || kind === "copilot")) {
    return shared;
  }

  if (kind === "codex") {
    return DEFAULT_CODEX_MODEL;
  }

  if (kind === "gemini") {
    return DEFAULT_GEMINI_MODEL;
  }

  if (kind === "copilot") {
    return DEFAULT_COPILOT_MODEL;
  }

  return;
}

export function getConfiguredAcpMode(
  kind: AcpBridgeAdapterKind
): string | undefined {
  const explicit = readEnv(`WECHAT_BRIDGE_${kind.toUpperCase()}_MODE`);
  if (explicit) {
    return explicit;
  }

  return kind === "gemini" ? "yolo" : DEFAULT_COPILOT_MODE;
}

export function getConfiguredDefaultCliProgram(): BridgeAdapterKind {
  return readBridgeAdapterEnv("WECHAT_BRIDGE_DEFAULT_CLI_PROGRAM", "codex");
}

export function getConfiguredUpdateCheckHour(): number {
  const parsed = readIntegerEnv("WECHAT_BRIDGE_UPDATE_CHECK_HOUR", 5);
  if (parsed < 0 || parsed > 23) {
    return 5;
  }
  return parsed;
}

export function shouldAutoApproveAcpPermissions(): boolean {
  return readBooleanEnv("WECHAT_BRIDGE_ACP_AUTO_APPROVE", true);
}

export function shouldAutoInstallCliPackages(): boolean {
  return readBooleanEnv("WECHAT_BRIDGE_AUTO_INSTALL_CLIS", true);
}

export function shouldLogBridgeTranscript(): boolean {
  return readBooleanEnv("WECHAT_BRIDGE_LOG_TRANSCRIPT", true);
}

export function shouldMirrorBackgroundBridgeLogsToContainer(): boolean {
  if (readEnv("WECHAT_BRIDGE_BACKGROUND_LOG_TO_CONTAINER")) {
    return readBooleanEnv("WECHAT_BRIDGE_BACKGROUND_LOG_TO_CONTAINER", true);
  }

  return (
    process.platform !== "win32" &&
    (fs.existsSync("/.dockerenv") ||
      (typeof process.env.container === "string" &&
        process.env.container.length > 0))
  );
}

export function getConfiguredTmuxSessionPrefix(): string {
  return readEnv("WECHAT_BRIDGE_TMUX_SESSION_PREFIX") ?? "wechat-bridge";
}

export function getConfiguredCodexApprovalPolicy(): CodexApprovalPolicy {
  const value = readEnv("WECHAT_BRIDGE_CODEX_APPROVAL_POLICY");
  if (!value) {
    return "never";
  }

  switch (value) {
    case "untrusted":
    case "on-failure":
    case "on-request":
    case "never":
      return value;
    default:
      return "never";
  }
}

export function getConfiguredCodexSandboxMode(): CodexSandboxMode {
  const value = readEnv("WECHAT_BRIDGE_CODEX_SANDBOX");
  if (!value) {
    return "danger-full-access";
  }

  switch (value) {
    case "read-only":
    case "workspace-write":
    case "danger-full-access":
      return value;
    default:
      return "danger-full-access";
  }
}
