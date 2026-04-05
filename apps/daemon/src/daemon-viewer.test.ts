import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import type { AuthUserProfile, IngestionStatus } from "@promptreel/domain";
import { PromptreelStore } from "@promptreel/storage";
import { buildViewerStatus, listLocalWorkspaceItems } from "./daemon-viewer.js";

function createIngestionStatus(overrides: Partial<IngestionStatus> = {}): IngestionStatus {
  return {
    watcher: "running",
    pollingIntervalMs: 1000,
    sessionsRoot: "C:/sessions",
    lastScanAt: "2026-04-04T10:00:00.000Z",
    workspaceStatuses: [],
    ...overrides,
  };
}

describe("daemon viewer helpers", () => {
  test("lists local workspaces with tailer activity state", () => {
    const root = mkdtempSync(join(tmpdir(), "promptreel-daemon-viewer-"));
    const repoPath = join(root, "repo");
    mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });

    const store = new PromptreelStore(join(root, ".pl"));
    const workspace = store.ensureWorkspaceGroup(repoPath, {
      source: "manual",
      status: "active",
      lastSeenAt: "2026-04-04T10:00:00.000Z",
    });
    const tailer = {
      getStatus: () =>
        createIngestionStatus({
          workspaceStatuses: [
            {
              workspaceId: workspace.id,
              folderPath: repoPath,
              mode: "watching",
              threadCount: 0,
              openThreadCount: 0,
              sessionFileCount: 4,
              recentlyUpdatedSessionCount: 1,
              lastSessionUpdateAt: new Date().toISOString(),
              lastImportAt: null,
              lastImportResult: null,
              lastError: null,
            },
          ],
        }),
    };

    const items = listLocalWorkspaceItems(store, tailer as never);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: workspace.id,
      slug: "repo",
      mode: "watching",
      isGenerating: true,
      sessionFileCount: 4,
      recentlyUpdatedSessionCount: 1,
    });
  });

  test("builds cloud viewer status from the latest linked device", async () => {
    const cloudUser: AuthUserProfile = {
      id: "user_123",
      clerkUserId: "clerk_123",
      email: "adam@example.com",
      name: "Adam",
      avatarUrl: null,
      createdAt: "2026-04-04T10:00:00.000Z",
      updatedAt: "2026-04-04T10:00:00.000Z",
    };
    const cloudStore = {
      getLatestAuthDeviceForUser: async () => ({
        id: "device_row_1",
        userId: cloudUser.id,
        deviceId: "device_1",
        deviceName: "Adam laptop",
        createdAt: "2026-04-04T10:00:00.000Z",
        lastSeenAt: new Date().toISOString(),
      }),
    };
    const tailer = {
      getStatus: () => createIngestionStatus(),
    };

    const status = await buildViewerStatus(
      cloudUser,
      cloudStore as never,
      tailer as never,
      {
        lastCloudSyncAt: null,
        lastCloudSyncError: null,
        syncInFlight: false,
        pendingDirtyWorkspaceCount: 0,
        nextScheduledSyncAt: null,
        lastCloudSyncStats: null,
      }
    );

    expect(status).toMatchObject({
      mode: "cloud",
      daemon: {
        connected: true,
        source: "cloud",
        label: "Syncing live",
        detail: "Adam laptop",
        syncState: "active",
        sync: {
          phase: "syncing",
        },
      },
    });
  });

  test("builds local viewer sync snapshot with pending work", async () => {
    const tailer = {
      getStatus: () =>
        createIngestionStatus({
          workspaceStatuses: [
            {
              workspaceId: "workspace_1",
              folderPath: "C:/repo",
              mode: "watching",
              threadCount: 1,
              openThreadCount: 1,
              sessionFileCount: 1,
              recentlyUpdatedSessionCount: 1,
              lastSessionUpdateAt: new Date().toISOString(),
              lastImportAt: "2026-04-04T10:00:00.000Z",
              lastImportResult: {
                importedFiles: 1,
                importedPrompts: 1,
              },
              lastError: null,
            },
          ],
        }),
    };

    const status = await buildViewerStatus(
      null,
      { getLatestAuthDeviceForUser: async () => null } as never,
      tailer as never,
      {
        lastCloudSyncAt: "2026-04-04T10:02:00.000Z",
        lastCloudSyncError: null,
        syncInFlight: false,
        pendingDirtyWorkspaceCount: 2,
        nextScheduledSyncAt: "2026-04-04T10:02:05.000Z",
        lastCloudSyncStats: {
          workspaceCount: 1,
          promptCount: 3,
          blobCount: 4,
        },
      }
    );

    expect(status).toMatchObject({
      mode: "local",
      daemon: {
        connected: true,
        syncState: "active",
        sync: {
          phase: "pending",
          pendingDirtyWorkspaceCount: 2,
          summary: "2 workspace changes pending",
          lastSuccessfulSyncAt: "2026-04-04T10:02:00.000Z",
          nextScheduledSyncAt: "2026-04-04T10:02:05.000Z",
          lastSuccessfulSyncStats: {
            workspaceCount: 1,
            promptCount: 3,
            blobCount: 4,
          },
        },
      },
    });
  });
});
