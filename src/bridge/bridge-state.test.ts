import { describe, expect, test } from "bun:test";

import {
  normalizeBridgeLockPayload,
  shouldAutoReclaimBridgeLock,
} from "./bridge-state.ts";

describe("bridge-state lock helpers", () => {
  test("normalizeBridgeLockPayload defaults old lock files to persistent lifecycle", () => {
    const payload = normalizeBridgeLockPayload({
      pid: 123,
      parentPid: 456,
      instanceId: "bridge-123",
      adapter: "codex",
      command: "codex",
      cwd: "C:\\workspace",
      startedAt: "2026-03-27T00:00:00.000Z",
    });

    expect(payload?.lifecycle).toBe("persistent");
    expect(payload?.legacyLifecycleFallback).toBe(true);
  });

  test("shouldAutoReclaimBridgeLock reclaims companion-bound locks when the parent is gone", () => {
    expect(
      shouldAutoReclaimBridgeLock(
        {
          pid: 123,
          parentPid: 456,
          instanceId: "bridge-123",
          adapter: "codex",
          command: "codex",
          cwd: "C:\\workspace",
          startedAt: "2026-03-27T00:00:00.000Z",
          lifecycle: "companion_bound",
        },
        (pid) => pid === 123,
      ),
    ).toBe(true);
  });

  test("shouldAutoReclaimBridgeLock reclaims legacy codex locks when the parent is gone", () => {
    expect(
      shouldAutoReclaimBridgeLock(
        {
          pid: 123,
          parentPid: 456,
          instanceId: "bridge-123",
          adapter: "codex",
          command: "codex",
          cwd: "C:\\workspace",
          startedAt: "2026-03-27T00:00:00.000Z",
          lifecycle: "persistent",
          legacyLifecycleFallback: true,
        },
        (pid) => pid === 123,
      ),
    ).toBe(true);
  });

  test("shouldAutoReclaimBridgeLock keeps persistent locks even when the parent is gone", () => {
    expect(
      shouldAutoReclaimBridgeLock(
        {
          pid: 123,
          parentPid: 456,
          instanceId: "bridge-123",
          adapter: "codex",
          command: "codex",
          cwd: "C:\\workspace",
          startedAt: "2026-03-27T00:00:00.000Z",
          lifecycle: "persistent",
        },
        (pid) => pid === 123,
      ),
    ).toBe(false);
  });

  test("shouldAutoReclaimBridgeLock keeps companion-bound locks while the parent is still alive", () => {
    expect(
      shouldAutoReclaimBridgeLock(
        {
          pid: 123,
          parentPid: 456,
          instanceId: "bridge-123",
          adapter: "codex",
          command: "codex",
          cwd: "C:\\workspace",
          startedAt: "2026-03-27T00:00:00.000Z",
          lifecycle: "companion_bound",
        },
        (pid) => pid === 123 || pid === 456,
      ),
    ).toBe(false);
  });
});
