import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import type { ArtifactRecord, PromptEventDetail, PromptEventRecord, PromptEventListItem, ThreadSummary, WorkspaceListItem } from "@promptreel/domain";
import {
  PromptreelStore,
  isEligibleWindowsGitWorkspace,
  toEligibleWorkspacePath
} from "./index";

describe("PromptreelStore", () => {
  test("registers repos idempotently under the Promptreel home", () => {
    const root = mkdtempSync(join(tmpdir(), "promptreel-store-"));
    const repoPath = join(root, "repo");
    mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });

    const store = new PromptreelStore(join(root, ".pl"));
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
    const root = mkdtempSync(join(tmpdir(), "promptreel-store-workspace-"));
    const repoPath = join(root, "repo");
    const nestedPath = join(repoPath, "packages", "ui");
    mkdirSync(nestedPath, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });

    const store = new PromptreelStore(join(root, ".pl"));
    const workspace = store.ensureWorkspaceGroup(nestedPath);
    const workspaces = store.listWorkspaces();

    expect(workspace.folderPath).toBe(nestedPath);
    expect(isEligibleWindowsGitWorkspace(repoPath)).toBe(true);
    expect(isEligibleWindowsGitWorkspace(nestedPath)).toBe(false);
    expect(toEligibleWorkspacePath(nestedPath)).toBeNull();
    expect(workspaces).toEqual([]);
  });

  test("reimport replaces prompt-scoped artifacts, links, and git links", () => {
    const root = mkdtempSync(join(tmpdir(), "promptreel-store-reimport-"));
    const repoPath = join(root, "repo");
    mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });

    const store = new PromptreelStore(join(root, ".pl"));
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
    const root = mkdtempSync(join(tmpdir(), "promptreel-store-legacy-boundary-"));
    const repoPath = join(root, "repo");
    mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });

    const store = new PromptreelStore(join(root, ".pl"));
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

  test("stores and reads back cloud bootstrap bundles by user", () => {
    const root = mkdtempSync(join(tmpdir(), "promptreel-store-cloud-sync-"));
    const store = new PromptreelStore(join(root, ".pl"));

    const workspace: WorkspaceListItem = {
      id: "workspace_cloud",
      slug: "repo",
      folderPath: "C:\\repo",
      gitRootPath: "C:\\repo",
      gitDir: "C:\\repo\\.git",
      createdAt: "2026-04-03T00:00:00.000Z",
      lastSeenAt: "2026-04-03T00:00:00.000Z",
      status: "active",
      source: "manual",
      threadCount: 1,
      openThreadCount: 0,
      isGenerating: false,
      lastActivityAt: "2026-04-03T00:00:02.000Z",
      sessionFileCount: 0,
      recentlyUpdatedSessionCount: 0,
      mode: "idle",
    };

    const thread: ThreadSummary = {
      id: "thread_cloud",
      workspaceId: workspace.id,
      sessionId: "session-1",
      threadId: "thread-1",
      folderPath: workspace.folderPath,
      startedAt: "2026-04-03T00:00:00.000Z",
      lastActivityAt: "2026-04-03T00:00:02.000Z",
      promptCount: 1,
      openPromptCount: 0,
      isGenerating: false,
      lastPromptSummary: "Ship the cloud sync.",
      status: "closed",
    };

    const prompt: PromptEventListItem = {
      id: "prompt_cloud",
      workspaceId: workspace.id,
      executionPath: workspace.folderPath,
      sessionId: "session-1",
      threadId: "thread-1",
      parentPromptEventId: null,
      startedAt: "2026-04-03T00:00:00.000Z",
      endedAt: "2026-04-03T00:00:02.000Z",
      boundaryReason: "import_end",
      status: "imported",
      mode: "default",
      artifactCount: 1,
      childCount: 0,
      filesTouched: ["src/index.ts"],
      filesTouchedCount: 1,
      additions: 3,
      deletions: 1,
      promptSummary: "Ship the cloud sync.",
      primaryArtifactId: "artifact_cloud",
      baselineSnapshotId: null,
      endSnapshotId: null,
      primaryArtifactType: "code_diff",
      primaryArtifactSummary: "Patch",
      hasCodeDiff: true,
      hasPlanArtifact: false,
      hasFinalResponse: true,
      isLiveDerived: false,
    };

    const detail: PromptEventDetail = {
      ...prompt,
      promptText: "Ship the cloud sync.",
      transcript: [
        {
          kind: "message",
          role: "user",
          occurredAt: "2026-04-03T00:00:00.000Z",
          phase: null,
          text: "Ship the cloud sync.",
        },
      ],
      artifacts: [
        {
          id: "artifact_cloud",
          promptEventId: prompt.id,
          type: "code_diff",
          role: "primary",
          summary: "Patch",
          blobId: "blob_cloud",
          fileStatsJson: JSON.stringify([{ path: "src/index.ts", changeType: "modified" }]),
          metadataJson: null,
        },
      ],
      artifactLinks: [],
      gitLinks: [],
    };

    store.upsertCloudWorkspaceBundle("user_cloud", {
      workspace,
      threads: [thread],
      prompts: [prompt],
      promptDetails: [detail],
      blobs: [{ blobId: "blob_cloud", content: "--- a/src/index.ts\n+++ b/src/index.ts\n+new line" }],
    });

    expect(store.listCloudWorkspaces("user_cloud")).toEqual([workspace]);
    expect(store.listCloudThreads("user_cloud", workspace.id)).toEqual([thread]);
    expect(store.listCloudPrompts("user_cloud", workspace.id, "thread-1")).toEqual([prompt]);
    expect(store.getCloudPromptDetail("user_cloud", workspace.id, prompt.id)).toEqual(detail);
    expect(store.readCloudBlob("user_cloud", workspace.id, "blob_cloud")).toContain("+++ b/src/index.ts");
  });
});
