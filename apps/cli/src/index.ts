#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import {
  buildCloudSyncCursorKey,
  buildCloudSyncScope,
  getPromptSyncFingerprint,
} from "@promptreel/api-contracts";
import type {
  AuthWhoamiResponse,
  CloudBootstrapSyncRequest,
  CloudBootstrapSyncResponse,
  CliLoginExchangeResponse,
  CliLoginStartRequest,
  CliLoginStartResponse,
} from "@promptreel/api-contracts";
import { importCodexSessionsForRepo, runLiveDoctor } from "@promptreel/codex-adapter";
import { PromptreelStore, type CloudAuthState } from "@promptreel/storage";
import { createId, nowIso, type WorkspaceListItem } from "@promptreel/domain";
import {
  printBlock,
  printBootstrapSyncResult,
  printCloudLoginSuccess,
  printPromptDetail,
  printPromptList,
  printRepoList,
  printRepoSummary,
  printResetResult,
  printWhoAmI,
} from "./cli-output.js";
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_WEB_BASE_URL,
  getDeviceName,
  getJson,
  loadCliEnvFiles,
  openBrowser,
  pollForCliLoginApproval,
  postJson,
} from "./cli-runtime.js";
import { startDaemonProcess, stopDaemonProcess } from "./cli-daemon.js";

loadCliEnvFiles();

const program = new Command();
const store = new PromptreelStore();
const CLOUD_SYNC_PROMPT_RECORD_TYPE = "cloud_prompt";
const CLOUD_SYNC_BLOB_RECORD_TYPE = "cloud_blob";

async function resolveAuthenticatedCloudUser(
  authState: CloudAuthState
): Promise<{ authState: CloudAuthState; whoami: AuthWhoamiResponse }> {
  const whoami = await getJson<AuthWhoamiResponse>(authState.apiBaseUrl, "/auth/me", authState.daemonToken);
  if (!whoami.authenticated || !whoami.user) {
    throw new Error("Cloud auth is no longer valid. Run `pl login` again.");
  }
  if (authState.userId === whoami.user.id) {
    return { authState, whoami };
  }
  const nextState: CloudAuthState = {
    ...authState,
    userId: whoami.user.id,
  };
  store.setCloudAuthState(nextState);
  return { authState: nextState, whoami };
}

function ensureDeviceId(existing: CloudAuthState | null): string {
  return existing?.deviceId ?? createId("device");
}

