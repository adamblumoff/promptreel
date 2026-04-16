import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  ArtifactLinkRecord,
  ArtifactRecord,
  AuthDevice,
  AuthUserProfile,
  GitLinkRecord,
  PromptEventDetail,
  PromptTranscriptActivity,
  PromptTranscriptEntry,
  PromptEventListItem,
  PromptEventRecord,
  RawEventRecord,
  RepoRegistration,
  ThreadSummary,
  WorkspaceGroup,
  WorkspaceListItem,
  WorkspaceSnapshot,
  WorkspaceSnapshotData
} from "@promptreel/domain";
import {
  createId,
  nowIso,
  repoRegistrationId,
  slugifyPath,
  slugifyRepoPath,
  threadSummaryId,
  workspaceGroupId
} from "@promptreel/domain";
import {
  buildAppServerActivityEntry,
  buildCompletedActivityEntry,
  upsertResponseItemActivity,
} from "./transcript-activity.js";
import {
  authenticateDaemonToken as authenticateStoredDaemonToken,
  approveCliLoginRequest as approveStoredCliLoginRequest,
  clearCloudAuthState as clearStoredCloudAuthState,
  createCliLoginRequest as createStoredCliLoginRequest,
  exchangeCliLoginRequest as exchangeStoredCliLoginRequest,
  getAuthUserByClerkUserId as getStoredAuthUserByClerkUserId,
  getCloudAuthState as getStoredCloudAuthState,
  getCliLoginRequest as getStoredCliLoginRequest,
  getLatestAuthDeviceForUser as getStoredLatestAuthDeviceForUser,
  resetCloudAuth as resetStoredCloudAuth,
  setCloudAuthState as setStoredCloudAuthState,
  type CliLoginRequestRow,
  type CloudAuthState,
} from "./storage-auth.js";
import {
  clearDaemonState as clearStoredDaemonState,
  getDaemonState as getStoredDaemonState,
  getIngestCursor as getStoredIngestCursor,
  getLegacyCloudSyncCursorForDevice as getStoredLegacyCloudSyncCursorForDevice,
  getLegacySyncRecordHashesForDevice as getStoredLegacySyncRecordHashesForDevice,
  getSyncRecordHashes as getStoredSyncRecordHashes,
  setDaemonState as setStoredDaemonState,
  setIngestCursor as setStoredIngestCursor,
  upsertSyncRecords as upsertStoredSyncRecords,
} from "./storage-sync-state.js";

export interface PersistPromptBundle {
  prompt: PromptEventRecord;
  snapshots: WorkspaceSnapshot[];
  artifacts: ArtifactRecord[];
  artifactLinks: ArtifactLinkRecord[];
  gitLinks: GitLinkRecord[];
  rawEvents: Array<{ record: RawEventRecord; payload: unknown }>;
}

type WorkspaceCreateOptions = {
  gitRootPath?: string | null;
  gitDir?: string | null;
  status?: WorkspaceGroup["status"];
  source?: WorkspaceGroup["source"];
  lastSeenAt?: string;
};

type LegacyPromptRow = {
  id: string;
  workspaceId: string;
  executionPath: string | null;
  sessionId: string | null;
  threadId: string | null;
  parentPromptEventId: string | null;
  startedAt: string;
  endedAt: string | null;
  boundaryReason: PromptEventRecord["boundaryReason"];
  status: PromptEventRecord["status"];
  mode: PromptEventRecord["mode"];
  promptText: string;
  promptSummary: string;
  primaryArtifactId: string | null;
  baselineSnapshotId: string | null;
  endSnapshotId: string | null;
};

export type { CloudAuthState } from "./storage-auth.js";

export class PromptreelStore {
  readonly homeDir: string;
  readonly registryPath: string;

  constructor(homeDir = join(homedir(), ".pl")) {
    this.homeDir = homeDir;
    this.registryPath = join(this.homeDir, "registry.sqlite");
    this.ensureBaseLayout();
    this.ensureRegistrySchema();
  }

  ensureBaseLayout(): void {
    mkdirSync(this.homeDir, { recursive: true });
    mkdirSync(join(this.homeDir, "daemon", "logs"), { recursive: true });
    mkdirSync(join(this.homeDir, "repos"), { recursive: true });
  }

  private storageRegistryContext() {
    return {
      homeDir: this.homeDir,
      openRegistry: () => this.openRegistry(),
    };
  }

  private storageWorkspaceContext() {
    return {
      homeDir: this.homeDir,
      ensureWorkspaceSchema: (workspaceId: string) => this.ensureWorkspaceSchema(workspaceId),
      openWorkspace: (workspaceId: string) => this.openWorkspace(workspaceId),
    };
  }

  addRepo(rootPath: string): RepoRegistration {
    const git = this.resolveGitMetadata(resolve(rootPath));
    if (!git.gitRootPath || !git.gitDir) {
      throw new Error(`No .git directory found for ${rootPath}`);
    }

    const now = nowIso();
    const repairedWorkspace = this.repairMovedWorkspaceForPath(git.gitRootPath, {
      gitRootPath: git.gitRootPath,
      gitDir: git.gitDir,
      source: "manual",
      status: existsSync(git.gitRootPath) ? "active" : "missing",
      lastSeenAt: now
    });
    const repo: RepoRegistration = {
      id: repairedWorkspace?.id ?? repoRegistrationId(git.gitRootPath),
      slug: slugifyRepoPath(git.gitRootPath),
      rootPath: git.gitRootPath,
      gitDir: git.gitDir,
      createdAt: now,
      lastSeenAt: now,
      status: existsSync(git.gitRootPath) ? "active" : "missing"
    };

    const db = this.openRegistry();
    db.prepare(
      `INSERT INTO repo_registrations
       (id, slug, root_path, git_dir, created_at, last_seen_at, status)
       VALUES (:id, :slug, :rootPath, :gitDir, :createdAt, :lastSeenAt, :status)
       ON CONFLICT(id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         status = excluded.status,
         git_dir = excluded.git_dir`
    ).run(asSqlParams(repo));
    db.close();

    this.ensureWorkspaceGroup(git.gitRootPath, {
      gitRootPath: git.gitRootPath,
      gitDir: git.gitDir,
      source: "manual",
      status: repo.status,
      lastSeenAt: now
    });

    return repo;
  }

  listRepos(): RepoRegistration[] {
    const db = this.openRegistry();
    const rows = db.prepare(
      `SELECT
         id,
         slug,
         root_path AS rootPath,
         git_dir AS gitDir,
         created_at AS createdAt,
         last_seen_at AS lastSeenAt,
         status
       FROM repo_registrations
       ORDER BY last_seen_at DESC, slug ASC`
    ).all() as unknown as RepoRegistration[];
    db.close();
    return rows;
  }

  getRepo(repoId: string): RepoRegistration | null {
    const db = this.openRegistry();
    const row = db.prepare(
      `SELECT
         id,
         slug,
         root_path AS rootPath,
         git_dir AS gitDir,
         created_at AS createdAt,
         last_seen_at AS lastSeenAt,
         status
       FROM repo_registrations
       WHERE id = ?`
    ).get(repoId) as RepoRegistration | undefined;
    db.close();
    return row ?? null;
  }

