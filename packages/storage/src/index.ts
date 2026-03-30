import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  appendFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  WorkspaceSnapshot,
  WorkspaceSnapshotData
} from "@promptline/domain";
import {
  createId,
  nowIso,
  repoRegistrationId,
  slugifyRepoPath
} from "@promptline/domain";

export interface PersistPromptBundle {
  prompt: PromptEventRecord;
  snapshots: WorkspaceSnapshot[];
  artifacts: ArtifactRecord[];
  artifactLinks: ArtifactLinkRecord[];
  gitLinks: GitLinkRecord[];
  rawEvents: Array<{ record: RawEventRecord; payload: unknown }>;
}

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
    const resolved = resolve(rootPath);
    const gitDir = this.resolveGitDir(resolved);
    const now = nowIso();
    const repo: RepoRegistration = {
      id: repoRegistrationId(resolved),
      slug: slugifyRepoPath(resolved),
      rootPath: resolved,
      gitDir,
      createdAt: now,
      lastSeenAt: now,
      status: "active"
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
    this.ensureRepoLayout(repo.id);
    this.ensureRepoSchema(repo.id);
    return repo;
  }

  listRepos(): RepoRegistration[] {
    const db = this.openRegistry();
    const rows = db
      .prepare(
        `SELECT
           id,
           slug,
           root_path AS rootPath,
           git_dir AS gitDir,
           created_at AS createdAt,
           last_seen_at AS lastSeenAt,
           status
         FROM repo_registrations
         ORDER BY last_seen_at DESC`
      )
      .all() as unknown as RepoRegistration[];
    db.close();
    return rows;
  }

  getRepo(repoId: string): RepoRegistration | null {
    const db = this.openRegistry();
    const row = db
      .prepare(
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
      )
      .get(repoId) as RepoRegistration | undefined;
    db.close();
    return row ?? null;
  }

  persistPromptBundle(repoId: string, bundle: PersistPromptBundle): void {
    const db = this.openRepo(repoId);
    db.exec("BEGIN");
    try {
      for (const raw of bundle.rawEvents) {
        const payloadBlobId = this.writeBlob(repoId, JSON.stringify(raw.payload, null, 2));
        db.prepare(
          `INSERT OR REPLACE INTO raw_events
           (id, repo_id, source, session_id, thread_id, event_type, occurred_at, payload_blob_id, ingest_path)
           VALUES (:id, :repoId, :source, :sessionId, :threadId, :eventType, :occurredAt, :payloadBlobId, :ingestPath)`
        ).run(asSqlParams({ ...raw.record, payloadBlobId }));
        this.appendRawEventLog(repoId, { ...raw.record, payloadBlobId });
      }

      for (const snapshot of bundle.snapshots) {
        db.prepare(
          `INSERT OR REPLACE INTO workspace_snapshots
           (id, repo_id, captured_at, head_sha, branch_name, dirty_file_hashes_json, git_status_summary, blob_id)
           VALUES (:id, :repoId, :capturedAt, :headSha, :branchName, :dirtyFileHashesJson, :gitStatusSummary, :blobId)`
        ).run(asSqlParams({
          id: snapshot.id,
          repoId: snapshot.repoId,
          capturedAt: snapshot.capturedAt,
          headSha: snapshot.headSha,
          branchName: snapshot.branchName,
          dirtyFileHashesJson: JSON.stringify(snapshot.dirtyFileHashes),
          gitStatusSummary: snapshot.gitStatusSummary,
          blobId: snapshot.blobId
        }));
      }

      const existingArtifactIds = (
        db
          .prepare(`SELECT id FROM artifacts WHERE prompt_event_id = ?`)
          .all(bundle.prompt.id) as Array<{ id: string }>
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
         (id, repo_id, session_id, thread_id, parent_prompt_event_id, started_at, ended_at, boundary_reason, status, prompt_text, prompt_summary, primary_artifact_id, baseline_snapshot_id, end_snapshot_id)
         VALUES (:id, :repoId, :sessionId, :threadId, :parentPromptEventId, :startedAt, :endedAt, :boundaryReason, :status, :promptText, :promptSummary, :primaryArtifactId, :baselineSnapshotId, :endSnapshotId)`
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

  createSnapshot(repoId: string, data: WorkspaceSnapshotData): WorkspaceSnapshot {
    const snapshotId = createId("snapshot");
    const blobId = this.writeBlob(repoId, JSON.stringify(data, null, 2));
    return {
      id: snapshotId,
      repoId,
      capturedAt: nowIso(),
      headSha: data.headSha,
      branchName: data.branchName,
      dirtyFileHashes: data.dirtyFileHashes,
      gitStatusSummary: data.gitStatusSummary,
      blobId
    };
  }

  writeBlob(repoId: string, content: string | Buffer): string {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const blobId = createHash("sha256").update(buffer).digest("hex");
    const filePath = join(this.repoDir(repoId), "objects", `${blobId}.br`);
    if (!existsSync(filePath)) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, brotliCompressSync(buffer));
    }
    return blobId;
  }

  readBlob(repoId: string, blobId: string): string {
    const filePath = join(this.repoDir(repoId), "objects", `${blobId}.br`);
    return brotliDecompressSync(readFileSync(filePath)).toString("utf8");
  }

  listPrompts(repoId: string): PromptEventListItem[] {
    const db = this.openRepo(repoId);
    const prompts = db
      .prepare(
        `SELECT
           id,
           repo_id AS repoId,
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
         ORDER BY started_at DESC`
      )
      .all() as unknown as PromptEventRecord[];
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
      };
    });
    db.close();
    return result;
  }

  getPromptDetail(repoId: string, promptId: string): PromptEventDetail | null {
    const db = this.openRepo(repoId);
    const prompt = db
      .prepare(
        `SELECT
           id,
           repo_id AS repoId,
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
      )
      .get(promptId) as PromptEventRecord | undefined;
    if (!prompt) {
      db.close();
      return null;
    }
    const artifacts = db
      .prepare(
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
      )
      .all(promptId) as unknown as ArtifactRecord[];
    const artifactIds = artifacts.map((artifact) => artifact.id);
    const artifactLinks = artifactIds.length
      ? (db
          .prepare(
            `SELECT
               id,
               from_artifact_id AS fromArtifactId,
               to_artifact_id AS toArtifactId,
               relation_type AS relationType
             FROM artifact_links
             WHERE from_artifact_id IN (${artifactIds.map(() => "?").join(",")})
                OR to_artifact_id IN (${artifactIds.map(() => "?").join(",")})`
          )
          .all(...artifactIds, ...artifactIds) as unknown as ArtifactLinkRecord[])
      : [];
    const gitLinks = db
      .prepare(
        `SELECT
           id,
           prompt_event_id AS promptEventId,
           commit_sha AS commitSha,
           patch_identity AS patchIdentity,
           survival_state AS survivalState,
           matched_at AS matchedAt
         FROM git_links
         WHERE prompt_event_id = ?`
      )
      .all(promptId) as unknown as GitLinkRecord[];
    db.close();
    return { ...prompt, artifacts, artifactLinks, gitLinks };
  }

  getFileHistory(repoId: string, filePath: string): PromptEventListItem[] {
    return this.listPrompts(repoId).filter((prompt) => prompt.filesTouched.includes(filePath));
  }

  getPlanTrace(repoId: string, artifactId: string): { promptId: string; steps: string[]; linkedArtifactIds: string[] } | null {
    const db = this.openRepo(repoId);
    const artifact = db
      .prepare(
        `SELECT
           id,
           prompt_event_id AS promptEventId,
           metadata_json AS metadataJson
         FROM artifacts
         WHERE id = ? AND type = 'plan'`
      )
      .get(artifactId) as { id: string; promptEventId: string; metadataJson: string | null } | undefined;
    if (!artifact) {
      db.close();
      return null;
    }
    const metadata = safeJsonParse<{ steps?: string[] }>(artifact.metadataJson, {});
    const links = db
      .prepare(
        `SELECT to_artifact_id AS toArtifactId
         FROM artifact_links
         WHERE from_artifact_id = ?`
      )
      .all(artifactId) as Array<{ toArtifactId: string }>;
    db.close();
    return {
      promptId: artifact.promptEventId,
      steps: metadata.steps ?? [],
      linkedArtifactIds: links.map((link) => link.toArtifactId)
    };
  }

  getIngestCursor(repoId: string, cursorKey: string): { cursorValue: string; updatedAt: string } | null {
    const db = this.openRepo(repoId);
    const row = db
      .prepare(`SELECT cursor_value AS cursorValue, updated_at AS updatedAt FROM ingestion_cursors WHERE cursor_key = ?`)
      .get(cursorKey) as { cursorValue: string; updatedAt: string } | undefined;
    db.close();
    return row ?? null;
  }

  setIngestCursor(repoId: string, cursorKey: string, cursorValue: string): void {
    const db = this.openRepo(repoId);
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

  repoDir(repoId: string): string {
    return join(this.homeDir, "repos", repoId);
  }

  repoDbPath(repoId: string): string {
    return join(this.repoDir(repoId), "repo.sqlite");
  }

  private resolveGitDir(rootPath: string): string {
    const gitPath = join(rootPath, ".git");
    if (!existsSync(gitPath)) {
      throw new Error(`No .git directory found at ${rootPath}`);
    }
    return gitPath;
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
    `);
    db.close();
  }

  private ensureRepoLayout(repoId: string): void {
    const base = this.repoDir(repoId);
    mkdirSync(join(base, "raw-events"), { recursive: true });
    mkdirSync(join(base, "objects"), { recursive: true });
    mkdirSync(join(base, "snapshots"), { recursive: true });
    mkdirSync(join(base, "cache"), { recursive: true });
  }

  private ensureRepoSchema(repoId: string): void {
    const db = this.openRepo(repoId);
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
    db.close();
  }

  private openRegistry(): DatabaseSync {
    return new DatabaseSync(this.registryPath);
  }

  private openRepo(repoId: string): DatabaseSync {
    this.ensureRepoLayout(repoId);
    return new DatabaseSync(this.repoDbPath(repoId));
  }

  private appendRawEventLog(repoId: string, event: RawEventRecord): void {
    const filePath = join(this.repoDir(repoId), "raw-events", "events.jsonl");
    appendFileSync(filePath, `${JSON.stringify(event)}\n`);
  }

  private getArtifactsByPrompt(db: DatabaseSync): Map<string, ArtifactRecord[]> {
    const rows = db
      .prepare(
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
      )
      .all() as unknown as ArtifactRecord[];
    const result = new Map<string, ArtifactRecord[]>();
    for (const row of rows) {
      const bucket = result.get(row.promptEventId) ?? [];
      bucket.push(row);
      result.set(row.promptEventId, bucket);
    }
    return result;
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

function asSqlParams(value: object): Record<string, SQLInputValue> {
  return value as Record<string, SQLInputValue>;
}
