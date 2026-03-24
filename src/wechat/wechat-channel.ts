#!/usr/bin/env bun
/**
 * WeChat MCP server.
 *
 * This server exposes standard MCP tools instead of relying on
 * Claude's preview-only channel push API.
 */

import crypto from "node:crypto";
import fs from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  CONTEXT_CACHE_FILE,
  CREDENTIALS_FILE,
  ensureChannelDataDir,
  migrateLegacyChannelFiles,
  SYNC_BUF_FILE,
} from "./channel-config.ts";

const SERVER_NAME = "wechat";
const SERVER_VERSION = "0.2.0";
const CHANNEL_VERSION = "0.2.0";

const DEFAULT_POLL_TIMEOUT_MS = 1_000;
const MAX_POLL_TIMEOUT_MS = 35_000;
const RECENT_MESSAGE_CACHE_SIZE = 500;

const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_ITEM_TEXT = 1;
const MSG_ITEM_VOICE = 3;
const MSG_STATE_FINISH = 2;

type AccountData = {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
};

type ContextTokenState = Record<string, string>;

type FetchMessagesArgs = {
  waitForNew: boolean;
  timeoutMs: number;
};

type ReplyArgs = {
  senderId: string;
  text: string;
};

type ResetSyncArgs = {
  clearContextCache: boolean;
};

type MessageSummary = {
  senderId: string;
  sender: string;
  sessionId: string;
  createdAt: string;
  text: string;
};

interface TextItem {
  text?: string;
}

interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

interface MessageItem {
  type?: number;
  text_item?: TextItem;
  voice_item?: { text?: string };
  ref_msg?: RefMessage;
}

interface WeixinMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  create_time_ms?: number;
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
}

