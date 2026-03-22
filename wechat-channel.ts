#!/usr/bin/env bun
/**
 * Claude Code WeChat channel server.
 *
 * Flow:
 *   1. Ensure credentials exist, or run QR login on first start.
 *   2. Long-poll the WeChat ilink API for inbound messages.
 *   3. Forward inbound messages to Claude Code over MCP channel notifications.
 *   4. Expose a reply tool so Claude can send text replies back to WeChat.
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
  BOT_TYPE,
  CREDENTIALS_FILE,
  DEFAULT_BASE_URL,
  ensureChannelDataDir,
  migrateLegacyChannelFiles,
  SYNC_BUF_FILE,
} from "./channel-config.ts";

const CHANNEL_NAME = "wechat";
const CHANNEL_VERSION = "0.1.0";

const LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
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
  longpolling_timeout_ms?: number;
}

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

function log(message: string): void {
  process.stderr.write(`[wechat-channel] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[wechat-channel] ERROR: ${message}\n`);
}

function loadCredentials(): AccountData | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8")) as AccountData;
  } catch (err) {
    logError(`Failed to read credentials from ${CREDENTIALS_FILE}: ${String(err)}`);
    return null;
  }
}

function saveCredentials(data: AccountData): void {
  ensureChannelDataDir();
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(CREDENTIALS_FILE, 0o600);
  } catch {
    // Best effort on Windows.
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

async function fetchQRCode(baseUrl: string): Promise<QRCodeResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
    base,
  );
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`QR fetch failed: ${res.status}`);
  }
  return (await res.json()) as QRCodeResponse;
}

async function pollQRStatus(
  baseUrl: string,
  qrcode: string,
): Promise<QRStatusResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    base,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);

  try {
    const res = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`QR status failed: ${res.status}`);
    }
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

async function doQRLogin(baseUrl: string): Promise<AccountData | null> {
  log("Fetching WeChat login QR code...");
  const qrResp = await fetchQRCode(baseUrl);

  log("");
  log("Scan the QR code in WeChat:");
  try {
    const qrterm = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrterm.default.generate(
        qrResp.qrcode_img_content,
        { small: true },
        (qr: string) => {
          process.stderr.write(`${qr}\n`);
          resolve();
        },
      );
    });
  } catch {
    log(`QR code URL: ${qrResp.qrcode_img_content}`);
  }

  log("Waiting for WeChat confirmation...");
  const deadline = Date.now() + 480_000;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(baseUrl, qrResp.qrcode);

    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        if (!scannedPrinted) {
          log("QR code scanned. Confirm the login in WeChat...");
          scannedPrinted = true;
        }
        break;
      case "expired":
        log("The QR code expired. Restart the server to try again.");
        return null;
      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token) {
          logError("Login was confirmed but bot credentials were missing.");
          return null;
        }

        const account: AccountData = {
          token: status.bot_token,
          baseUrl: status.baseurl || baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        };

        saveCredentials(account);
        log(`WeChat login completed for ${account.accountId}.`);
        return account;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  log("Login timed out.");
  return null;
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

const contextTokenCache = new Map<string, string>();

function cacheContextToken(userId: string, token: string): void {
  contextTokenCache.set(userId, token);
}

function getCachedContextToken(userId: string): string | undefined {
  return contextTokenCache.get(userId);
}

async function getUpdates(
  baseUrl: string,
  token: string,
  getUpdatesBuf: string,
): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs: LONG_POLL_TIMEOUT_MS,
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
  return `claude-code-wechat:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function sendTextMessage(
  baseUrl: string,
  token: string,
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
    baseUrl,
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
    token,
    timeoutMs: 15_000,
  });
  return clientId;
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

function parseWechatReplyArguments(args: unknown):
  | { senderId: string; text: string }
  | { error: string } {
  if (!args || typeof args !== "object") {
    return { error: "Missing tool arguments." };
  }

  const senderId = (args as { sender_id?: unknown }).sender_id;
  const text = (args as { text?: unknown }).text;

  if (typeof senderId !== "string" || !senderId.trim()) {
    return { error: "sender_id must be a non-empty string." };
  }
  if (typeof text !== "string" || !text.trim()) {
    return { error: "text must be a non-empty string." };
  }

  return {
    senderId: senderId.trim(),
    text: text.trim(),
  };
}

const mcp = new Server(
  { name: CHANNEL_NAME, version: CHANNEL_VERSION },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      `Messages from WeChat users arrive as <channel source="wechat" sender="..." sender_id="...">.`,
      "Reply with the wechat_reply tool and pass the sender_id from the inbound tag.",
      "Messages are from real WeChat users via the WeChat ClawBot interface.",
      "Respond naturally in Chinese unless the user writes in another language.",
      "Keep replies concise because WeChat is a chat app.",
      "Use plain text only. Do not rely on Markdown formatting.",
    ].join("\n"),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "wechat_reply",
      description: "Send a text reply back to the WeChat user",
      inputSchema: {
        type: "object" as const,
        properties: {
          sender_id: {
            type: "string",
            description: "The sender_id from the inbound channel tag",
          },
          text: {
            type: "string",
            description: "The plain-text message to send",
          },
        },
        required: ["sender_id", "text"],
      },
    },
  ],
}));

let activeAccount: AccountData | null = null;

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "wechat_reply") {
    throw new Error(`unknown tool: ${req.params.name}`);
  }

  const parsed = parseWechatReplyArguments(req.params.arguments);
  if ("error" in parsed) {
    return {
      content: [{ type: "text" as const, text: `error: ${parsed.error}` }],
    };
  }

  if (!activeAccount) {
    return {
      content: [{ type: "text" as const, text: "error: not logged in" }],
    };
  }

  const contextToken = getCachedContextToken(parsed.senderId);
  if (!contextToken) {
    return {
      content: [
        {
          type: "text" as const,
          text: `error: no context token for ${parsed.senderId}. The user may need to send a message first.`,
        },
      ],
    };
  }

  try {
    await sendTextMessage(
      activeAccount.baseUrl,
      activeAccount.token,
      parsed.senderId,
      parsed.text,
      contextToken,
    );
    return { content: [{ type: "text" as const, text: "sent" }] };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: `send failed: ${String(err)}`,
        },
      ],
    };
  }
});

async function startPolling(account: AccountData): Promise<never> {
  const { baseUrl, token } = account;
  let getUpdatesBuf = "";
  let consecutiveFailures = 0;

  try {
    if (fs.existsSync(SYNC_BUF_FILE)) {
      getUpdatesBuf = fs.readFileSync(SYNC_BUF_FILE, "utf-8");
      if (getUpdatesBuf) {
        log(`Recovered sync state from ${SYNC_BUF_FILE}.`);
      }
    }
  } catch (err) {
    logError(`Failed to load sync state: ${String(err)}`);
  }

  log("Starting WeChat long-poll loop...");

  while (true) {
    try {
      const resp = await getUpdates(baseUrl, token, getUpdatesBuf);

      const isError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);
      if (isError) {
        consecutiveFailures++;
        logError(
          `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logError(
            `Backing off for ${BACKOFF_DELAY_MS / 1000}s after ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`,
          );
          consecutiveFailures = 0;
          await new Promise((resolve) => setTimeout(resolve, BACKOFF_DELAY_MS));
        } else {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf) {
        getUpdatesBuf = resp.get_updates_buf;
        try {
          ensureChannelDataDir();
          fs.writeFileSync(SYNC_BUF_FILE, getUpdatesBuf, "utf-8");
        } catch (err) {
          logError(`Failed to persist sync state: ${String(err)}`);
        }
      }

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

        log(`Inbound message from ${senderId}: ${text.slice(0, 80)}`);

        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: text,
            meta: {
              sender: senderId.split("@")[0] || senderId,
              sender_id: senderId,
            },
          },
        });
      }
    } catch (err) {
      consecutiveFailures++;
      logError(`Polling error: ${String(err)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await new Promise((resolve) => setTimeout(resolve, BACKOFF_DELAY_MS));
      } else {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }
}

async function main() {
  migrateLegacyChannelFiles(log);

  if (process.argv.includes("--check")) {
    log(`Credentials file: ${CREDENTIALS_FILE}`);
    log(`Sync state file: ${SYNC_BUF_FILE}`);
    const account = loadCredentials();
    if (account) {
      log(`Saved account detected: ${account.accountId}`);
      process.exit(0);
    }
    log("No saved WeChat credentials found.");
    process.exit(1);
  }

  await mcp.connect(new StdioServerTransport());
  log("MCP transport connected.");

  let account = loadCredentials();
  if (!account) {
    log("No saved credentials found. Starting QR login...");
    account = await doQRLogin(DEFAULT_BASE_URL);
    if (!account) {
      logError("Login failed. Exiting.");
      process.exit(1);
    }
  } else {
    log(`Using saved account ${account.accountId}.`);
  }

  activeAccount = account;
  await startPolling(account);
}

main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  process.exit(1);
});
