import { describe, expect, test } from "vitest";
import type { Health, PromptDetail, PromptListItem, Workspace } from "./types";
import {
  buildThreadRowViewModels,
  buildWorkspaceSidebarItems,
  getSelectedWorkspaceStatus,
  resolveSelectedThreadId,
  resolveSelectedWorkspaceId,
  sortWorkspacesByActivity,
  toPromptDetailViewModel,
  toPromptRowViewModel,
  toThreadRowViewModel
} from "./view-models";

const workspaces: Workspace[] = [
  {
    id: "workspace-z",
    slug: "zeta",
    folderPath: "C:/work/zeta",
    gitRootPath: "C:/work/zeta",
    gitDir: "C:/work/zeta/.git",
    createdAt: "2026-03-30T14:00:00.000Z",
    lastSeenAt: "2026-03-30T14:21:00.000Z",
    lastActivityAt: "2026-03-30T14:21:00.000Z",
    status: "active",
    source: "auto_discovered",
    threadCount: 2,
    openThreadCount: 1,
    sessionFileCount: 2,
    recentlyUpdatedSessionCount: 1,
    mode: "watching"
  },
  {
    id: "workspace-a",
    slug: "alpha",
    folderPath: "C:/work/alpha",
    gitRootPath: "C:/work/alpha",
    gitDir: "C:/work/alpha/.git",
    createdAt: "2026-03-30T14:00:00.000Z",
    lastSeenAt: "2026-03-30T14:25:00.000Z",
    lastActivityAt: "2026-03-30T14:25:00.000Z",
    status: "active",
    source: "auto_discovered",
    threadCount: 3,
    openThreadCount: 0,
    sessionFileCount: 3,
    recentlyUpdatedSessionCount: 2,
    mode: "idle"
  }
];

