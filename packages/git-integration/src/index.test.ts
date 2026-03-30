import { describe, expect, test } from "vitest";
import {
  mergeCodeDiffs,
  parseApplyPatchToCodeDiff,
  parseUnifiedDiffToCodeDiff
} from "./index";

describe("git integration diff parsers", () => {
  test("parses apply_patch add operations", () => {
    const diff = parseApplyPatchToCodeDiff(`*** Begin Patch
*** Add File: src/new-file.ts
+export const value = 1;
*** End Patch`);

    expect(diff?.files).toEqual([{ path: "src/new-file.ts", changeType: "added" }]);
  });

  test("parses apply_patch update operations", () => {
    const diff = parseApplyPatchToCodeDiff(`*** Begin Patch
*** Update File: src/existing.ts
@@
-old
+new
*** End Patch`);

    expect(diff?.files).toEqual([{ path: "src/existing.ts", changeType: "modified" }]);
  });

  test("parses apply_patch delete operations", () => {
    const diff = parseApplyPatchToCodeDiff(`*** Begin Patch
*** Delete File: src/old.ts
*** End Patch`);

    expect(diff?.files).toEqual([{ path: "src/old.ts", changeType: "deleted" }]);
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
      { path: "src/a.ts", changeType: "modified" },
      { path: "src/b.ts", changeType: "modified" }
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
    expect(diff?.files).toEqual([{ path: "src/app.ts", changeType: "modified" }]);
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
      { path: "src/added.ts", changeType: "added" },
      { path: "src/removed.ts", changeType: "deleted" }
    ]);
  });
});
