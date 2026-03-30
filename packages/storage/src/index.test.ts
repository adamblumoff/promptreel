import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import type { ArtifactRecord, PromptEventRecord } from "@promptline/domain";
import { PromptlineStore } from "./index";

describe("PromptlineStore", () => {
  test("registers repos idempotently under the Promptline home", () => {
    const root = mkdtempSync(join(tmpdir(), "promptline-store-"));
    const repoPath = join(root, "repo");
    mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });

    const store = new PromptlineStore(join(root, ".pl"));
    const first = store.addRepo(repoPath);
    const second = store.addRepo(repoPath);
    const repos = store.listRepos();

    expect(first.id).toBe(second.id);
    expect(repos).toHaveLength(1);
    expect(store.repoDir(first.id)).toContain(".pl");
  });

  test("reimport replaces prompt-scoped artifacts, links, and git links", () => {
    const root = mkdtempSync(join(tmpdir(), "promptline-store-reimport-"));
    const repoPath = join(root, "repo");
    mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });

    const store = new PromptlineStore(join(root, ".pl"));
    const repo = store.addRepo(repoPath);
    const baseline = store.createSnapshot(repo.id, {
      repoPath,
      headSha: null,
      branchName: null,
      gitStatusSummary: "baseline",
      dirtyFileHashes: {},
      files: []
    });
    const ending = store.createSnapshot(repo.id, {
      repoPath,
      headSha: null,
      branchName: null,
      gitStatusSummary: "end",
      dirtyFileHashes: {},
      files: []
    });
    const prompt: PromptEventRecord = {
      id: "prompt_test",
      repoId: repo.id,
      sessionId: "session-1",
      threadId: "session-1",
      parentPromptEventId: null,
      startedAt: "2026-03-29T00:00:00.000Z",
      endedAt: "2026-03-29T00:00:01.000Z",
      boundaryReason: "import_end",
      status: "imported",
      promptText: "Reimport this prompt.",
      promptSummary: "Reimport this prompt.",
      primaryArtifactId: "artifact_old_primary",
      baselineSnapshotId: baseline.id,
      endSnapshotId: ending.id
    };

    const oldArtifacts: ArtifactRecord[] = [
      {
        id: "artifact_old_primary",
        promptEventId: prompt.id,
        type: "code_diff",
        role: "primary",
        summary: "Old diff",
        blobId: null,
        fileStatsJson: JSON.stringify([{ path: "src/old.ts", changeType: "modified" }]),
        metadataJson: null
      },
      {
        id: "artifact_old_linked",
        promptEventId: prompt.id,
        type: "plan",
        role: "secondary",
        summary: "Old plan",
        blobId: null,
        fileStatsJson: null,
        metadataJson: null
      }
    ];

    store.persistPromptBundle(repo.id, {
      prompt,
      snapshots: [baseline, ending],
      artifacts: oldArtifacts,
      artifactLinks: [
        {
          id: "link_old",
          fromArtifactId: "artifact_old_linked",
          toArtifactId: "artifact_old_primary",
          relationType: "implements"
        }
      ],
      gitLinks: [
        {
          id: "git_old",
          promptEventId: prompt.id,
          commitSha: null,
          patchIdentity: "old-patch",
          survivalState: "uncommitted",
          matchedAt: "2026-03-29T00:00:02.000Z"
        }
      ],
      rawEvents: []
    });

    store.persistPromptBundle(repo.id, {
      prompt: {
        ...prompt,
        primaryArtifactId: "artifact_new_primary"
      },
      snapshots: [baseline, ending],
      artifacts: [
        {
          id: "artifact_new_primary",
          promptEventId: prompt.id,
          type: "code_diff",
          role: "primary",
          summary: "New diff",
          blobId: null,
          fileStatsJson: JSON.stringify([{ path: "src/new.ts", changeType: "modified" }]),
          metadataJson: null
        }
      ],
      artifactLinks: [],
      gitLinks: [],
      rawEvents: []
    });

    const detail = store.getPromptDetail(repo.id, prompt.id);
    const prompts = store.listPrompts(repo.id);

    expect(detail?.artifacts.map((artifact) => artifact.id)).toEqual(["artifact_new_primary"]);
    expect(detail?.artifactLinks).toEqual([]);
    expect(detail?.gitLinks).toEqual([]);
    expect(prompts[0]?.filesTouched).toEqual(["src/new.ts"]);
  });
});
