#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import type {
  AuthWhoamiResponse,
  CloudBootstrapSyncRequest,
  CloudBootstrapSyncResponse,
  CliLoginExchangeResponse,
  CliLoginStartRequest,
  CliLoginStartResponse,
} from "@promptline/api-contracts";
import { importCodexSessionsForRepo, runLiveDoctor } from "@promptline/codex-adapter";
import { PromptlineStore, type CloudAuthState } from "@promptline/storage";
import { createId, type WorkspaceListItem } from "@promptline/domain";

loadCliEnvFiles();

const program = new Command();
const store = new PromptlineStore();
const DEFAULT_CLOUD_BASE_URL = trimTrailingSlash(
  process.env.PROMPTLINE_CLOUD_URL
  ?? process.env.PROMPTLINE_CLOUD_WEB_URL
  ?? "https://promptlinedaemon-production.up.railway.app"
);
const DEFAULT_API_BASE_URL = trimTrailingSlash(process.env.PROMPTLINE_CLOUD_API_URL ?? `${DEFAULT_CLOUD_BASE_URL}/api`);
const DEFAULT_WEB_BASE_URL = trimTrailingSlash(process.env.PROMPTLINE_CLOUD_WEB_URL ?? DEFAULT_CLOUD_BASE_URL);

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function loadCliEnvFiles(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "../../..");
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), ".env.local"),
    resolve(repoRoot, ".env"),
    resolve(repoRoot, ".env.local"),
    resolve(repoRoot, "apps/cli/.env"),
    resolve(repoRoot, "apps/cli/.env.local"),
    resolve(repoRoot, "apps/daemon/.env"),
    resolve(repoRoot, "apps/daemon/.env.local"),
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) {
      continue;
    }
    const contents = readFileSync(filePath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) {
        continue;
      }
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) {
        continue;
      }
      let value = rawValue.trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

function getDeviceName(): string {
  return `${hostname()} (${platform()})`;
}

function printBlock(lines: Array<string | null | undefined>): void {
  console.log(lines.filter(Boolean).join("\n"));
}

function formatValue(value: string | null | undefined, fallback = "none"): string {
  return value && value.trim() ? value : fallback;
}

function printRepoSummary(repo: { id: string; slug: string; rootPath?: string; gitDir?: string; status?: string }): void {
  printBlock([
    `Repo ready: ${repo.slug}`,
    `ID: ${repo.id}`,
    `Path: ${formatValue(repo.rootPath)}`,
    repo.gitDir ? `Git dir: ${repo.gitDir}` : null,
    repo.status ? `Status: ${repo.status}` : null,
  ]);
}

function printRepoList(repos: Array<{ id: string; slug: string; rootPath: string; status: string }>): void {
  if (repos.length === 0) {
    console.log("No repos registered yet.");
    return;
  }
  printBlock([
    `Registered repos: ${repos.length}`,
    ...repos.map((repo, index) => `${index + 1}. ${repo.slug}  [${repo.status}]  ${repo.rootPath}`),
  ]);
}

function printPromptList(prompts: Array<{ id: string; startedAt: string; promptSummary: string; status: string }>): void {
  if (prompts.length === 0) {
    console.log("No prompt events found.");
    return;
  }
  printBlock([
    `Prompt events: ${prompts.length}`,
    ...prompts.map((prompt, index) => `${index + 1}. ${prompt.startedAt}  [${prompt.status}]  ${prompt.promptSummary}  (${prompt.id})`),
  ]);
}

function printPromptDetail(detail: ReturnType<PromptlineStore["getPromptDetail"]>): void {
  if (!detail) {
    console.log("Prompt not found.");
    return;
  }
  printBlock([
    `Prompt: ${detail.promptSummary}`,
    `ID: ${detail.id}`,
    `Started: ${detail.startedAt}`,
    `Status: ${detail.status}`,
    `Artifacts: ${detail.artifacts.length}`,
    `Transcript entries: ${detail.transcript.length}`,
    "",
    detail.promptText,
  ]);
}

function printCloudLoginSuccess(input: {
  apiBaseUrl: string;
  webBaseUrl: string;
  deviceId: string;
  userName: string | null | undefined;
  userEmail: string | null | undefined;
}): void {
  printBlock([
    "Promptline Cloud login succeeded.",
    `User: ${formatValue(input.userName, input.userEmail ?? "unknown user")}`,
    input.userEmail ? `Email: ${input.userEmail}` : null,
    `Device: ${input.deviceId}`,
    `Web: ${input.webBaseUrl}`,
    `API: ${input.apiBaseUrl}`,
    "",
    "Next steps:",
    "  pnpm dev:cli -- whoami",
    "  pnpm dev:cli -- sync bootstrap",
  ]);
}

