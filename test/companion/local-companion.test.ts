import { describe, expect, test } from "bun:test";

import {
  LOCAL_COMPANION_RECONNECT_RETRY_MS,
  shouldReconnectLocalCompanion,
} from "../../src/companion/local-companion.ts";

describe("local companion reconnect policy", () => {
  test("reconnects only for unexpected bridge disconnects", () => {
    expect(
      shouldReconnectLocalCompanion({
        shuttingDown: false,
        closeReason: null,
      })
    ).toBe(true);

    expect(
      shouldReconnectLocalCompanion({
        shuttingDown: true,
        closeReason: null,
      })
    ).toBe(false);

    expect(
      shouldReconnectLocalCompanion({
        shuttingDown: false,
        closeReason: "worker_exit",
      })
    ).toBe(false);
  });

  test("keeps reconnect retries short for the grace window loop", () => {
    expect(LOCAL_COMPANION_RECONNECT_RETRY_MS).toBe(250);
  });
});