  ensureWorkspaceGroup(folderPath: string | null, options: WorkspaceCreateOptions = {}): WorkspaceGroup {
    const normalizedFolderPath = normalizeFolderPath(folderPath);
    const existingWorkspace = normalizedFolderPath ? this.findWorkspaceByFolderPath(normalizedFolderPath) : null;
    if (existingWorkspace) {
      const resolvedFolderPath = normalizedFolderPath!;
      const inferredGit = this.resolveGitMetadata(resolvedFolderPath);
      const now = options.lastSeenAt ?? nowIso();
      const updatedWorkspace: WorkspaceGroup = {
        ...existingWorkspace,
        slug: slugifyPath(resolvedFolderPath),
        folderPath: resolvedFolderPath,
        gitRootPath: options.gitRootPath ?? inferredGit.gitRootPath,
        gitDir: options.gitDir ?? inferredGit.gitDir,
        lastSeenAt: now,
        status:
          options.status
          ?? (!existsSync(resolvedFolderPath) ? "missing" : "active"),
        source: existingWorkspace.source === "manual" ? "manual" : (options.source ?? existingWorkspace.source)
      };
      this.upsertWorkspaceGroup(updatedWorkspace);
      this.ensureWorkspaceLayout(updatedWorkspace.id);
      this.ensureWorkspaceSchema(updatedWorkspace.id);
      return this.getWorkspace(updatedWorkspace.id) ?? updatedWorkspace;
    }

    const inferredGit = normalizedFolderPath
      ? this.resolveGitMetadata(normalizedFolderPath)
      : { gitRootPath: null, gitDir: null };
    const now = options.lastSeenAt ?? nowIso();
    const repairedWorkspace = normalizedFolderPath
      ? this.repairMovedWorkspaceForPath(normalizedFolderPath, {
          gitRootPath: options.gitRootPath ?? inferredGit.gitRootPath,
          gitDir: options.gitDir ?? inferredGit.gitDir,
          source: options.source ?? "auto_discovered",
          status:
            options.status
            ?? (normalizedFolderPath && !existsSync(normalizedFolderPath) ? "missing" : "active"),
          lastSeenAt: now
        })
      : null;
    if (repairedWorkspace) {
      return repairedWorkspace;
    }

    const workspace: WorkspaceGroup = {
      id: workspaceGroupId(normalizedFolderPath),
      slug: slugifyPath(normalizedFolderPath),
      folderPath: normalizedFolderPath,
      gitRootPath: options.gitRootPath ?? inferredGit.gitRootPath,
      gitDir: options.gitDir ?? inferredGit.gitDir,
      createdAt: now,
      lastSeenAt: now,
      status:
        options.status
        ?? (normalizedFolderPath && !existsSync(normalizedFolderPath) ? "missing" : "active"),
      source: options.source ?? "auto_discovered"
    };

    this.upsertWorkspaceGroup(workspace);

    this.ensureWorkspaceLayout(workspace.id);
    this.ensureWorkspaceSchema(workspace.id);
    return this.getWorkspace(workspace.id) ?? workspace;
  }

  listWorkspaces(): WorkspaceGroup[] {
    const db = this.openRegistry();
    const rows = db.prepare(
      `SELECT
         id,
         slug,
         folder_path AS folderPath,
         git_root_path AS gitRootPath,
         git_dir AS gitDir,
         created_at AS createdAt,
         last_seen_at AS lastSeenAt,
         status,
         source
       FROM workspace_groups
       ORDER BY last_seen_at DESC, folder_path ASC, slug ASC`
    ).all() as unknown as WorkspaceGroup[];
    db.close();
    return rows.filter((workspace) => isVisibleWorkspaceGroup(workspace));
  }

  getWorkspace(workspaceId: string): WorkspaceGroup | null {
    const db = this.openRegistry();
    const row = db.prepare(
      `SELECT
         id,
         slug,
         folder_path AS folderPath,
         git_root_path AS gitRootPath,
         git_dir AS gitDir,
         created_at AS createdAt,
         last_seen_at AS lastSeenAt,
         status,
         source
       FROM workspace_groups
       WHERE id = ?`
    ).get(workspaceId) as WorkspaceGroup | undefined;
    db.close();
    return row ?? null;
  }

  listThreads(workspaceId: string): ThreadSummary[] {
    const prompts = this.listPrompts(workspaceId);
    const grouped = new Map<
      string,
      {
        sessionId: string | null;
        threadId: string | null;
        folderPath: string | null;
        startedAt: string;
        lastActivityAt: string;
        promptCount: number;
        openPromptCount: number;
        lastPromptSummary: string;
      }
    >();

    for (const prompt of prompts) {
      const threadKey = prompt.threadId ?? prompt.sessionId ?? `prompt:${prompt.id}`;
      const existing = grouped.get(threadKey);
      const lastActivityAt = prompt.endedAt ?? prompt.startedAt;
      if (!existing) {
        grouped.set(threadKey, {
          sessionId: prompt.sessionId,
          threadId: prompt.threadId,
          folderPath: prompt.executionPath,
          startedAt: prompt.startedAt,
          lastActivityAt,
          promptCount: 1,
          openPromptCount: prompt.status === "in_progress" ? 1 : 0,
          lastPromptSummary: prompt.promptSummary
        });
        continue;
      }

      existing.promptCount += 1;
      existing.openPromptCount += prompt.status === "in_progress" ? 1 : 0;
      if (prompt.startedAt < existing.startedAt) {
        existing.startedAt = prompt.startedAt;
      }
      if (lastActivityAt >= existing.lastActivityAt) {
        existing.lastActivityAt = lastActivityAt;
        existing.lastPromptSummary = prompt.promptSummary;
      }
      if (!existing.folderPath && prompt.executionPath) {
        existing.folderPath = prompt.executionPath;
      }
    }

    return [...grouped.entries()]
      .map(([threadKey, thread]) => ({
        id: threadSummaryId(workspaceId, threadKey),
        workspaceId,
        sessionId: thread.sessionId,
        threadId: thread.threadId,
        folderPath: thread.folderPath,
        startedAt: thread.startedAt,
        lastActivityAt: thread.lastActivityAt,
        promptCount: thread.promptCount,
        openPromptCount: thread.openPromptCount,
        isGenerating: false,
        lastPromptSummary: thread.lastPromptSummary,
        status: (thread.openPromptCount > 0 ? "open" : "closed") as ThreadSummary["status"]
      }))
      .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
  }

