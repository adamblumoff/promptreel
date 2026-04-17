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
import {
  importCodexSessionsForRepo,
  recoverHistoricalCodeDiffFromSessionLines,
  runLiveDoctor
} from "@promptreel/codex-adapter";
import {
  buildCodeDiff,
  buildCodeDiffArtifact,
} from "@promptreel/git-integration";
import { PromptreelStore, type CloudAuthState } from "@promptreel/storage";
import { choosePrimaryArtifactType, createId, nowIso, type ArtifactRecord, type WorkspaceListItem, type WorkspaceSnapshotData } from "@promptreel/domain";
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

type BootstrapSyncOptions = { workspace?: string };
const CLOUD_BOOTSTRAP_TARGET_BYTES = 8 * 1024 * 1024;

function createEmptyBootstrapBundle(workspace: CloudBootstrapSyncRequest["workspace"]): CloudBootstrapSyncRequest {
  return {
    workspace,
    threads: [],
    prompts: [],
    promptDetails: [],
    blobs: [],
  };
}

function getBootstrapBundleSize(bundle: CloudBootstrapSyncRequest): number {
  return Buffer.byteLength(JSON.stringify(bundle));
}

function buildBootstrapChunks(bundle: CloudBootstrapSyncRequest): CloudBootstrapSyncRequest[] {
  const chunks: CloudBootstrapSyncRequest[] = [];
  const appendCategoryChunks = <T,>(
    items: T[],
    applyItem: (target: CloudBootstrapSyncRequest, item: T) => void
  ) => {
    if (items.length === 0) {
      return;
    }

    let current = createEmptyBootstrapBundle(bundle.workspace);
    for (const item of items) {
      const candidate = {
        workspace: current.workspace,
        threads: [...current.threads],
        prompts: [...current.prompts],
        promptDetails: [...current.promptDetails],
        blobs: [...current.blobs],
      };
      applyItem(candidate, item);
      if (getBootstrapBundleSize(candidate) > CLOUD_BOOTSTRAP_TARGET_BYTES) {
        if (
          current.threads.length === 0
          && current.prompts.length === 0
          && current.promptDetails.length === 0
          && current.blobs.length === 0
        ) {
          throw new Error("Single bootstrap sync item exceeds request size budget.");
        }
        chunks.push(current);
        current = createEmptyBootstrapBundle(bundle.workspace);
        applyItem(current, item);
        if (getBootstrapBundleSize(current) > CLOUD_BOOTSTRAP_TARGET_BYTES) {
          throw new Error("Single bootstrap sync item exceeds request size budget.");
        }
        continue;
      }
      current = candidate;
    }

    if (
      current.threads.length > 0
      || current.prompts.length > 0
      || current.promptDetails.length > 0
      || current.blobs.length > 0
    ) {
      chunks.push(current);
    }
  };

  appendCategoryChunks(bundle.threads, (target, thread) => {
    target.threads.push(thread);
  });
  appendCategoryChunks(bundle.prompts, (target, prompt) => {
    target.prompts.push(prompt);
  });
  appendCategoryChunks(bundle.promptDetails, (target, detail) => {
    target.promptDetails.push(detail);
  });
  appendCategoryChunks(bundle.blobs, (target, blob) => {
    target.blobs.push(blob);
  });

  if (chunks.length === 0) {
    return [createEmptyBootstrapBundle(bundle.workspace)];
  }
  return chunks;
}

async function resolveCloudAuthForWrite(): Promise<CloudAuthState> {
  const existingAuthState = store.getCloudAuthState();
  const authState = existingAuthState?.daemonToken
    ? (await resolveAuthenticatedCloudUser(existingAuthState)).authState
    : existingAuthState;
  if (!authState?.daemonToken) {
    throw new Error("Not logged in. Run `pl login` first.");
  }
  return authState;
}

function resolveWorkspaceIds(options: BootstrapSyncOptions): string[] {
  const workspaceIds = options.workspace
    ? [options.workspace]
    : store.listWorkspaces().map((workspace) => workspace.id);

  if (workspaceIds.length === 0) {
    throw new Error("No workspaces available.");
  }

  return workspaceIds;
}

