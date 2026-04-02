import { describe, expect, test } from "vitest";
import type { PromptDetail, PromptListItem } from "./types";
import {
  getPromptIdsNeedingDetailRefresh,
  mapPromptStatuses,
} from "./prompt-detail-state";

function makePrompt(
  id: string,
  status: PromptListItem["status"]
): PromptListItem {
  return {
    id,
    workspaceId: "workspace-1",
    executionPath: "C:/work/example",
    sessionId: "session-1",
    threadId: "thread-1",
    parentPromptEventId: null,
    startedAt: "2026-04-02T20:00:00.000Z",
    endedAt: status === "in_progress" ? null : "2026-04-02T20:01:00.000Z",
    boundaryReason: status === "in_progress" ? null : "turn_completed",
    status,
    mode: "default",
    promptSummary: `Prompt ${id}`,
    primaryArtifactId: null,
    baselineSnapshotId: null,
    endSnapshotId: null,
    filesTouched: [],
    filesTouchedCount: 0,
    childCount: 0,
    artifactCount: 0,
    primaryArtifactType: null,
    primaryArtifactSummary: null,
    hasCodeDiff: false,
    hasPlanArtifact: false,
    hasFinalResponse: false,
    isLiveDerived: false,
  };
}

describe("prompt detail state", () => {
  test("maps prompt statuses by id", () => {
    const prompts = [
      makePrompt("prompt-open", "in_progress"),
      makePrompt("prompt-done", "completed"),
    ];

    expect(mapPromptStatuses(prompts)).toEqual({
      "prompt-open": "in_progress",
      "prompt-done": "completed",
    });
  });

  test("refreshes only prompts that just closed and already have detail cached", () => {
    const prompts = [
      makePrompt("prompt-closed", "completed"),
      makePrompt("prompt-still-open", "in_progress"),
      makePrompt("prompt-imported", "imported"),
    ];

    const previousStatuses = {
      "prompt-closed": "in_progress",
      "prompt-still-open": "in_progress",
      "prompt-imported": "completed",
    } satisfies Partial<Record<string, PromptListItem["status"]>>;

    const cachedDetails = {
      "prompt-closed": {
        status: "in_progress",
        endedAt: null,
      },
      "prompt-still-open": {
        status: "in_progress",
        endedAt: null,
      },
    } satisfies Partial<Record<string, Pick<PromptDetail, "status" | "endedAt">>>;

    expect(getPromptIdsNeedingDetailRefresh(prompts, previousStatuses, cachedDetails)).toEqual([
      "prompt-closed",
    ]);
  });

  test("backfills stale closed prompt detail even after revisiting a thread later", () => {
    const prompts = [
      makePrompt("prompt-finished", "completed"),
      makePrompt("prompt-fresh", "completed"),
    ];

    const cachedDetails = {
      "prompt-finished": {
        status: "in_progress",
        endedAt: null,
      },
      "prompt-fresh": {
        status: "completed",
        endedAt: "2026-04-02T20:01:00.000Z",
      },
    } satisfies Partial<Record<string, Pick<PromptDetail, "status" | "endedAt">>>;

    expect(getPromptIdsNeedingDetailRefresh(prompts, {}, cachedDetails)).toEqual([
      "prompt-finished",
    ]);
  });
});