  persistPromptBundle(workspaceId: string, bundle: PersistPromptBundle): void {
    this.ensureWorkspaceLayout(workspaceId);
    this.ensureWorkspaceSchema(workspaceId);
    const db = this.openWorkspace(workspaceId);
    db.exec("BEGIN");
    try {
      // Raw events are immutable by id, so live prompt rewrites only need to add new rows.
      for (const raw of bundle.rawEvents) {
        const payloadBlobId = this.writeBlob(workspaceId, JSON.stringify(raw.payload));
        db.prepare(
          `INSERT OR IGNORE INTO raw_events
           (id, repo_id, source, session_id, thread_id, event_type, occurred_at, payload_blob_id, ingest_path)
           VALUES (:id, :workspaceId, :source, :sessionId, :threadId, :eventType, :occurredAt, :payloadBlobId, :ingestPath)`
        ).run(asSqlParams({ ...raw.record, payloadBlobId }));
      }

      // Snapshot ids are immutable too, so repeated in-progress prompt rewrites should not churn these rows.
      for (const snapshot of bundle.snapshots) {
        db.prepare(
          `INSERT OR IGNORE INTO workspace_snapshots
           (id, repo_id, captured_at, head_sha, branch_name, dirty_file_hashes_json, git_status_summary, blob_id)
           VALUES (:id, :workspaceId, :capturedAt, :headSha, :branchName, :dirtyFileHashesJson, :gitStatusSummary, :blobId)`
        ).run(asSqlParams({
          id: snapshot.id,
          workspaceId: snapshot.workspaceId,
          capturedAt: snapshot.capturedAt,
          headSha: snapshot.headSha,
          branchName: snapshot.branchName,
          dirtyFileHashesJson: JSON.stringify(snapshot.dirtyFileHashes),
          gitStatusSummary: snapshot.gitStatusSummary,
          blobId: snapshot.blobId
        }));
      }

      const existingArtifactIds = (
        db.prepare(`SELECT id FROM artifacts WHERE prompt_event_id = ?`).all(bundle.prompt.id) as Array<{ id: string }>
      ).map((row) => row.id);
      if (existingArtifactIds.length > 0) {
        db.prepare(
          `DELETE FROM artifact_links
           WHERE from_artifact_id IN (${existingArtifactIds.map(() => "?").join(",")})
              OR to_artifact_id IN (${existingArtifactIds.map(() => "?").join(",")})`
        ).run(...existingArtifactIds, ...existingArtifactIds);
        db.prepare(`DELETE FROM artifacts WHERE prompt_event_id = ?`).run(bundle.prompt.id);
      }
      db.prepare(`DELETE FROM git_links WHERE prompt_event_id = ?`).run(bundle.prompt.id);

      db.prepare(
        `INSERT OR REPLACE INTO prompt_events
         (id, repo_id, execution_path, session_id, thread_id, parent_prompt_event_id, started_at, ended_at, boundary_reason, status, mode, prompt_text, prompt_summary, primary_artifact_id, baseline_snapshot_id, end_snapshot_id)
         VALUES (:id, :workspaceId, :executionPath, :sessionId, :threadId, :parentPromptEventId, :startedAt, :endedAt, :boundaryReason, :status, :mode, :promptText, :promptSummary, :primaryArtifactId, :baselineSnapshotId, :endSnapshotId)`
      ).run(asSqlParams(bundle.prompt));

      for (const artifact of bundle.artifacts) {
        db.prepare(
          `INSERT OR REPLACE INTO artifacts
           (id, prompt_event_id, type, role, summary, blob_id, file_stats_json, metadata_json)
           VALUES (:id, :promptEventId, :type, :role, :summary, :blobId, :fileStatsJson, :metadataJson)`
        ).run(asSqlParams(artifact));
      }

      for (const link of bundle.artifactLinks) {
        db.prepare(
          `INSERT OR REPLACE INTO artifact_links
           (id, from_artifact_id, to_artifact_id, relation_type)
           VALUES (:id, :fromArtifactId, :toArtifactId, :relationType)`
        ).run(asSqlParams(link));
      }

      for (const gitLink of bundle.gitLinks) {
        db.prepare(
          `INSERT OR REPLACE INTO git_links
           (id, prompt_event_id, commit_sha, patch_identity, survival_state, matched_at)
           VALUES (:id, :promptEventId, :commitSha, :patchIdentity, :survivalState, :matchedAt)`
        ).run(asSqlParams(gitLink));
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }

  createSnapshot(workspaceId: string, data: WorkspaceSnapshotData): WorkspaceSnapshot {
    const snapshotId = createId("snapshot");
    const blobId = this.writeBlob(workspaceId, JSON.stringify(data, null, 2));
    return {
      id: snapshotId,
      workspaceId,
      capturedAt: nowIso(),
      headSha: data.headSha,
      branchName: data.branchName,
      dirtyFileHashes: data.dirtyFileHashes,
      gitStatusSummary: data.gitStatusSummary,
      blobId
    };
  }

  writeBlob(workspaceId: string, content: string | Buffer): string {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const blobId = createHash("sha256").update(buffer).digest("hex");
    const filePath = join(this.workspaceDir(workspaceId), "objects", `${blobId}.br`);
    if (!existsSync(filePath)) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, brotliCompressSync(buffer));
    }
    return blobId;
  }

  readBlob(workspaceId: string, blobId: string): string {
    const filePath = join(this.workspaceDir(workspaceId), "objects", `${blobId}.br`);
    return brotliDecompressSync(readFileSync(filePath)).toString("utf8");
  }

  listPrompts(workspaceId: string, threadId?: string | null): PromptEventListItem[] {
    this.ensureWorkspaceSchema(workspaceId);
    const db = this.openWorkspace(workspaceId);
    const query = threadId
      ? `SELECT
           id,
           repo_id AS workspaceId,
           execution_path AS executionPath,
           session_id AS sessionId,
           thread_id AS threadId,
           parent_prompt_event_id AS parentPromptEventId,
           started_at AS startedAt,
           ended_at AS endedAt,
           boundary_reason AS boundaryReason,
           status,
           COALESCE(mode, 'default') AS mode,
           prompt_summary AS promptSummary,
           primary_artifact_id AS primaryArtifactId,
           baseline_snapshot_id AS baselineSnapshotId,
           end_snapshot_id AS endSnapshotId
         FROM prompt_events
         WHERE COALESCE(thread_id, session_id) = ?
         ORDER BY started_at DESC`
      : `SELECT
           id,
           repo_id AS workspaceId,
           execution_path AS executionPath,
           session_id AS sessionId,
           thread_id AS threadId,
           parent_prompt_event_id AS parentPromptEventId,
           started_at AS startedAt,
           ended_at AS endedAt,
           boundary_reason AS boundaryReason,
           status,
           COALESCE(mode, 'default') AS mode,
           prompt_summary AS promptSummary,
           primary_artifact_id AS primaryArtifactId,
           baseline_snapshot_id AS baselineSnapshotId,
           end_snapshot_id AS endSnapshotId
         FROM prompt_events
         ORDER BY started_at DESC`;
    const prompts = (threadId ? db.prepare(query).all(threadId) : db.prepare(query).all()) as unknown as LegacyPromptRow[];
    const artifactsByPrompt = this.getArtifactsByPrompt(db);
    const childCounts = new Map<string, number>();
    for (const prompt of prompts) {
      if (prompt.parentPromptEventId) {
        childCounts.set(prompt.parentPromptEventId, (childCounts.get(prompt.parentPromptEventId) ?? 0) + 1);
      }
    }
    const result = prompts.map((prompt) => {
      const artifacts = artifactsByPrompt.get(prompt.id) ?? [];
      const files = new Set<string>();
      const diffSummary = summarizeCodeDiffArtifacts(this, workspaceId, artifacts);
      const primaryArtifact =
        artifacts.find((artifact) => artifact.id === prompt.primaryArtifactId)
        ?? artifacts.find((artifact) => artifact.role === "primary")
        ?? null;
      for (const artifact of artifacts) {
        if (!artifact.fileStatsJson) {
          continue;
        }
        const parsed = safeJsonParse<Array<{ path: string }>>(artifact.fileStatsJson, []);
        for (const file of parsed) {
          files.add(file.path);
        }
      }
      return {
        ...prompt,
        artifactCount: artifacts.length,
        childCount: childCounts.get(prompt.id) ?? 0,
        filesTouched: [...files],
        filesTouchedCount: files.size,
        additions: diffSummary.additions,
        deletions: diffSummary.deletions,
        primaryArtifactType: primaryArtifact?.type ?? null,
        primaryArtifactSummary: primaryArtifact?.summary ?? null,
        hasCodeDiff: artifacts.some((artifact) => artifact.type === "code_diff"),
        hasPlanArtifact: artifacts.some((artifact) => artifact.type === "plan"),
        hasFinalResponse: artifacts.some((artifact) => artifact.type === "final_output"),
        isLiveDerived: prompt.status === "in_progress"
      } satisfies PromptEventListItem;
    });
    db.close();
    return result;
  }