function buildCloudWorkspaceItem(store: PromptreelStore, workspaceId: string): WorkspaceListItem {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace ${workspaceId}`);
  }
  const threads = store.listThreads(workspaceId);
  return {
    ...workspace,
    threadCount: threads.length,
    openThreadCount: threads.filter((thread) => thread.status === "open").length,
    isGenerating: false,
    lastActivityAt: threads[0]?.lastActivityAt ?? workspace.lastSeenAt,
    sessionFileCount: 0,
    recentlyUpdatedSessionCount: 0,
    mode: "idle",
  };
}

function buildBootstrapBundle(store: PromptreelStore, workspaceId: string): CloudBootstrapSyncRequest {
  const workspace = buildCloudWorkspaceItem(store, workspaceId);
  const threads = store.listThreads(workspaceId);
  const prompts = store.listPrompts(workspaceId);
  const promptDetails = prompts
    .map((prompt) => store.getPromptDetail(workspaceId, prompt.id))
    .filter((detail): detail is NonNullable<typeof detail> => detail !== null);
  const blobMap = new Map<string, string>();

  for (const detail of promptDetails) {
    for (const artifact of detail.artifacts) {
      if (!artifact.blobId || blobMap.has(artifact.blobId)) {
        continue;
      }
      blobMap.set(artifact.blobId, store.readBlob(workspaceId, artifact.blobId));
    }
  }

  return {
    workspace,
    threads,
    prompts,
    promptDetails,
    blobs: [...blobMap.entries()].map(([blobId, content]) => ({ blobId, content })),
  };
}

program.name("pl").description("Promptreel CLI");

program
  .command("start")
  .description("Start the Promptreel Cloud sync daemon")
  .option("--detach", "Run the daemon in the background")
  .action(async (options: { detach?: boolean }) => {
    await startDaemonProcess({
      store,
      detach: Boolean(options.detach),
      resolveAuthenticatedCloudUser,
    });
  });

program
  .command("stop")
  .description("Stop the Promptreel daemon")
  .action(() => {
    stopDaemonProcess(store);
  });

program
  .command("reset")
  .description("Reset local Promptreel Cloud credentials so you can rerun login")
  .action(() => {
    const authState = store.getCloudAuthState();
    const result = store.resetCloudAuth(authState?.deviceId ?? null);
    printResetResult(result);
  });

program
  .command("repo")
  .description("Manage Promptreel repos")
  .addCommand(
    new Command("add")
      .argument("<path>")
      .action((path: string) => {
        const repo = store.addRepo(resolve(path));
        printRepoSummary(repo);
      })
  )
  .addCommand(
    new Command("list").action(() => {
      printRepoList(store.listRepos());
    })
  );

program
  .command("daemon")
  .description("Manage the Promptreel daemon")
  .addCommand(
    new Command("start")
      .description("Start the Promptreel Cloud sync daemon")
      .option("--detach", "Run the daemon in the background")
      .action(async (options: { detach?: boolean }) => {
      await startDaemonProcess({
        store,
        detach: Boolean(options.detach),
        resolveAuthenticatedCloudUser,
      });
      })
  )
  .addCommand(
    new Command("stop")
      .description("Stop the Promptreel daemon")
      .action(() => {
      stopDaemonProcess(store);
      })
  );

program
  .command("import")
  .description("Import historical Codex sessions")
  .addCommand(
    new Command("codex")
      .requiredOption("--repo <repoId>")
      .action((options: { repo: string }) => {
        const repo = store.getRepo(options.repo);
        if (!repo) {
          throw new Error(`Unknown repo ${options.repo}`);
        }
        const result = importCodexSessionsForRepo(store, repo);
        printBlock([
          `Imported Codex sessions for ${repo.slug}.`,
          `Files scanned: ${result.importedFiles}`,
          `Prompts imported: ${result.importedPrompts}`,
        ]);
      })
  );

program
  .command("prompts")
  .description("Query stored prompt events")
  .addCommand(
    new Command("list")
      .requiredOption("--repo <repoId>")
      .action((options: { repo: string }) => {
        printPromptList(store.listPrompts(options.repo));
      })
  )
  .addCommand(
    new Command("show")
      .argument("<promptId>")
      .requiredOption("--repo <repoId>")
      .action((promptId: string, options: { repo: string }) => {
        printPromptDetail(store.getPromptDetail(options.repo, promptId));
      })
  );

program
  .command("doctor")
  .description("Diagnostic checks")
  .addCommand(
    new Command("live")
      .requiredOption("--repo <repoId>")
      .action(async (options: { repo: string }) => {
        const repo = store.getRepo(options.repo);
        if (!repo) {
          throw new Error(`Unknown repo ${options.repo}`);
        }
        const result = await runLiveDoctor(store, repo);
        printBlock([
          result.ok ? "Live doctor passed." : "Live doctor failed.",
          `Endpoint: ${result.endpoint}`,
          result.threadId ? `Thread: ${result.threadId}` : null,
          result.turnId ? `Turn: ${result.turnId}` : null,
          `Notifications: ${result.notificationCount}`,
          result.promptEventId ? `Prompt event: ${result.promptEventId}` : null,
          result.message,
        ]);
        process.exitCode = result.ok ? 0 : 1;
      })
  );

program
  .command("login")
  .description("Connect this machine to Promptreel Cloud")
  .action(async () => {
    const existing = store.getCloudAuthState();
    const deviceId = ensureDeviceId(existing);
    const deviceName = existing?.deviceName ?? getDeviceName();
    const apiBaseUrl = DEFAULT_API_BASE_URL;
    const webBaseUrl = DEFAULT_WEB_BASE_URL;

    const start = await postJson<CliLoginStartResponse, CliLoginStartRequest>(
      apiBaseUrl,
      "/auth/cli/start",
      {
        deviceId,
        deviceName,
      }
    );

    const loginUrlObject = new URL(start.loginUrl);
    const desiredWebBaseUrl = new URL(webBaseUrl);
    loginUrlObject.protocol = desiredWebBaseUrl.protocol;
    loginUrlObject.host = desiredWebBaseUrl.host;
    const loginUrl = loginUrlObject.toString();
    console.log(`Opening browser for Promptreel Cloud login...\n${loginUrl}`);
    openBrowser(loginUrl);

    const exchange = await pollForCliLoginApproval<CliLoginExchangeResponse>(apiBaseUrl, start.loginCode, deviceId);
    if (exchange.status !== "approved" || !exchange.daemonToken) {
      throw new Error(
        exchange.status === "expired"
          ? "Login link expired before approval completed."
          : "Login request was not approved."
      );
    }

    store.setCloudAuthState({
      apiBaseUrl,
      webBaseUrl,
      userId: exchange.user?.id ?? null,
      deviceId,
      deviceName,
      daemonToken: exchange.daemonToken,
      linkedAt: new Date().toISOString(),
    });

    printCloudLoginSuccess({
      apiBaseUrl,
      webBaseUrl,
      deviceId,
      userName: exchange.user?.name,
      userEmail: exchange.user?.email,
    });
  });

program
  .command("whoami")
  .description("Show the connected Promptreel Cloud account")
  .action(async () => {
    const existingAuthState = store.getCloudAuthState();
    const resolved = existingAuthState?.daemonToken
      ? await resolveAuthenticatedCloudUser(existingAuthState)
      : null;
    const authState = resolved?.authState ?? existingAuthState;
    if (!authState?.daemonToken) {
      throw new Error("Not logged in. Run `pl login` first.");
    }
    printWhoAmI(resolved?.whoami ?? await getJson<AuthWhoamiResponse>(authState.apiBaseUrl, "/auth/me", authState.daemonToken));
  });

program
  .command("sync")
  .description("Sync Promptreel data to Promptreel Cloud")
  .addCommand(
    new Command("bootstrap")
      .option("--workspace <workspaceId>", "Sync a single workspace id")
      .action(async (options: { workspace?: string }) => {
        const existingAuthState = store.getCloudAuthState();
        const authState = existingAuthState?.daemonToken
          ? (await resolveAuthenticatedCloudUser(existingAuthState)).authState
          : existingAuthState;
        if (!authState?.daemonToken) {
          throw new Error("Not logged in. Run `pl login` first.");
        }

        const workspaceIds = options.workspace
          ? [options.workspace]
          : store.listWorkspaces().map((workspace) => workspace.id);

        if (workspaceIds.length === 0) {
          throw new Error("No workspaces available to sync.");
        }

        const synced: CloudBootstrapSyncResponse[] = [];
        const syncScope = buildCloudSyncScope(authState);
        for (const workspaceId of workspaceIds) {
          const bundle = buildBootstrapBundle(store, workspaceId);
          const result = await postJson<CloudBootstrapSyncResponse, CloudBootstrapSyncRequest>(
            authState.apiBaseUrl,
            "/cloud/sync/bootstrap",
            bundle,
            authState.daemonToken
          );
          store.upsertSyncRecords(
            workspaceId,
            syncScope,
            CLOUD_SYNC_PROMPT_RECORD_TYPE,
            bundle.promptDetails.map((detail) => ({
              recordId: detail.id,
              recordHash: getPromptSyncFingerprint(detail),
            }))
          );
          store.upsertSyncRecords(
            workspaceId,
            syncScope,
            CLOUD_SYNC_BLOB_RECORD_TYPE,
            bundle.blobs.map((blob) => ({
              recordId: blob.blobId,
              recordHash: blob.blobId,
            }))
          );
          store.setIngestCursor(
            workspaceId,
            buildCloudSyncCursorKey(syncScope),
            JSON.stringify({ lastSyncedAt: nowIso() })
          );
          synced.push(result);
        }

        printBootstrapSyncResult({
          workspaceCount: synced.length,
          synced,
        });
      })
  );

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
