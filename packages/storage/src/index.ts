import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  ArtifactLinkRecord,
  ArtifactRecord,
  GitLinkRecord,
  PromptEventDetail,
  PromptEventListItem,
  PromptEventRecord,
  RawEventRecord,
  RepoRegistration,
  ThreadSummary,
  WorkspaceGroup,
  WorkspaceSnapshot,
  WorkspaceSnapshotData
} from "@promptline/domain";
import {
  createId,
  nowIso,
  repoRegistrationId,
  slugifyPath,
  slugifyRepoPath,
  threadSummaryId,
  workspaceGroupId
} from "@promptline/domain";

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
  promptText: string;
  promptSummary: string;
  primaryArtifactId: string | null;
  baselineSnapshotId: string | null;
  endSnapshotId: string | null;
};

export class PromptlineStore {
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

  addRepo(rootPath: string): RepoRegistration {
    const git = this.resolveGitMetadata(resolve(rootPath));
    if (!git.gitRootPath || !git.gitDir) {
      throw new Error(`No .git directory found for ${rootPath}`);
    }

    const now = nowIso();
    const repo: RepoRegistration = {
      id: repoRegistrationId(git.gitRootPath),
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
    const inferredGit = normalizedFolderPath
      ? this.resolveGitMetadata(normalizedFolderPath)
      : { gitRootPath: null, gitDir: null };
    const now = options.lastSeenAt ?? nowIso();
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
      for (const raw of bundle.rawEvents) {
        const payloadBlobId = this.writeBlob(workspaceId, JSON.stringify(raw.payload, null, 2));
        db.prepare(
          `INSERT OR REPLACE INTO raw_events
           (id, repo_id, source, session_id, thread_id, event_type, occurred_at, payload_blob_id, ingest_path)
           VALUES (:id, :workspaceId, :source, :sessionId, :threadId, :eventType, :occurredAt, :payloadBlobId, :ingestPath)`
        ).run(asSqlParams({ ...raw.record, payloadBlobId }));
        this.appendRawEventLog(workspaceId, { ...raw.record, payloadBlobId });
      }

      for (const snapshot of bundle.snapshots) {
        db.prepare(
          `INSERT OR REPLACE INTO workspace_snapshots
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
         (id, repo_id, execution_path, session_id, thread_id, parent_prompt_event_id, started_at, ended_at, boundary_reason, status, prompt_text, prompt_summary, primary_artifact_id, baseline_snapshot_id, end_snapshot_id)
         VALUES (:id, :workspaceId, :executionPath, :sessionId, :threadId, :parentPromptEventId, :startedAt, :endedAt, :boundaryReason, :status, :promptText, :promptSummary, :primaryArtifactId, :baselineSnapshotId, :endSnapshotId)`
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
        primaryArtifactType: primaryArtifact?.type ?? null,
        primaryArtifactSummary: primaryArtifact?.summary ?? null,
        hasCodeDiff: artifacts.some((artifact) => artifact.type === "code_diff"),
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
    db.close();
    return { ...prompt, artifacts, artifactLinks, gitLinks };
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
    this.ensureWorkspaceSchema(workspaceId);
    const db = this.openWorkspace(workspaceId);
    const row = db.prepare(
      `SELECT cursor_value AS cursorValue, updated_at AS updatedAt
       FROM ingestion_cursors
       WHERE cursor_key = ?`
    ).get(cursorKey) as { cursorValue: string; updatedAt: string } | undefined;
    db.close();
    return row ?? null;
  }

  setIngestCursor(workspaceId: string, cursorKey: string, cursorValue: string): void {
    this.ensureWorkspaceSchema(workspaceId);
    const db = this.openWorkspace(workspaceId);
    db.prepare(
      `INSERT INTO ingestion_cursors (cursor_key, cursor_value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(cursor_key) DO UPDATE SET
         cursor_value = excluded.cursor_value,
         updated_at = excluded.updated_at`
    ).run(cursorKey, cursorValue, nowIso());
    db.close();
  }

  getDaemonState(): { pid: number | null } {
    const file = join(this.homeDir, "daemon", "daemon.json");
    if (!existsSync(file)) {
      return { pid: null };
    }
    return safeJsonParse(readFileSync(file, "utf8"), { pid: null });
  }

  setDaemonState(pid: number): void {
    writeFileSync(join(this.homeDir, "daemon", "daemon.json"), JSON.stringify({ pid, updatedAt: nowIso() }, null, 2));
  }

  clearDaemonState(): void {
    writeFileSync(join(this.homeDir, "daemon", "daemon.json"), JSON.stringify({ pid: null, updatedAt: nowIso() }, null, 2));
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
    `);
    this.ensureColumn(db, "prompt_events", "execution_path", "TEXT");
    db.close();
  }

  private openRegistry(): DatabaseSync {
    return this.openDatabase(this.registryPath);
  }

  private openWorkspace(workspaceId: string): DatabaseSync {
    this.ensureWorkspaceLayout(workspaceId);
    return this.openDatabase(this.workspaceDbPath(workspaceId));
  }

  private appendRawEventLog(workspaceId: string, event: RawEventRecord): void {
    const filePath = join(this.workspaceDir(workspaceId), "raw-events", "events.jsonl");
    appendFileSync(filePath, `${JSON.stringify(event)}\n`);
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
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
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
