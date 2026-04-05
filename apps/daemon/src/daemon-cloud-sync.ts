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

const CLOUD_SYNC_EVENT_DEBOUNCE_MS = 500;
export const CLOUD_SYNC_MIN_INTERVAL_MS = 3_000;
export const CLOUD_SYNC_REQUEST_TIMEOUT_MS = 15_000;
const CLOUD_SYNC_RETRY_INTERVAL_MS = 4_000;
const CLOUD_SYNC_PROMPT_RECORD_TYPE = "cloud_prompt";
const CLOUD_SYNC_BLOB_RECORD_TYPE = "cloud_blob";

export const CLOUD_DAEMON_ACTIVE_WINDOW_MS = 20_000;
export const CLOUD_DAEMON_CONNECTED_WINDOW_MS = 120_000;
export const CLOUD_SYNC_ENABLED = process.env.PROMPTREEL_ENABLE_CLOUD_SYNC === "1";

export function resolveCloudSyncDelay(
  requestedDelayMs: number,
  lastCompletedAtMs: number | null,
  nowMs: number,
  minIntervalMs = CLOUD_SYNC_MIN_INTERVAL_MS
): number {
  if (lastCompletedAtMs == null) {
    return requestedDelayMs;
  }
  const cooldownRemainingMs = Math.max(0, minIntervalMs - (nowMs - lastCompletedAtMs));
  return Math.max(requestedDelayMs, cooldownRemainingMs);
}

export function shouldBypassCloudSyncCooldownForPrompt(prompt: {
  status: string;
  endedAt: string | null;
}): boolean {
  return prompt.status !== "in_progress" && Boolean(prompt.endedAt);
}

export function isCloudSyncTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function resolveDirtyWorkspaceIds(
  dirtyWorkspaceIds: Iterable<string>,
  availableWorkspaceIds: Iterable<string>
): string[] {
  const available = new Set(availableWorkspaceIds);
  return [...new Set(dirtyWorkspaceIds)].filter((workspaceId) => available.has(workspaceId));
}

export function resolveCloudSyncRunResult(
  requestedWorkspaceCount: number,
  syncedWorkspaceCount: number
): "no-dirty-workspaces" | "no-deltas" | "synced" {
  if (requestedWorkspaceCount === 0) {
    return "no-dirty-workspaces";
  }
  if (syncedWorkspaceCount === 0) {
    return "no-deltas";
  }
  return "synced";
}

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

type CloudSyncSummary =
  | {
    outcome: "synced";
    durationMs: number;
    workspaces: number;
    prompts: number;
    blobs: number;
  }
  | {
    outcome: "skipped";
    durationMs: number;
    reason: "no-dirty-workspaces" | "no-deltas";
    workspaces: number;
  }
  | {
    outcome: "error";
    durationMs: number;
    message: string;
    dirtyWorkspaces: number;
  };

type CloudSyncRequest = {
  reason: string;
  bypassCooldown: boolean;
};

function logCloudSyncSummary(summary: CloudSyncSummary): void {
  if (summary.outcome === "synced") {
    console.log(
      `[cloud-sync] synced duration_ms=${summary.durationMs} workspaces=${summary.workspaces} prompts=${summary.prompts} blobs=${summary.blobs}`
    );
    return;
  }
  if (summary.outcome === "skipped") {
    console.log(
      `[cloud-sync] skipped reason=${summary.reason} duration_ms=${summary.durationMs} workspaces=${summary.workspaces}`
    );
    return;
  }
  console.error(
    `[cloud-sync] error duration_ms=${summary.durationMs} dirty_workspaces=${summary.dirtyWorkspaces} message=${JSON.stringify(summary.message)}`
  );
}

function mergePendingCloudSyncRequest(
  current: CloudSyncRequest | null,
  next: CloudSyncRequest
): CloudSyncRequest {
  if (!current) {
    return next;
  }
  if (next.bypassCooldown) {
    return next;
  }
  return {
    reason: current.reason,
    bypassCooldown: current.bypassCooldown || next.bypassCooldown,
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
  hasCompletedPrompts: boolean;
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
    hasCompletedPrompts: promptsUpsert.some((prompt) => shouldBypassCloudSyncCooldownForPrompt(prompt)),
  };
}