function log(message: string): void {
  process.stderr.write(`[wechat-mcp] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[wechat-mcp] ERROR: ${message}\n`);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (err) {
    logError(`Failed to read ${filePath}: ${String(err)}`);
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureChannelDataDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function loadCredentials(): AccountData | null {
  return readJsonFile<AccountData>(CREDENTIALS_FILE);
}

function loadContextTokenState(): ContextTokenState {
  return readJsonFile<ContextTokenState>(CONTEXT_CACHE_FILE) ?? {};
}

const contextTokenCache = new Map<string, string>(
  Object.entries(loadContextTokenState()),
);

function persistContextTokenState(): void {
  writeJsonFile(CONTEXT_CACHE_FILE, Object.fromEntries(contextTokenCache));
}

function cacheContextToken(userId: string, token: string): void {
  contextTokenCache.set(userId, token);
  persistContextTokenState();
}

function clearContextTokenCache(): void {
  contextTokenCache.clear();
  if (fs.existsSync(CONTEXT_CACHE_FILE)) {
    fs.rmSync(CONTEXT_CACHE_FILE, { force: true });
  }
}

function getCachedContextToken(userId: string): string | undefined {
  return contextTokenCache.get(userId);
}

function loadSyncBuffer(): string {
  try {
    if (!fs.existsSync(SYNC_BUF_FILE)) {
      return "";
    }
    return fs.readFileSync(SYNC_BUF_FILE, "utf-8");
  } catch (err) {
    logError(`Failed to read sync state: ${String(err)}`);
    return "";
  }
}

function saveSyncBuffer(syncBuffer: string): void {
  ensureChannelDataDir();
  fs.writeFileSync(SYNC_BUF_FILE, syncBuffer, "utf-8");
}

function clearSyncBuffer(): void {
  if (fs.existsSync(SYNC_BUF_FILE)) {
    fs.rmSync(SYNC_BUF_FILE, { force: true });
  }
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };

  if (body) {
    headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const base = params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(params.token, params.body),
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return text;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function getUpdates(
  account: AccountData,
  getUpdatesBuf: string,
  timeoutMs: number,
): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl: account.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token: account.token,
      timeoutMs,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

function generateClientId(): string {
  return `wechat-mcp:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function sendTextMessage(
  account: AccountData,
  to: string,
  text: string,
  contextToken: string,
): Promise<string> {
  const trimmedText = text.trim();
  if (!trimmedText) {
    throw new Error("Reply text cannot be empty.");
  }

  const clientId = generateClientId();
  await apiFetch({
    baseUrl: account.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text: trimmedText } }],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token: account.token,
    timeoutMs: 15_000,
  });
  return clientId;
}

function extractReferenceLabel(item: MessageItem): string | null {
  const ref = item.ref_msg;
  if (!ref) {
    return null;
  }

  const parts: string[] = [];
  if (ref.title?.trim()) {
    parts.push(ref.title.trim());
  }
  const quotedText = ref.message_item?.text_item?.text?.trim();
  if (quotedText) {
    parts.push(quotedText);
  }

  return parts.length ? `Quoted: ${parts.join(" | ")}` : null;
}

function extractTextFromMessage(msg: WeixinMessage): string {
  if (!msg.item_list?.length) {
    return "";
  }

  const lines: string[] = [];

  for (const item of msg.item_list) {
    const reference = extractReferenceLabel(item);
    if (reference && !lines.includes(reference)) {
      lines.push(reference);
    }

    if (item.type === MSG_ITEM_TEXT) {
      const text = item.text_item?.text?.trim();
      if (text) {
        lines.push(text);
      }
    }

    if (item.type === MSG_ITEM_VOICE) {
      const transcript = item.voice_item?.text?.trim();
      if (transcript) {
        lines.push(transcript);
      }
    }
  }

  return lines.join("\n").trim();
}

const recentMessageKeys = new Set<string>();
const recentMessageOrder: string[] = [];

function buildMessageKey(msg: WeixinMessage): string {
  return [
    msg.from_user_id ?? "",
    msg.client_id ?? "",
    String(msg.create_time_ms ?? ""),
    msg.context_token ?? "",
  ].join("|");
}

function rememberMessage(key: string): boolean {
  if (!key || recentMessageKeys.has(key)) {
    return false;
  }

  recentMessageKeys.add(key);
  recentMessageOrder.push(key);

  while (recentMessageOrder.length > RECENT_MESSAGE_CACHE_SIZE) {
    const oldest = recentMessageOrder.shift();
    if (oldest) {
      recentMessageKeys.delete(oldest);
    }
  }

  return true;
}

function clearRecentMessages(): void {
  recentMessageKeys.clear();
  recentMessageOrder.length = 0;
}

function formatTimestamp(timestampMs?: number): string {
  if (!timestampMs) {
    return "(unknown)";
  }
  return new Date(timestampMs).toISOString();
}

function normalizeSender(senderId: string): string {
  return senderId.split("@")[0] || senderId;
}

function requireAccount():
  | { account: AccountData }
  | { error: string } {
  const account = loadCredentials();
  if (!account) {
    return {
      error: `No saved WeChat credentials found. Run "bun run setup" first. Expected file: ${CREDENTIALS_FILE}`,
    };
  }
  return { account };
}

function asObject(args: unknown): Record<string, unknown> {
  return args && typeof args === "object"
    ? (args as Record<string, unknown>)
    : {};
}

function clampTimeoutMs(value: unknown, fallbackMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallbackMs;
  }
  const rounded = Math.floor(value);
  return Math.min(Math.max(rounded, 1_000), MAX_POLL_TIMEOUT_MS);
}

function parseFetchMessagesArgs(args: unknown): FetchMessagesArgs {
  const record = asObject(args);
  const waitForNew =
    typeof record.wait_for_new === "boolean" ? record.wait_for_new : false;
  const fallbackTimeout = waitForNew ? 15_000 : DEFAULT_POLL_TIMEOUT_MS;

  return {
    waitForNew,
    timeoutMs: clampTimeoutMs(record.timeout_ms, fallbackTimeout),
  };
}

function parseResetSyncArgs(args: unknown): ResetSyncArgs {
  const record = asObject(args);
  return {
    clearContextCache:
      typeof record.clear_context_cache === "boolean"
        ? record.clear_context_cache
        : false,
  };
}

function parseReplyArgs(args: unknown):
  | { value: ReplyArgs }
  | { error: string } {
  const record = asObject(args);
  const senderId = record.sender_id;
  const text = record.text;

  if (typeof senderId !== "string" || !senderId.trim()) {
    return { error: "sender_id must be a non-empty string." };
  }
  if (typeof text !== "string" || !text.trim()) {
    return { error: "text must be a non-empty string." };
  }

  return {
    value: {
      senderId: senderId.trim(),
      text: text.trim(),
    },
  };
}

async function fetchMessages(
  args: FetchMessagesArgs,
): Promise<string> {
  const accountResult = requireAccount();
  if ("error" in accountResult) {
    return `error: ${accountResult.error}`;
  }

  const syncBuffer = loadSyncBuffer();
  const resp = await getUpdates(accountResult.account, syncBuffer, args.timeoutMs);

  const isError =
    (resp.ret !== undefined && resp.ret !== 0) ||
    (resp.errcode !== undefined && resp.errcode !== 0);
  if (isError) {
    return `error: getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`;
  }

  if (resp.get_updates_buf) {
    saveSyncBuffer(resp.get_updates_buf);
  }

  const messages: MessageSummary[] = [];

  for (const msg of resp.msgs ?? []) {
    if (msg.message_type !== MSG_TYPE_USER) {
      continue;
    }

    const text = extractTextFromMessage(msg);
    if (!text) {
      continue;
    }

    const senderId = msg.from_user_id ?? "unknown";
    const messageKey = buildMessageKey(msg);
    if (!rememberMessage(messageKey)) {
      continue;
    }

    if (msg.context_token) {
      cacheContextToken(senderId, msg.context_token);
    }

    messages.push({
      senderId,
      sender: normalizeSender(senderId),
      sessionId: msg.session_id ?? "",
      createdAt: formatTimestamp(msg.create_time_ms),
      text,
    });
  }

  if (!messages.length) {
    return "No new WeChat messages.";
  }

  const blocks = messages.map((message, index) =>
    [
      `[${index + 1}]`,
      `sender_id: ${message.senderId}`,
      `sender: ${message.sender}`,
      `session_id: ${message.sessionId || "(unknown)"}`,
      `created_at: ${message.createdAt}`,
      "text:",
      message.text,
    ].join("\n"),
  );

  return [
    `Fetched ${messages.length} new WeChat message${messages.length === 1 ? "" : "s"}.`,
    "",
    ...blocks,
  ].join("\n");
}

function getStatusText(): string {
  const account = loadCredentials();
  const syncExists = fs.existsSync(SYNC_BUF_FILE);
  const contextExists = fs.existsSync(CONTEXT_CACHE_FILE);

  return [
    `credentials_file: ${CREDENTIALS_FILE}`,
    `credentials_present: ${account ? "yes" : "no"}`,
    `sync_state_file: ${SYNC_BUF_FILE}`,
    `sync_state_present: ${syncExists ? "yes" : "no"}`,
    `context_cache_file: ${CONTEXT_CACHE_FILE}`,
    `context_cache_present: ${contextExists ? "yes" : "no"}`,
    `cached_context_count: ${contextTokenCache.size}`,
    `account_id: ${account?.accountId ?? "(none)"}`,
    `user_id: ${account?.userId ?? "(none)"}`,
    `saved_at: ${account?.savedAt ?? "(none)"}`,
  ].join("\n");
}

function resetSyncState(args: ResetSyncArgs): string {
  clearSyncBuffer();
  clearRecentMessages();
  if (args.clearContextCache) {
    clearContextTokenCache();
  }

  return args.clearContextCache
    ? "Reset sync state and cleared cached context tokens."
    : "Reset sync state.";
}

async function replyToMessage(args: ReplyArgs): Promise<string> {
  const accountResult = requireAccount();
  if ("error" in accountResult) {
    return `error: ${accountResult.error}`;
  }

  const contextToken = getCachedContextToken(args.senderId);
  if (!contextToken) {
    return `error: no cached context token for ${args.senderId}. Run wechat_fetch_messages first.`;
  }

  await sendTextMessage(
    accountResult.account,
    args.senderId,
    args.text,
    contextToken,
  );

  return `Sent reply to ${args.senderId}.`;
}

const mcp = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: {
      tools: {},
    },
    instructions: [
      "Use wechat_fetch_messages to pull new inbound WeChat messages.",
      "Use wechat_reply to send a plain-text response.",
      "Run wechat_fetch_messages before replying so the sender's context token is cached.",
      "Use wechat_get_status to inspect auth and local state.",
      "Use wechat_reset_sync if you need to clear local sync state.",
    ].join("\n"),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "wechat_get_status",
      description: "Show saved account information and local MCP state files.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "wechat_fetch_messages",
      description: "Pull new WeChat messages using the saved sync cursor.",
      inputSchema: {
        type: "object" as const,
        properties: {
          wait_for_new: {
            type: "boolean",
            description: "If true, long-poll briefly for new messages before returning.",
          },
          timeout_ms: {
            type: "number",
            description: "Polling timeout in milliseconds. Max 35000.",
          },
        },
      },
    },
    {
      name: "wechat_reply",
      description: "Send a plain-text reply to a WeChat sender_id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sender_id: {
            type: "string",
            description: "The sender_id from wechat_fetch_messages output.",
          },
          text: {
            type: "string",
            description: "The plain-text message to send.",
          },
        },
        required: ["sender_id", "text"],
      },
    },
    {
      name: "wechat_reset_sync",
      description: "Clear saved sync state so future fetches restart from a fresh cursor.",
      inputSchema: {
        type: "object" as const,
        properties: {
          clear_context_cache: {
            type: "boolean",
            description: "If true, also clear cached reply context tokens.",
          },
        },
      },
    },
  ],
}));

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  switch (req.params.name) {
    case "wechat_get_status":
      return textResult(getStatusText());
    case "wechat_fetch_messages":
      return textResult(await fetchMessages(parseFetchMessagesArgs(req.params.arguments)));
    case "wechat_reset_sync":
      return textResult(resetSyncState(parseResetSyncArgs(req.params.arguments)));
    case "wechat_reply": {
      const parsed = parseReplyArgs(req.params.arguments);
      if ("error" in parsed) {
        return textResult(`error: ${parsed.error}`);
      }
      return textResult(await replyToMessage(parsed.value));
    }
    default:
      throw new Error(`unknown tool: ${req.params.name}`);
  }
});

async function main() {
  migrateLegacyChannelFiles(log);

  if (process.argv.includes("--check")) {
    log(getStatusText());
    process.exit(0);
  }

  await mcp.connect(new StdioServerTransport());
  log("WeChat MCP server is ready.");
}

main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  process.exit(1);
});
