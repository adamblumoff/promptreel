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
        syncDetail: null,
        lastSeenAt: device?.lastSeenAt ?? null,
        syncState: device ? (isActive ? "active" : isConnected ? "idle" : "disconnected") : "disconnected",
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
      syncDetail: runtimeStatus.lastCloudSyncError
        ? runtimeStatus.lastCloudSyncError
        : runtimeStatus.syncInFlight
        ? "Syncing deltas..."
        : runtimeStatus.lastCloudSyncStats
        ? `Last sync: ${runtimeStatus.lastCloudSyncStats.promptCount} prompt${runtimeStatus.lastCloudSyncStats.promptCount === 1 ? "" : "s"}, ${runtimeStatus.lastCloudSyncStats.blobCount} blob${runtimeStatus.lastCloudSyncStats.blobCount === 1 ? "" : "s"}`
        : null,
      lastSeenAt: ingestion.lastScanAt,
      syncState: runtimeStatus.lastCloudSyncError
        ? "error"
        : hasRecentLocalActivity || runtimeStatus.syncInFlight
        ? "active"
        : "idle",
    },
  };
}
