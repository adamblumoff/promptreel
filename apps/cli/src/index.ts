#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { importCodexSessionsForRepo, runLiveDoctor } from "@promptline/codex-adapter";
import { PromptlineStore } from "@promptline/storage";

const program = new Command();
const store = new PromptlineStore();

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

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
