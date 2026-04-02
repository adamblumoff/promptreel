import { describe, expect, test } from "vitest";
import type { Health, PromptDetail, PromptListItem, Workspace } from "./types";
import {
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
    isGenerating: true,
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
    isGenerating: false,
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
      isGenerating: false,
      threadCountLabel: "3 threads",
      statusTone: "idle",
      gitBadgeLabel: "git"
    });
    expect(items[1]).toMatchObject({
      id: "workspace-z",
      isGenerating: true,
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
      isGenerating: true,
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
    expect(thread.openLabel).toBe("Generating");
    expect(row.statusLabel).toBe("Generating");
    expect(row.filesLabel).toBe("2 files");
    expect(row.artifactLabel).toBe("4 artifacts");
    expect(row.childLabel).toBe("3 child prompts");
    expect(row.primaryLabel).toBe("code diff");
    expect(row.executionPathLabel).toBe("C:/work/alpha");
  });

  test("labels final output prompts as final response", () => {
    const row = toPromptRowViewModel({
      id: "prompt-final",
      workspaceId: "workspace-a",
      executionPath: "C:/work/alpha",
      sessionId: "session-1",
      threadId: "thread-1",
      parentPromptEventId: null,
      startedAt: "2026-03-30T14:22:00.000Z",
      endedAt: "2026-03-30T14:24:00.000Z",
      boundaryReason: "turn_completed",
      status: "completed",
      promptSummary: "Summarize what changed.",
      primaryArtifactId: "artifact-final",
      baselineSnapshotId: null,
      endSnapshotId: null,
      filesTouched: [],
      filesTouchedCount: 0,
      childCount: 0,
      artifactCount: 1,
      primaryArtifactType: "final_output",
      primaryArtifactSummary: "Wrapped up the work.",
      hasCodeDiff: false,
      isLiveDerived: false
    } satisfies PromptListItem);

    expect(row.primaryLabel).toBe("final response");
  });

  test("shapes prompt detail into featured response, plan, artifact summaries, and git summaries", () => {
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
          id: "artifact-final",
          promptEventId: "prompt-1",
          type: "final_output",
          role: "secondary",
          summary: "Wrapped up the implementation.",
          blobId: "blob-final",
          fileStatsJson: null,
          metadataJson: JSON.stringify({
            classification: {
              family: "final",
              subtype: "final.answer",
              displayLabel: "answer"
            }
          })
        },
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
        },
        {
          id: "artifact-search",
          promptEventId: "prompt-1",
          type: "command_run",
          role: "evidence",
          summary: "rg artifact packages",
          blobId: "blob-3",
          fileStatsJson: null,
          metadataJson: JSON.stringify({
            classification: {
              family: "execution",
              subtype: "execution.search",
              displayLabel: "search"
            }
          })
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
    expect(detail.featuredFinalResponseArtifact).toBeNull();
    expect(detail.featuredFinalResponseBlobId).toBeNull();
    expect(detail.featuredPlanArtifact).toMatchObject({
      id: "artifact-plan",
      label: "plan",
      blobId: "blob-2"
    });
    expect(detail.featuredPlanBlobId).toBe("blob-2");
    expect(detail.artifactSummaries).toHaveLength(1);
    expect(detail.artifactSummaries[0]).toMatchObject({
      label: "search",
      family: "execution",
      subtype: "execution.search",
    });
    expect(detail.gitSummaries[0]?.headline).toContain("Commit abcdef1");
  });

  test("features final response when there is no plan artifact", () => {
    const detail = toPromptDetailViewModel({
      id: "prompt-final",
      workspaceId: "workspace-a",
      executionPath: "C:/work/alpha",
      sessionId: "session-1",
      threadId: "thread-1",
      parentPromptEventId: null,
      startedAt: "2026-03-30T14:22:00.000Z",
      endedAt: "2026-03-30T14:24:00.000Z",
      boundaryReason: "turn_completed",
      status: "completed",
      promptText: "Summarize the work.",
      promptSummary: "Summarize the work.",
      primaryArtifactId: "artifact-final",
      baselineSnapshotId: null,
      endSnapshotId: null,
      artifacts: [
        {
          id: "artifact-final",
          promptEventId: "prompt-final",
          type: "final_output",
          role: "primary",
          summary: "Wrapped up the implementation.",
          blobId: "blob-final",
          fileStatsJson: null,
          metadataJson: JSON.stringify({
            classification: {
              family: "final",
              subtype: "final.answer",
              displayLabel: "answer"
            }
          })
        },
        {
          id: "artifact-command",
          promptEventId: "prompt-final",
          type: "command_run",
          role: "evidence",
          summary: "pnpm test",
          blobId: "blob-command",
          fileStatsJson: null,
          metadataJson: JSON.stringify({
            classification: {
              family: "verification",
              subtype: "verification.test",
              displayLabel: "test"
            }
          })
        }
      ],
      artifactLinks: [],
      gitLinks: []
    } satisfies PromptDetail);

    expect(detail.featuredFinalResponseArtifact).toMatchObject({
      id: "artifact-final",
      label: "final response",
      blobId: "blob-final"
    });
    expect(detail.featuredFinalResponseBlobId).toBe("blob-final");
    expect(detail.artifactSummaries).toHaveLength(1);
    expect(detail.artifactSummaries[0]).toMatchObject({
      id: "artifact-command",
      label: "test"
    });
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
