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
    const { root, repoPath, sessionsRoot } = createImportHarness("promptline-import-");

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
    const { root, repoPath, sessionsRoot } = createImportHarness("promptline-import-open-");

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

  test("recovers code diffs from successful apply_patch custom tool calls", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptline-import-apply-patch-");
    const patch = `*** Begin Patch
*** Add File: ${repoPath.replace(/\\/g, "/")}/src/helper.ts
+export const helper = true;
*** End Patch`;

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "apply-patch-success.jsonl",
      [
        eventMsg("2026-03-29T01:00:01.000Z", "user_message", "Add the helper."),
        customToolCall("2026-03-29T01:00:02.000Z", "call_patch", "apply_patch", patch),
        customToolCallOutput(
          "2026-03-29T01:00:03.000Z",
          "call_patch",
          "{\"output\":\"Success. Updated the following files:\\nA src/helper.ts\\n\",\"metadata\":{\"exit_code\":0}}"
        ),
        eventMsg("2026-03-29T01:00:04.000Z", "agent_message", "Implemented the helper.")
      ]
    );

    const store = new PromptlineStore(join(root, ".pl"));
    const repo = store.addRepo(repoPath);
    importCodexSessionsForRepo(store, repo, join(root, "sessions"));

    const prompts = store.listPrompts(repo.id);
    const detail = store.getPromptDetail(repo.id, prompts[0]!.id);
    const diffArtifact = detail?.artifacts.find((artifact) => artifact.type === "code_diff") ?? null;

    expect(prompts[0]?.hasCodeDiff).toBe(true);
    expect(prompts[0]?.filesTouched).toEqual(["src/helper.ts"]);
    expect(diffArtifact?.metadataJson).toContain("\"source\":\"apply_patch\"");
    expect(diffArtifact?.metadataJson).toContain("\"sourceFormat\":\"codex_apply_patch\"");
    expect(store.readBlob(repo.id, diffArtifact?.blobId ?? "")).toBe(patch);
  });

  test("ignores failed apply_patch attempts when a later retry succeeds", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptline-import-apply-patch-retry-");
    const failedPatch = `*** Begin Patch
*** Update File: src/old.ts
@@
-old
+new
*** End Patch`;
    const successfulPatch = `*** Begin Patch
*** Add File: src/retry.ts
+export const retry = true;
*** End Patch`;

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "apply-patch-retry.jsonl",
      [
        eventMsg("2026-03-29T02:00:01.000Z", "user_message", "Retry the patch."),
        customToolCall("2026-03-29T02:00:02.000Z", "call_fail", "apply_patch", failedPatch),
        customToolCallOutput(
          "2026-03-29T02:00:03.000Z",
          "call_fail",
          "apply_patch verification failed: Failed to find expected lines in src/old.ts"
        ),
        customToolCall("2026-03-29T02:00:04.000Z", "call_success", "apply_patch", successfulPatch),
        customToolCallOutput(
          "2026-03-29T02:00:05.000Z",
          "call_success",
          "{\"output\":\"Success. Updated the following files:\\nA src/retry.ts\\n\",\"metadata\":{\"exit_code\":0}}"
        ),
        eventMsg("2026-03-29T02:00:06.000Z", "agent_message", "Applied the retry.")
      ]
    );

    const store = new PromptlineStore(join(root, ".pl"));
    const repo = store.addRepo(repoPath);
    importCodexSessionsForRepo(store, repo, join(root, "sessions"));

    const prompt = store.listPrompts(repo.id)[0]!;
    const detail = store.getPromptDetail(repo.id, prompt.id)!;
    const diffArtifact = detail.artifacts.find((artifact) => artifact.type === "code_diff")!;

    expect(prompt.filesTouched).toEqual(["src/retry.ts"]);
    expect(store.readBlob(repo.id, diffArtifact.blobId ?? "")).toBe(successfulPatch);
  });

  test("falls back to git diff command output when no apply_patch diff exists", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptline-import-git-diff-");
    const gitDiffOutput = `Command: "pwsh" -Command 'git diff -- src/app.ts'
Chunk ID: diff123
Output:
diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
`;

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "git-diff-only.jsonl",
      [
        eventMsg("2026-03-29T03:00:01.000Z", "user_message", "Show the diff."),
        functionCall(
          "2026-03-29T03:00:02.000Z",
          "call_diff",
          "exec_command",
          "{\"cmd\":\"git diff -- src/app.ts\"}"
        ),
        functionCallOutput("2026-03-29T03:00:03.000Z", "call_diff", gitDiffOutput),
        eventMsg("2026-03-29T03:00:04.000Z", "agent_message", "Here is the diff.")
      ]
    );

    const store = new PromptlineStore(join(root, ".pl"));
    const repo = store.addRepo(repoPath);
    importCodexSessionsForRepo(store, repo, join(root, "sessions"));

    const prompt = store.listPrompts(repo.id)[0]!;
    const detail = store.getPromptDetail(repo.id, prompt.id)!;
    const diffArtifact = detail.artifacts.find((artifact) => artifact.type === "code_diff")!;

    expect(prompt.hasCodeDiff).toBe(true);
    expect(prompt.filesTouched).toEqual(["src/app.ts"]);
    expect(diffArtifact.metadataJson).toContain("\"source\":\"git_diff_output\"");
    expect(store.readBlob(repo.id, diffArtifact.blobId ?? "")).toBe(gitDiffOutput);
  });

  test("leaves prompts without patch or git diff data unchanged", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptline-import-no-diff-");

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "no-diff.jsonl",
      [
        eventMsg("2026-03-29T04:00:01.000Z", "user_message", "Explain the helper."),
        functionCall(
          "2026-03-29T04:00:02.000Z",
          "call_test",
          "exec_command",
          "{\"cmd\":\"pnpm test\"}"
        ),
        functionCallOutput("2026-03-29T04:00:03.000Z", "call_test", "Process exited with code 0"),
        eventMsg("2026-03-29T04:00:04.000Z", "agent_message", "The helper normalizes input.")
      ]
    );

    const store = new PromptlineStore(join(root, ".pl"));
    const repo = store.addRepo(repoPath);
    importCodexSessionsForRepo(store, repo, join(root, "sessions"));

    const prompt = store.listPrompts(repo.id)[0]!;

    expect(prompt.hasCodeDiff).toBe(false);
    expect(prompt.filesTouched).toEqual([]);
  });

  test("keeps recovered diffs on open tailed prompts", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptline-import-open-diff-");
    const patch = `*** Begin Patch
*** Add File: src/open.ts
+export const open = true;
*** End Patch`;

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "open-diff.jsonl",
      [
        eventMsg("2026-03-29T05:00:01.000Z", "user_message", "Keep working."),
        customToolCall("2026-03-29T05:00:02.000Z", "call_open", "apply_patch", patch),
        customToolCallOutput(
          "2026-03-29T05:00:03.000Z",
          "call_open",
          "{\"output\":\"Success. Updated the following files:\\nA src/open.ts\\n\",\"metadata\":{\"exit_code\":0}}"
        )
      ]
    );

    const store = new PromptlineStore(join(root, ".pl"));
    const repo = store.addRepo(repoPath);
    importCodexSessionsForRepo(store, repo, join(root, "sessions"), { tailOpenPrompt: true });

    const prompt = store.listPrompts(repo.id)[0]!;

    expect(prompt.status).toBe("in_progress");
    expect(prompt.hasCodeDiff).toBe(true);
    expect(prompt.filesTouched).toEqual(["src/open.ts"]);
  });
});

