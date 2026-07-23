import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesktopStatusSnapshot } from "@open-design/sidecar-proto";

import { waitForDesktopRuntime } from "../src/sidecar-client.js";

describe("tools-dev sidecar client", () => {
  it("waits for a cold desktop window to become visible after 15 seconds", async () => {
    let now = 0;
    const expected = {
      pid: 42,
      state: "running",
      title: "Open Design",
      updatedAt: "2026-07-23T00:00:20.000Z",
      url: "http://127.0.0.1:3000",
      windowVisible: true,
    } as DesktopStatusSnapshot;
    const hidden = {
      ...expected,
      updatedAt: "2026-07-23T00:00:01.000Z",
      windowVisible: false,
    } as DesktopStatusSnapshot;

    const actual = await waitForDesktopRuntime(
      { base: "test", namespace: "windows-cold-start" },
      undefined,
      {
        inspect: async () => (now >= 20_000 ? expected : now >= 1_000 ? hidden : null),
        now: () => now,
        sleep: async (delayMs) => {
          now += delayMs;
        },
      },
    );

    assert.equal(actual, expected);
    assert.ok(now > 15_000);
  });
});
