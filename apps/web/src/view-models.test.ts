import { describe, expect, test } from "vitest";
import type { Health, PromptDetail, PromptListItem, Repo } from "./types";
import {
  buildProjectSidebarItems,
  getSelectedRepoStatus,
  resolveSelectedProjectId,
  sortProjectsAlphabetically,
  toPromptDetailViewModel,
  toPromptRowViewModel
} from "./view-models";

const repos: Repo[] = [
  {
    id: "repo-z",
    slug: "zeta",
    rootPath: "C:/work/zeta"
  },
  {
    id: "repo-a",
    slug: "alpha",
    rootPath: "C:/work/alpha"
  }
];

describe("web view models", () => {
  test("sorts projects alphabetically and falls back to the first project when selection is missing", () => {
    const sorted = sortProjectsAlphabetically(repos);

    expect(sorted.map((repo) => repo.slug)).toEqual(["alpha", "zeta"]);
    expect(resolveSelectedProjectId(sorted, "repo-z")).toBe("repo-z");
    expect(resolveSelectedProjectId(sorted, "missing")).toBe("repo-a");
  });

  test("builds idle sidebar items when health is missing", () => {
    const items = buildProjectSidebarItems(repos, null, "repo-a");

    expect(items[0]).toMatchObject({
      id: "repo-a",
      isSelected: true,
      openPromptCount: 0,
      activityLabel: "Waiting for watcher",
      statusTone: "idle"
    });
  });

  test("formats prompt rows with compact labels", () => {
    const row = toPromptRowViewModel({
      id: "prompt-1",
      repoId: "repo-a",
      sessionId: "session-1",
      threadId: "thread-1",
      parentPromptEventId: null,
      startedAt: "2026-03-30T14:22:00.000Z",
      endedAt: "2026-03-30T14:24:00.000Z",
      boundaryReason: "turn_completed",
      status: "in_progress",
      promptText: "Open the prompt.",
      promptSummary: "Open the prompt.",
      primaryArtifactId: "artifact-1",
      baselineSnapshotId: null,
      endSnapshotId: null,
      filesTouched: ["src/app.ts", "src/api.ts"],
      filesTouchedCount: 2,
      childCount: 3,
      artifactCount: 4,
      primaryArtifactType: "code_diff",
      primaryArtifactSummary: "Updated the app shell.",
      hasCodeDiff: true,
      isLiveDerived: true
    } satisfies PromptListItem);

    expect(row.statusLabel).toBe("Open now");
    expect(row.filesLabel).toBe("2 files");
    expect(row.artifactLabel).toBe("4 artifacts");
    expect(row.childLabel).toBe("3 child prompts");
    expect(row.primaryLabel).toBe("code diff");
  });

  test("shapes prompt detail into touched files, artifact summaries, and git summaries", () => {
    const detail = toPromptDetailViewModel({
      id: "prompt-1",
      repoId: "repo-a",
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
        repoStatuses: [
          {
            repoId: "repo-a",
            mode: "watching",
            sessionFileCount: 3,
            recentlyUpdatedSessionCount: 2,
            openPromptCount: 1,
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

    expect(getSelectedRepoStatus(health, "repo-a")).toMatchObject({
      tone: "watching",
      openPromptCount: 1
    });
    expect(getSelectedRepoStatus(health, "repo-z")).toBeNull();
  });
});
