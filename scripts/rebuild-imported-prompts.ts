import { cwd } from "node:process";
import { importCodexSessions, importCodexSessionsForRepo } from "../packages/codex-adapter/src/index.ts";
import { PromptreelStore } from "../packages/storage/src/index.ts";

type ScriptOptions = {
  all: boolean;
};

function parseOptions(argv: string[]): ScriptOptions {
  return {
    all: argv.includes("--all"),
  };
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const store = new PromptreelStore();

  if (options.all) {
    const result = importCodexSessions(store);
    console.log(JSON.stringify({ scope: "all", ...result }, null, 2));
    return;
  }

  const repo = store.addRepo(cwd());
  const result = importCodexSessionsForRepo(store, repo);
  console.log(JSON.stringify({ scope: "repo", repoId: repo.id, ...result }, null, 2));
}

main();
