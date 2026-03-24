import crypto from "node:crypto";
import fs from "node:fs";

import {
  CONTEXT_CACHE_FILE,
  CREDENTIALS_FILE,
  ensureChannelDataDir,
  migrateLegacyChannelFiles,
  SYNC_BUF_FILE,
} from "./channel-config.ts";

export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_ITEM_TEXT = 1;
const MSG_ITEM_VOICE = 3;
const MSG_STATE_FINISH = 2;
const CHANNEL_VERSION = "0.3.0";
const RECENT_MESSAGE_CACHE_SIZE = 500;

type AccountData = {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
};

type ContextTokenState = Record<string, string>;

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

export type InboundWechatMessage = {
  senderId: string;
  sender: string;
  sessionId: string;
  text: string;
  contextToken?: string;
  createdAt: string;
  createdAtMs?: number;
};

type PollMessagesOptions = {
  timeoutMs?: number;
  minCreatedAtMs?: number;
};

type PollMessagesResult = {
  messages: InboundWechatMessage[];
  ignoredBacklogCount: number;
};

type TransportLogger = {
  log: (message: string) => void;
  logError: (message: string) => void;
};

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureChannelDataDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
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

function extractTextFromMessage(message: WeixinMessage): string {
  if (!message.item_list?.length) {
    return "";
  }

  const lines: string[] = [];
  for (const item of message.item_list) {
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

function buildMessageKey(message: WeixinMessage): string {
  return [
    message.from_user_id ?? "",
    message.client_id ?? "",
    String(message.create_time_ms ?? ""),
    message.context_token ?? "",
  ].join("|");
}

function normalizeSender(senderId: string): string {
  return senderId.split("@")[0] || senderId;
}

function formatTimestamp(timestampMs?: number): string {
  if (!timestampMs) {
    return new Date().toISOString();
  }
  return new Date(timestampMs).toISOString();
}

export class WeChatTransport {
  private readonly logger: TransportLogger;
  private readonly recentMessageKeys = new Set<string>();
  private readonly recentMessageOrder: string[] = [];
  private readonly contextTokenCache = new Map<string, string>(
    Object.entries(readJsonFile<ContextTokenState>(CONTEXT_CACHE_FILE) ?? {}),
  );
  private syncBuffer = "";

  constructor(logger: TransportLogger) {
    this.logger = logger;
    migrateLegacyChannelFiles((message) => this.logger.log(message));
    this.syncBuffer = this.readSyncBuffer();
  }

  getCredentials(): AccountData | null {
    return readJsonFile<AccountData>(CREDENTIALS_FILE);
  }

  async pollMessages(
    options: PollMessagesOptions = {},
  ): Promise<PollMessagesResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
    const account = this.getCredentials();
    if (!account) {
      throw new Error(
        `No saved WeChat credentials found. Run "bun run setup" first. Expected file: ${CREDENTIALS_FILE}`,
      );
    }

    const response = await this.getUpdates(account, timeoutMs);
    const isError =
      (response.ret !== undefined && response.ret !== 0) ||
      (response.errcode !== undefined && response.errcode !== 0);

    if (isError) {
      throw new Error(
        `getUpdates failed: ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg ?? ""}`,
      );
    }

    if (response.get_updates_buf) {
      this.syncBuffer = response.get_updates_buf;
      this.saveSyncBuffer(this.syncBuffer);
    }

    const messages: InboundWechatMessage[] = [];
    let ignoredBacklogCount = 0;
    for (const rawMessage of response.msgs ?? []) {
      if (rawMessage.message_type !== MSG_TYPE_USER) {
        continue;
      }

      const text = extractTextFromMessage(rawMessage);
      if (!text) {
        continue;
      }

      const messageKey = buildMessageKey(rawMessage);
      if (!this.rememberMessage(messageKey)) {
        continue;
      }

      const senderId = rawMessage.from_user_id ?? "unknown";
      if (rawMessage.context_token) {
        this.cacheContextToken(senderId, rawMessage.context_token);
      }

      const createdAtMs = rawMessage.create_time_ms;
      if (
        typeof options.minCreatedAtMs === "number" &&
        (!Number.isFinite(createdAtMs) || createdAtMs < options.minCreatedAtMs)
      ) {
        ignoredBacklogCount += 1;
        continue;
      }

      messages.push({
        senderId,
        sender: normalizeSender(senderId),
        sessionId: rawMessage.session_id ?? "",
        text,
        contextToken: rawMessage.context_token,
        createdAt: formatTimestamp(rawMessage.create_time_ms),
        createdAtMs,
      });
    }

    return { messages, ignoredBacklogCount };
  }

  async sendText(senderId: string, text: string): Promise<void> {
    const account = this.getCredentials();
    if (!account) {
      throw new Error(
        `No saved WeChat credentials found. Run "bun run setup" first. Expected file: ${CREDENTIALS_FILE}`,
      );
    }

    const contextToken = this.contextTokenCache.get(senderId);
    if (!contextToken) {
      throw new Error(`No cached context token for ${senderId}.`);
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    await apiFetch({
      baseUrl: account.baseUrl,
      endpoint: "ilink/bot/sendmessage",
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: senderId,
          client_id: this.generateClientId(),
          message_type: MSG_TYPE_BOT,
          message_state: MSG_STATE_FINISH,
          item_list: [{ type: MSG_ITEM_TEXT, text_item: { text: trimmed } }],
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token: account.token,
      timeoutMs: 15_000,
    });
  }

  private async getUpdates(
    account: AccountData,
    timeoutMs: number,
  ): Promise<GetUpdatesResp> {
    try {
      const raw = await apiFetch({
        baseUrl: account.baseUrl,
        endpoint: "ilink/bot/getupdates",
        body: JSON.stringify({
          get_updates_buf: this.syncBuffer,
          base_info: { channel_version: CHANNEL_VERSION },
        }),
        token: account.token,
        timeoutMs,
      });

      return JSON.parse(raw) as GetUpdatesResp;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ret: 0, msgs: [], get_updates_buf: this.syncBuffer };
      }
      throw err;
    }
  }

  private rememberMessage(key: string): boolean {
    if (!key || this.recentMessageKeys.has(key)) {
      return false;
    }

    this.recentMessageKeys.add(key);
    this.recentMessageOrder.push(key);

    while (this.recentMessageOrder.length > RECENT_MESSAGE_CACHE_SIZE) {
      const oldest = this.recentMessageOrder.shift();
      if (oldest) {
        this.recentMessageKeys.delete(oldest);
      }
    }

    return true;
  }

  private readSyncBuffer(): string {
    try {
      if (!fs.existsSync(SYNC_BUF_FILE)) {
        return "";
      }
      return fs.readFileSync(SYNC_BUF_FILE, "utf-8");
    } catch (err) {
      this.logger.logError(`Failed to read sync state: ${String(err)}`);
      return "";
    }
  }

  private saveSyncBuffer(syncBuffer: string): void {
    ensureChannelDataDir();
    fs.writeFileSync(SYNC_BUF_FILE, syncBuffer, "utf-8");
  }

  private cacheContextToken(senderId: string, token: string): void {
    const existing = this.contextTokenCache.get(senderId);
    if (existing === token) {
      return;
    }

    this.contextTokenCache.set(senderId, token);
    writeJsonFile(CONTEXT_CACHE_FILE, Object.fromEntries(this.contextTokenCache));
  }

  private generateClientId(): string {
    return `wechat-bridge:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  }
}
