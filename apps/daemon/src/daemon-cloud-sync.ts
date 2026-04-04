import {
  buildCloudSyncCursorKey,
  buildCloudSyncScope,
  getPromptSyncFingerprint,
  trimTrailingSlash,
} from "@promptreel/api-contracts";
import type {
  CloudBootstrapSyncRequest,
  CloudBootstrapSyncResponse,
} from "@promptreel/api-contracts";
import { CodexSessionTailer, LIVE_ACTIVITY_WINDOW_MS } from "@promptreel/codex-adapter";
import { nowIso, type WorkspaceListItem } from "@promptreel/domain";
import { PromptreelStore } from "@promptreel/storage";

const CLOUD_SYNC_ACTIVE_INTERVAL_MS = 1_500;
const CLOUD_SYNC_IDLE_INTERVAL_MS = 8_000;
const CLOUD_SYNC_ERROR_INTERVAL_MS = 4_000;
const CLOUD_SYNC_PROMPT_RECORD_TYPE = "cloud_prompt";
const CLOUD_SYNC_BLOB_RECORD_TYPE = "cloud_blob";

export const CLOUD_DAEMON_ACTIVE_WINDOW_MS = 20_000;
export const CLOUD_DAEMON_CONNECTED_WINDOW_MS = 120_000;
export const CLOUD_SYNC_ENABLED = process.env.PROMPTREEL_ENABLE_CLOUD_SYNC === "1";

export interface DaemonRuntimeStatus {
  lastCloudSyncAt: string | null;
  lastCloudSyncError: string | null;
  syncInFlight: boolean;
  lastCloudSyncStats: null | {
    workspaceCount: number;
    promptCount: number;
    blobCount: number;
  };
}

export function hasRecentWorkspaceActivity(
  status: {
    recentlyUpdatedSessionCount?: number;
    lastSessionUpdateAt?: string | null;
  } | null | undefined
): boolean {
  if (!status) {
    return false;
  }
  if ((status.recentlyUpdatedSessionCount ?? 0) > 0) {
    return true;
  }
  if (!status.lastSessionUpdateAt) {
    return false;
  }
  return Date.now() - Date.parse(status.lastSessionUpdateAt) <= LIVE_ACTIVITY_WINDOW_MS;
}

export function buildWorkspaceListItem(
  store: PromptreelStore,
  tailer: CodexSessionTailer,
  workspaceId: string
): WorkspaceListItem | null {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) {
    return null;
  }
  const status = tailer.getStatus().workspaceStatuses.find((item) => item.workspaceId === workspaceId);
  const threads = store.listThreads(workspace.id);
  return {
    ...workspace,
    threadCount: threads.length,
    openThreadCount: threads.filter((thread) => thread.status === "open").length,
    isGenerating: Boolean(
      (status?.recentlyUpdatedSessionCount ?? 0) > 0
      || (status?.lastSessionUpdateAt
        && Date.now() - Date.parse(status.lastSessionUpdateAt) <= LIVE_ACTIVITY_WINDOW_MS)
    ),
    lastActivityAt: threads[0]?.lastActivityAt ?? null,
    sessionFileCount: status?.sessionFileCount ?? 0,
    recentlyUpdatedSessionCount: status?.recentlyUpdatedSessionCount ?? 0,
    mode: status?.mode ?? "idle",
  };
}

function getCloudSyncCursor(
  store: PromptreelStore,
  workspaceId: string,
  syncScope: string
): { lastSyncedAt: string | null } {
  const row = store.getIngestCursor(workspaceId, buildCloudSyncCursorKey(syncScope));
  if (!row) {
    return { lastSyncedAt: null };
  }
  return JSON.parse(row.cursorValue) as { lastSyncedAt: string | null };
}

function setCloudSyncCursor(
  store: PromptreelStore,
  workspaceId: string,
  syncScope: string,
  cursor: { lastSyncedAt: string | null }
): void {
  store.setIngestCursor(workspaceId, buildCloudSyncCursorKey(syncScope), JSON.stringify(cursor));
}

