import crypto, { createCipheriv, createDecipheriv } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BridgeInputAttachment } from "../bridge/bridge-types.ts";
import {
  CHANNEL_DATA_DIR,
  CONTEXT_CACHE_FILE,
  CREDENTIALS_FILE,
  ensureChannelDataDir,
  INBOUND_MESSAGE_CLAIMS_DIR,
  migrateLegacyChannelFiles,
  SYNC_BUF_FILE,
} from "./channel-config.ts";

export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const CHANNEL_VERSION = "0.3.0";
const RECENT_MESSAGE_CACHE_SIZE = 500;
const BYTES_PER_MB = 1024 * 1024;
const SEND_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;
const CDN_MAX_RETRIES = 3;
const ERROR_CAUSE_DEPTH_LIMIT = 4;
const INBOUND_MESSAGE_CLAIM_TTL_MS = 10 * 60 * 1000;

const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;

const MSG_ITEM_TEXT = 1;
const MSG_ITEM_IMAGE = 2;
const MSG_ITEM_VOICE = 3;
const MSG_ITEM_FILE = 4;
const MSG_ITEM_VIDEO = 5;

const MSG_STATE_FINISH = 2;
const TYPING_STATUS_TYPING = 1;
const TYPING_STATUS_CANCEL = 2;

const UPLOAD_MEDIA_TYPE_IMAGE = 1;
const UPLOAD_MEDIA_TYPE_VIDEO = 2;
const UPLOAD_MEDIA_TYPE_FILE = 3;
const UPLOAD_MEDIA_TYPE_VOICE = 4;

export interface AccountData {
  accountId: string;
  baseUrl: string;
  savedAt: string;
  token: string;
  userId?: string;
}

type ContextTokenState = Record<string, string>;

interface TextItem {
  text?: string;
}

interface CDNMedia {
  aes_key?: string;
  encrypt_query_param?: string;
  encrypt_type?: number;
  full_url?: string;
}

interface ImageItem {
  aeskey?: string;
  media?: CDNMedia;
  mid_size?: number;
  thumb_media?: CDNMedia;
  url?: string;
}

interface VoiceItem {
  encode_type?: number;
  media?: CDNMedia;
  sample_rate?: number;
  text?: string;
}

interface FileItem {
  file_name?: string;
  len?: string;
  media?: CDNMedia;
}

interface VideoItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  video_size?: number;
}

interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

interface MessageItem {
  file_item?: FileItem;
  image_item?: ImageItem;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  type?: number;
  video_item?: VideoItem;
  voice_item?: VoiceItem;
}

interface WeixinMessage {
  client_id?: string;
  context_token?: string;
  create_time_ms?: number;
  from_user_id?: string;
  item_list?: MessageItem[];
  message_state?: number;
  message_type?: number;
  session_id?: string;
  to_user_id?: string;
}

interface GetUpdatesResp {
  errcode?: number;
  errmsg?: string;
  get_updates_buf?: string;
  msgs?: WeixinMessage[];
  ret?: number;
}

export interface InboundWechatMessage {
  attachments: BridgeInputAttachment[];
  contextToken?: string;
  createdAt: string;
  createdAtMs?: number;
  sender: string;
  senderId: string;
  sessionId: string;
  text: string;
}

interface PollMessagesOptions {
  minCreatedAtMs?: number;
  timeoutMs?: number;
}

interface PollMessagesResult {
  ignoredBacklogCount: number;
  messages: InboundWechatMessage[];
}

interface TransportLogger {
  log: (message: string) => void;
  logError: (message: string) => void;
}

interface ResetSyncOptions {
  clearContextCache?: boolean;
}

interface SendImageOptions {
  caption?: string;
  recipientId?: string;
}

interface SendFileOptions {
  recipientId?: string;
  title?: string;
}

interface SendVideoOptions {
  recipientId?: string;
  title?: string;
}

type UploadLabel = "image" | "file" | "voice" | "video";

interface ResolvedRecipient {
  account: AccountData;
  contextToken: string;
  recipientId: string;
}

interface UploadPreparation {
  aeskey: Buffer;
  downloadParam: string;
  filesize: number;
  rawsize: number;
}

type InboundMediaDownloadKind = UploadLabel;

interface InboundMediaDownloadTarget {
  directUrl?: string;
  kind: InboundMediaDownloadKind;
  media?: CDNMedia;
  mimeType?: string;
  preferredAesKeyHex?: string;
  sizeBytes?: number;
  title?: string;
}

export type WechatTransportErrorKind =
  | "timeout"
  | "network"
  | "http"
  | "auth"
  | "unknown";

export interface WechatTransportErrorClassification {
  kind: WechatTransportErrorKind;
  retryable: boolean;
  statusCode?: number;
}

const DEFAULT_MEDIA_UPLOAD_LIMIT_MB: Record<UploadLabel, number> = {
  image: 20,
  file: 50,
  voice: 20,
  video: 300,
};

