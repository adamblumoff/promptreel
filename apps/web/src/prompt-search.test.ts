import { describe, expect, test } from "vitest";
import { filterPromptSearchItems, normalizePromptSearchText } from "./prompt-search";
import type { PromptSearchItem } from "./types";

const items: PromptSearchItem[] = [
  {
    promptId: "prompt-3",
    workspaceId: "workspace-a",
    threadId: "thread-3",
    workspaceSlug: "workspace-a",
    threadTitle: "Thread three",
    promptSummary: "Viewer refresh follow-up",
    startedAt: "2026-04-08T16:00:00.000Z",
  },
  {
    promptId: "prompt-2",
    workspaceId: "workspace-a",
    threadId: "thread-2",
    workspaceSlug: "workspace-a",
    threadTitle: "Thread two",
    promptSummary: "Cloud sync polling cleanup",
    startedAt: "2026-04-08T15:00:00.000Z",
  },
  {
    promptId: "prompt-1",
    workspaceId: "workspace-b",
    threadId: "thread-1",
    workspaceSlug: "workspace-b",
    threadTitle: "Thread one",
    promptSummary: "Ship cloud sync viewer",
    startedAt: "2026-04-08T14:00:00.000Z",
  },
];

describe("prompt search helpers", () => {
  test("normalizes case and whitespace", () => {
    expect(normalizePromptSearchText("  Ship   CLOUD Sync ")).toBe("ship cloud sync");
  });

  test("returns exact substring matches in existing recency order", () => {
    expect(filterPromptSearchItems(items, "cloud sync").map((item) => item.promptId)).toEqual([
      "prompt-2",
      "prompt-1",
    ]);
  });

  test("returns no results for an empty query", () => {
    expect(filterPromptSearchItems(items, "   ")).toEqual([]);
  });
});