function createImportHarness(prefix: string): { root: string; repoPath: string; sessionsRoot: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const repoPath = join(root, "repo");
  const sessionsRoot = join(root, "sessions", "2026", "03", "29");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(sessionsRoot, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });
  return { root, repoPath, sessionsRoot };
}

function writeCodexSession(
  sessionsRoot: string,
  repoPath: string,
  fileName: string,
  lines: string[]
): void {
  const escapedPath = repoPath.replace(/\\/g, "\\\\");
  writeFileSync(
    join(sessionsRoot, fileName),
    [
      `{"timestamp":"2026-03-29T00:00:00.000Z","type":"session_meta","payload":{"id":"session-${fileName}","cwd":"${escapedPath}","source":"vscode"}}`,
      ...lines
    ].join("\n"),
    "utf8"
  );
}

function eventMsg(timestamp: string, type: "user_message" | "agent_message", message: string): string {
  return `{"timestamp":"${timestamp}","type":"event_msg","payload":{"type":"${type}","message":"${escapeJson(message)}"}}`;
}

function functionCall(timestamp: string, callId: string, name: string, argumentsJson: string): string {
  return `{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"function_call","name":"${name}","arguments":"${escapeJson(argumentsJson)}","call_id":"${callId}"}}`;
}

function functionCallOutput(timestamp: string, callId: string, output: string): string {
  return `{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"function_call_output","call_id":"${callId}","output":"${escapeJson(output)}"}}`;
}

function customToolCall(timestamp: string, callId: string, name: string, input: string): string {
  return `{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"${callId}","name":"${name}","input":"${escapeJson(input)}"}}`;
}

function customToolCallOutput(timestamp: string, callId: string, output: string): string {
  return `{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"${callId}","output":"${escapeJson(output)}"}}`;
}

function escapeJson(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
