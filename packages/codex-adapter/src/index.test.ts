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

  test("keeps the terminal prompt open while tailing active sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "promptline-import-open-"));
    const repoPath = join(root, "repo");
    const sessionsRoot = join(root, "sessions", "2026", "03", "28");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(sessionsRoot, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });

    const escapedPath = repoPath.replace(/\\/g, "\\\\");
    writeFileSync(
      join(sessionsRoot, "active-session.jsonl"),
      [
        `{"timestamp":"2026-03-28T20:00:00.000Z","type":"session_meta","payload":{"id":"session-open","cwd":"${escapedPath}","source":"vscode"}}`,
        `{"timestamp":"2026-03-28T20:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"Keep watching this thread."}}`,
        `{"timestamp":"2026-03-28T20:00:02.000Z","type":"event_msg","payload":{"type":"agent_message","message":"Still working on it."}}`
      ].join("\n"),
      "utf8"
    );

    const store = new PromptlineStore(join(root, ".pl"));
    const repo = store.addRepo(repoPath);
    importCodexSessionsForRepo(store, repo, join(root, "sessions"), { tailOpenPrompt: true });
    const prompts = store.listPrompts(repo.id);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.status).toBe("in_progress");
    expect(prompts[0]?.endedAt).toBeNull();
    expect(prompts[0]?.boundaryReason).toBeNull();
  });
});
