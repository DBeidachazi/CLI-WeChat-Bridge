import { describe, expect, test } from "bun:test";

import {
  assertMediaUploadSizeAllowed,
  classifyWechatTransportError,
  describeWechatTransportError,
  formatByteSize,
  resolveMediaUploadLimitBytes,
} from "../../src/wechat/wechat-transport.ts";

describe("wechat upload limits", () => {
  test("uses the default per-media upload limits", () => {
    expect(resolveMediaUploadLimitBytes("image", {})).toBe(20 * 1024 * 1024);
    expect(resolveMediaUploadLimitBytes("file", {})).toBe(50 * 1024 * 1024);
    expect(resolveMediaUploadLimitBytes("voice", {})).toBe(20 * 1024 * 1024);
    expect(resolveMediaUploadLimitBytes("video", {})).toBe(100 * 1024 * 1024);
  });

  test("allows env overrides and ignores invalid values", () => {
    expect(
      resolveMediaUploadLimitBytes("video", {
        WECHAT_MAX_VIDEO_MB: "64",
      } as NodeJS.ProcessEnv),
    ).toBe(64 * 1024 * 1024);

    expect(
      resolveMediaUploadLimitBytes("video", {
        WECHAT_MAX_VIDEO_MB: "not-a-number",
      } as NodeJS.ProcessEnv),
    ).toBe(100 * 1024 * 1024);
  });

  test("throws a clear error when a file exceeds the configured limit", () => {
    expect(() =>
      assertMediaUploadSizeAllowed(
        "video",
        377_800_000,
        {} as NodeJS.ProcessEnv,
      ),
    ).toThrow(
      "Video too large: 360 MB exceeds 100 MB limit. Set WECHAT_MAX_VIDEO_MB to override.",
    );
  });

  test("formats byte sizes consistently", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1_536)).toBe("1.5 KB");
    expect(formatByteSize(20 * 1024 * 1024)).toBe("20.0 MB");
  });

  test("classifies transient fetch failures as retryable network errors", () => {
    const cause = Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:443"), {
      code: "ETIMEDOUT",
      syscall: "connect",
      address: "10.0.0.1",
      port: 443,
    });
    const error = new TypeError("fetch failed", { cause });

    expect(classifyWechatTransportError(error)).toEqual({
      kind: "network",
      retryable: true,
    });
    expect(describeWechatTransportError(error)).toContain("TypeError: fetch failed");
    expect(describeWechatTransportError(error)).toContain("code=ETIMEDOUT");
  });

  test("treats HTTP 503 as retryable and HTTP 401 as fatal auth", () => {
    expect(classifyWechatTransportError(new Error("HTTP 503: upstream unavailable"))).toEqual({
      kind: "http",
      retryable: true,
      statusCode: 503,
    });

    expect(classifyWechatTransportError(new Error("HTTP 401: unauthorized"))).toEqual({
      kind: "auth",
      retryable: false,
      statusCode: 401,
    });
  });
});
