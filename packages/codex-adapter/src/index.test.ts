import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { SAMPLE_CODEX_SESSION } from "@promptline/test-fixtures";
import { PromptlineStore } from "@promptline/storage";
import { importCodexSessionsForRepo } from "./index";

describe("importCodexSessionsForRepo", () => {
  test("segments prompt-to-idle windows from Codex session jsonl", () => {
    const root = mkdtempSync(join(tmpdir(), "promptline-import-"));
    const repoPath = join(root, "repo");
    const sessionsRoot = join(root, "sessions", "2026", "03", "28");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(sessionsRoot, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });

    const escapedPath = repoPath.replace(/\\/g, "\\\\");
    writeFileSync(
      join(sessionsRoot, "rollout-sample.jsonl"),
      SAMPLE_CODEX_SESSION.replace("C:\\\\repo", escapedPath),
      "utf8"
    );

    const store = new PromptlineStore(join(root, ".pl"));
    const repo = store.addRepo(repoPath);
    const result = importCodexSessionsForRepo(store, repo, join(root, "sessions"));
    const prompts = store.listPrompts(repo.id);

    expect(result.importedFiles).toBe(1);
    expect(result.importedPrompts).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].promptSummary.length).toBeGreaterThan(0);

    const detail = store.getPromptDetail(repo.id, prompts[1].id);
    expect(detail?.artifacts.some((artifact) => artifact.type === "plan")).toBe(true);
  });
});
