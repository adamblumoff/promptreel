import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import type { ArtifactRecord, PromptEventRecord } from "@promptline/domain";
import {
  PromptlineStore,
  isEligibleWindowsGitWorkspace,
  toEligibleWorkspacePath
} from "./index";

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
    const workspaces = store.listWorkspaces();

    expect(first.id).toBe(second.id);
    expect(repos).toHaveLength(1);
    expect(workspaces).toHaveLength(1);
    expect(store.repoDir(first.id)).toContain(".pl");
  });

  test("only exposes exact Windows directories with a direct .git folder", () => {
    const root = mkdtempSync(join(tmpdir(), "promptline-store-workspace-"));
    const repoPath = join(root, "repo");
    const nestedPath = join(repoPath, "packages", "ui");
    mkdirSync(nestedPath, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });

    const store = new PromptlineStore(join(root, ".pl"));
    const workspace = store.ensureWorkspaceGroup(nestedPath);
    const workspaces = store.listWorkspaces();

    expect(workspace.folderPath).toBe(nestedPath);
    expect(isEligibleWindowsGitWorkspace(repoPath)).toBe(true);
    expect(isEligibleWindowsGitWorkspace(nestedPath)).toBe(false);
    expect(toEligibleWorkspacePath(nestedPath)).toBeNull();
    expect(workspaces).toEqual([]);
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
      workspaceId: repo.id,
      executionPath: repoPath,
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

    expect(detail?.executionPath).toBe(repoPath);
    expect(detail?.artifacts.map((artifact) => artifact.id)).toEqual(["artifact_new_primary"]);
    expect(detail?.artifactLinks).toEqual([]);
    expect(detail?.gitLinks).toEqual([]);
    expect(prompts[0]?.filesTouched).toEqual(["src/new.ts"]);
    expect(store.listThreads(repo.id)).toHaveLength(1);
  });

  test("skips a legacy next-user boundary row when reading prompt transcripts", () => {
    const root = mkdtempSync(join(tmpdir(), "promptline-store-legacy-boundary-"));
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
      id: "prompt_legacy_boundary",
      workspaceId: repo.id,
      executionPath: repoPath,
      sessionId: "session-1",
      threadId: "session-1",
      parentPromptEventId: null,
      startedAt: "2026-03-29T00:00:00.000Z",
      endedAt: "2026-03-29T00:00:02.000Z",
      boundaryReason: "next_user_prompt",
      status: "imported",
      promptText: "First prompt.",
      promptSummary: "First prompt.",
      primaryArtifactId: null,
      baselineSnapshotId: baseline.id,
      endSnapshotId: ending.id
    };

    store.persistPromptBundle(repo.id, {
      prompt,
      snapshots: [baseline, ending],
      artifacts: [],
      artifactLinks: [],
      gitLinks: [],
      rawEvents: [
        {
          record: {
            id: "raw_first_user",
            workspaceId: repo.id,
            source: "codex-session",
            sessionId: "session-1",
            threadId: "session-1",
            eventType: "event_msg:user_message",
            occurredAt: "2026-03-29T00:00:00.000Z",
            ingestPath: "session.jsonl",
            payloadBlobId: ""
          },
          payload: {
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "First prompt."
            }
          }
        },
        {
          record: {
            id: "raw_first_assistant",
            workspaceId: repo.id,
            source: "codex-session",
            sessionId: "session-1",
            threadId: "session-1",
            eventType: "event_msg:agent_message",
            occurredAt: "2026-03-29T00:00:01.000Z",
            ingestPath: "session.jsonl",
            payloadBlobId: ""
          },
          payload: {
            type: "event_msg",
            payload: {
              type: "agent_message",
              phase: "final_answer",
              message: "First answer."
            }
          }
        },
        {
          record: {
            id: "raw_second_user",
            workspaceId: repo.id,
            source: "codex-session",
            sessionId: "session-1",
            threadId: "session-1",
            eventType: "event_msg:user_message",
            occurredAt: "2026-03-29T00:00:02.000Z",
            ingestPath: "session.jsonl",
            payloadBlobId: ""
          },
          payload: {
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "Second prompt."
            }
          }
        }
      ]
    });

    const detail = store.getPromptDetail(repo.id, prompt.id)!;

    expect(
      detail.transcript.map((entry) =>
        entry.kind === "message" ? `${entry.role}:${entry.text}` : entry.summary
      )
    ).toEqual([
      "user:First prompt.",
      "assistant:First answer."
    ]);
  });
});