const MEDIA_UPLOAD_LIMIT_ENV_KEYS: Record<UploadLabel, string> = {
  image: "WECHAT_MAX_IMAGE_MB",
  file: "WECHAT_MAX_FILE_MB",
  voice: "WECHAT_MAX_VOICE_MB",
  video: "WECHAT_MAX_VIDEO_MB",
};
const INBOUND_MEDIA_DIR = path.join(CHANNEL_DATA_DIR, "inbound-media");
const MEDIA_KIND_DEFAULT_EXTENSIONS: Record<InboundMediaDownloadKind, string> =
  {
    image: ".jpg",
    file: ".bin",
    voice: ".silk",
    video: ".mp4",
  };
const MIME_TYPE_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/aac": ".aac",
  "audio/mp4": ".m4a",
  "audio/silk": ".silk",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/webm": ".webm",
};

const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 425, 429]);
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const RETRYABLE_NETWORK_ERROR_HINTS = [
  "connection closed",
  "connection reset",
  "connection refused",
  "econnaborted",
  "econnrefused",
  "econnreset",
  "ehostunreach",
  "enetunreach",
  "enotfound",
  "eai_again",
  "fetch failed",
  "network error",
  "request timeout",
  "socket hang up",
  "timed out",
  "timeout",
];

type ErrorWithCause = Error & {
  cause?: unknown;
  code?: unknown;
  errno?: unknown;
  syscall?: unknown;
  hostname?: unknown;
  address?: unknown;
  port?: unknown;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeErrorNode(value: unknown): string {
  if (value instanceof Error) {
    const error = value as ErrorWithCause;
    const parts: string[] = [];
    if (error.name && error.message) {
      parts.push(`${error.name}: ${error.message}`);
    } else if (error.message) {
      parts.push(error.message);
    } else if (error.name) {
      parts.push(error.name);
    }
    if (typeof error.code === "string" && error.code.trim()) {
      parts.push(`code=${error.code}`);
    }
    if (
      (typeof error.errno === "string" && error.errno.trim()) ||
      typeof error.errno === "number"
    ) {
      parts.push(`errno=${error.errno}`);
    }
    if (typeof error.syscall === "string" && error.syscall.trim()) {
      parts.push(`syscall=${error.syscall}`);
    }
    if (typeof error.hostname === "string" && error.hostname.trim()) {
      parts.push(`host=${error.hostname}`);
    }
    if (typeof error.address === "string" && error.address.trim()) {
      parts.push(`address=${error.address}`);
    }
    if (
      (typeof error.port === "string" && error.port.trim()) ||
      typeof error.port === "number"
    ) {
      parts.push(`port=${error.port}`);
    }
    return parts.filter(Boolean).join(" ");
  }

  if (isRecord(value)) {
    const parts: string[] = [];
    if (typeof value.message === "string" && value.message.trim()) {
      parts.push(value.message);
    }
    if (typeof value.code === "string" && value.code.trim()) {
      parts.push(`code=${value.code}`);
    }
    if (
      (typeof value.errno === "string" && value.errno.trim()) ||
      typeof value.errno === "number"
    ) {
      parts.push(`errno=${value.errno}`);
    }
    if (typeof value.syscall === "string" && value.syscall.trim()) {
      parts.push(`syscall=${value.syscall}`);
    }
    if (typeof value.hostname === "string" && value.hostname.trim()) {
      parts.push(`host=${value.hostname}`);
    }
    if (typeof value.address === "string" && value.address.trim()) {
      parts.push(`address=${value.address}`);
    }
    if (
      (typeof value.port === "string" && value.port.trim()) ||
      typeof value.port === "number"
    ) {
      parts.push(`port=${value.port}`);
    }
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }

  return String(value);
}

function getErrorCause(value: unknown): unknown {
  if (value instanceof Error) {
    return (value as ErrorWithCause).cause;
  }
  if (isRecord(value) && "cause" in value) {
    return value.cause;
  }
  return;
}

function collectErrorCodes(value: unknown): string[] {
  const seen = new Set<unknown>();
  const codes = new Set<string>();
  let current: unknown = value;
  let depth = 0;

  while (current && depth < ERROR_CAUSE_DEPTH_LIMIT && !seen.has(current)) {
    seen.add(current);
    if (
      isRecord(current) &&
      typeof current.code === "string" &&
      current.code.trim()
    ) {
      codes.add(current.code.toUpperCase());
    }
    current = getErrorCause(current);
    depth += 1;
  }

  return [...codes];
}

function extractHttpStatusCode(error: Error): number | null {
  const match = /^HTTP (\d{3}):/.exec(error.message);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function describeWechatTransportError(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current && depth < ERROR_CAUSE_DEPTH_LIMIT && !seen.has(current)) {
    seen.add(current);
    const description = describeErrorNode(current);
    if (description) {
      parts.push(depth === 0 ? description : `cause: ${description}`);
    }
    current = getErrorCause(current);
    depth += 1;
  }

  return parts.length > 0 ? parts.join(" | ") : String(error);
}

export function classifyWechatTransportError(
  error: unknown
): WechatTransportErrorClassification {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return { kind: "timeout", retryable: true };
    }

    const statusCode = extractHttpStatusCode(error);
    if (statusCode !== null) {
      if (statusCode === 401 || statusCode === 403) {
        return { kind: "auth", retryable: false, statusCode };
      }
      if (statusCode >= 500 || RETRYABLE_HTTP_STATUS_CODES.has(statusCode)) {
        return { kind: "http", retryable: true, statusCode };
      }
      return { kind: "http", retryable: false, statusCode };
    }
  }

  const errorCodes = collectErrorCodes(error);
  if (errorCodes.some((code) => RETRYABLE_NETWORK_ERROR_CODES.has(code))) {
    return { kind: "network", retryable: true };
  }

  const details = describeWechatTransportError(error).toLowerCase();
  if (RETRYABLE_NETWORK_ERROR_HINTS.some((hint) => details.includes(hint))) {
    return { kind: "network", retryable: true };
  }

  return { kind: "unknown", retryable: false };
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
  const base = params.baseUrl.endsWith("/")
    ? params.baseUrl
    : `${params.baseUrl}/`;
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

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes >= BYTES_PER_MB) {
    const value = bytes / BYTES_PER_MB;
    return `${value.toFixed(value >= 100 ? 0 : 1)} MB`;
  }
  if (bytes >= 1024) {
    const value = bytes / 1024;
    return `${value.toFixed(value >= 100 ? 0 : 1)} KB`;
  }
  return `${bytes} B`;
}

