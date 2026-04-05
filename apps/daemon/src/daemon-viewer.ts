import type { ViewerStatusResponse } from "@promptreel/api-contracts";
import { CodexSessionTailer } from "@promptreel/codex-adapter";
import type { AuthUserProfile, WorkspaceListItem } from "@promptreel/domain";
import { PromptreelStore } from "@promptreel/storage";
import type { CloudStore } from "./cloud-store-support.js";
import {
  CLOUD_DAEMON_ACTIVE_WINDOW_MS,
  CLOUD_DAEMON_CONNECTED_WINDOW_MS,
  buildWorkspaceListItem,
  hasRecentWorkspaceActivity,
  type DaemonRuntimeStatus,
} from "./daemon-cloud-sync.js";

function formatSyncSummary(runtimeStatus: DaemonRuntimeStatus): string | null {
  if (runtimeStatus.lastCloudSyncError) {
    return runtimeStatus.nextScheduledSyncAt ? "Retrying soon" : "Sync error";
  }
  if (runtimeStatus.syncInFlight) {
    return "Syncing now";
  }
  if (runtimeStatus.pendingDirtyWorkspaceCount > 0) {
    return `${runtimeStatus.pendingDirtyWorkspaceCount} workspace change${runtimeStatus.pendingDirtyWorkspaceCount === 1 ? "" : "s"} pending`;
  }
  if (runtimeStatus.lastCloudSyncStats) {
    const { promptCount } = runtimeStatus.lastCloudSyncStats;
    return `Last sync: ${promptCount} prompt${promptCount === 1 ? "" : "s"}`;
  }
  return null;
}

function resolveSyncPhase(runtimeStatus: DaemonRuntimeStatus): ViewerStatusResponse["daemon"]["sync"]["phase"] {
  if (runtimeStatus.lastCloudSyncError) {
    return runtimeStatus.nextScheduledSyncAt ? "retrying" : "error";
  }
  if (runtimeStatus.syncInFlight) {
    return "syncing";
  }
  if (runtimeStatus.pendingDirtyWorkspaceCount > 0) {
    return "pending";
  }
  return "idle";
}

export function listLocalWorkspaceItems(
  store: PromptreelStore,
  tailer: CodexSessionTailer
): WorkspaceListItem[] {
  return store
    .listWorkspaces()
    .map((workspace) => buildWorkspaceListItem(store, tailer, workspace.id))
    .filter((workspace): workspace is WorkspaceListItem => workspace !== null);
}

export async function buildViewerStatus(
  cloudUser: AuthUserProfile | null,
  cloudStore: CloudStore,
  tailer: CodexSessionTailer,
  runtimeStatus: DaemonRuntimeStatus
): Promise<ViewerStatusResponse> {
  if (cloudUser) {
    const device = await cloudStore.getLatestAuthDeviceForUser(cloudUser.id);
    const isActive = Boolean(
      device?.lastSeenAt
      && Date.now() - Date.parse(device.lastSeenAt) <= CLOUD_DAEMON_ACTIVE_WINDOW_MS
    );
    const isConnected = Boolean(
      device?.lastSeenAt
      && Date.now() - Date.parse(device.lastSeenAt) <= CLOUD_DAEMON_CONNECTED_WINDOW_MS
    );

    return {
      mode: "cloud",
      daemon: {
        connected: isConnected,
        source: "cloud",
        label: device
          ? (isActive ? "Syncing live" : isConnected ? "Daemon connected" : "Daemon offline")
          : "No daemon linked",
        detail: device?.deviceName ?? null,
        lastSeenAt: device?.lastSeenAt ?? null,
        syncState: device ? (isActive ? "active" : isConnected ? "idle" : "disconnected") : "disconnected",
        sync: {
          phase: device ? (isActive ? "syncing" : isConnected ? "idle" : "unavailable") : "unavailable",
          pendingDirtyWorkspaceCount: 0,
          summary: null,
          lastSuccessfulSyncAt: null,
          lastSuccessfulSyncStats: null,
          nextScheduledSyncAt: null,
          lastErrorMessage: null,
        },
      },
    };
  }

  const ingestion = tailer.getStatus();
  const hasRecentLocalActivity = ingestion.workspaceStatuses.some((status) => hasRecentWorkspaceActivity(status));

  return {
    mode: "local",
    daemon: {
      connected: ingestion.watcher === "running",
      source: "local",
      label: ingestion.watcher === "running" ? "Local daemon running" : "Local daemon stopped",
      detail: `${ingestion.workspaceStatuses.length} workspace${ingestion.workspaceStatuses.length === 1 ? "" : "s"} watching`,
      lastSeenAt: ingestion.lastScanAt,
      syncState: runtimeStatus.lastCloudSyncError
        ? "error"
        : hasRecentLocalActivity || runtimeStatus.syncInFlight
        ? "active"
        : "idle",
      sync: {
        phase: resolveSyncPhase(runtimeStatus),
        pendingDirtyWorkspaceCount: runtimeStatus.pendingDirtyWorkspaceCount,
        summary: formatSyncSummary(runtimeStatus),
        lastSuccessfulSyncAt: runtimeStatus.lastCloudSyncAt,
        lastSuccessfulSyncStats: runtimeStatus.lastCloudSyncStats,
        nextScheduledSyncAt: runtimeStatus.nextScheduledSyncAt,
        lastErrorMessage: runtimeStatus.lastCloudSyncError,
      },
    },
  };
}