async function postJsonWithToken<TResponse, TBody extends object>(
  apiBaseUrl: string,
  path: string,
  token: string,
  body: TBody
): Promise<TResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, CLOUD_SYNC_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Cloud sync request failed: ${response.status}`);
    }
    return response.json() as Promise<TResponse>;
  } catch (error) {
    if (isCloudSyncTimeoutError(error)) {
      throw new Error(`Cloud sync request timed out after ${CLOUD_SYNC_REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
  let tailerUnsubscribe: (() => void) | null = null;
  let lastCloudSyncNotice: string | null = null;
  let lastCompletedSyncAtMs: number | null = null;
  const dirtyWorkspaceIds = new Set<string>();
  let pendingSyncRequest: CloudSyncRequest | null = null;

  const markDirtyWorkspaces = (workspaceIds: Iterable<string>) => {
    for (const workspaceId of workspaceIds) {
      if (workspaceId) {
        dirtyWorkspaceIds.add(workspaceId);
      }
    }
  };

  const clearScheduledCloudSync = () => {
    if (!cloudSyncTimer) {
      return;
    }
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = null;
  };

  const setSyncInFlight = (value: boolean) => {
    syncInFlight = value;
    runtimeStatus.syncInFlight = value;
    notifyChange?.();
  };

  const scheduleCloudSync = (
    delayMs = 0,
    options: { bypassCooldown?: boolean; reason?: string } = {}
  ) => {
    const request: CloudSyncRequest = {
      reason: options.reason ?? "unspecified",
      bypassCooldown: Boolean(options.bypassCooldown),
    };
    if (!CLOUD_SYNC_ENABLED) {
      return;
    }
    if (syncInFlight) {
      pendingSyncRequest = mergePendingCloudSyncRequest(pendingSyncRequest, request);
      return;
    }
    clearScheduledCloudSync();
    const effectiveDelayMs = request.bypassCooldown
      ? delayMs
      : resolveCloudSyncDelay(delayMs, lastCompletedSyncAtMs, Date.now());
    cloudSyncTimer = setTimeout(() => {
      cloudSyncTimer = null;
      void syncCloudWorkspaces();
    }, effectiveDelayMs);
  };

  const shouldBypassCooldownForWorkspaces = (workspaceIds: string[]): boolean => {
    const authState = store.getCloudAuthState();
    if (!authState?.daemonToken || workspaceIds.length === 0) {
      return false;
    }
    const syncScope = buildCloudSyncScope(authState);
    for (const workspaceId of workspaceIds) {
      const delta = buildCloudDeltaBundle(store, tailer, workspaceId, syncScope, authState.deviceId);
      if (delta?.hasCompletedPrompts) {
        return true;
      }
    }
    return false;
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
      scheduleCloudSync(CLOUD_SYNC_RETRY_INTERVAL_MS);
      return;
    }

    setSyncInFlight(true);
    const startedAt = Date.now();
    try {
      reportCloudSyncNotice("Cloud sync authenticated. Watching for local changes...");
      const syncScope = buildCloudSyncScope(authState);
      const syncedWorkspaces: string[] = [];
      let syncedPromptCount = 0;
      let syncedBlobCount = 0;
      const workspaces = store.listWorkspaces();
      const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
      const workspaceIdsToSync = resolveDirtyWorkspaceIds(dirtyWorkspaceIds, workspacesById.keys());
      for (const staleWorkspaceId of [...dirtyWorkspaceIds]) {
        if (!workspacesById.has(staleWorkspaceId)) {
          dirtyWorkspaceIds.delete(staleWorkspaceId);
        }
      }
      for (const workspaceId of workspaceIdsToSync) {
        const workspace = workspacesById.get(workspaceId);
        if (!workspace) {
          dirtyWorkspaceIds.delete(workspaceId);
          continue;
        }
        const delta = buildCloudDeltaBundle(store, tailer, workspace.id, syncScope, authState.deviceId);
        if (!delta) {
          dirtyWorkspaceIds.delete(workspace.id);
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
        dirtyWorkspaceIds.delete(workspace.id);
        runtimeStatus.lastCloudSyncAt = nowIso();
        runtimeStatus.lastCloudSyncError = null;
        syncedPromptCount += delta.bundle.prompts.length;
        syncedBlobCount += delta.bundle.blobs.length;
        syncedWorkspaces.push(workspace.slug);
      }
      notifyChange?.();
      const runResult = resolveCloudSyncRunResult(workspaceIdsToSync.length, syncedWorkspaces.length);
      if (runResult === "synced") {
        runtimeStatus.lastCloudSyncStats = {
          workspaceCount: syncedWorkspaces.length,
          promptCount: syncedPromptCount,
          blobCount: syncedBlobCount,
        };
        logCloudSyncSummary({
          outcome: "synced",
          durationMs: Date.now() - startedAt,
          workspaces: syncedWorkspaces.length,
          prompts: syncedPromptCount,
          blobs: syncedBlobCount,
        });
      } else {
        runtimeStatus.lastCloudSyncStats = {
          workspaceCount: 0,
          promptCount: 0,
          blobCount: 0,
        };
        logCloudSyncSummary({
          outcome: "skipped",
          durationMs: Date.now() - startedAt,
          reason: runResult,
          workspaces: workspaceIdsToSync.length,
        });
      }
    } catch (error) {
      runtimeStatus.lastCloudSyncError = error instanceof Error ? error.message : String(error);
      notifyChange?.();
      logCloudSyncSummary({
        outcome: "error",
        durationMs: Date.now() - startedAt,
        message: runtimeStatus.lastCloudSyncError,
        dirtyWorkspaces: dirtyWorkspaceIds.size,
      });
    } finally {
      setSyncInFlight(false);
      const completedWithoutError = !runtimeStatus.lastCloudSyncError;
      if (completedWithoutError) {
        lastCompletedSyncAtMs = Date.now();
      }
      const nextPendingRequest = pendingSyncRequest;
      pendingSyncRequest = null;
      if (nextPendingRequest) {
        scheduleCloudSync(0, nextPendingRequest);
      } else if (!completedWithoutError) {
        scheduleCloudSync(CLOUD_SYNC_RETRY_INTERVAL_MS, { reason: "retry" });
      }
    }
  };

  return {
    start() {
      if (CLOUD_SYNC_ENABLED) {
        markDirtyWorkspaces(store.listWorkspaces().map((workspace) => workspace.id));
        tailerUnsubscribe = tailer.subscribe((update) => {
          const trigger = shouldBypassCooldownForWorkspaces(update.workspaceIds)
            ? "completed-prompt"
            : "dirty-workspace";
          markDirtyWorkspaces(update.workspaceIds);
          scheduleCloudSync(CLOUD_SYNC_EVENT_DEBOUNCE_MS, {
            bypassCooldown: trigger === "completed-prompt",
            reason: trigger,
          });
        });
        scheduleCloudSync(0, { reason: "startup" });
      }
    },
    stop() {
      clearScheduledCloudSync();
      tailerUnsubscribe?.();
    },
  };
}