async function bootstrapSyncWorkspaces(options: BootstrapSyncOptions): Promise<{
  workspaceCount: number;
  synced: CloudBootstrapSyncResponse[];
}> {
  const authState = await resolveCloudAuthForWrite();
  const workspaceIds = resolveWorkspaceIds(options);
  const synced: CloudBootstrapSyncResponse[] = [];
  const syncScope = buildCloudSyncScope(authState);

  for (const workspaceId of workspaceIds) {
    const bundle = buildBootstrapBundle(store, workspaceId);
    const chunks = buildBootstrapChunks(bundle);
    for (const chunk of chunks) {
      await postJson<CloudBootstrapSyncResponse, CloudBootstrapSyncRequest>(
        authState.apiBaseUrl,
        "/cloud/sync/bootstrap",
        chunk,
        authState.daemonToken
      );
    }
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
    synced.push({
      ok: true,
      workspaceId,
      threadCount: bundle.threads.length,
      promptCount: bundle.promptDetails.length,
      blobCount: bundle.blobs.length,
    });
  }

  return {
    workspaceCount: synced.length,
    synced,
  };
}

function isHistoricalPlaceholderSnapshot(snapshot: WorkspaceSnapshotData | null): boolean {
  if (!snapshot) {
    return true;
  }
  return snapshot.note === "historical import cannot reconstruct exact workspace state"
    || snapshot.gitStatusSummary === "historical import cannot reconstruct exact workspace state"
    || snapshot.gitStatusSummary === "historical import placeholder";
}

function buildCanonicalCodeDiffArtifact(
  workspaceId: string,
  detail: ReturnType<PromptreelStore["getPromptDetail"]>
): ArtifactRecord | null {
  if (!detail) {
    return null;
  }
  const existingDiffArtifact = detail.artifacts.find((artifact) => artifact.type === "code_diff") ?? null;
  let diff = null as ReturnType<typeof buildCodeDiff> | null;
  let metadata: { source: "snapshot_diff" | "git_diff_output"; sourceFormat: "unified_diff" } | null = null;

  if (detail?.baselineSnapshotId && detail.endSnapshotId) {
    const baselineSnapshot = store.getSnapshotData(workspaceId, detail.baselineSnapshotId);
    const endSnapshot = store.getSnapshotData(workspaceId, detail.endSnapshotId);
    if (
      baselineSnapshot
      && endSnapshot
      && !isHistoricalPlaceholderSnapshot(baselineSnapshot)
      && !isHistoricalPlaceholderSnapshot(endSnapshot)
    ) {
      diff = buildCodeDiff(baselineSnapshot, endSnapshot);
      if (diff) {
        metadata = {
          source: "snapshot_diff",
          sourceFormat: "unified_diff",
        };
      }
    }
  }

  if (!diff) {
    const rawLines = store.getPromptRawEventLines(workspaceId, detail.id);
    const recovered = recoverHistoricalCodeDiffFromSessionLines(rawLines, detail.executionPath);
    if (recovered) {
      diff = recovered.diff;
      metadata = {
        source: recovered.source,
        sourceFormat: recovered.sourceFormat,
      };
    }
  }

  if (!diff || !metadata) {
    return null;
  }

  const nextArtifact = buildCodeDiffArtifact(detail.id, diff, metadata);
  nextArtifact.id = existingDiffArtifact?.id ?? createId("artifact");
  nextArtifact.role = existingDiffArtifact?.role ?? "secondary";
  nextArtifact.blobId = store.writeBlob(workspaceId, diff.patch);
  if (existingDiffArtifact?.metadataJson && nextArtifact.metadataJson) {
    try {
      const existingMetadata = JSON.parse(existingDiffArtifact.metadataJson) as { generatedAt?: string };
      const nextMetadata = JSON.parse(nextArtifact.metadataJson) as { generatedAt?: string };
      if (existingMetadata.generatedAt) {
        nextArtifact.metadataJson = JSON.stringify({
          ...nextMetadata,
          generatedAt: existingMetadata.generatedAt,
        });
      }
    } catch {
      // Ignore invalid legacy metadata and keep the freshly generated snapshot metadata.
    }
  }
  return nextArtifact;
}

function chooseNextPrimaryArtifactId(artifacts: ArtifactRecord[]): string | null {
  const primaryType = choosePrimaryArtifactType(
    artifacts.some((artifact) => artifact.type === "plan"),
    artifacts.some((artifact) => artifact.type === "code_diff"),
    artifacts.some((artifact) => artifact.type === "final_output")
  );
  if (!primaryType) {
    return null;
  }
  return artifacts.find((artifact) => artifact.type === primaryType)?.id ?? null;
}

