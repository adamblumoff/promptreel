import { appendFileSync, mkdtempSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { workspaceGroupId } from "@promptreel/domain";
import { SAMPLE_CODEX_SESSION } from "@promptreel/test-fixtures";
import { PromptreelStore } from "@promptreel/storage";
import {
  ACTIVE_SESSION_WATCH_DEBOUNCE_MS,
  CodexSessionTailer,
  importCodexSessions,
  resolveSessionWatchDebounceMs
} from "./index";

describe("importCodexSessions", () => {
  test("segments prompt-to-idle windows from Codex session jsonl", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-");

    const escapedPath = repoPath.replace(/\\/g, "\\\\");
    writeFileSync(
      join(sessionsRoot, "rollout-sample.jsonl"),
      SAMPLE_CODEX_SESSION.replace("C:\\\\repo", escapedPath),
      "utf8"
    );

    const store = new PromptreelStore(join(root, ".pl"));
    const result = importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const prompts = store.listPrompts(workspace.id);

    expect(result.importedFiles).toBe(1);
    expect(result.importedPrompts).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].promptSummary.length).toBeGreaterThan(0);

    const detail = store.getPromptDetail(workspace.id, prompts[1].id);
    expect(detail?.artifacts.some((artifact) => artifact.type === "plan")).toBe(true);
  });

  test("imports explicit plan items as dedicated plan artifacts", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-explicit-plan-");
    const explicitPlan = [
      "# Shipping Plan",
      "",
      "We should land the importer fix first.",
      "",
      "## Plan",
      "1. Parse explicit plan items from the session log.",
      "2. Prefer final answers over commentary for fallback extraction."
    ].join("\n");

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "explicit-plan.jsonl",
      [
        eventMsg(
          "2026-03-29T00:10:01.000Z",
          "user_message",
          "Come up with a plan for the importer fix."
        ),
        agentMessage(
          "2026-03-29T00:10:02.000Z",
          "commentary",
          "I’m checking the importer and storage code first."
        ),
        itemCompleted(
          "2026-03-29T00:10:03.000Z",
          "Plan",
          explicitPlan
        ),
        agentMessage(
          "2026-03-29T00:10:04.000Z",
          "final_answer",
          "I found the root cause and I’m ready to implement."
        )
      ]
    );

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const prompt = store.listPrompts(workspace.id)[0]!;
    const detail = store.getPromptDetail(workspace.id, prompt.id)!;
    const planArtifact = detail.artifacts.find((artifact) => artifact.type === "plan");
    const finalOutputArtifact = detail.artifacts.find((artifact) => artifact.type === "final_output");

    expect(planArtifact).toBeTruthy();
    expect(store.readBlob(workspace.id, planArtifact?.blobId ?? "")).toBe(explicitPlan);
    expect(planArtifact?.metadataJson).toContain("Parse explicit plan items from the session log.");
    expect(store.readBlob(workspace.id, finalOutputArtifact?.blobId ?? "")).toBe(
      "I found the root cause and I’m ready to implement."
    );
  });

  test("imports embedded user-supplied plans from implementation prompts", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-user-plan-");
    const embeddedPlan = [
      "# Importer Plan",
      "",
      "## Summary",
      "",
      "Use the prompt body as the plan source.",
      "",
      "## Plan",
      "1. Parse the embedded markdown after the implementation prefix.",
      "2. Keep final output separate from the plan document."
    ].join("\n");

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "user-plan-prompt.jsonl",
      [
        eventMsg(
          "2026-03-29T00:15:01.000Z",
          "user_message",
          `PLEASE IMPLEMENT THIS PLAN:\n${embeddedPlan}`
        ),
        agentMessage(
          "2026-03-29T00:15:02.000Z",
          "final_answer",
          "Implemented the importer change and ran the tests."
        )
      ]
    );

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const prompt = store.listPrompts(workspace.id)[0]!;
    const detail = store.getPromptDetail(workspace.id, prompt.id)!;
    const planArtifact = detail.artifacts.find((artifact) => artifact.type === "plan")!;
    const finalOutputArtifact = detail.artifacts.find((artifact) => artifact.type === "final_output")!;

    expect(store.readBlob(workspace.id, planArtifact.blobId ?? "")).toBe(embeddedPlan);
    expect(store.readBlob(workspace.id, finalOutputArtifact.blobId ?? "")).toBe(
      "Implemented the importer change and ran the tests."
    );
    expect(planArtifact.summary).toBe("Parse the embedded markdown after the implementation prefix.");
  });

  test("uses only final-answer agent messages for imported final output and plan fallback", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-final-answer-");
    const finalAnswer = [
      "Here is the plan.",
      "",
      "1. Fix the importer.",
      "2. Re-run the backfill."
    ].join("\n");

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "final-answer-only.jsonl",
      [
        eventMsg("2026-03-29T00:20:01.000Z", "user_message", "Write a plan for the importer fix."),
        agentMessage(
          "2026-03-29T00:20:02.000Z",
          "commentary",
          "I’m reading the adapter, storage, and tests now."
        ),
        agentMessage(
          "2026-03-29T00:20:03.000Z",
          "commentary",
          "I’ve got the root cause pinned down."
        ),
        agentMessage("2026-03-29T00:20:04.000Z", "final_answer", finalAnswer)
      ]
    );

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const prompt = store.listPrompts(workspace.id)[0]!;
    const detail = store.getPromptDetail(workspace.id, prompt.id)!;
    const finalOutputArtifact = detail.artifacts.find((artifact) => artifact.type === "final_output")!;
    const planArtifact = detail.artifacts.find((artifact) => artifact.type === "plan")!;

    expect(store.readBlob(workspace.id, finalOutputArtifact.blobId ?? "")).toBe(finalAnswer);
    expect(store.readBlob(workspace.id, planArtifact.blobId ?? "")).toBe([
      "Here is the plan.",
      "",
      "## Plan",
      "",
      "1. Fix the importer.",
      "2. Re-run the backfill."
    ].join("\n"));
    expect(planArtifact.metadataJson).not.toContain("root cause pinned down");
  });

  test("stores plan-mode decision details inside the plan artifact and keeps the final plan clean", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-plan-decisions-");
    const finalAnswer = [
      "Which direction should I take?",
      "",
      "1. Keep it very simple and only fix the importer.",
      "2. Add the rebuild script in the same pass.",
      "",
      "## Plan",
      "",
      "1. Fix the importer classification path.",
      "2. Add the rebuild command once the importer is stable."
    ].join("\n");

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "plan-handoff.jsonl",
      [
        eventMsg("2026-03-29T00:25:01.000Z", "user_message", "Write a plan for the importer fix."),
        turnContext("2026-03-29T00:25:01.500Z", "plan"),
        agentMessage("2026-03-29T00:25:02.000Z", "final_answer", finalAnswer),
        eventMsg("2026-03-29T00:25:03.000Z", "user_message", "Let's do option 2.")
      ]
    );

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const promptWithPlan = store.listPrompts(workspace.id).find((prompt) => prompt.hasPlanArtifact)!;
    expect(promptWithPlan.mode).toBe("plan");
    const detail = store.getPromptDetail(workspace.id, promptWithPlan.id)!;
    const planArtifact = detail.artifacts.find((artifact) => artifact.type === "plan")!;
    const planMetadata = JSON.parse(planArtifact.metadataJson ?? "{}") as {
      decisions?: Array<{
        question?: string;
        userAnswer?: string;
        selectedOptionId?: string | null;
        selectedText?: string | null;
      }>;
    };

    expect(store.readBlob(workspace.id, planArtifact.blobId ?? "")).toBe([
      "## Plan",
      "",
      "1. Fix the importer classification path.",
      "2. Add the rebuild command once the importer is stable."
    ].join("\n"));
    expect(planMetadata.decisions).toHaveLength(1);
    expect(planMetadata.decisions?.[0]).toMatchObject({
      question: "Which direction should I take?",
      userAnswer: "Let's do option 2.",
      selectedOptionId: "2",
      selectedText: "Add the rebuild script in the same pass.",
    });
  });

  test("does not turn conceptual answers about plan artifacts into plan artifacts", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-conceptual-plan-talk-");
    const finalAnswer = [
      "I think this is worth doing, and I’d keep it very narrow at first.",
      "",
      "1. Track the question.",
      "2. Track the options.",
      "3. Track the chosen answer."
    ].join("\n");

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "conceptual-plan-talk.jsonl",
      [
        eventMsg(
          "2026-03-29T00:27:01.000Z",
          "user_message",
          "Let's think more about plan handoffs and how to track them."
        ),
        agentMessage("2026-03-29T00:27:02.000Z", "final_answer", finalAnswer)
      ]
    );

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const prompt = store.listPrompts(workspace.id)[0]!;
    const detail = store.getPromptDetail(workspace.id, prompt.id)!;

    expect(detail.artifacts.some((artifact) => artifact.type === "plan")).toBe(false);
    expect(detail.artifacts.some((artifact) => artifact.type === "final_output")).toBe(true);
  });

  test("does not invent plan artifacts for non-plan prompts with bullet lists", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-no-plan-fallback-");
    const finalAnswer = [
      "Implemented the importer fix.",
      "",
      "1. Added explicit plan-item parsing.",
      "2. Tightened final output extraction.",
      "3. Re-ran the tests."
    ].join("\n");

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "no-plan-fallback.jsonl",
      [
        eventMsg("2026-03-29T00:30:01.000Z", "user_message", "Fix the importer bug."),
        agentMessage("2026-03-29T00:30:02.000Z", "final_answer", finalAnswer)
      ]
    );

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const prompt = store.listPrompts(workspace.id)[0]!;
    const detail = store.getPromptDetail(workspace.id, prompt.id)!;

    expect(detail.artifacts.some((artifact) => artifact.type === "plan")).toBe(false);
    expect(detail.artifacts.some((artifact) => artifact.type === "final_output")).toBe(true);
  });

  test("keeps the terminal prompt open while tailing active sessions", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-open-");

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

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"), { tailOpenPrompt: true });
    const workspace = store.listWorkspaces()[0]!;
    const prompts = store.listPrompts(workspace.id);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.status).toBe("in_progress");
    expect(prompts[0]?.endedAt).toBeNull();
    expect(prompts[0]?.boundaryReason).toBeNull();
  });

  test("keeps embedded plans clean while tailing active sessions", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-open-user-plan-");
    const embeddedPlan = [
      "# Clean Tail Plan",
      "",
      "## Plan",
      "1. Prefer the embedded user markdown.",
      "2. Ignore live explanation chatter."
    ].join("\n");

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "open-user-plan.jsonl",
      [
        eventMsg(
          "2026-03-29T00:40:01.000Z",
          "user_message",
          `PLEASE IMPLEMENT THIS PLAN:\n${embeddedPlan}`
        ),
        agentMessage(
          "2026-03-29T00:40:02.000Z",
          "commentary",
          "I’ve got the root cause pinned down and I’m moving into the implementation now."
        )
      ]
    );

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"), { tailOpenPrompt: true });
    const workspace = store.listWorkspaces()[0]!;
    const prompt = store.listPrompts(workspace.id)[0]!;
    const detail = store.getPromptDetail(workspace.id, prompt.id)!;
    const planArtifact = detail.artifacts.find((artifact) => artifact.type === "plan")!;

    expect(prompt.status).toBe("in_progress");
    expect(store.readBlob(workspace.id, planArtifact.blobId ?? "")).toBe(embeddedPlan);
    expect(planArtifact.metadataJson).not.toContain("root cause pinned down");
  });

  test("carries plan-mode decisions forward to a later final plan artifact", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-plan-decision-chain-");

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "plan-decision-chain.jsonl",
      [
        eventMsg("2026-03-29T00:41:01.000Z", "user_message", "Help me plan the artifact redesign."),
        turnContext("2026-03-29T00:41:01.500Z", "plan"),
        agentMessage(
          "2026-03-29T00:41:02.000Z",
          "final_answer",
          [
            "Which direction should I take?",
            "",
            "1. Start with a tiny family/subtype pipeline.",
            "2. Rebuild the whole artifact stack at once.",
          ].join("\n")
        ),
        eventMsg("2026-03-29T00:41:03.000Z", "user_message", "Let's do option 1."),
        turnContext("2026-03-29T00:41:03.500Z", "plan"),
        agentMessage(
          "2026-03-29T00:41:04.000Z",
          "final_answer",
          [
            "## Plan",
            "",
            "1. Add family/subtype classification for command artifacts.",
            "2. Keep the UI simple in the first pass.",
          ].join("\n")
        )
      ]
    );

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const prompts = store.listPrompts(workspace.id);
    expect(prompts[0]?.mode).toBe("plan");
    expect(prompts[1]?.mode).toBe("plan");

    const finalPlanPrompt = prompts.find((prompt) => prompt.hasPlanArtifact && prompt.hasFinalResponse)!;
    const detail = store.getPromptDetail(workspace.id, finalPlanPrompt.id)!;
    const planArtifact = detail.artifacts.find((artifact) => artifact.type === "plan")!;
    const planMetadata = JSON.parse(planArtifact.metadataJson ?? "{}") as {
      decisions?: Array<{
        question?: string;
        userAnswer?: string;
        selectedOptionId?: string | null;
      }>;
    };

    expect(planMetadata.decisions).toHaveLength(1);
    expect(planMetadata.decisions?.[0]).toMatchObject({
      question: "Which direction should I take?",
      userAnswer: "Let's do option 1.",
      selectedOptionId: "1",
    });
    expect(store.readBlob(workspace.id, planArtifact.blobId ?? "")).toBe([
      "## Plan",
      "",
      "1. Add family/subtype classification for command artifacts.",
      "2. Keep the UI simple in the first pass.",
    ].join("\n"));
  });

  test("recovers code diffs from successful apply_patch custom tool calls", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-apply-patch-");
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

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const prompts = store.listPrompts(workspace.id);
    const detail = store.getPromptDetail(workspace.id, prompts[0]!.id);
    const diffArtifact = detail?.artifacts.find((artifact) => artifact.type === "code_diff") ?? null;

    expect(prompts[0]?.hasCodeDiff).toBe(true);
    expect(prompts[0]?.filesTouched).toEqual(["src/helper.ts"]);
    expect(diffArtifact?.metadataJson).toContain("\"source\":\"apply_patch\"");
    expect(diffArtifact?.metadataJson).toContain("\"sourceFormat\":\"codex_apply_patch\"");
    expect(store.readBlob(workspace.id, diffArtifact?.blobId ?? "")).toBe(patch);
  });

  test("ignores failed apply_patch attempts when a later retry succeeds", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-apply-patch-retry-");
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

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const prompt = store.listPrompts(workspace.id)[0]!;
    const detail = store.getPromptDetail(workspace.id, prompt.id)!;
    const diffArtifact = detail.artifacts.find((artifact) => artifact.type === "code_diff")!;

    expect(prompt.filesTouched).toEqual(["src/retry.ts"]);
    expect(store.readBlob(workspace.id, diffArtifact.blobId ?? "")).toBe(successfulPatch);
  });

  test("falls back to git diff command output when no apply_patch diff exists", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-git-diff-");
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

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const prompt = store.listPrompts(workspace.id)[0]!;
    const detail = store.getPromptDetail(workspace.id, prompt.id)!;
    const diffArtifact = detail.artifacts.find((artifact) => artifact.type === "code_diff")!;
    const commandArtifacts = detail.artifacts.filter((artifact) => artifact.type === "command_run");

    expect(prompt.hasCodeDiff).toBe(true);
    expect(prompt.filesTouched).toEqual(["src/app.ts"]);
    expect(diffArtifact.metadataJson).toContain("\"source\":\"git_diff_output\"");
    expect(store.readBlob(workspace.id, diffArtifact.blobId ?? "")).toBe(gitDiffOutput);
    expect(commandArtifacts).toHaveLength(0);
  });

  test("leaves prompts without patch or git diff data unchanged", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-no-diff-");

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

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const prompt = store.listPrompts(workspace.id)[0]!;

    expect(prompt.hasCodeDiff).toBe(false);
    expect(prompt.filesTouched).toEqual([]);
  });

  test("creates one command artifact per meaningful command and skips aggregate output artifacts", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-command-artifacts-");

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "command-artifacts.jsonl",
      [
        eventMsg("2026-03-29T04:30:01.000Z", "user_message", "Run the tests and keep going."),
        functionCall(
          "2026-03-29T04:30:02.000Z",
          "call_test",
          "exec_command",
          "{\"cmd\":\"pnpm test\"}"
        ),
        functionCallOutput("2026-03-29T04:30:03.000Z", "call_test", "Tests passed."),
        functionCall(
          "2026-03-29T04:30:04.000Z",
          "call_write",
          "write_stdin",
          "{\"session_id\":1,\"chars\":\"q\"}"
        ),
        functionCallOutput("2026-03-29T04:30:05.000Z", "call_write", "ok"),
        eventMsg("2026-03-29T04:30:06.000Z", "agent_message", "Everything passed.")
      ]
    );

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const prompt = store.listPrompts(workspace.id)[0]!;
    const detail = store.getPromptDetail(workspace.id, prompt.id)!;
    const testArtifacts = detail.artifacts.filter((artifact) => artifact.type === "test_run");
    const testMetadata = JSON.parse(testArtifacts[0]?.metadataJson ?? "{}") as {
      classification?: { family?: string; subtype?: string; displayLabel?: string };
    };

    expect(testArtifacts).toHaveLength(1);
    expect(testArtifacts[0]?.summary).toBe("pnpm test");
    expect(store.readBlob(workspace.id, testArtifacts[0]?.blobId ?? "")).toBe("pnpm test\n\nTests passed.");
    expect(testMetadata.classification).toEqual({
      family: "verification",
      subtype: "verification.test",
      displayLabel: "test",
    });
    expect(detail.artifacts.some((artifact) => artifact.summary === "Function call output")).toBe(false);
    expect(detail.artifacts.some((artifact) => artifact.summary === "write_stdin")).toBe(false);
  });

  test("classifies non-test commands into simple execution families", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-command-classification-");

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "command-classification.jsonl",
      [
        eventMsg("2026-03-29T04:45:01.000Z", "user_message", "Inspect the repo."),
        functionCall(
          "2026-03-29T04:45:02.000Z",
          "call_search",
          "exec_command",
          "{\"cmd\":\"rg artifact packages\"}"
        ),
        functionCallOutput("2026-03-29T04:45:03.000Z", "call_search", "packages/domain/src/index.ts"),
        functionCall(
          "2026-03-29T04:45:04.000Z",
          "call_status",
          "exec_command",
          "{\"cmd\":\"git status --short\"}"
        ),
        functionCallOutput("2026-03-29T04:45:05.000Z", "call_status", " M packages/codex-adapter/src/index.ts"),
        eventMsg("2026-03-29T04:45:06.000Z", "agent_message", "Done.")
      ]
    );

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const prompt = store.listPrompts(workspace.id)[0]!;
    const detail = store.getPromptDetail(workspace.id, prompt.id)!;
    const searchArtifact = detail.artifacts.find((artifact) => artifact.summary === "rg artifact packages")!;
    const statusArtifact = detail.artifacts.find((artifact) => artifact.summary === "git status --short")!;

    expect(JSON.parse(searchArtifact.metadataJson ?? "{}").classification).toEqual({
      family: "execution",
      subtype: "execution.search",
      displayLabel: "search",
    });
    expect(JSON.parse(statusArtifact.metadataJson ?? "{}").classification).toEqual({
      family: "execution",
      subtype: "execution.git_status",
      displayLabel: "git status",
    });
  });

  test("does not misclassify filenames that contain test runner words as test runs", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-no-filename-test-match-");

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "no-filename-test-match.jsonl",
      [
        eventMsg("2026-03-29T04:50:01.000Z", "user_message", "Inspect the files."),
        functionCall(
          "2026-03-29T04:50:02.000Z",
          "call_diff",
          "exec_command",
          "{\"cmd\":\"git diff -- packages/domain/src/index.test.ts\"}"
        ),
        functionCallOutput("2026-03-29T04:50:03.000Z", "call_diff", "diff --git a/packages/domain/src/index.test.ts b/packages/domain/src/index.test.ts"),
        functionCall(
          "2026-03-29T04:50:04.000Z",
          "call_read",
          "exec_command",
          "{\"cmd\":\"Get-Content vitest.config.ts\"}"
        ),
        functionCallOutput("2026-03-29T04:50:05.000Z", "call_read", "import { defineConfig } from 'vitest/config';"),
        eventMsg("2026-03-29T04:50:06.000Z", "agent_message", "Done.")
      ]
    );

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const prompt = store.listPrompts(workspace.id)[0]!;
    const detail = store.getPromptDetail(workspace.id, prompt.id)!;

    expect(detail.artifacts.some((artifact) => artifact.type === "test_run")).toBe(false);
    expect(detail.artifacts.some((artifact) => artifact.summary === "Get-Content vitest.config.ts")).toBe(true);
  });

  test("keeps recovered diffs on open tailed prompts", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-open-diff-");
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

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"), { tailOpenPrompt: true });
    const workspace = store.listWorkspaces()[0]!;
    const prompt = store.listPrompts(workspace.id)[0]!;

    expect(prompt.status).toBe("in_progress");
    expect(prompt.hasCodeDiff).toBe(true);
    expect(prompt.filesTouched).toEqual(["src/open.ts"]);
  });

  test("keeps the next prompt's mirrored user response out of the previous transcript window", () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-import-next-user-boundary-");

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "next-user-boundary.jsonl",
      [
        eventMsg("2026-03-29T05:10:01.000Z", "user_message", "First prompt."),
        agentMessage("2026-03-29T05:10:02.000Z", "final_answer", "First answer."),
        userResponseItem("2026-03-29T05:10:03.000Z", "Second prompt."),
        eventMsg("2026-03-29T05:10:03.000Z", "user_message", "Second prompt."),
        agentMessage("2026-03-29T05:10:04.000Z", "final_answer", "Second answer.")
      ]
    );

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));
    const workspace = store.listWorkspaces()[0]!;
    const prompts = store.listPrompts(workspace.id);
    const firstPrompt = prompts.find((prompt) => prompt.promptSummary === "First prompt.")!;
    const firstDetail = store.getPromptDetail(workspace.id, firstPrompt.id)!;

    expect(firstPrompt.endedAt).toBe("2026-03-29T05:10:02.000Z");
    expect(
      firstDetail.transcript.some(
        (entry) =>
          entry.kind === "message"
          && entry.role === "user"
          && entry.text === "Second prompt."
      )
    ).toBe(false);
  });

  test("ignores nested cwd values unless that exact folder has its own .git directory", () => {
    const root = mkdtempSync(join(tmpdir(), "promptreel-import-grouping-"));
    const repoPath = join(root, "repo");
    const nestedPath = join(repoPath, "packages", "ui");
    const sessionsRoot = join(root, "sessions", "2026", "03", "29");
    mkdirSync(nestedPath, { recursive: true });
    mkdirSync(sessionsRoot, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });

    writeCodexSession(
      sessionsRoot,
      repoPath,
      "root-workspace.jsonl",
      [eventMsg("2026-03-29T06:00:01.000Z", "user_message", "Root prompt.")]
    );
    writeFileSync(
      join(sessionsRoot, "nested-workspace.jsonl"),
      [
        `{"timestamp":"2026-03-29T06:00:00.000Z","type":"session_meta","payload":{"id":"session-nested","cwd":"${nestedPath.replace(/\\/g, "\\\\")}","source":"vscode"}}`,
        eventMsg("2026-03-29T06:00:01.000Z", "user_message", "Nested prompt.")
      ].join("\n"),
      "utf8"
    );

    const store = new PromptreelStore(join(root, ".pl"));
    importCodexSessions(store, join(root, "sessions"));

    const workspaces = store.listWorkspaces();

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.folderPath).toBe(repoPath);
  });

  test("watches for newly created session files after startup", async () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-tailer-watch-new-");
    const store = new PromptreelStore(join(root, ".pl"));
    const tailer = new CodexSessionTailer(store, join(root, "sessions"), 0);

    try {
      tailer.start();
      writeCodexSession(
        sessionsRoot,
        repoPath,
        "new-session.jsonl",
        [
          eventMsg("2026-03-29T07:00:01.000Z", "user_message", "Watch for this prompt."),
          agentMessage("2026-03-29T07:00:02.000Z", "commentary", "Still working.")
        ]
      );

      await waitForCondition(() => store.listWorkspaces().length === 1);
      const workspace = store.listWorkspaces()[0]!;
      await waitForCondition(() => store.listPrompts(workspace.id).length === 1);

      expect(store.listPrompts(workspace.id)[0]?.status).toBe("in_progress");
      expect(tailer.getStatus().workspaceStatuses[0]?.sessionFileCount).toBe(1);
    } finally {
      tailer.stop();
    }
  });

  test("re-imports an active session file when Codex appends more events", async () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-tailer-watch-append-");
    writeCodexSession(
      sessionsRoot,
      repoPath,
      "active-session.jsonl",
      [eventMsg("2026-03-29T08:00:01.000Z", "user_message", "First prompt.")]
    );
    const store = new PromptreelStore(join(root, ".pl"));
    const tailer = new CodexSessionTailer(store, join(root, "sessions"), 0);

    try {
      tailer.start();
      await waitForCondition(() => store.listWorkspaces().length === 1);
      const workspace = store.listWorkspaces()[0]!;
      await waitForCondition(() => store.listPrompts(workspace.id).length === 1);

      appendFileSync(
        join(sessionsRoot, "active-session.jsonl"),
        [
          "",
          agentMessage("2026-03-29T08:00:02.000Z", "final_answer", "First answer."),
          eventMsg("2026-03-29T08:00:03.000Z", "user_message", "Second prompt."),
          agentMessage("2026-03-29T08:00:04.000Z", "commentary", "Working on the second prompt.")
        ].join("\n"),
        "utf8"
      );

      await waitForCondition(() => store.listPrompts(workspace.id).length === 2);
      const prompts = store.listPrompts(workspace.id);
      const firstPrompt = prompts.find((prompt) => prompt.promptSummary === "First prompt.")!;
      const secondPrompt = prompts.find((prompt) => prompt.promptSummary === "Second prompt.")!;
      const firstPromptDetail = store.getPromptDetail(workspace.id, firstPrompt.id)!;

      expect(firstPrompt.status).toBe("imported");
      expect(secondPrompt.status).toBe("in_progress");
      expect(firstPromptDetail.artifacts.some((artifact) => artifact.type === "final_output")).toBe(true);
      expect(tailer.getStatus().workspaceStatuses[0]?.sessionFileCount).toBe(1);
    } finally {
      tailer.stop();
    }
  });

  test("buffers partial appended jsonl lines until the event completes", async () => {
    const { root, repoPath, sessionsRoot } = createImportHarness("promptreel-tailer-watch-partial-");
    writeCodexSession(
      sessionsRoot,
      repoPath,
      "partial-session.jsonl",
      [eventMsg("2026-03-29T09:00:01.000Z", "user_message", "Keep going.")]
    );
    const store = new PromptreelStore(join(root, ".pl"));
    const tailer = new CodexSessionTailer(store, join(root, "sessions"), 0);

    try {
      tailer.start();
      await waitForCondition(() => store.listWorkspaces().length === 1);
      const workspace = store.listWorkspaces()[0]!;
      await waitForCondition(() => store.listPrompts(workspace.id).length === 1);

      appendFileSync(
        join(sessionsRoot, "partial-session.jsonl"),
        `\n{"timestamp":"2026-03-29T09:00:02.000Z","type":"event_msg","payload":{"type":"agent_message","phase":"final_answer"`,
        "utf8"
      );

      await new Promise((resolve) => setTimeout(resolve, 250));
      let detail = store.getPromptDetail(workspace.id, store.listPrompts(workspace.id)[0]!.id)!;
      expect(detail.artifacts.some((artifact) => artifact.type === "final_output")).toBe(false);

      appendFileSync(
        join(sessionsRoot, "partial-session.jsonl"),
        `,"message":"Done."}}\n`,
        "utf8"
      );

      await waitForCondition(() => {
        const nextDetail = store.getPromptDetail(workspace.id, store.listPrompts(workspace.id)[0]!.id);
        return Boolean(nextDetail?.artifacts.some((artifact) => artifact.type === "final_output"));
      });

      detail = store.getPromptDetail(workspace.id, store.listPrompts(workspace.id)[0]!.id)!;
      expect(store.readBlob(workspace.id, detail.artifacts.find((artifact) => artifact.type === "final_output")?.blobId ?? "")).toBe("Done.");
      expect(store.listPrompts(workspace.id)).toHaveLength(1);
    } finally {
      tailer.stop();
    }
  });

  test("emits canonical workspace ids for moved manual workspaces on append updates", async () => {
    const root = mkdtempSync(join(tmpdir(), "promptreel-tailer-moved-workspace-"));
    const originalRepoPath = join(root, "repo-original");
    const movedRepoPath = join(root, "repo-moved");
    const sessionsRoot = join(root, "sessions", "2026", "03", "29");
    mkdirSync(originalRepoPath, { recursive: true });
    mkdirSync(sessionsRoot, { recursive: true });
    execFileSync("git", ["init"], { cwd: originalRepoPath, stdio: "ignore" });

    const store = new PromptreelStore(join(root, ".pl"));
    store.addRepo(originalRepoPath);
    const originalWorkspace = store.listWorkspaces()[0]!;
    const movedWorkspaceId = workspaceGroupId(movedRepoPath);

    renameSync(originalRepoPath, movedRepoPath);
    writeCodexSession(
      sessionsRoot,
      movedRepoPath,
      "moved-session.jsonl",
      [eventMsg("2026-03-29T10:00:01.000Z", "user_message", "First prompt.")]
    );

    const tailer = new CodexSessionTailer(store, join(root, "sessions"), 0);
    const updates: Array<{ kind: string; workspaceIds: string[] }> = [];
    const unsubscribe = tailer.subscribe((update) => {
      updates.push({
        kind: update.kind,
        workspaceIds: [...update.workspaceIds],
      });
    });

    try {
      tailer.start();
      await waitForCondition(() => store.listWorkspaces()[0]?.folderPath === movedRepoPath);
      await waitForCondition(() => store.listPrompts(originalWorkspace.id).length === 1);

      expect(store.listWorkspaces()[0]?.id).toBe(originalWorkspace.id);
      expect(originalWorkspace.id).not.toBe(movedWorkspaceId);

      updates.length = 0;
      appendFileSync(
        join(sessionsRoot, "moved-session.jsonl"),
        [
          "",
          agentMessage("2026-03-29T10:00:02.000Z", "final_answer", "First answer."),
          eventMsg("2026-03-29T10:00:03.000Z", "user_message", "Second prompt."),
        ].join("\n"),
        "utf8"
      );

      await waitForCondition(() => store.listPrompts(originalWorkspace.id).length === 2);
      await waitForCondition(() => updates.some((update) => update.kind === "ingest"));

      expect(updates.some((update) => update.workspaceIds.includes(originalWorkspace.id))).toBe(true);
      expect(updates.some((update) => update.workspaceIds.includes(movedWorkspaceId))).toBe(false);
    } finally {
      unsubscribe();
      tailer.stop();
    }
  });

  test("uses a shorter watcher debounce for tracked live session files", () => {
    expect(resolveSessionWatchDebounceMs({
      isTrackedSessionFile: false,
      hasOpenPrompt: false,
      wasRecentlyUpdated: false
    })).toBe(150);

    expect(resolveSessionWatchDebounceMs({
      isTrackedSessionFile: true,
      hasOpenPrompt: true,
      wasRecentlyUpdated: false
    })).toBe(ACTIVE_SESSION_WATCH_DEBOUNCE_MS);

    expect(resolveSessionWatchDebounceMs({
      isTrackedSessionFile: true,
      hasOpenPrompt: false,
      wasRecentlyUpdated: true
    })).toBe(ACTIVE_SESSION_WATCH_DEBOUNCE_MS);

    expect(resolveSessionWatchDebounceMs({
      isTrackedSessionFile: true,
      hasOpenPrompt: false,
      wasRecentlyUpdated: false
    })).toBe(150);
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

function userResponseItem(timestamp: string, message: string): string {
  return `{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"${escapeJson(message)}"}]}}`;
}

function agentMessage(timestamp: string, phase: string, message: string): string {
  return `{"timestamp":"${timestamp}","type":"event_msg","payload":{"type":"agent_message","phase":"${phase}","message":"${escapeJson(message)}"}}`;
}

function itemCompleted(timestamp: string, itemType: string, text: string): string {
  return `{"timestamp":"${timestamp}","type":"event_msg","payload":{"type":"item_completed","item":{"type":"${itemType}","text":"${escapeJson(text)}"}}}`;
}

function turnContext(timestamp: string, mode: "default" | "plan"): string {
  return `{"timestamp":"${timestamp}","type":"turn_context","payload":{"turn_id":"turn-${mode}","collaboration_mode":{"mode":"${mode}"}}}`;
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

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 3_000,
  intervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