describe("web view models", () => {
  test("sorts workspaces by activity and falls back to the first workspace when selection is missing", () => {
    const sorted = sortWorkspacesByActivity(workspaces);

    expect(sorted.map((workspace) => workspace.slug)).toEqual(["alpha", "zeta"]);
    expect(resolveSelectedWorkspaceId(sorted, "workspace-z")).toBe("workspace-z");
    expect(resolveSelectedWorkspaceId(sorted, "missing")).toBe("workspace-a");
  });

  test("builds sidebar items directly from workspace payloads", () => {
    const items = buildWorkspaceSidebarItems(workspaces, "workspace-a");

    expect(items[0]).toMatchObject({
      id: "workspace-a",
      isSelected: true,
      showActivityDot: true,
      threadCountLabel: "3 threads",
      statusTone: "idle",
      gitBadgeLabel: "git"
    });
    expect(items[1]).toMatchObject({
      id: "workspace-z",
      showActivityDot: false,
    });
  });

  test("formats thread and prompt rows with compact labels", () => {
    const thread = toThreadRowViewModel({
      id: "thread-1",
      workspaceId: "workspace-a",
      sessionId: "session-1",
      threadId: "thread-1",
      folderPath: "C:/work/alpha",
      startedAt: "2026-03-30T14:00:00.000Z",
      lastActivityAt: "2026-03-30T14:22:00.000Z",
      promptCount: 4,
      openPromptCount: 1,
      lastPromptSummary: "Refactor the stream layout.",
      status: "open"
    });
    const row = toPromptRowViewModel({
      id: "prompt-1",
      workspaceId: "workspace-a",
      executionPath: "C:/work/alpha",
      sessionId: "session-1",
      threadId: "thread-1",
      parentPromptEventId: null,
      startedAt: "2026-03-30T14:22:00.000Z",
      endedAt: "2026-03-30T14:24:00.000Z",
      boundaryReason: "turn_completed",
      status: "in_progress",
      promptSummary: "Open the prompt.",
      primaryArtifactId: "artifact-1",
      baselineSnapshotId: null,
      endSnapshotId: null,
      filesTouched: ["src/app.tsx", "src/api.ts"],
      filesTouchedCount: 2,
      childCount: 3,
      artifactCount: 4,
      primaryArtifactType: "code_diff",
      primaryArtifactSummary: "Updated the app shell.",
      hasCodeDiff: true,
      isLiveDerived: true
    } satisfies PromptListItem);

    expect(thread.promptCountLabel).toBe("4 prompts");
    expect(thread.openLabel).toBe("1 active");
    expect(row.statusLabel).toBe("Active now");
    expect(row.filesLabel).toBe("2 files");
    expect(row.artifactLabel).toBe("4 artifacts");
    expect(row.childLabel).toBe("3 child prompts");
    expect(row.primaryLabel).toBe("code diff");
    expect(row.executionPathLabel).toBe("C:/work/alpha");
    expect(thread.showActivityDot).toBe(false);
  });

  test("marks only active threads, or the most recent thread when none are active", () => {
    const now = new Date().toISOString();
    const justBeforeNow = new Date(Date.now() - 60_000).toISOString();
    const staleTime = "2026-03-30T14:24:00.000Z";

    const activeThreads = buildThreadRowViewModels([
      {
        id: "thread-1",
        workspaceId: "workspace-a",
        sessionId: "session-1",
        threadId: "thread-1",
        folderPath: "C:/work/alpha",
        startedAt: "2026-03-30T14:00:00.000Z",
        lastActivityAt: now,
        promptCount: 4,
        openPromptCount: 1,
        lastPromptSummary: "Still running",
        status: "open"
      },
      {
        id: "thread-2",
        workspaceId: "workspace-a",
        sessionId: "session-2",
        threadId: "thread-2",
        folderPath: "C:/work/alpha",
        startedAt: "2026-03-30T14:10:00.000Z",
        lastActivityAt: staleTime,
        promptCount: 2,
        openPromptCount: 0,
        lastPromptSummary: "Wrapped up",
        status: "closed"
      }
    ]);
    const idleThreads = buildThreadRowViewModels([
      {
        id: "thread-3",
        workspaceId: "workspace-a",
        sessionId: "session-3",
        threadId: "thread-3",
        folderPath: "C:/work/alpha",
        startedAt: "2026-03-30T14:15:00.000Z",
        lastActivityAt: justBeforeNow,
        promptCount: 3,
        openPromptCount: 0,
        lastPromptSummary: "Most recent",
        status: "closed"
      },
      {
        id: "thread-4",
        workspaceId: "workspace-a",
        sessionId: "session-4",
        threadId: "thread-4",
        folderPath: "C:/work/alpha",
        startedAt: "2026-03-30T14:05:00.000Z",
        lastActivityAt: staleTime,
        promptCount: 1,
        openPromptCount: 0,
        lastPromptSummary: "Older",
        status: "closed"
      }
    ]);

    expect(activeThreads.find((thread) => thread.id === "thread-1")?.showActivityDot).toBe(true);
    expect(activeThreads.find((thread) => thread.id === "thread-2")?.showActivityDot).toBe(false);
    expect(idleThreads.find((thread) => thread.id === "thread-3")?.showActivityDot).toBe(true);
    expect(idleThreads.find((thread) => thread.id === "thread-4")?.showActivityDot).toBe(false);
  });

  test("shows only recently active workspaces when stale open counts exist", () => {
    const items = buildWorkspaceSidebarItems([
      {
        ...workspaces[0],
        id: "workspace-stale",
        slug: "stale",
        lastActivityAt: "2026-03-20T17:12:48.014Z",
        openThreadCount: 3,
      },
      {
        ...workspaces[1],
        id: "workspace-fresh",
        slug: "fresh",
        lastActivityAt: new Date().toISOString(),
        openThreadCount: 1,
      }
    ], "workspace-fresh");

    expect(items.find((item) => item.id === "workspace-stale")?.showActivityDot).toBe(false);
    expect(items.find((item) => item.id === "workspace-fresh")?.showActivityDot).toBe(true);
  });

  test("shapes prompt detail into touched files, artifact summaries, and git summaries", () => {
    const detail = toPromptDetailViewModel({
      id: "prompt-1",
      workspaceId: "workspace-a",
      executionPath: "C:/work/alpha",
      sessionId: "session-1",
      threadId: "thread-1",
      parentPromptEventId: null,
      startedAt: "2026-03-30T14:22:00.000Z",
      endedAt: "2026-03-30T14:24:00.000Z",
      boundaryReason: "turn_completed",
      status: "completed",
      promptText: "Explain the change and summarize the diff.",
      promptSummary: "Explain the change.",
      primaryArtifactId: "artifact-diff",
      baselineSnapshotId: null,
      endSnapshotId: null,
      artifacts: [
        {
          id: "artifact-diff",
          promptEventId: "prompt-1",
          type: "code_diff",
          role: "primary",
          summary: "Updated the shell and prompt list.",
          blobId: "blob-1",
          fileStatsJson: JSON.stringify([
            { path: "src/App.tsx" },
            { path: "src/components.tsx" }
          ]),
          metadataJson: null
        },
        {
          id: "artifact-plan",
          promptEventId: "prompt-1",
          type: "plan",
          role: "secondary",
          summary: "Outline the sidebar and accordion work.",
          blobId: "blob-2",
          fileStatsJson: null,
          metadataJson: null
        }
      ],
      artifactLinks: [
        {
          id: "link-1",
          fromArtifactId: "artifact-plan",
          toArtifactId: "artifact-diff",
          relationType: "implements"
        }
      ],
      gitLinks: [
        {
          id: "git-1",
          promptEventId: "prompt-1",
          commitSha: "abcdef1234567890",
          patchIdentity: "patch-identity",
          survivalState: "survived",
          matchedAt: "2026-03-30T14:25:00.000Z"
        }
      ]
    } satisfies PromptDetail);

    expect(detail.primaryArtifactSummary).toBe("Updated the shell and prompt list.");
    expect(detail.executionPathLabel).toBe("C:/work/alpha");
    expect(detail.touchedFiles).toEqual(["src/App.tsx", "src/components.tsx"]);
    expect(detail.touchedFilesLabel).toBe("2 touched files");
    expect(detail.artifactSummaries[0]).toMatchObject({
      label: "code diff · primary",
      fileCountLabel: "2 files"
    });
    expect(detail.artifactSummaries[1]?.relationCountLabel).toBe("1 link");
    expect(detail.gitSummaries[0]?.headline).toContain("Commit abcdef1");
  });

  test("derives watcher status labels from health and handles missing status", () => {
    const health: Health = {
      ok: true,
      daemonPid: 123,
      homeDir: "C:/Users/demo/.pl",
      ingestion: {
        watcher: "running",
        pollingIntervalMs: 3000,
        sessionsRoot: "C:/Users/demo/.codex/sessions",
        lastScanAt: "2026-03-30T14:25:00.000Z",
        workspaceStatuses: [
          {
            workspaceId: "workspace-a",
            folderPath: "C:/work/alpha",
            mode: "watching",
            threadCount: 3,
            openThreadCount: 1,
            sessionFileCount: 3,
            recentlyUpdatedSessionCount: 2,
            lastImportAt: "2026-03-30T14:24:00.000Z",
            lastImportResult: {
              importedFiles: 2,
              importedPrompts: 5
            },
            lastError: null
          }
        ]
      }
    };

    expect(getSelectedWorkspaceStatus(workspaces[1], health, "workspace-a")).toMatchObject({
      tone: "watching",
      openThreadCount: 1
    });
    expect(getSelectedWorkspaceStatus(workspaces[0], health, "workspace-z")).toMatchObject({
      tone: "watching"
    });
    expect(resolveSelectedThreadId([], "missing")).toBe("");
  });
});
