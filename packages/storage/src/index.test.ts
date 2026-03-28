import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { PromptlineStore } from "./index";

describe("PromptlineStore", () => {
  test("registers repos idempotently under the Promptline home", () => {
    const root = mkdtempSync(join(tmpdir(), "promptline-store-"));
    const repoPath = join(root, "repo");
    mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });

    const store = new PromptlineStore(join(root, ".pl"));
    const first = store.addRepo(repoPath);
    const second = store.addRepo(repoPath);
    const repos = store.listRepos();

    expect(first.id).toBe(second.id);
    expect(repos).toHaveLength(1);
    expect(store.repoDir(first.id)).toContain(".pl");
  });
});

