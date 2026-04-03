#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import type {
  AuthWhoamiResponse,
  CliLoginExchangeResponse,
  CliLoginStartRequest,
  CliLoginStartResponse,
} from "@promptline/api-contracts";
import { importCodexSessionsForRepo, runLiveDoctor } from "@promptline/codex-adapter";
import { PromptlineStore, type CloudAuthState } from "@promptline/storage";
import { createId } from "@promptline/domain";

const program = new Command();
const store = new PromptlineStore();
const DEFAULT_API_BASE_URL = trimTrailingSlash(process.env.PROMPTLINE_CLOUD_API_URL ?? "http://127.0.0.1:4312/api");
const DEFAULT_WEB_BASE_URL = trimTrailingSlash(process.env.PROMPTLINE_CLOUD_WEB_URL ?? "http://127.0.0.1:4175");

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function getDeviceName(): string {
  return `${hostname()} (${platform()})`;
}

function ensureDeviceId(existing: CloudAuthState | null): string {
  return existing?.deviceId ?? createId("device");
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
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
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
        console.log(JSON.stringify(repo, null, 2));
      })
  )
  .addCommand(
    new Command("list").action(() => {
      console.log(JSON.stringify({ repos: store.listRepos() }, null, 2));
    })
  );

program
  .command("daemon")
  .description("Manage the Promptline daemon")
  .addCommand(
    new Command("start").action(() => {
      const current = store.getDaemonState();
      if (current.pid) {
        console.log(JSON.stringify({ ok: true, pid: current.pid, message: "Daemon already recorded as running." }, null, 2));
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
      console.log(JSON.stringify({ ok: true, pid: child.pid, message: "Daemon started." }, null, 2));
    })
  )
  .addCommand(
    new Command("stop").action(() => {
      const state = store.getDaemonState();
      if (!state.pid) {
        console.log(JSON.stringify({ ok: true, message: "No daemon pid recorded." }, null, 2));
        return;
      }
      process.kill(state.pid);
      store.clearDaemonState();
      console.log(JSON.stringify({ ok: true, pid: state.pid, message: "Daemon stop requested." }, null, 2));
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
        console.log(JSON.stringify(result, null, 2));
      })
  );

program
  .command("prompts")
  .description("Query stored prompt events")
  .addCommand(
    new Command("list")
      .requiredOption("--repo <repoId>")
      .action((options: { repo: string }) => {
        console.log(JSON.stringify({ prompts: store.listPrompts(options.repo) }, null, 2));
      })
  )
  .addCommand(
    new Command("show")
      .argument("<promptId>")
      .requiredOption("--repo <repoId>")
      .action((promptId: string, options: { repo: string }) => {
        console.log(JSON.stringify({ prompt: store.getPromptDetail(options.repo, promptId) }, null, 2));
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
        console.log(JSON.stringify({ result }, null, 2));
        process.exitCode = result.ok ? 0 : 1;
      })
  );

program
  .command("login")
  .description("Connect this machine to Promptline Cloud")
  .option("--api-url <apiUrl>", "Promptline Cloud API base URL", DEFAULT_API_BASE_URL)
  .option("--web-url <webUrl>", "Promptline Cloud web base URL", DEFAULT_WEB_BASE_URL)
  .action(async (options: { apiUrl: string; webUrl: string }) => {
    const existing = store.getCloudAuthState();
    const deviceId = ensureDeviceId(existing);
    const deviceName = existing?.deviceName ?? getDeviceName();
    const apiBaseUrl = trimTrailingSlash(options.apiUrl);
    const webBaseUrl = trimTrailingSlash(options.webUrl);

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

    console.log(JSON.stringify({
      ok: true,
      apiBaseUrl,
      webBaseUrl,
      deviceId,
      user: exchange.user,
      device: exchange.device,
      message: "Promptline Cloud login succeeded."
    }, null, 2));
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
    console.log(JSON.stringify(result, null, 2));
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