export function resolveMediaUploadLimitBytes(
  label: UploadLabel,
  env: NodeJS.ProcessEnv = process.env
): number {
  const envKey = MEDIA_UPLOAD_LIMIT_ENV_KEYS[label];
  const raw = env[envKey];
  const fallbackMb = DEFAULT_MEDIA_UPLOAD_LIMIT_MB[label];
  const parsedMb = raw ? Number(raw) : Number.NaN;
  const limitMb =
    Number.isFinite(parsedMb) && parsedMb > 0 ? parsedMb : fallbackMb;
  return Math.floor(limitMb * BYTES_PER_MB);
}

export function assertMediaUploadSizeAllowed(
  label: UploadLabel,
  rawsize: number,
  env: NodeJS.ProcessEnv = process.env
): void {
  const limitBytes = resolveMediaUploadLimitBytes(label, env);
  if (rawsize <= limitBytes) {
    return;
  }

  const envKey = MEDIA_UPLOAD_LIMIT_ENV_KEYS[label];
  const labelName = label.charAt(0).toUpperCase() + label.slice(1);
  throw new Error(
    `${labelName} too large: ${formatByteSize(rawsize)} exceeds ${formatByteSize(limitBytes)} limit. Set ${envKey} to override.`
  );
}

function encodeMessageAesKey(aeskey: Buffer): string {
  return Buffer.from(aeskey.toString("hex")).toString("base64");
}

async function getUploadUrl(
  account: AccountData,
  params: {
    filekey: string;
    media_type: number;
    to_user_id: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskey: string;
  }
): Promise<{ upload_param?: string }> {
  const raw = await apiFetch({
    baseUrl: account.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      ...params,
      no_need_thumb: true,
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token: account.token,
    timeoutMs: SEND_TIMEOUT_MS,
  });
  return JSON.parse(raw) as { upload_param?: string };
}

function buildCdnUploadUrl(
  cdnBaseUrl: string,
  uploadParam: string,
  filekey: string
): string {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadParam: string;
  filekey: string;
  aeskey: Buffer;
  onRetry?: (attempt: number) => void;
}): Promise<{ downloadParam: string }> {
  const ciphertext = encryptAesEcb(params.buf, params.aeskey);
  const cdnUrl = buildCdnUploadUrl(
    CDN_BASE_URL,
    params.uploadParam,
    params.filekey
  );

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= CDN_MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });

      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg =
          res.headers.get("x-error-message") ?? `status ${res.status}`;
        throw new Error(`CDN server error: ${errMsg}`);
      }

      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        throw new Error("CDN response missing x-encrypted-param header");
      }
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) {
        throw err;
      }
      if (attempt >= CDN_MAX_RETRIES) {
        break;
      }
      params.onRetry?.(attempt);
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error("CDN upload failed");
  }

  return { downloadParam };
}

function isHexString(value: string): boolean {
  return /^[0-9a-fA-F]+$/.test(value);
}