function buildCloudDeltaBundle(
  store: PromptreelStore,
  tailer: CodexSessionTailer,
  workspaceId: string,
  syncScope: string,
  legacyDeviceId: string | null = null
): {
  bundle: CloudBootstrapSyncRequest;
  promptSyncRecords: Array<{ recordId: string; recordHash: string }>;
  blobSyncRecords: Array<{ recordId: string; recordHash: string }>;
} | null {
  const workspace = buildWorkspaceListItem(store, tailer, workspaceId);
  if (!workspace) {
    return null;
  }

  const prompts = store.listPrompts(workspaceId);
  if (prompts.length === 0) {
    return null;
  }

  const cursor = getCloudSyncCursor(store, workspaceId, syncScope);
  let syncedPromptHashes = store.getSyncRecordHashes(workspaceId, syncScope, CLOUD_SYNC_PROMPT_RECORD_TYPE);
  let syncedBlobHashes = store.getSyncRecordHashes(workspaceId, syncScope, CLOUD_SYNC_BLOB_RECORD_TYPE);
  let lastSyncedAt = cursor.lastSyncedAt;

  if (legacyDeviceId && (syncedPromptHashes.size === 0 || syncedBlobHashes.size === 0 || !lastSyncedAt)) {
    const legacyPromptHashes = store.getLegacySyncRecordHashesForDevice(
      workspaceId,
      legacyDeviceId,
      CLOUD_SYNC_PROMPT_RECORD_TYPE
    );
    const legacyBlobHashes = store.getLegacySyncRecordHashesForDevice(
      workspaceId,
      legacyDeviceId,
      CLOUD_SYNC_BLOB_RECORD_TYPE
    );
    const legacyCursor = store.getLegacyCloudSyncCursorForDevice(workspaceId, legacyDeviceId);

    if (syncedPromptHashes.size === 0 && legacyPromptHashes.size > 0) {
      store.upsertSyncRecords(
        workspaceId,
        syncScope,
        CLOUD_SYNC_PROMPT_RECORD_TYPE,
        [...legacyPromptHashes.entries()].map(([recordId, recordHash]) => ({ recordId, recordHash }))
      );
      syncedPromptHashes = store.getSyncRecordHashes(workspaceId, syncScope, CLOUD_SYNC_PROMPT_RECORD_TYPE);
    }

    if (syncedBlobHashes.size === 0 && legacyBlobHashes.size > 0) {
      store.upsertSyncRecords(
        workspaceId,
        syncScope,
        CLOUD_SYNC_BLOB_RECORD_TYPE,
        [...legacyBlobHashes.entries()].map(([recordId, recordHash]) => ({ recordId, recordHash }))
      );
      syncedBlobHashes = store.getSyncRecordHashes(workspaceId, syncScope, CLOUD_SYNC_BLOB_RECORD_TYPE);
    }

    if (!lastSyncedAt && legacyCursor) {
      store.setIngestCursor(workspaceId, buildCloudSyncCursorKey(syncScope), legacyCursor.cursorValue);
      lastSyncedAt = (JSON.parse(legacyCursor.cursorValue) as { lastSyncedAt: string | null }).lastSyncedAt;
    }
  }
  const changedPromptDetails: NonNullable<ReturnType<PromptreelStore["getPromptDetail"]>>[] = [];
  const promptSyncRecords: Array<{ recordId: string; recordHash: string }> = [];

  for (const prompt of prompts) {
    const shouldConsider =
      !syncedPromptHashes.has(prompt.id)
      || prompt.status === "in_progress"
      || Boolean(lastSyncedAt && prompt.endedAt && prompt.endedAt > lastSyncedAt);

    if (!shouldConsider) {
      continue;
    }

    const detail = store.getPromptDetail(workspaceId, prompt.id);
    if (!detail) {
      continue;
    }
    const fingerprint = getPromptSyncFingerprint(detail);
    if (syncedPromptHashes.get(prompt.id) === fingerprint) {
      continue;
    }
    changedPromptDetails.push(detail);
    promptSyncRecords.push({ recordId: prompt.id, recordHash: fingerprint });
  }

  if (changedPromptDetails.length === 0) {
    return null;
  }

  const promptIds = new Set(changedPromptDetails.map((detail) => detail.id));
  const touchedThreadKeys = new Set(
    changedPromptDetails.map((detail) => detail.threadId ?? detail.sessionId ?? `prompt:${detail.id}`)
  );
  const threads = store
    .listThreads(workspaceId)
    .filter((thread) => touchedThreadKeys.has(thread.threadId ?? thread.sessionId ?? `prompt:${thread.id}`));
  const promptsUpsert = prompts.filter((prompt) => promptIds.has(prompt.id));

  const blobMap = new Map<string, string>();
  const blobSyncRecords: Array<{ recordId: string; recordHash: string }> = [];
  for (const detail of changedPromptDetails) {
    for (const artifact of detail.artifacts) {
      if (!artifact.blobId || blobMap.has(artifact.blobId) || syncedBlobHashes.has(artifact.blobId)) {
        continue;
      }
      blobMap.set(artifact.blobId, store.readBlob(workspaceId, artifact.blobId));
      blobSyncRecords.push({ recordId: artifact.blobId, recordHash: artifact.blobId });
    }
  }

  return {
    bundle: {
      workspace,
      threads,
      prompts: promptsUpsert,
      promptDetails: changedPromptDetails,
      blobs: [...blobMap.entries()].map(([blobId, content]) => ({ blobId, content })),
    },
    promptSyncRecords,
    blobSyncRecords,
  };
}