  getPromptDetail(workspaceId: string, promptId: string): PromptEventDetail | null {
    this.ensureWorkspaceSchema(workspaceId);
    const db = this.openWorkspace(workspaceId);
    const prompt = db.prepare(
      `SELECT
         id,
         repo_id AS workspaceId,
         execution_path AS executionPath,
         session_id AS sessionId,
         thread_id AS threadId,
         parent_prompt_event_id AS parentPromptEventId,
         started_at AS startedAt,
         ended_at AS endedAt,
         boundary_reason AS boundaryReason,
         status,
         COALESCE(mode, 'default') AS mode,
         prompt_text AS promptText,
         prompt_summary AS promptSummary,
         primary_artifact_id AS primaryArtifactId,
         baseline_snapshot_id AS baselineSnapshotId,
         end_snapshot_id AS endSnapshotId
       FROM prompt_events
       WHERE id = ?`
    ).get(promptId) as LegacyPromptRow | undefined;
    if (!prompt) {
      db.close();
      return null;
    }
    const artifacts = db.prepare(
      `SELECT
         id,
         prompt_event_id AS promptEventId,
         type,
         role,
         summary,
         blob_id AS blobId,
         file_stats_json AS fileStatsJson,
         metadata_json AS metadataJson
       FROM artifacts
       WHERE prompt_event_id = ?
       ORDER BY rowid ASC`
    ).all(promptId) as unknown as ArtifactRecord[];
    const artifactIds = artifacts.map((artifact) => artifact.id);
    const artifactLinks = artifactIds.length > 0
      ? (db.prepare(
          `SELECT
             id,
             from_artifact_id AS fromArtifactId,
             to_artifact_id AS toArtifactId,
             relation_type AS relationType
           FROM artifact_links
           WHERE from_artifact_id IN (${artifactIds.map(() => "?").join(",")})
              OR to_artifact_id IN (${artifactIds.map(() => "?").join(",")})`
        ).all(...artifactIds, ...artifactIds) as unknown as ArtifactLinkRecord[])
      : [];
    const gitLinks = db.prepare(
      `SELECT
         id,
         prompt_event_id AS promptEventId,
         commit_sha AS commitSha,
         patch_identity AS patchIdentity,
         survival_state AS survivalState,
       matched_at AS matchedAt
       FROM git_links
       WHERE prompt_event_id = ?`
    ).all(promptId) as unknown as GitLinkRecord[];
    const transcript = this.getPromptTranscript(db, workspaceId, prompt);
    db.close();
    return { ...prompt, transcript, artifacts, artifactLinks, gitLinks, parsedCodeDiffs: [] };
  }

  upsertArtifact(workspaceId: string, artifact: ArtifactRecord): void {
    this.ensureWorkspaceSchema(workspaceId);
    const db = this.openWorkspace(workspaceId);
    try {
      db.prepare(
        `INSERT OR REPLACE INTO artifacts
         (id, prompt_event_id, type, role, summary, blob_id, file_stats_json, metadata_json)
         VALUES (:id, :promptEventId, :type, :role, :summary, :blobId, :fileStatsJson, :metadataJson)`
      ).run(asSqlParams(artifact));
    } finally {
      db.close();
    }
  }

  getFileHistory(workspaceId: string, filePath: string): PromptEventListItem[] {
    return this.listPrompts(workspaceId).filter((prompt) => prompt.filesTouched.includes(filePath));
  }

  getPlanTrace(
    workspaceId: string,
    artifactId: string
  ): { promptId: string; steps: string[]; linkedArtifactIds: string[] } | null {
    this.ensureWorkspaceSchema(workspaceId);
    const db = this.openWorkspace(workspaceId);
    const artifact = db.prepare(
      `SELECT
         id,
         prompt_event_id AS promptEventId,
         metadata_json AS metadataJson
       FROM artifacts
       WHERE id = ? AND type = 'plan'`
    ).get(artifactId) as { id: string; promptEventId: string; metadataJson: string | null } | undefined;
    if (!artifact) {
      db.close();
      return null;
    }
    const metadata = safeJsonParse<{ steps?: string[] }>(artifact.metadataJson, {});
    const links = db.prepare(
      `SELECT to_artifact_id AS toArtifactId
       FROM artifact_links
       WHERE from_artifact_id = ?`
    ).all(artifactId) as Array<{ toArtifactId: string }>;
    db.close();
    return {
      promptId: artifact.promptEventId,
      steps: metadata.steps ?? [],
      linkedArtifactIds: links.map((link) => link.toArtifactId)
    };
  }

  getIngestCursor(workspaceId: string, cursorKey: string): { cursorValue: string; updatedAt: string } | null {
    return getStoredIngestCursor(this.storageWorkspaceContext(), workspaceId, cursorKey);
  }

  setIngestCursor(workspaceId: string, cursorKey: string, cursorValue: string): void {
    setStoredIngestCursor(this.storageWorkspaceContext(), workspaceId, cursorKey, cursorValue);
  }

  getLegacyCloudSyncCursorForDevice(
    workspaceId: string,
    deviceId: string
  ): { cursorValue: string; updatedAt: string } | null {
    return getStoredLegacyCloudSyncCursorForDevice(this.storageWorkspaceContext(), workspaceId, deviceId);
  }

  getSyncRecordHashes(
    workspaceId: string,
    syncScope: string,
    recordType: string
  ): Map<string, string | null> {
    return getStoredSyncRecordHashes(this.storageWorkspaceContext(), workspaceId, syncScope, recordType);
  }

  getLegacySyncRecordHashesForDevice(
    workspaceId: string,
    deviceId: string,
    recordType: string
  ): Map<string, string | null> {
    return getStoredLegacySyncRecordHashesForDevice(this.storageWorkspaceContext(), workspaceId, deviceId, recordType);
  }