function decodeHexAesKey(encoded: string): Buffer | null {
  const normalized = encoded.trim();
  if (!normalized || normalized.length % 2 !== 0 || !isHexString(normalized)) {
    return null;
  }

  const decoded = Buffer.from(normalized, "hex");
  return decoded.length === 16 ? decoded : null;
}

export function decodeWechatAesKey(
  media?: CDNMedia,
  preferredHex?: string
): Buffer | null {
  const preferredDecoded = preferredHex ? decodeHexAesKey(preferredHex) : null;
  if (preferredDecoded) {
    return preferredDecoded;
  }

  const encoded = media?.aes_key?.trim();
  if (!encoded) {
    return null;
  }

  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length === 16) {
      return decoded;
    }

    const decodedUtf8 = decoded.toString("utf8").trim();
    const decodedHex = decodeHexAesKey(decodedUtf8);
    if (decodedHex) {
      return decodedHex;
    }
  } catch {
    return null;
  }

  return null;
}

function buildCdnDownloadUrl(
  target: InboundMediaDownloadTarget
): string | null {
  const fullUrl = target.media?.full_url?.trim();
  if (fullUrl && /^https?:\/\//i.test(fullUrl)) {
    return fullUrl;
  }

  const encryptedQueryParam = target.media?.encrypt_query_param?.trim();
  if (!encryptedQueryParam) {
    const directUrl = target.directUrl?.trim();
    if (directUrl && /^https?:\/\//i.test(directUrl)) {
      return directUrl;
    }
    return null;
  }

  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

function decryptWechatCdnPayload(ciphertext: Buffer, aesKey: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", aesKey, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function sanitizeFileNameSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function inferAttachmentMimeType(
  kind: InboundMediaDownloadKind,
  title?: string,
  directUrl?: string
): string | undefined {
  const source = title || directUrl || "";
  const ext = path.extname(source).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".aac":
      return "audio/aac";
    case ".m4a":
      return "audio/mp4";
    case ".sil":
    case ".silk":
      return "audio/silk";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".mkv":
      return "video/x-matroska";
    case ".webm":
      return "video/webm";
    default:
      return kind === "image"
        ? "image/jpeg"
        : kind === "voice"
          ? "audio/silk"
          : kind === "video"
            ? "video/mp4"
            : undefined;
  }
}

function inferAttachmentExtension(
  kind: InboundMediaDownloadKind,
  title?: string,
  mimeType?: string,
  directUrl?: string
): string {
  const titleExtension = path.extname(title || directUrl || "").toLowerCase();
  if (titleExtension) {
    return titleExtension;
  }

  if (mimeType) {
    const mapped = MIME_TYPE_TO_EXTENSION[mimeType.toLowerCase()];
    if (mapped) {
      return mapped;
    }
  }

  return MEDIA_KIND_DEFAULT_EXTENSIONS[kind];
}

function isProbablyImagePayload(payload: Buffer): boolean {
  return (
    (payload.length >= 3 &&
      payload[0] === 0xff &&
      payload[1] === 0xd8 &&
      payload[2] === 0xff) ||
    (payload.length >= 8 &&
      payload[0] === 0x89 &&
      payload[1] === 0x50 &&
      payload[2] === 0x4e &&
      payload[3] === 0x47 &&
      payload[4] === 0x0d &&
      payload[5] === 0x0a &&
      payload[6] === 0x1a &&
      payload[7] === 0x0a) ||
    (payload.length >= 6 &&
      (payload.subarray(0, 6).equals(Buffer.from("GIF87a")) ||
        payload.subarray(0, 6).equals(Buffer.from("GIF89a")))) ||
    (payload.length >= 12 &&
      payload.subarray(0, 4).equals(Buffer.from("RIFF")) &&
      payload.subarray(8, 12).equals(Buffer.from("WEBP")))
  );
}

function decodeInboundMediaPayload(
  ciphertext: Buffer,
  aesKey: Buffer,
  target: InboundMediaDownloadTarget
): Buffer {
  const decrypted = decryptWechatCdnPayload(ciphertext, aesKey);
  if (target.kind !== "image") {
    return decrypted;
  }

  if (isProbablyImagePayload(decrypted)) {
    return decrypted;
  }

  if (isProbablyImagePayload(ciphertext)) {
    return ciphertext;
  }

  throw new Error(
    "Inbound image payload is not a valid image after download/decrypt"
  );
}