async function postJsonWithToken<TResponse, TBody extends object>(
  apiBaseUrl: string,
  path: string,
  token: string,
  body: TBody
): Promise<TResponse> {
  const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Cloud sync request failed: ${response.status}`);
  }
  return response.json() as Promise<TResponse>;
}

export function createCloudSyncController({
  store,
  tailer,
  runtimeStatus,
  notifyChange,
}: {
  store: PromptreelStore;
  tailer: CodexSessionTailer;
  runtimeStatus: DaemonRuntimeStatus;
  notifyChange?: () => void;
}) {
  let syncInFlight = false;
  let cloudSyncTimer: NodeJS.Timeout | null = null;
  let lastCloudSyncNotice: string | null = null;

  const getNextCloudSyncInterval = () => {
    const status = tailer.getStatus();
    const hasRecentActivity = status.workspaceStatuses.some((workspaceStatus) => hasRecentWorkspaceActivity(workspaceStatus));

    if (hasRecentActivity) {
      return CLOUD_SYNC_ACTIVE_INTERVAL_MS;
    }
    if (runtimeStatus.lastCloudSyncError) {
      return CLOUD_SYNC_ERROR_INTERVAL_MS;
    }
    return CLOUD_SYNC_IDLE_INTERVAL_MS;
  };

  const scheduleCloudSync = (delayMs = getNextCloudSyncInterval()) => {
    if (cloudSyncTimer) {
      clearTimeout(cloudSyncTimer);
    }
    cloudSyncTimer = setTimeout(() => {
      void syncCloudWorkspaces();
    }, delayMs);
  };

  const reportCloudSyncNotice = (message: string, tone: "info" | "warn" = "info") => {
    if (lastCloudSyncNotice === message) {
      return;
    }
    lastCloudSyncNotice = message;
    if (tone === "warn") {
      console.warn(message);
      return;
    }
    console.log(message);
  };

  const syncCloudWorkspaces = async () => {
    if (!CLOUD_SYNC_ENABLED) {
      return;
    }
    if (syncInFlight) {
      return;
    }
    const authState = store.getCloudAuthState();
    if (!authState?.daemonToken) {
      runtimeStatus.lastCloudSyncError = "Cloud sync paused: not signed in.";
      notifyChange?.();
      reportCloudSyncNotice(
        "Cloud sync paused: not signed in. Run `pnpm dev:cli -- login` to reconnect this daemon.",
        "warn"
      );
      scheduleCloudSync(CLOUD_SYNC_ERROR_INTERVAL_MS);
      return;
    }

    syncInFlight = true;
    runtimeStatus.syncInFlight = true;
    try {
      reportCloudSyncNotice("Cloud sync authenticated. Watching for local changes...");
      const syncScope = buildCloudSyncScope(authState);
      const syncedWorkspaces: string[] = [];
      let syncedPromptCount = 0;
      let syncedBlobCount = 0;
      const workspaces = store.listWorkspaces();
      for (const workspace of workspaces) {
        const delta = buildCloudDeltaBundle(store, tailer, workspace.id, syncScope, authState.deviceId);
        if (!delta) {
          continue;
        }
        await postJsonWithToken<CloudBootstrapSyncResponse, CloudBootstrapSyncRequest>(
          authState.apiBaseUrl,
          "/cloud/sync/bootstrap",
          authState.daemonToken,
          delta.bundle
        );
        store.upsertSyncRecords(workspace.id, syncScope, CLOUD_SYNC_PROMPT_RECORD_TYPE, delta.promptSyncRecords);
        store.upsertSyncRecords(workspace.id, syncScope, CLOUD_SYNC_BLOB_RECORD_TYPE, delta.blobSyncRecords);
        setCloudSyncCursor(store, workspace.id, syncScope, { lastSyncedAt: nowIso() });
        runtimeStatus.lastCloudSyncAt = nowIso();
        runtimeStatus.lastCloudSyncError = null;
        syncedPromptCount += delta.bundle.prompts.length;
        syncedBlobCount += delta.bundle.blobs.length;
        syncedWorkspaces.push(`${workspace.slug} (${delta.bundle.prompts.length} prompts)`);
      }
      notifyChange?.();
      if (syncedWorkspaces.length > 0) {
        runtimeStatus.lastCloudSyncStats = {
          workspaceCount: syncedWorkspaces.length,
          promptCount: syncedPromptCount,
          blobCount: syncedBlobCount,
        };
        console.log(`Synced ${syncedWorkspaces.length} workspace${syncedWorkspaces.length === 1 ? "" : "s"} to Promptreel Cloud.`);
        for (const summary of syncedWorkspaces) {
          console.log(`- ${summary}`);
        }
      }
    } catch (error) {
      runtimeStatus.lastCloudSyncError = error instanceof Error ? error.message : String(error);
      notifyChange?.();
      console.error(runtimeStatus.lastCloudSyncError);
    } finally {
      syncInFlight = false;
      runtimeStatus.syncInFlight = false;
      notifyChange?.();
      scheduleCloudSync();
    }
  };

  return {
    start() {
      if (CLOUD_SYNC_ENABLED) {
        void syncCloudWorkspaces();
      }
    },
    stop() {
      if (cloudSyncTimer) {
        clearTimeout(cloudSyncTimer);
      }
    },
  };
}
