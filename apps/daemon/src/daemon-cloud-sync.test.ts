import { describe, expect, test } from "vitest";
import {
  CLOUD_SYNC_MIN_INTERVAL_MS,
  resolveCloudSyncDelay,
  shouldBypassCloudSyncCooldownForPrompt,
} from "./daemon-cloud-sync.js";

describe("cloud sync cooldown", () => {
  test("does not delay the first sync when nothing has completed yet", () => {
    expect(resolveCloudSyncDelay(500, null, 10_000)).toBe(500);
  });

  test("respects the longer requested delay when it already exceeds the cooldown", () => {
    expect(resolveCloudSyncDelay(4_000, 10_000, 11_000)).toBe(4_000);
  });

  test("stretches short follow-up syncs to the minimum interval", () => {
    expect(resolveCloudSyncDelay(500, 10_000, 11_000)).toBe(CLOUD_SYNC_MIN_INTERVAL_MS - 1_000);
  });

  test("allows immediate sync again once the cooldown window passes", () => {
    expect(resolveCloudSyncDelay(0, 10_000, 10_000 + CLOUD_SYNC_MIN_INTERVAL_MS + 50)).toBe(0);
  });

  test("treats completed prompts as urgent sync candidates", () => {
    expect(shouldBypassCloudSyncCooldownForPrompt({
      status: "imported",
      endedAt: "2026-04-05T00:00:00.000Z",
    })).toBe(true);
    expect(shouldBypassCloudSyncCooldownForPrompt({
      status: "in_progress",
      endedAt: null,
    })).toBe(false);
  });
});
