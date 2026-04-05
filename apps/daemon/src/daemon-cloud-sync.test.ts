import { describe, expect, test } from "vitest";
import { CLOUD_SYNC_MIN_INTERVAL_MS, resolveCloudSyncDelay } from "./daemon-cloud-sync.js";

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
});