function printWhoAmI(result: AuthWhoamiResponse): void {
  if (!result.authenticated || !result.user || !result.device) {
    console.log("Not connected to Promptline Cloud.");
    return;
  }
  printBlock([
    "Promptline Cloud connection is active.",
    `User: ${formatValue(result.user.name, result.user.email ?? "unknown user")}`,
    result.user.email ? `Email: ${result.user.email}` : null,
    `Device: ${formatValue(result.device.deviceName, result.device.deviceId)}`,
    `Device ID: ${result.device.deviceId}`,
    `Last seen: ${result.device.lastSeenAt}`,
  ]);
}

function printBootstrapSyncResult(result: { workspaceCount: number; synced: CloudBootstrapSyncResponse[] }): void {
  printBlock([
    `Bootstrap sync complete for ${result.workspaceCount} workspace${result.workspaceCount === 1 ? "" : "s"}.`,
    ...result.synced.map((item) =>
      `- ${item.workspaceId}: ${item.threadCount} threads, ${item.promptCount} prompts, ${item.blobCount} blobs`
    ),
  ]);
}

function ensureDeviceId(existing: CloudAuthState | null): string {
  return existing?.deviceId ?? createId("device");
}

function buildCloudWorkspaceItem(store: PromptlineStore, workspaceId: string): WorkspaceListItem {
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

function buildBootstrapBundle(store: PromptlineStore, workspaceId: string): CloudBootstrapSyncRequest {
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

async function postJson<TResponse, TRequest extends object>(
  apiBaseUrl: string,
  path: string,
  body: TRequest,
  token?: string
): Promise<TResponse> {
  const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<TResponse>;
}

async function getJson<TResponse>(apiBaseUrl: string, path: string, token?: string): Promise<TResponse> {
  const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<TResponse>;
}

function openBrowser(url: string): void {
  if (process.platform === "win32") {
    const escapedUrl = url.replace(/'/g, "''");
    spawn("powershell", ["-NoProfile", "-Command", `Start-Process '${escapedUrl}'`], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

async function pollForCliLoginApproval(
  apiBaseUrl: string,
  loginCode: string,
  deviceId: string
): Promise<CliLoginExchangeResponse> {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const result = await postJson<CliLoginExchangeResponse, { loginCode: string; deviceId: string }>(
      apiBaseUrl,
      "/auth/cli/exchange",
      { loginCode, deviceId }
    );
    if (result.status === "approved" || result.status === "expired" || result.status === "not_found") {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Timed out waiting for browser login approval.");
}

program.name("pl").description("Promptline CLI");

program
  .command("repo")
  .description("Manage Promptline repos")
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
  .description("Manage the Promptline daemon")
  .addCommand(
    new Command("start").action(() => {
      const current = store.getDaemonState();
      if (current.pid) {
        printBlock([
          "Daemon is already recorded as running.",
          `PID: ${current.pid}`,
        ]);
        return;
      }
      const daemonEntry = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../../../apps/daemon/dist/apps/daemon/src/server.js"
      );
      if (!existsSync(daemonEntry)) {
        throw new Error(`Build the daemon first: missing ${daemonEntry}`);
      }
      const child = spawn(process.execPath, [daemonEntry], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      printBlock([
        "Daemon started.",
        `PID: ${child.pid}`,
      ]);
    })
  )
  .addCommand(
    new Command("stop").action(() => {
      const state = store.getDaemonState();
      if (!state.pid) {
        console.log("No daemon pid recorded.");
        return;
      }
      process.kill(state.pid);
      store.clearDaemonState();
      printBlock([
        "Daemon stop requested.",
        `PID: ${state.pid}`,
      ]);
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
  .description("Connect this machine to Promptline Cloud")
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
    console.log(`Opening browser for Promptline Cloud login...\n${loginUrl}`);
    openBrowser(loginUrl);

    const exchange = await pollForCliLoginApproval(apiBaseUrl, start.loginCode, deviceId);
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
  .description("Show the connected Promptline Cloud account")
  .action(async () => {
    const authState = store.getCloudAuthState();
    if (!authState?.daemonToken) {
      throw new Error("Not logged in. Run `pl login` first.");
    }
    const result = await getJson<AuthWhoamiResponse>(authState.apiBaseUrl, "/auth/me", authState.daemonToken);
    printWhoAmI(result);
  });

program
  .command("sync")
  .description("Sync Promptline data to Promptline Cloud")
  .addCommand(
    new Command("bootstrap")
      .option("--workspace <workspaceId>", "Sync a single workspace id")
      .action(async (options: { workspace?: string }) => {
        const authState = store.getCloudAuthState();
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
        for (const workspaceId of workspaceIds) {
          const bundle = buildBootstrapBundle(store, workspaceId);
          const result = await postJson<CloudBootstrapSyncResponse, CloudBootstrapSyncRequest>(
            authState.apiBaseUrl,
            "/cloud/sync/bootstrap",
            bundle,
            authState.daemonToken
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
