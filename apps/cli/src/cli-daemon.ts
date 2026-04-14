import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptreelStore, CloudAuthState } from "@promptreel/storage";
import { printBlock } from "./cli-output.js";

function resolveDaemonEntry(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../daemon/dist/apps/daemon/src/server.js"
  );
}

function resolveDaemonSource(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../daemon/src/server.ts"
  );
}

function resolveDevDaemonCommand(): { command: string; args: string[] } | null {
  const daemonSource = resolveDaemonSource();
  const workspaceFile = resolve(dirname(fileURLToPath(import.meta.url)), "../../../pnpm-workspace.yaml");
  const tsxCli = resolve(dirname(fileURLToPath(import.meta.url)), "../../../node_modules/tsx/dist/cli.mjs");
  if (!existsSync(daemonSource) || !existsSync(workspaceFile) || !existsSync(tsxCli)) {
    return null;
  }
  return {
    command: process.execPath,
    args: [tsxCli, daemonSource],
  };
}

function isRecordedDaemonAlive(pid: number | null): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startDetachedWindowsProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): number {
  const launcher = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      [
        "$argList = $env:PROMPTREEL_DAEMON_ARGS_JSON | ConvertFrom-Json;",
        "$proc = Start-Process",
        "-FilePath $env:PROMPTREEL_DAEMON_COMMAND",
        "-ArgumentList $argList",
        "-WorkingDirectory $env:PROMPTREEL_DAEMON_CWD",
        "-WindowStyle Hidden",
        "-PassThru;",
        "[Console]::Out.Write($proc.Id)",
      ].join(" "),
    ],
    {
      cwd: input.cwd,
      env: {
        ...input.env,
        PROMPTREEL_DAEMON_COMMAND: input.command,
        PROMPTREEL_DAEMON_ARGS_JSON: JSON.stringify(input.args),
        PROMPTREEL_DAEMON_CWD: input.cwd,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );

  if (launcher.status !== 0) {
    throw new Error(
      `Failed to start hidden daemon on Windows.${launcher.stderr ? ` ${launcher.stderr.trim()}` : ""}`
    );
  }

  const pid = Number.parseInt((launcher.stdout ?? "").trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error("Failed to determine daemon pid for hidden Windows process.");
  }

  return pid;
}

export async function startDaemonProcess(input: {
  store: PromptreelStore;
  detach: boolean;
  resolveAuthenticatedCloudUser: (authState: CloudAuthState) => Promise<{ authState: CloudAuthState }>;
}): Promise<void> {
  const existingAuthState = input.store.getCloudAuthState();
  const authState = existingAuthState?.daemonToken
    ? (await input.resolveAuthenticatedCloudUser(existingAuthState)).authState
    : existingAuthState;
  if (!authState?.daemonToken) {
    throw new Error(
      "Not logged in. Run `pl login` first. For local-only development, use `pnpm dev`, `pnpm dev:web`, or `pnpm dev:daemon`."
    );
  }
  const current = input.store.getDaemonState();
  if (isRecordedDaemonAlive(current.pid)) {
    printBlock([
      "Daemon is already recorded as running.",
      `PID: ${current.pid}`,
      "Stop it with: pnpm dev:cli stop",
    ]);
    return;
  }
  if (current.pid) {
    input.store.clearDaemonState();
  }
  const devDaemon = resolveDevDaemonCommand();
  const daemonEntry = resolveDaemonEntry();
  let command = process.execPath;
  let args = [daemonEntry];
  const daemonCwd = resolve(dirname(fileURLToPath(import.meta.url)), "../../daemon");
  if (devDaemon) {
    command = devDaemon.command;
    args = devDaemon.args;
  } else if (!existsSync(daemonEntry)) {
    throw new Error(`Build the daemon first: missing ${daemonEntry}`);
  }
  const childEnv = {
    ...process.env,
    PROMPTREEL_RUNTIME_MODE: "cloud",
  };
  if (input.detach && process.platform === "win32") {
    const pid = startDetachedWindowsProcess({
      command,
      args,
      cwd: daemonCwd,
      env: childEnv,
    });
    input.store.setDaemonState(pid);
    printBlock([
      "Daemon started in background.",
      `PID: ${pid}`,
      "Stop it with: pnpm dev:cli stop",
    ]);
    return;
  }
  const child = spawn(command, args, {
    detached: input.detach,
    stdio: input.detach ? "ignore" : "inherit",
    windowsHide: input.detach,
    env: childEnv,
    cwd: daemonCwd,
  });
  if (!child.pid) {
    throw new Error("Failed to start daemon.");
  }
  input.store.setDaemonState(child.pid);
  if (input.detach) {
    child.unref();
    printBlock([
      "Daemon started in background.",
      `PID: ${child.pid}`,
      "Stop it with: pnpm dev:cli stop",
    ]);
    return;
  }

  printBlock([
    "Daemon started in foreground.",
    `PID: ${child.pid}`,
    "Press Ctrl+C to stop.",
    "If you later run it in background, stop it with: pnpm dev:cli stop",
  ]);

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const state = input.store.getDaemonState();
      if (state.pid === child.pid) {
        input.store.clearDaemonState();
      }
      if (code && code !== 0 && signal !== "SIGINT" && signal !== "SIGTERM") {
        reject(new Error(`Daemon exited with code ${code}.`));
        return;
      }
      resolve();
    });
  });
}

export function stopDaemonProcess(store: PromptreelStore): void {
  const state = store.getDaemonState();
  if (!state.pid) {
    console.log("No daemon pid recorded.");
    return;
  }
  if (!isRecordedDaemonAlive(state.pid)) {
    store.clearDaemonState();
    console.log("Cleared stale daemon state.");
    return;
  }
  process.kill(state.pid);
  store.clearDaemonState();
  printBlock([
    "Daemon stop requested.",
    `PID: ${state.pid}`,
    "If the process takes a moment to exit, rerun this command once.",
  ]);
}
