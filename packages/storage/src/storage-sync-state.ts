import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "@promptreel/domain";

interface WorkspaceStorageContext {
  homeDir: string;
  ensureWorkspaceSchema(workspaceId: string): void;
  openWorkspace(workspaceId: string): DatabaseSync;
}

type DaemonState = { pid: number | null };

export function getIngestCursor(
  context: WorkspaceStorageContext,
  workspaceId: string,
  cursorKey: string
): { cursorValue: string; updatedAt: string } | null {
  context.ensureWorkspaceSchema(workspaceId);
  const db = context.openWorkspace(workspaceId);
  const row = db.prepare(
    `SELECT cursor_value AS cursorValue, updated_at AS updatedAt
     FROM ingestion_cursors
     WHERE cursor_key = ?`
  ).get(cursorKey) as { cursorValue: string; updatedAt: string } | undefined;
  db.close();
  return row ?? null;
}

export function setIngestCursor(
  context: WorkspaceStorageContext,
  workspaceId: string,
  cursorKey: string,
  cursorValue: string
): void {
  context.ensureWorkspaceSchema(workspaceId);
  const db = context.openWorkspace(workspaceId);
  db.prepare(
    `INSERT INTO ingestion_cursors (cursor_key, cursor_value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(cursor_key) DO UPDATE SET
       cursor_value = excluded.cursor_value,
       updated_at = excluded.updated_at`
  ).run(cursorKey, cursorValue, nowIso());
  db.close();
}

export function getLegacyCloudSyncCursorForDevice(
  context: WorkspaceStorageContext,
  workspaceId: string,
  deviceId: string
): { cursorValue: string; updatedAt: string } | null {
  context.ensureWorkspaceSchema(workspaceId);
  const db = context.openWorkspace(workspaceId);
  const row = db.prepare(
    `SELECT cursor_value AS cursorValue, updated_at AS updatedAt
     FROM ingestion_cursors
     WHERE cursor_key LIKE ?
     ORDER BY updated_at DESC
     LIMIT 1`
  ).get(`cloud-sync:%|${deviceId}:state`) as { cursorValue: string; updatedAt: string } | undefined;
  db.close();
  return row ?? null;
}

export function getSyncRecordHashes(
  context: WorkspaceStorageContext,
  workspaceId: string,
  syncScope: string,
  recordType: string
): Map<string, string | null> {
  context.ensureWorkspaceSchema(workspaceId);
  const db = context.openWorkspace(workspaceId);
  const rows = db.prepare(
    `SELECT record_id AS recordId, record_hash AS recordHash
     FROM sync_records
     WHERE sync_scope = ? AND record_type = ?`
  ).all(syncScope, recordType) as Array<{ recordId: string; recordHash: string | null }>;
  db.close();
  return new Map(rows.map((row) => [row.recordId, row.recordHash ?? null]));
}

export function getLegacySyncRecordHashesForDevice(
  context: WorkspaceStorageContext,
  workspaceId: string,
  deviceId: string,
  recordType: string
): Map<string, string | null> {
  context.ensureWorkspaceSchema(workspaceId);
  const db = context.openWorkspace(workspaceId);
  const rows = db.prepare(
    `SELECT record_id AS recordId, record_hash AS recordHash, updated_at AS updatedAt
     FROM sync_records
     WHERE record_type = ?
       AND sync_scope LIKE ?
     ORDER BY updated_at DESC`
  ).all(recordType, `%|${deviceId}`) as Array<{
    recordId: string;
    recordHash: string | null;
    updatedAt: string;
  }>;
  db.close();
  const latest = new Map<string, string | null>();
  for (const row of rows) {
    if (latest.has(row.recordId)) {
      continue;
    }
    latest.set(row.recordId, row.recordHash ?? null);
  }
  return latest;
}

export function upsertSyncRecords(
  context: WorkspaceStorageContext,
  workspaceId: string,
  syncScope: string,
  recordType: string,
  records: Array<{ recordId: string; recordHash?: string | null }>
): void {
  if (records.length === 0) {
    return;
  }
  context.ensureWorkspaceSchema(workspaceId);
  const db = context.openWorkspace(workspaceId);
  const now = nowIso();
  const statement = db.prepare(
    `INSERT INTO sync_records (sync_scope, record_type, record_id, record_hash, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sync_scope, record_type, record_id) DO UPDATE SET
       record_hash = excluded.record_hash,
       updated_at = excluded.updated_at`
  );
  db.exec("BEGIN");
  try {
    for (const record of records) {
      statement.run(syncScope, recordType, record.recordId, record.recordHash ?? null, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function readDaemonState(homeDir: string): DaemonState {
  const file = join(homeDir, "daemon", "daemon.json");
  if (!existsSync(file)) {
    return { pid: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DaemonState>;
    return { pid: typeof parsed.pid === "number" ? parsed.pid : null };
  } catch {
    return { pid: null };
  }
}

export function getDaemonState(homeDir: string): DaemonState {
  return readDaemonState(homeDir);
}

export function setDaemonState(homeDir: string, pid: number): void {
  writeFileSync(join(homeDir, "daemon", "daemon.json"), JSON.stringify({ pid, updatedAt: nowIso() }, null, 2));
}

export function clearDaemonState(homeDir: string): void {
  writeFileSync(join(homeDir, "daemon", "daemon.json"), JSON.stringify({ pid: null, updatedAt: nowIso() }, null, 2));
}