  upsertSyncRecords(
    workspaceId: string,
    syncScope: string,
    recordType: string,
    records: Array<{ recordId: string; recordHash?: string | null }>
  ): void {
    upsertStoredSyncRecords(this.storageWorkspaceContext(), workspaceId, syncScope, recordType, records);
  }

  getDaemonState(): { pid: number | null } {
    return getStoredDaemonState(this.homeDir);
  }

  setDaemonState(pid: number): void {
    setStoredDaemonState(this.homeDir, pid);
  }

  clearDaemonState(): void {
    clearStoredDaemonState(this.homeDir);
  }

  getCloudAuthState(): CloudAuthState | null {
    return getStoredCloudAuthState(this.homeDir);
  }

  setCloudAuthState(state: CloudAuthState): void {
    setStoredCloudAuthState(this.homeDir, state);
  }

  clearCloudAuthState(): void {
    clearStoredCloudAuthState(this.homeDir);
  }

  resetCloudAuth(deviceId: string | null): { revokedTokens: number; clearedLoginRequests: number } {
    return resetStoredCloudAuth(this.storageRegistryContext(), deviceId);
  }

  createCliLoginRequest(deviceId: string, deviceName: string | null, ttlMs = 10 * 60 * 1000): CliLoginRequestRow {
    return createStoredCliLoginRequest(this.storageRegistryContext(), deviceId, deviceName, ttlMs);
  }

  getCliLoginRequest(loginCode: string): CliLoginRequestRow | null {
    return getStoredCliLoginRequest(this.storageRegistryContext(), loginCode);
  }

  approveCliLoginRequest(input: {
    loginCode: string;
    clerkUserId: string;
    email: string | null;
    name: string | null;
    avatarUrl: string | null;
    deviceId: string;
    deviceName: string | null;
  }): { user: AuthUserProfile; device: AuthDevice; daemonToken: string } | null {
    return approveStoredCliLoginRequest(this.storageRegistryContext(), input);
  }

  exchangeCliLoginRequest(loginCode: string, deviceId: string): {
    status: "pending" | "approved" | "expired" | "not_found";
    daemonToken?: string;
    user?: AuthUserProfile;
    device?: AuthDevice;
  } {
    return exchangeStoredCliLoginRequest(this.storageRegistryContext(), loginCode, deviceId);
  }

  authenticateDaemonToken(daemonToken: string): { user: AuthUserProfile; device: AuthDevice } | null {
    return authenticateStoredDaemonToken(this.storageRegistryContext(), daemonToken);
  }

  getAuthUserByClerkUserId(clerkUserId: string): AuthUserProfile | null {
    return getStoredAuthUserByClerkUserId(this.storageRegistryContext(), clerkUserId);
  }

  getLatestAuthDeviceForUser(userId: string): AuthDevice | null {
    return getStoredLatestAuthDeviceForUser(this.storageRegistryContext(), userId);
  }

