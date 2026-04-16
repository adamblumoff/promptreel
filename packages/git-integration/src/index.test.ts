import { describe, expect, test } from "vitest";
import {
  CURRENT_CODE_DIFF_PARSER_VERSION,
  buildCodeDiffArtifact,
  mergeCodeDiffs,
  parseApplyPatchToCodeDiff,
  parseStoredCodeDiffPatch,
  parseUnifiedDiffToCodeDiff
} from "./index.js";

describe("git integration diff parsers", () => {
  test("parses apply_patch add operations", () => {
    const diff = parseApplyPatchToCodeDiff(`*** Begin Patch
*** Add File: src/new-file.ts
+export const value = 1;
*** End Patch`);

    expect(diff?.files).toEqual([{
      path: "src/new-file.ts",
      changeType: "added",
      additions: 1,
      deletions: 0,
      hunkCount: 0
    }]);
  });

  test("parses apply_patch update operations", () => {
    const diff = parseApplyPatchToCodeDiff(`*** Begin Patch
*** Update File: src/existing.ts
@@
-old
+new
*** End Patch`);

    expect(diff?.files).toEqual([{
      path: "src/existing.ts",
      changeType: "modified",
      additions: 1,
      deletions: 1,
      hunkCount: 1
    }]);
  });

  test("parses apply_patch delete operations", () => {
    const diff = parseApplyPatchToCodeDiff(`*** Begin Patch
*** Delete File: src/old.ts
*** End Patch`);

    expect(diff?.files).toEqual([{
      path: "src/old.ts",
      changeType: "deleted",
      additions: 0,
      deletions: 0,
      hunkCount: 0
    }]);
  });

  test("merges multiple code diffs in order and de-duplicates files", () => {
    const merged = mergeCodeDiffs([
      parseApplyPatchToCodeDiff(`*** Begin Patch
*** Update File: src/a.ts
@@
-one
+two
*** End Patch`)!,
      parseApplyPatchToCodeDiff(`*** Begin Patch
*** Update File: src/a.ts
@@
-two
+three
*** Update File: src/b.ts
@@
-left
+right
*** End Patch`)!
    ]);

    expect(merged.files).toEqual([
      { path: "src/a.ts", changeType: "modified", additions: 1, deletions: 1, hunkCount: 1 },
      { path: "src/b.ts", changeType: "modified", additions: 1, deletions: 1, hunkCount: 1 }
    ]);
    expect(merged.patch).toContain("src/a.ts");
    expect(merged.patch).toContain("src/b.ts");
  });

  test("parses unified diff output with leading shell noise", () => {
    const rawOutput = `Command: "pwsh" -Command 'git diff -- src/app.ts'
Chunk ID: abc123
Output:
diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
`;
    const diff = parseUnifiedDiffToCodeDiff(rawOutput);

    expect(diff?.patch).toBe(rawOutput);
    expect(diff?.files).toEqual([{
      path: "src/app.ts",
      oldPath: "src/app.ts",
      newPath: "src/app.ts",
      changeType: "modified",
      additions: 1,
      deletions: 1,
      hunkCount: 1
    }]);
  });

  test("parses unified diff output with multiple file sections", () => {
    const diff = parseUnifiedDiffToCodeDiff(`diff --git a/src/added.ts b/src/added.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1 @@
+export const added = true;
diff --git a/src/removed.ts b/src/removed.ts
deleted file mode 100644
index 2222222..0000000
--- a/src/removed.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const removed = true;
`);

    expect(diff?.files).toEqual([
      {
        path: "src/added.ts",
        oldPath: "/dev/null",
        newPath: "src/added.ts",
        changeType: "added",
        additions: 1,
        deletions: 0,
        hunkCount: 1
      },
      {
        path: "src/removed.ts",
        oldPath: "src/removed.ts",
        newPath: "/dev/null",
        changeType: "deleted",
        additions: 0,
        deletions: 1,
        hunkCount: 1
      }
    ]);
  });

  test("parses stored unified diff patches without shell noise", () => {
    const parsed = parseStoredCodeDiffPatch(`diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
`, "unified_diff");

    expect(parsed?.files[0]).toMatchObject({
      path: "src/app.ts",
      changeType: "modified",
      additions: 1,
      deletions: 1,
      hunkCount: 1
    });
  });

  test("parses stored unified diff patches with transcript wrappers between file sections", () => {
    const parsed = parseStoredCodeDiffPatch(`Chunk ID: d5cd7c
Wall time: 0.1909 seconds
Process exited with code 0
Original token count: 1134
Output:
warning: in the working copy of 'packages/codex-adapter/src/index.ts', LF will be replaced by CRLF the next time Git touches it
diff --git a/packages/codex-adapter/src/index.ts b/packages/codex-adapter/src/index.ts
index fcc44f8..a689aeb 100644
--- a/packages/codex-adapter/src/index.ts
+++ b/packages/codex-adapter/src/index.ts
@@ -1 +1 @@
-old
+new
Chunk ID: 434664
Wall time: 0.1481 seconds
Process exited with code 0
Original token count: 437
Output:
warning: in the working copy of 'packages/storage/src/index.ts', LF will be replaced by CRLF the next time Git touches it
diff --git a/packages/storage/src/index.ts b/packages/storage/src/index.ts
index 01fe5a4..164d31d 100644
--- a/packages/storage/src/index.ts
+++ b/packages/storage/src/index.ts
@@ -10 +10 @@
-before
+after
`, "unified_diff");

    expect(parsed?.files).toEqual([
      {
        path: "packages/codex-adapter/src/index.ts",
        oldPath: "packages/codex-adapter/src/index.ts",
        newPath: "packages/codex-adapter/src/index.ts",
        changeType: "modified",
        additions: 1,
        deletions: 1,
        hunkCount: 1
      },
      {
        path: "packages/storage/src/index.ts",
        oldPath: "packages/storage/src/index.ts",
        newPath: "packages/storage/src/index.ts",
        changeType: "modified",
        additions: 1,
        deletions: 1,
        hunkCount: 1
      }
    ]);
  });

  test("writes parser version metadata on code diff artifacts", () => {
    const diff = parseApplyPatchToCodeDiff(`*** Begin Patch
*** Update File: src/example.ts
@@
-before
+after
*** End Patch`)!;
    const artifact = buildCodeDiffArtifact("prompt_123", diff, { sourceFormat: "codex_apply_patch" });

    expect(artifact.metadataJson).toContain(`"parserVersion":${CURRENT_CODE_DIFF_PARSER_VERSION}`);
  });
});