function artifactsMatch(left: ArtifactRecord | null, right: ArtifactRecord | null): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.summary === right.summary
    && left.blobId === right.blobId
    && left.fileStatsJson === right.fileStatsJson
    && left.metadataJson === right.metadataJson;
}

function backfillCodeDiffArtifacts(workspaceIds: string[]): {
  workspaceCount: number;
  promptCount: number;
  artifactCount: number;
  skippedArtifactCount: number;
} {
  let promptCount = 0;
  let artifactCount = 0;
  let skippedArtifactCount = 0;

  for (const workspaceId of workspaceIds) {
    const prompts = store.listPrompts(workspaceId);
    for (const prompt of prompts) {
      const detail = store.getPromptDetail(workspaceId, prompt.id);
      if (!detail) {
        continue;
      }
      promptCount += 1;
      const existingDiffArtifacts = detail.artifacts.filter((artifact) => artifact.type === "code_diff");
      const existingCanonicalArtifact = existingDiffArtifacts[0] ?? null;
      const nextDiffArtifact = buildCanonicalCodeDiffArtifact(workspaceId, detail);
      const nextArtifacts = [
        ...detail.artifacts.filter((artifact) => artifact.type !== "code_diff"),
        ...(nextDiffArtifact ? [nextDiffArtifact] : []),
      ];
      const nextPrimaryArtifactId = chooseNextPrimaryArtifactId(nextArtifacts);
      const primaryChanged = detail.primaryArtifactId !== nextPrimaryArtifactId;
      const diffChanged =
        existingDiffArtifacts.length > 1
        || !artifactsMatch(existingCanonicalArtifact, nextDiffArtifact);

      if (!nextDiffArtifact) {
        skippedArtifactCount += 1;
      }
      if (!diffChanged && !primaryChanged) {
        continue;
      }

      store.deleteArtifactsByTypeForPrompt(workspaceId, prompt.id, "code_diff");
      store.deleteGitLinksForPrompt(workspaceId, prompt.id);
      if (nextDiffArtifact) {
        store.upsertArtifact(workspaceId, nextDiffArtifact);
      }
      store.updatePromptPrimaryArtifactId(workspaceId, prompt.id, nextPrimaryArtifactId);
      artifactCount += 1;
    }
  }

  return {
    workspaceCount: workspaceIds.length,
    promptCount,
    artifactCount,
    skippedArtifactCount,
  };
}

program.name("pl").description("Promptreel CLI");

program
  .command("start")
  .description("Start the Promptreel Cloud sync daemon")
  .option("--bg", "Run the daemon in the background")
  .option("--detach", "Alias for --bg")
  .action(async (options: { bg?: boolean; detach?: boolean }) => {
    await startDaemonProcess({
      store,
      detach: Boolean(options.bg || options.detach),
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
      .option("--bg", "Run the daemon in the background")
      .option("--detach", "Alias for --bg")
      .action(async (options: { bg?: boolean; detach?: boolean }) => {
      await startDaemonProcess({
        store,
        detach: Boolean(options.bg || options.detach),
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
      .action(async (options: BootstrapSyncOptions) => {
        printBootstrapSyncResult(await bootstrapSyncWorkspaces(options));
      })
  );

program
  .command("diffs")
  .description("Inspect and repair stored code diffs")
  .addCommand(
    new Command("backfill")
      .option("--workspace <workspaceId>", "Repair a single workspace id")
      .option("--sync-cloud", "After local repair, push the repaired prompt details and blobs to Promptreel Cloud")
      .action(async (options: BootstrapSyncOptions & { syncCloud?: boolean }) => {
        const workspaceIds = resolveWorkspaceIds(options);
        const result = backfillCodeDiffArtifacts(workspaceIds);
        printBlock([
          `Backfilled code diff artifacts for ${result.workspaceCount} workspace${result.workspaceCount === 1 ? "" : "s"}.`,
          `Prompts scanned: ${result.promptCount}`,
          `Artifacts updated: ${result.artifactCount}`,
          result.skippedArtifactCount > 0 ? `Artifacts skipped: ${result.skippedArtifactCount}` : null,
        ]);
        if (options.syncCloud) {
          printBootstrapSyncResult(await bootstrapSyncWorkspaces(options));
        }
      })
  );

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