  upsertCloudWorkspaceBundle(
    userId: string,
    bundle: {
      workspace: WorkspaceListItem;
      threads: ThreadSummary[];
      prompts: PromptEventListItem[];
      promptDetails: PromptEventDetail[];
      blobs: Array<{ blobId: string; content: string }>;
    }
  ): { workspaceId: string; threadCount: number; promptCount: number; blobCount: number } {
    const db = this.openRegistry();
    const now = nowIso();
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO cloud_workspaces
         (user_id, workspace_id, last_activity_at, payload_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, workspace_id) DO UPDATE SET
           last_activity_at = excluded.last_activity_at,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`
      ).run(
        userId,
        bundle.workspace.id,
        bundle.workspace.lastActivityAt,
        JSON.stringify(bundle.workspace),
        now
      );

      for (const thread of bundle.threads) {
        db.prepare(
          `INSERT INTO cloud_threads
           (user_id, workspace_id, thread_id, last_activity_at, payload_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, workspace_id, thread_id) DO UPDATE SET
             last_activity_at = excluded.last_activity_at,
             payload_json = excluded.payload_json,
             updated_at = excluded.updated_at`
        ).run(
          userId,
          bundle.workspace.id,
          thread.id,
          thread.lastActivityAt,
          JSON.stringify(thread),
          now
        );
      }

      for (const prompt of bundle.prompts) {
        db.prepare(
          `INSERT INTO cloud_prompts
           (user_id, workspace_id, prompt_id, thread_lookup_key, started_at, payload_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, workspace_id, prompt_id) DO UPDATE SET
             thread_lookup_key = excluded.thread_lookup_key,
             started_at = excluded.started_at,
             payload_json = excluded.payload_json,
             updated_at = excluded.updated_at`
        ).run(
          userId,
          bundle.workspace.id,
          prompt.id,
          getThreadLookupKey(prompt),
          prompt.startedAt,
          JSON.stringify(prompt),
          now
        );
      }

      for (const detail of bundle.promptDetails) {
        db.prepare(
          `INSERT INTO cloud_prompt_details
           (user_id, workspace_id, prompt_id, payload_json, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, workspace_id, prompt_id) DO UPDATE SET
             payload_json = excluded.payload_json,
             updated_at = excluded.updated_at`
        ).run(
          userId,
          bundle.workspace.id,
          detail.id,
          JSON.stringify(detail),
          now
        );
      }

      for (const blob of bundle.blobs) {
        db.prepare(
          `INSERT INTO cloud_blobs
           (user_id, workspace_id, blob_id, content, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, workspace_id, blob_id) DO UPDATE SET
             content = excluded.content,
             updated_at = excluded.updated_at`
        ).run(userId, bundle.workspace.id, blob.blobId, blob.content, now);
      }

      db.exec("COMMIT");
      db.close();
      return {
        workspaceId: bundle.workspace.id,
        threadCount: bundle.threads.length,
        promptCount: bundle.prompts.length,
        blobCount: bundle.blobs.length,
      };
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }

  listCloudWorkspaces(userId: string): WorkspaceListItem[] {
    const db = this.openRegistry();
    const rows = db.prepare(
      `SELECT payload_json AS payloadJson
       FROM cloud_workspaces
       WHERE user_id = ?
       ORDER BY COALESCE(last_activity_at, '') DESC, workspace_id ASC`
    ).all(userId) as Array<{ payloadJson: string }>;
    db.close();
    return rows.map((row) => safeJsonParse<WorkspaceListItem | null>(row.payloadJson, null)).filter(Boolean) as WorkspaceListItem[];
  }

  listCloudThreads(userId: string, workspaceId: string): ThreadSummary[] {
    const db = this.openRegistry();
    const rows = db.prepare(
      `SELECT payload_json AS payloadJson
       FROM cloud_threads
       WHERE user_id = ? AND workspace_id = ?
       ORDER BY last_activity_at DESC, thread_id ASC`
    ).all(userId, workspaceId) as Array<{ payloadJson: string }>;
    db.close();
    return rows.map((row) => safeJsonParse<ThreadSummary | null>(row.payloadJson, null)).filter(Boolean) as ThreadSummary[];
  }

  listCloudPrompts(userId: string, workspaceId: string, threadLookupKey?: string | null): PromptEventListItem[] {
    const db = this.openRegistry();
    const rows = threadLookupKey
      ? db.prepare(
          `SELECT payload_json AS payloadJson
           FROM cloud_prompts
           WHERE user_id = ? AND workspace_id = ? AND thread_lookup_key = ?
           ORDER BY started_at DESC, prompt_id ASC`
        ).all(userId, workspaceId, threadLookupKey) as Array<{ payloadJson: string }>
      : db.prepare(
          `SELECT payload_json AS payloadJson
           FROM cloud_prompts
           WHERE user_id = ? AND workspace_id = ?
           ORDER BY started_at DESC, prompt_id ASC`
        ).all(userId, workspaceId) as Array<{ payloadJson: string }>;
    db.close();
    return rows.map((row) => safeJsonParse<PromptEventListItem | null>(row.payloadJson, null)).filter(Boolean) as PromptEventListItem[];
  }

  getCloudPromptDetail(userId: string, workspaceId: string, promptId: string): PromptEventDetail | null {
    const db = this.openRegistry();
    const row = db.prepare(
      `SELECT payload_json AS payloadJson
       FROM cloud_prompt_details
       WHERE user_id = ? AND workspace_id = ? AND prompt_id = ?`
    ).get(userId, workspaceId, promptId) as { payloadJson: string } | undefined;
    db.close();
    return safeJsonParse<PromptEventDetail | null>(row?.payloadJson, null);
  }

  readCloudBlob(userId: string, workspaceId: string, blobId: string): string {
    const db = this.openRegistry();
    const row = db.prepare(
      `SELECT content
       FROM cloud_blobs
       WHERE user_id = ? AND workspace_id = ? AND blob_id = ?`
    ).get(userId, workspaceId, blobId) as { content: string } | undefined;
    db.close();
    if (!row) {
      throw new Error(`Cloud blob not found: ${blobId}`);
    }
    return row.content;
  }

  workspaceDir(workspaceId: string): string {
    return join(this.homeDir, "repos", workspaceId);
  }

  repoDir(repoId: string): string {
    return this.workspaceDir(repoId);
  }

  workspaceDbPath(workspaceId: string): string {
    return join(this.workspaceDir(workspaceId), "repo.sqlite");
  }

  repoDbPath(repoId: string): string {
    return this.workspaceDbPath(repoId);
  }

  resolveWorkspacePathAlias(folderPath: string | null): string | null {
    const normalizedFolderPath = normalizeFolderPath(folderPath);
    if (!normalizedFolderPath) {
      return null;
    }
    const db = this.openRegistry();
    const row = db.prepare(
      `SELECT folder_path AS folderPath
       FROM workspace_path_aliases
       WHERE alias_path = ?`
    ).get(normalizedFolderPath) as { folderPath: string | null } | undefined;
    db.close();
    return row?.folderPath ?? null;
  }

  private ensureRegistrySchema(): void {
    const db = this.openRegistry();
    db.exec(`
      CREATE TABLE IF NOT EXISTS repo_registrations (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        root_path TEXT NOT NULL,
        git_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_groups (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        folder_path TEXT,
        git_root_path TEXT,
        git_dir TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_path_aliases (
        alias_path TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_users (
        id TEXT PRIMARY KEY,
        clerk_user_id TEXT NOT NULL UNIQUE,
        email TEXT,
        name TEXT,
        avatar_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(user_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS auth_daemon_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cli_login_requests (
        login_code TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        device_name TEXT,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        approved_at TEXT,
        completed_at TEXT,
        user_id TEXT,
        daemon_token TEXT
      );
      CREATE TABLE IF NOT EXISTS cloud_workspaces (
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        last_activity_at TEXT,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, workspace_id)
      );
      CREATE TABLE IF NOT EXISTS cloud_threads (
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, workspace_id, thread_id)
      );
      CREATE TABLE IF NOT EXISTS cloud_prompts (
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        prompt_id TEXT NOT NULL,
        thread_lookup_key TEXT NOT NULL,
        started_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, workspace_id, prompt_id)
      );
      CREATE TABLE IF NOT EXISTS cloud_prompt_details (
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        prompt_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, workspace_id, prompt_id)
      );
      CREATE TABLE IF NOT EXISTS cloud_blobs (
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        blob_id TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, workspace_id, blob_id)
      );
    `);
    db.close();
    this.backfillWorkspaceGroupsFromRepos();
  }

  private backfillWorkspaceGroupsFromRepos(): void {
    const db = this.openRegistry();
    const legacyRepos = db.prepare(
      `SELECT
         id,
         slug,
         root_path AS rootPath,
         git_dir AS gitDir,
         created_at AS createdAt,
         last_seen_at AS lastSeenAt,
         status
       FROM repo_registrations`
    ).all() as unknown as RepoRegistration[];
    for (const repo of legacyRepos) {
      db.prepare(
        `INSERT INTO workspace_groups
         (id, slug, folder_path, git_root_path, git_dir, created_at, last_seen_at, status, source)
         VALUES (:id, :slug, :folderPath, :gitRootPath, :gitDir, :createdAt, :lastSeenAt, :status, :source)
         ON CONFLICT(id) DO UPDATE SET
           git_root_path = COALESCE(workspace_groups.git_root_path, excluded.git_root_path),
           git_dir = COALESCE(workspace_groups.git_dir, excluded.git_dir),
           last_seen_at = CASE
             WHEN workspace_groups.last_seen_at > excluded.last_seen_at THEN workspace_groups.last_seen_at
             ELSE excluded.last_seen_at
           END,
           source = CASE
             WHEN workspace_groups.source = 'manual' THEN workspace_groups.source
             ELSE excluded.source
           END`
      ).run(asSqlParams({
        id: repo.id,
        slug: repo.slug,
        folderPath: normalizeFolderPath(repo.rootPath),
        gitRootPath: normalizeFolderPath(repo.rootPath),
        gitDir: normalizeFolderPath(repo.gitDir),
        createdAt: repo.createdAt,
        lastSeenAt: repo.lastSeenAt,
        status: repo.status,
        source: "manual"
      }));
      this.ensureWorkspaceLayout(repo.id);
      this.ensureWorkspaceSchema(repo.id);
    }
    db.close();
  }

  private ensureWorkspaceLayout(workspaceId: string): void {
    const base = this.workspaceDir(workspaceId);
    mkdirSync(join(base, "raw-events"), { recursive: true });
    mkdirSync(join(base, "objects"), { recursive: true });
    mkdirSync(join(base, "snapshots"), { recursive: true });
    mkdirSync(join(base, "cache"), { recursive: true });
  }

  private ensureWorkspaceSchema(workspaceId: string): void {
    const db = this.openWorkspace(workspaceId);
    db.exec(`
      CREATE TABLE IF NOT EXISTS raw_events (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT,
        thread_id TEXT,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_blob_id TEXT NOT NULL,
        ingest_path TEXT
      );
      CREATE TABLE IF NOT EXISTS workspace_snapshots (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        head_sha TEXT,
        branch_name TEXT,
        dirty_file_hashes_json TEXT NOT NULL,
        git_status_summary TEXT NOT NULL,
        blob_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS prompt_events (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        execution_path TEXT,
        session_id TEXT,
        thread_id TEXT,
        parent_prompt_event_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        boundary_reason TEXT,
        status TEXT NOT NULL,
        mode TEXT,
        prompt_text TEXT NOT NULL,
        prompt_summary TEXT NOT NULL,
        primary_artifact_id TEXT,
        baseline_snapshot_id TEXT,
        end_snapshot_id TEXT
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        prompt_event_id TEXT NOT NULL,
        type TEXT NOT NULL,
        role TEXT NOT NULL,
        summary TEXT NOT NULL,
        blob_id TEXT,
        file_stats_json TEXT,
        metadata_json TEXT
      );
      CREATE TABLE IF NOT EXISTS artifact_links (
        id TEXT PRIMARY KEY,
        from_artifact_id TEXT NOT NULL,
        to_artifact_id TEXT NOT NULL,
        relation_type TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS git_links (
        id TEXT PRIMARY KEY,
        prompt_event_id TEXT NOT NULL,
        commit_sha TEXT,
        patch_identity TEXT NOT NULL,
        survival_state TEXT NOT NULL,
        matched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ingestion_cursors (
        cursor_key TEXT PRIMARY KEY,
        cursor_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_records (
        sync_scope TEXT NOT NULL,
        record_type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        record_hash TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (sync_scope, record_type, record_id)
      );
    `);
    this.ensureColumn(db, "prompt_events", "execution_path", "TEXT");
    this.ensureColumn(db, "prompt_events", "mode", "TEXT");
    db.close();
  }

  private getPromptTranscript(
    db: DatabaseSync,
    workspaceId: string,
    prompt: LegacyPromptRow
  ): PromptTranscriptEntry[] {
    const rawRows = db.prepare(
      `SELECT
         occurred_at AS occurredAt,
         payload_blob_id AS payloadBlobId
       FROM raw_events
       WHERE repo_id = ?
         AND (
           (? IS NOT NULL AND thread_id = ?)
           OR (? IS NULL AND session_id = ?)
         )
         AND occurred_at >= ?
         AND (? IS NULL OR occurred_at <= ?)
       ORDER BY occurred_at ASC, rowid ASC`
    ).all(
      workspaceId,
      prompt.threadId,
      prompt.threadId,
      prompt.threadId,
      prompt.sessionId,
      prompt.startedAt,
      prompt.endedAt,
      prompt.endedAt
    ) as Array<{ occurredAt: string; payloadBlobId: string }>;

    const transcript: PromptTranscriptEntry[] = [];
    const activityEntries = new Map<string, PromptTranscriptActivity>();

    for (const row of rawRows) {
      try {
        const payload = JSON.parse(this.readBlob(workspaceId, row.payloadBlobId)) as {
          type?: unknown;
          method?: unknown;
          params?: Record<string, unknown>;
          payload?: Record<string, unknown>;
        };

        if (payload?.type === "event_msg") {
          const eventPayload = payload.payload;
          const messageType = eventPayload?.type;
          const messageText = typeof eventPayload?.message === "string" ? eventPayload.message.trim() : "";
          if (messageType === "user_message" && messageText) {
            if (
              prompt.boundaryReason === "next_user_prompt"
              && prompt.endedAt
              && row.occurredAt === prompt.endedAt
            ) {
              continue;
            }
            transcript.push({
              kind: "message",
              role: "user",
              occurredAt: row.occurredAt,
              phase: null,
              text: messageText,
            });
            continue;
          }
          if (messageType === "agent_message" && messageText) {
            transcript.push({
              kind: "message",
              role: "assistant",
              occurredAt: row.occurredAt,
              phase: typeof eventPayload?.phase === "string" ? eventPayload.phase : null,
              text: messageText,
            });
            continue;
          }

          const completedActivity = buildCompletedActivityEntry(row.occurredAt, eventPayload);
          if (completedActivity) {
            transcript.push(completedActivity);
          }
          continue;
        }

        if (payload?.type === "response_item") {
          const activity = upsertResponseItemActivity(activityEntries, transcript, row.occurredAt, payload.payload);
          if (activity) {
            activity.occurredAt = activity.occurredAt || row.occurredAt;
          }
          continue;
        }

        const appServerActivity = buildAppServerActivityEntry(row.occurredAt, payload);
        if (appServerActivity) {
          transcript.push(appServerActivity);
        }
      } catch {
        continue;
      }
    }

    return transcript;
  }

  private openRegistry(): DatabaseSync {
    return this.openDatabase(this.registryPath);
  }

  private openWorkspace(workspaceId: string): DatabaseSync {
    this.ensureWorkspaceLayout(workspaceId);
    return this.openDatabase(this.workspaceDbPath(workspaceId));
  }

  private getArtifactsByPrompt(db: DatabaseSync): Map<string, ArtifactRecord[]> {
    const rows = db.prepare(
      `SELECT
         id,
         prompt_event_id AS promptEventId,
         type,
         role,
         summary,
         blob_id AS blobId,
         file_stats_json AS fileStatsJson,
         metadata_json AS metadataJson
       FROM artifacts`
    ).all() as unknown as ArtifactRecord[];
    const result = new Map<string, ArtifactRecord[]>();
    for (const row of rows) {
      const bucket = result.get(row.promptEventId) ?? [];
      bucket.push(row);
      result.set(row.promptEventId, bucket);
    }
    return result;
  }

  private ensureColumn(
    db: DatabaseSync,
    tableName: string,
    columnName: string,
    columnDefinition: string
  ): void {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) {
      return;
    }
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }

  private upsertWorkspaceGroup(workspace: WorkspaceGroup): void {
    const db = this.openRegistry();
    db.prepare(
      `INSERT INTO workspace_groups
       (id, slug, folder_path, git_root_path, git_dir, created_at, last_seen_at, status, source)
       VALUES (:id, :slug, :folderPath, :gitRootPath, :gitDir, :createdAt, :lastSeenAt, :status, :source)
       ON CONFLICT(id) DO UPDATE SET
         slug = excluded.slug,
         folder_path = excluded.folder_path,
         git_root_path = COALESCE(excluded.git_root_path, workspace_groups.git_root_path),
         git_dir = COALESCE(excluded.git_dir, workspace_groups.git_dir),
         last_seen_at = excluded.last_seen_at,
         status = excluded.status,
         source = CASE
           WHEN workspace_groups.source = 'manual' THEN workspace_groups.source
           ELSE excluded.source
         END`
    ).run(asSqlParams(workspace));
    db.close();
  }

  private findWorkspaceByFolderPath(folderPath: string): WorkspaceGroup | null {
    const db = this.openRegistry();
    const row = db.prepare(
      `SELECT
         id,
         slug,
         folder_path AS folderPath,
         git_root_path AS gitRootPath,
         git_dir AS gitDir,
         created_at AS createdAt,
         last_seen_at AS lastSeenAt,
         status,
         source
       FROM workspace_groups
       WHERE folder_path = ?`
    ).get(folderPath) as WorkspaceGroup | undefined;
    db.close();
    return row ?? null;
  }

  private repairMovedWorkspaceForPath(
    normalizedFolderPath: string,
    options: WorkspaceCreateOptions
  ): WorkspaceGroup | null {
    const parentDir = dirname(normalizedFolderPath);
    const db = this.openRegistry();
    const candidates = db.prepare(
      `SELECT
         id,
         slug,
         folder_path AS folderPath,
         git_root_path AS gitRootPath,
         git_dir AS gitDir,
         created_at AS createdAt,
         last_seen_at AS lastSeenAt,
         status,
         source
       FROM workspace_groups
       WHERE source = 'manual'
         AND folder_path IS NOT NULL`
    ).all() as unknown as WorkspaceGroup[];
    db.close();

    const matchingCandidates = candidates.filter((candidate) => {
      if (!candidate.folderPath || candidate.folderPath === normalizedFolderPath) {
        return false;
      }
      if (existsSync(candidate.folderPath)) {
        return false;
      }
      if (dirname(candidate.folderPath) !== parentDir) {
        return false;
      }
      return existsSync(this.workspaceDbPath(candidate.id));
    });

    if (matchingCandidates.length !== 1) {
      return null;
    }

    const candidate = matchingCandidates[0]!;
    const updatedWorkspace: WorkspaceGroup = {
      ...candidate,
      slug: slugifyPath(normalizedFolderPath),
      folderPath: normalizedFolderPath,
      gitRootPath: options.gitRootPath ?? normalizeFolderPath(candidate.gitRootPath),
      gitDir: options.gitDir ?? normalizeFolderPath(candidate.gitDir),
      lastSeenAt: options.lastSeenAt ?? nowIso(),
      status: options.status ?? "active",
      source: "manual"
    };
    this.upsertWorkspaceGroup(updatedWorkspace);
    this.recordWorkspacePathAlias(candidate.id, candidate.folderPath, normalizedFolderPath);

    const repo = this.getRepo(candidate.id);
    if (repo) {
      const updatedRepo: RepoRegistration = {
        ...repo,
        slug: slugifyRepoPath(normalizedFolderPath),
        rootPath: normalizedFolderPath,
        gitDir: options.gitDir ?? join(normalizedFolderPath, ".git"),
        lastSeenAt: updatedWorkspace.lastSeenAt,
        status: updatedWorkspace.status
      };
      const repoDbDir = this.repoDir(repo.id);
      mkdirSync(dirname(repoDbDir), { recursive: true });
      if (!existsSync(repoDbDir) && existsSync(this.repoDir(candidate.id))) {
        renameSync(this.repoDir(candidate.id), repoDbDir);
      }
      const registry = this.openRegistry();
      registry.prepare(
        `INSERT INTO repo_registrations
         (id, slug, root_path, git_dir, created_at, last_seen_at, status)
         VALUES (:id, :slug, :rootPath, :gitDir, :createdAt, :lastSeenAt, :status)
         ON CONFLICT(id) DO UPDATE SET
           slug = excluded.slug,
           root_path = excluded.root_path,
           git_dir = excluded.git_dir,
           last_seen_at = excluded.last_seen_at,
           status = excluded.status`
      ).run(asSqlParams(updatedRepo));
      registry.close();
    }

    this.ensureWorkspaceLayout(candidate.id);
    this.ensureWorkspaceSchema(candidate.id);
    return this.getWorkspace(candidate.id);
  }

  private recordWorkspacePathAlias(workspaceId: string, aliasPath: string | null, folderPath: string): void {
    const normalizedAliasPath = normalizeFolderPath(aliasPath);
    if (!normalizedAliasPath || normalizedAliasPath === folderPath) {
      return;
    }
    const db = this.openRegistry();
    db.prepare(
      `INSERT INTO workspace_path_aliases
       (alias_path, workspace_id, folder_path, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(alias_path) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         folder_path = excluded.folder_path,
         updated_at = excluded.updated_at`
    ).run(normalizedAliasPath, workspaceId, folderPath, nowIso());
    db.close();
  }

  private resolveGitMetadata(folderPath: string): { gitRootPath: string | null; gitDir: string | null } {
    let current = folderPath;
    while (true) {
      const gitDir = join(current, ".git");
      if (isExistingDirectory(gitDir)) {
        return {
          gitRootPath: current,
          gitDir
        };
      }
      const parent = dirname(current);
      if (parent === current) {
        return {
          gitRootPath: null,
          gitDir: null
        };
      }
      current = parent;
    }
  }

  private openDatabase(pathValue: string): DatabaseSync {
    const db = new DatabaseSync(pathValue);
    db.exec("PRAGMA busy_timeout = 5000;");
    try {
      db.exec("PRAGMA journal_mode = WAL;");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as { code?: string }).code !== "ERR_SQLITE_ERROR") {
        throw error;
      }
    }
    return db;
  }
}

export function defaultPlHome(): string {
  return join(homedir(), ".pl");
}

export function safeJsonParse<T>(input: string | null | undefined, fallback: T): T {
  if (!input) {
    return fallback;
  }
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

function summarizeCodeDiffArtifacts(
  store: PromptreelStore,
  workspaceId: string,
  artifacts: ArtifactRecord[]
): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const artifact of artifacts) {
    if (artifact.type !== "code_diff" || !artifact.blobId) {
      continue;
    }

    const patch = store.readBlob(workspaceId, artifact.blobId);
    const summary = countDiffPatchLines(patch);
    additions += summary.additions;
    deletions += summary.deletions;
  }

  return { additions, deletions };
}

function countDiffPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }
    if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

function getThreadLookupKey(prompt: {
  id: string;
  threadId: string | null;
  sessionId: string | null;
}): string {
  return prompt.threadId ?? prompt.sessionId ?? `prompt:${prompt.id}`;
}

export function getFileMtimeMs(path: string): number | null {
  if (!existsSync(path)) {
    return null;
  }
  return statSync(path).mtimeMs;
}

export function isEligibleWindowsGitWorkspace(cwd: string | null): boolean {
  return toEligibleWorkspacePath(cwd) !== null;
}

export function toEligibleWorkspacePath(cwd: string | null): string | null {
  if (!cwd) {
    return null;
  }
  const trimmed = cwd.trim();
  if (!trimmed || isNetworkLikePath(trimmed) || !/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return null;
  }

  const normalizedPath = normalize(resolve(trimmed));
  if (!isExistingDirectory(normalizedPath)) {
    return null;
  }

  const gitDir = join(normalizedPath, ".git");
  return isExistingDirectory(gitDir) ? normalizedPath : null;
}

function normalizeFolderPath(folderPath: string | null): string | null {
  if (!folderPath) {
    return null;
  }
  return normalize(resolve(folderPath));
}

function isExistingDirectory(pathValue: string): boolean {
  try {
    return statSync(pathValue).isDirectory();
  } catch {
    return false;
  }
}

function isNetworkLikePath(pathValue: string): boolean {
  return pathValue.startsWith("\\\\");
}

function isVisibleWorkspaceGroup(workspace: WorkspaceGroup): boolean {
  const eligibleFolderPath = toEligibleWorkspacePath(workspace.folderPath);
  return eligibleFolderPath !== null && workspace.status === "active";
}

function asSqlParams(value: object): Record<string, SQLInputValue> {
  return value as Record<string, SQLInputValue>;
}