async function downloadInboundMedia(
  account: AccountData,
  cacheKey: string,
  target: InboundMediaDownloadTarget
): Promise<BridgeInputAttachment | null> {
  const downloadUrl = buildCdnDownloadUrl(target);
  const aesKey = decodeWechatAesKey(target.media, target.preferredAesKeyHex);
  if (!(downloadUrl && aesKey)) {
    return null;
  }

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Inbound media download failed: HTTP ${response.status}`);
  }

  const ciphertext = Buffer.from(await response.arrayBuffer());
  const plaintext = decodeInboundMediaPayload(ciphertext, aesKey, target);
  const mimeType =
    target.mimeType ??
    inferAttachmentMimeType(target.kind, target.title, target.directUrl);
  const extension = inferAttachmentExtension(
    target.kind,
    target.title,
    mimeType,
    target.directUrl
  );
  const baseName =
    sanitizeFileNameSegment(target.title ?? "") ||
    `${target.kind}-${crypto.createHash("sha1").update(cacheKey).digest("hex").slice(0, 12)}`;
  const accountDir = path.join(
    INBOUND_MEDIA_DIR,
    sanitizeFileNameSegment(account.accountId) || "account"
  );
  fs.mkdirSync(accountDir, { recursive: true });
  const filePath = path.join(accountDir, `${baseName}${extension}`);
  fs.writeFileSync(filePath, plaintext);

  return {
    kind: target.kind,
    path: filePath,
    mimeType,
    title: target.title,
    sizeBytes: plaintext.length,
  };
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

function extractInboundMediaTargets(
  message: WeixinMessage
): InboundMediaDownloadTarget[] {
  if (!message.item_list?.length) {
    return [];
  }

  const targets: InboundMediaDownloadTarget[] = [];
  for (const item of message.item_list) {
    switch (item.type) {
      case MSG_ITEM_IMAGE:
        if (item.image_item?.media || item.image_item?.url) {
          targets.push({
            kind: "image",
            title: undefined,
            sizeBytes: item.image_item?.mid_size,
            mimeType: inferAttachmentMimeType(
              "image",
              undefined,
              item.image_item?.url
            ),
            media: item.image_item?.media,
            preferredAesKeyHex: item.image_item?.aeskey,
            directUrl: item.image_item?.url,
          });
        }
        break;
      case MSG_ITEM_VOICE:
        if (item.voice_item?.media) {
          targets.push({
            kind: "voice",
            title: undefined,
            mimeType: inferAttachmentMimeType("voice"),
            media: item.voice_item.media,
          });
        }
        break;
      case MSG_ITEM_FILE:
        if (item.file_item?.media) {
          targets.push({
            kind: "file",
            title: item.file_item.file_name,
            sizeBytes: Number(item.file_item.len),
            mimeType: inferAttachmentMimeType("file", item.file_item.file_name),
            media: item.file_item.media,
          });
        }
        break;
      case MSG_ITEM_VIDEO:
        if (item.video_item?.media) {
          targets.push({
            kind: "video",
            title: undefined,
            sizeBytes: item.video_item.video_size,
            mimeType: inferAttachmentMimeType("video"),
            media: item.video_item.media,
          });
        }
        break;
      default:
        break;
    }
  }

  return targets;
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

function buildScopedMessageClaimKey(
  accountId: string,
  messageKey: string
): string {
  return `${accountId}|${messageKey}`;
}

export function buildInboundMessageClaimPath(
  messageKey: string,
  claimsDir = INBOUND_MESSAGE_CLAIMS_DIR
): string {
  const fileName = `${crypto.createHash("sha1").update(messageKey).digest("hex")}.json`;
  return path.join(claimsDir, fileName);
}

export function clearInboundMessageClaims(
  claimsDir = INBOUND_MESSAGE_CLAIMS_DIR
): void {
  try {
    fs.rmSync(claimsDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
}

export function tryClaimInboundMessage(
  messageKey: string,
  options: {
    claimsDir?: string;
    nowMs?: number;
    ttlMs?: number;
  } = {}
): boolean {
  if (!messageKey) {
    return false;
  }

  const claimsDir = options.claimsDir ?? INBOUND_MESSAGE_CLAIMS_DIR;
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? INBOUND_MESSAGE_CLAIM_TTL_MS;
  const claimPath = buildInboundMessageClaimPath(messageKey, claimsDir);

  const attemptClaim = (): boolean => {
    fs.mkdirSync(claimsDir, { recursive: true });
    const handle = fs.openSync(claimPath, "wx");
    try {
      fs.writeFileSync(
        handle,
        JSON.stringify(
          {
            key: messageKey,
            claimedAt: new Date(nowMs).toISOString(),
            pid: process.pid,
          },
          null,
          2
        ),
        "utf-8"
      );
    } finally {
      fs.closeSync(handle);
    }
    return true;
  };

  try {
    return attemptClaim();
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "";
    if (code !== "EEXIST") {
      return true;
    }
  }

  try {
    const stat = fs.statSync(claimPath);
    if (Number.isFinite(stat.mtimeMs) && nowMs - stat.mtimeMs > ttlMs) {
      fs.rmSync(claimPath, { force: true });
      return attemptClaim();
    }
  } catch {
    return attemptClaim();
  }

  return false;
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
    Object.entries(readJsonFile<ContextTokenState>(CONTEXT_CACHE_FILE) ?? {})
  );
  private readonly typingTicketCache = new Map<string, string | null>();
  private syncBuffer = "";

  constructor(logger: TransportLogger) {
    this.logger = logger;
    migrateLegacyChannelFiles((message) => this.logger.log(message));
    this.syncBuffer = this.readSyncBuffer();
  }

  getCredentials(): AccountData | null {
    return readJsonFile<AccountData>(CREDENTIALS_FILE);
  }

  getStatusText(): string {
    const account = this.getCredentials();
    const syncExists = fs.existsSync(SYNC_BUF_FILE);
    const contextExists = fs.existsSync(CONTEXT_CACHE_FILE);

    return [
      `credentials_file: ${CREDENTIALS_FILE}`,
      `credentials_present: ${account ? "yes" : "no"}`,
      `sync_state_file: ${SYNC_BUF_FILE}`,
      `sync_state_present: ${syncExists ? "yes" : "no"}`,
      `context_cache_file: ${CONTEXT_CACHE_FILE}`,
      `context_cache_present: ${contextExists ? "yes" : "no"}`,
      `cached_context_count: ${this.contextTokenCache.size}`,
      `max_image_mb: ${resolveMediaUploadLimitBytes("image") / BYTES_PER_MB}`,
      `max_file_mb: ${resolveMediaUploadLimitBytes("file") / BYTES_PER_MB}`,
      `max_voice_mb: ${resolveMediaUploadLimitBytes("voice") / BYTES_PER_MB}`,
      `max_video_mb: ${resolveMediaUploadLimitBytes("video") / BYTES_PER_MB}`,
      `account_id: ${account?.accountId ?? "(none)"}`,
      `user_id: ${account?.userId ?? "(none)"}`,
      `saved_at: ${account?.savedAt ?? "(none)"}`,
    ].join("\n");
  }

  resetSyncState(options: ResetSyncOptions = {}): string {
    this.clearSyncBuffer();
    this.clearRecentMessages();
    clearInboundMessageClaims();

    if (options.clearContextCache) {
      this.clearContextTokenCache();
    }

    return options.clearContextCache
      ? "Reset sync state and cleared cached context tokens."
      : "Reset sync state.";
  }

  async pollMessages(
    options: PollMessagesOptions = {}
  ): Promise<PollMessagesResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
    const account = this.requireAccount();

    const response = await this.getUpdates(account, timeoutMs);
    const isError =
      (response.ret !== undefined && response.ret !== 0) ||
      (response.errcode !== undefined && response.errcode !== 0);

    if (isError) {
      throw new Error(
        `getUpdates failed: ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg ?? ""}`
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

      const messageKey = buildMessageKey(rawMessage);
      if (!this.rememberMessage(messageKey)) {
        continue;
      }
      if (
        !tryClaimInboundMessage(
          buildScopedMessageClaimKey(account.accountId, messageKey)
        )
      ) {
        continue;
      }

      const text = extractTextFromMessage(rawMessage);
      const attachmentTargets = extractInboundMediaTargets(rawMessage);
      const attachments: BridgeInputAttachment[] = [];
      for (let index = 0; index < attachmentTargets.length; index += 1) {
        const target = attachmentTargets[index];
        try {
          const downloaded = await downloadInboundMedia(
            account,
            `${messageKey}|${index}`,
            target
          );
          if (downloaded) {
            attachments.push(downloaded);
          }
        } catch (error) {
          this.logger.logError(
            `Failed to download inbound ${target.kind}: ${describeWechatTransportError(error)}`
          );
        }
      }

      if (!text && attachments.length === 0) {
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
        attachments,
        contextToken: rawMessage.context_token,
        createdAt: formatTimestamp(rawMessage.create_time_ms),
        createdAtMs,
      });
    }

    return { messages, ignoredBacklogCount };
  }

  async sendText(senderId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const resolved = this.resolveRecipient(senderId);
    await this.sendTextWithContextToken(
      resolved.account,
      resolved.recipientId,
      trimmed,
      resolved.contextToken
    );
  }

  async sendNotification(
    message: string,
    recipientId?: string
  ): Promise<string> {
    const trimmed = message.trim();
    if (!trimmed) {
      throw new Error("Notification text cannot be empty.");
    }

    const resolved = this.resolveRecipient(recipientId);
    await this.sendTextWithContextToken(
      resolved.account,
      resolved.recipientId,
      trimmed,
      resolved.contextToken
    );
    return resolved.recipientId;
  }

  async sendTyping(
    recipientId?: string,
    status: "typing" | "cancel" = "typing"
  ): Promise<string> {
    const resolved = this.resolveRecipient(recipientId);
    const typingTicket = await this.getTypingTicket(
      resolved.account,
      resolved.recipientId,
      resolved.contextToken
    );
    if (!typingTicket) {
      this.logger.log(
        `Typing indicator unavailable for ${resolved.recipientId}: no typing ticket returned by getconfig.`
      );
      return resolved.recipientId;
    }

    await apiFetch({
      baseUrl: resolved.account.baseUrl,
      endpoint: "ilink/bot/sendtyping",
      body: JSON.stringify({
        ilink_user_id: resolved.recipientId,
        typing_ticket: typingTicket,
        status:
          status === "typing" ? TYPING_STATUS_TYPING : TYPING_STATUS_CANCEL,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token: resolved.account.token,
      timeoutMs: CONFIG_TIMEOUT_MS,
    });

    return resolved.recipientId;
  }

  async sendImage(
    imagePath: string,
    options: SendImageOptions = {}
  ): Promise<string> {
    const resolved = this.resolveRecipient(options.recipientId);
    const caption = options.caption?.trim();

    if (caption) {
      await this.sendTextWithContextToken(
        resolved.account,
        resolved.recipientId,
        caption,
        resolved.contextToken
      );
    }

    const upload = await this.prepareUpload(
      resolved.account,
      resolved.recipientId,
      imagePath,
      UPLOAD_MEDIA_TYPE_IMAGE,
      "image"
    );

    await this.sendMessage(
      resolved.account,
      resolved.recipientId,
      resolved.contextToken,
      [
        {
          type: MSG_ITEM_IMAGE,
          image_item: {
            media: {
              encrypt_query_param: upload.downloadParam,
              aes_key: encodeMessageAesKey(upload.aeskey),
              encrypt_type: 1,
            },
            mid_size: upload.filesize,
          },
        },
      ]
    );

    return resolved.recipientId;
  }

  async sendFile(
    filePath: string,
    options: SendFileOptions = {}
  ): Promise<string> {
    const resolved = this.resolveRecipient(options.recipientId);
    const upload = await this.prepareUpload(
      resolved.account,
      resolved.recipientId,
      filePath,
      UPLOAD_MEDIA_TYPE_FILE,
      "file"
    );
    const fileName = options.title?.trim() || path.basename(filePath);

    await this.sendMessage(
      resolved.account,
      resolved.recipientId,
      resolved.contextToken,
      [
        {
          type: MSG_ITEM_FILE,
          file_item: {
            file_name: fileName,
            len: String(upload.rawsize),
            media: {
              encrypt_query_param: upload.downloadParam,
              aes_key: encodeMessageAesKey(upload.aeskey),
              encrypt_type: 1,
            },
          },
        },
      ]
    );

    return resolved.recipientId;
  }

  async sendVoice(voicePath: string, recipientId?: string): Promise<string> {
    const resolved = this.resolveRecipient(recipientId);
    const upload = await this.prepareUpload(
      resolved.account,
      resolved.recipientId,
      voicePath,
      UPLOAD_MEDIA_TYPE_VOICE,
      "voice"
    );

    await this.sendMessage(
      resolved.account,
      resolved.recipientId,
      resolved.contextToken,
      [
        {
          type: MSG_ITEM_VOICE,
          voice_item: {
            media: {
              encrypt_query_param: upload.downloadParam,
              aes_key: encodeMessageAesKey(upload.aeskey),
              encrypt_type: 1,
            },
          },
        },
      ]
    );

    return resolved.recipientId;
  }

  async sendVideo(
    videoPath: string,
    options: SendVideoOptions = {}
  ): Promise<string> {
    const resolved = this.resolveRecipient(options.recipientId);
    const title = options.title?.trim();

    if (title) {
      await this.sendTextWithContextToken(
        resolved.account,
        resolved.recipientId,
        title,
        resolved.contextToken
      );
    }

    const upload = await this.prepareUpload(
      resolved.account,
      resolved.recipientId,
      videoPath,
      UPLOAD_MEDIA_TYPE_VIDEO,
      "video"
    );

    await this.sendMessage(
      resolved.account,
      resolved.recipientId,
      resolved.contextToken,
      [
        {
          type: MSG_ITEM_VIDEO,
          video_item: {
            media: {
              encrypt_query_param: upload.downloadParam,
              aes_key: encodeMessageAesKey(upload.aeskey),
              encrypt_type: 1,
            },
            video_size: upload.filesize,
          },
        },
      ]
    );

    return resolved.recipientId;
  }

  private requireAccount(): AccountData {
    const account = this.getCredentials();
    if (!account) {
      throw new Error(
        `No saved WeChat credentials found. Run "bun run setup" first. Expected file: ${CREDENTIALS_FILE}`
      );
    }
    return account;
  }

  private resolveRecipient(recipientId?: string): ResolvedRecipient {
    const account = this.requireAccount();

    let resolvedRecipientId = recipientId?.trim();
    if (!resolvedRecipientId) {
      const recipients = [...this.contextTokenCache.keys()];
      resolvedRecipientId = recipients.at(-1);
      if (!resolvedRecipientId) {
        throw new Error(
          "No cached context token is available. Fetch messages first or ask the user to send a new WeChat message."
        );
      }
    }

    const contextToken = this.contextTokenCache.get(resolvedRecipientId);
    if (!contextToken) {
      throw new Error(
        `No cached context token for ${resolvedRecipientId}. Fetch messages first or ask the user to send a new WeChat message.`
      );
    }

    return { account, recipientId: resolvedRecipientId, contextToken };
  }

  private async getTypingTicket(
    account: AccountData,
    recipientId: string,
    contextToken: string
  ): Promise<string | null> {
    if (this.typingTicketCache.has(recipientId)) {
      return this.typingTicketCache.get(recipientId) ?? null;
    }

    const raw = await apiFetch({
      baseUrl: account.baseUrl,
      endpoint: "ilink/bot/getconfig",
      body: JSON.stringify({
        ilink_user_id: recipientId,
        context_token: contextToken,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token: account.token,
      timeoutMs: CONFIG_TIMEOUT_MS,
    });
    const parsed = JSON.parse(raw) as { typing_ticket?: unknown };
    const typingTicket =
      typeof parsed.typing_ticket === "string" && parsed.typing_ticket.trim()
        ? parsed.typing_ticket.trim()
        : null;
    this.typingTicketCache.set(recipientId, typingTicket);
    return typingTicket;
  }

  private async sendTextWithContextToken(
    account: AccountData,
    recipientId: string,
    text: string,
    contextToken: string
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    await this.sendMessage(account, recipientId, contextToken, [
      { type: MSG_ITEM_TEXT, text_item: { text: trimmed } },
    ]);
  }

  private async sendMessage(
    account: AccountData,
    recipientId: string,
    contextToken: string,
    itemList: unknown[]
  ): Promise<void> {
    await apiFetch({
      baseUrl: account.baseUrl,
      endpoint: "ilink/bot/sendmessage",
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: recipientId,
          client_id: this.generateClientId(),
          message_type: MSG_TYPE_BOT,
          message_state: MSG_STATE_FINISH,
          item_list: itemList,
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token: account.token,
      timeoutMs: SEND_TIMEOUT_MS,
    });
  }

  private async prepareUpload(
    account: AccountData,
    recipientId: string,
    filePath: string,
    mediaType: number,
    label: UploadLabel
  ): Promise<UploadPreparation> {
    const stat = this.requireExistingFile(filePath);
    assertMediaUploadSizeAllowed(label, stat.size);

    const plaintext = fs.readFileSync(filePath);
    const rawsize = plaintext.length;
    const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = crypto.randomBytes(16).toString("hex");
    const aeskey = crypto.randomBytes(16);

    this.logger.log(
      `Uploading ${label}: ${filePath} (${rawsize} bytes, md5=${rawfilemd5})`
    );

    const uploadResp = await getUploadUrl(account, {
      filekey,
      media_type: mediaType,
      to_user_id: recipientId,
      rawsize,
      rawfilemd5,
      filesize,
      aeskey: aeskey.toString("hex"),
    });

    if (!uploadResp.upload_param) {
      throw new Error("getUploadUrl returned no upload_param");
    }

    const { downloadParam } = await uploadBufferToCdn({
      buf: plaintext,
      uploadParam: uploadResp.upload_param,
      filekey,
      aeskey,
      onRetry: (attempt) => {
        this.logger.log(
          `CDN upload attempt ${attempt} failed for ${label}, retrying...`
        );
      },
    });

    this.logger.log(
      `${label} upload complete, downloadParam length=${downloadParam.length}`
    );

    return {
      rawsize,
      filesize,
      aeskey,
      downloadParam,
    };
  }

  private requireExistingFile(filePath: string): fs.Stats {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    return stat;
  }

  private async getUpdates(
    account: AccountData,
    timeoutMs: number
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

  private clearRecentMessages(): void {
    this.recentMessageKeys.clear();
    this.recentMessageOrder.length = 0;
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

  private clearSyncBuffer(): void {
    this.syncBuffer = "";
    if (fs.existsSync(SYNC_BUF_FILE)) {
      fs.rmSync(SYNC_BUF_FILE, { force: true });
    }
  }

  private cacheContextToken(senderId: string, token: string): void {
    if (this.contextTokenCache.has(senderId)) {
      this.contextTokenCache.delete(senderId);
    }
    this.contextTokenCache.set(senderId, token);
    this.typingTicketCache.delete(senderId);
    writeJsonFile(
      CONTEXT_CACHE_FILE,
      Object.fromEntries(this.contextTokenCache)
    );
  }

  private clearContextTokenCache(): void {
    this.contextTokenCache.clear();
    this.typingTicketCache.clear();
    if (fs.existsSync(CONTEXT_CACHE_FILE)) {
      fs.rmSync(CONTEXT_CACHE_FILE, { force: true });
    }
  }

  private generateClientId(): string {
    return `wechat-bridge:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  }
}
