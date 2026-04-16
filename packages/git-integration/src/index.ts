import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createTwoFilesPatch, parsePatch } from "diff";
import type {
  ArtifactRecord,
  CodeDiffDisplayArtifact,
  CodeDiffDisplayBlock,
  CodeDiffDisplayFile,
  CodeDiffDisplayRow,
  CodeDiffResult,
  WorkspaceFileState,
  WorkspaceSnapshotData
} from "@promptreel/domain";
import { createId, hashValue, nowIso } from "@promptreel/domain";

type FileChange = CodeDiffResult["files"][number];

export interface CodeDiffArtifactMetadata {
  source?: "apply_patch" | "git_diff_output" | "app_server_diff" | "snapshot_diff";
  sourceFormat?: "codex_apply_patch" | "unified_diff";
  parserVersion?: number;
}

export const CURRENT_CODE_DIFF_PARSER_VERSION = 2;

function git(repoPath: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

function listDirtyFiles(repoPath: string): Array<{ status: string; path: string }> {
  const output = git(repoPath, ["status", "--porcelain=v1"]);
  if (!output) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || "??";
      const path = line.slice(3).trim();
      return { status, path };
    });
}

function fileHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function readTextIfPossible(path: string): { hash: string | null; content: string | null } {
  if (!existsSync(path)) {
    return { hash: null, content: null };
  }
  const content = readFileSync(path);
  return {
    hash: fileHash(content),
    content: content.toString("utf8")
  };
}

export function captureWorkspaceSnapshot(repoPath: string): WorkspaceSnapshotData {
  const headSha = git(repoPath, ["rev-parse", "HEAD"]) || null;
  const branchName = git(repoPath, ["branch", "--show-current"]) || null;
  const statusOutput = git(repoPath, ["status", "--short", "--branch"]);
  const dirtyFiles = listDirtyFiles(repoPath);
  const files: WorkspaceFileState[] = dirtyFiles.map((entry) => {
    const absolute = join(repoPath, entry.path);
    const state = readTextIfPossible(absolute);
    return {
      path: entry.path,
      status: entry.status,
      hash: state.hash,
      content: state.content
    };
  });
  return {
    repoPath,
    headSha,
    branchName,
    gitStatusSummary: statusOutput,
    dirtyFileHashes: Object.fromEntries(files.map((file) => [file.path, file.hash])),
    files
  };
}

export function createPlaceholderSnapshot(repoPath: string, note: string): WorkspaceSnapshotData {
  return {
    repoPath,
    headSha: null,
    branchName: null,
    gitStatusSummary: note,
    dirtyFileHashes: {},
    files: [],
    note
  };
}

export function buildCodeDiff(
  before: WorkspaceSnapshotData,
  after: WorkspaceSnapshotData
): CodeDiffResult | null {
  const beforeFiles = new Map(before.files.map((file) => [file.path, file]));
  const afterFiles = new Map(after.files.map((file) => [file.path, file]));
  const allPaths = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
  const patches: string[] = [];
  const files: CodeDiffResult["files"] = [];

  for (const path of [...allPaths].sort()) {
    const left = beforeFiles.get(path);
    const right = afterFiles.get(path);
    const beforeContent = left?.content ?? "";
    const afterContent = right?.content ?? "";
    if (beforeContent === afterContent && left?.status === right?.status) {
      continue;
    }
    const changeType = !left ? "added" : !right ? "deleted" : "modified";
    const patch = createTwoFilesPatch(path, path, beforeContent, afterContent, left?.status ?? "before", right?.status ?? "after");
    const delta = countPatchDeltaLines(patch);
    files.push({ path, changeType, additions: delta.additions, deletions: delta.deletions, hunkCount: delta.hunkCount });
    patches.push(patch);
  }

  if (patches.length === 0) {
    return null;
  }

  const patch = patches.join("\n");
  return {
    patch,
    files,
    patchIdentity: hashValue(patch)
  };
}

export function parseApplyPatchToCodeDiff(input: string): CodeDiffResult | null {
  const files: Array<FileChange & { additions?: number; deletions?: number; hunkCount?: number }> = [];
  const lines = input.split(/\r?\n/);
  let current:
    | (FileChange & {
        additions: number;
        deletions: number;
        hunkCount: number;
      })
    | null = null;

  const flushCurrent = () => {
    if (!current) {
      return;
    }
    files.push(current);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("*** Add File: ")) {
      flushCurrent();
      current = {
        path: normalizeDiffPath(line.slice("*** Add File: ".length)),
        changeType: "added",
        additions: 0,
        deletions: 0,
        hunkCount: 0
      };
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      flushCurrent();
      current = {
        path: normalizeDiffPath(line.slice("*** Delete File: ".length)),
        changeType: "deleted",
        additions: 0,
        deletions: 0,
        hunkCount: 0
      };
      continue;
    }
    if (!line.startsWith("*** Update File: ")) {
      if (!current) {
        continue;
      }
      if (line === "@@") {
        current.hunkCount += 1;
        continue;
      }
      if (line.startsWith("+")) {
        current.additions += 1;
        continue;
      }
      if (line.startsWith("-")) {
        current.deletions += 1;
      }
      continue;
    }

    flushCurrent();
    const sourcePath = normalizeDiffPath(line.slice("*** Update File: ".length));
    const moveLine = lines[index + 1] ?? "";
    if (moveLine.startsWith("*** Move to: ")) {
      files.push({ path: sourcePath, changeType: "deleted", additions: 0, deletions: 0, hunkCount: 0 });
      files.push({
        path: normalizeDiffPath(moveLine.slice("*** Move to: ".length)),
        changeType: "added",
        additions: 0,
        deletions: 0,
        hunkCount: 0
      });
      index += 1;
      continue;
    }

    current = {
      path: sourcePath,
      changeType: "modified",
      additions: 0,
      deletions: 0,
      hunkCount: 0
    };
  }

  flushCurrent();
  return toCodeDiffResult(input, files);
}

export function parseStoredCodeDiffPatch(
  patch: string,
  sourceFormat?: CodeDiffArtifactMetadata["sourceFormat"] | null
): CodeDiffResult | null {
  if (sourceFormat === "codex_apply_patch") {
    return parseApplyPatchToCodeDiff(patch);
  }
  if (sourceFormat === "unified_diff") {
    return parseUnifiedDiffToCodeDiff(patch);
  }
  if (patch.includes("*** Begin Patch") || patch.includes("*** Update File:") || patch.includes("*** Add File:")) {
    return parseApplyPatchToCodeDiff(patch);
  }
  return parseUnifiedDiffToCodeDiff(patch);
}

export function buildCodeDiffDisplay(
  patch: string,
  sourceFormat?: CodeDiffArtifactMetadata["sourceFormat"] | null
): CodeDiffDisplayFile[] {
  if (sourceFormat === "codex_apply_patch") {
    return buildCodexDiffDisplay(patch);
  }
  if (sourceFormat === "unified_diff") {
    return buildUnifiedDiffDisplay(patch);
  }
  if (patch.includes("*** Begin Patch") || patch.includes("*** Update File:") || patch.includes("*** Add File:")) {
    return buildCodexDiffDisplay(patch);
  }
  return buildUnifiedDiffDisplay(patch);
}

export function buildCodeDiffDisplayArtifact(input: {
  artifactId: string;
  summary: string;
  patch: string;
  sourceFormat?: CodeDiffArtifactMetadata["sourceFormat"] | null;
}): CodeDiffDisplayArtifact {
  return {
    artifactId: input.artifactId,
    summary: input.summary,
    files: buildCodeDiffDisplay(input.patch, input.sourceFormat)
  };
}

export function parseUnifiedDiffToCodeDiff(output: string): CodeDiffResult | null {
  const diffBody = sanitizeUnifiedDiffText(output);
  if (!diffBody) {
    return null;
  }

  const sections = collectUnifiedDiffSections(diffBody);
  const statsBySectionKey = new Map<string, { additions: number; deletions: number; hunkCount: number }>();
  try {
    const parsedFiles = parsePatch(diffBody);
    for (const parsed of parsedFiles) {
      const oldPath = normalizePatchFileName(parsed.oldFileName);
      const newPath = normalizePatchFileName(parsed.newFileName);
      const stats = summarizeParsedPatchFile(parsed);
      statsBySectionKey.set(buildSectionKey(oldPath, newPath), stats);
    }
  } catch {
    // Some historical blobs include terminal transcript wrappers between diff
    // sections. We still return section-level file data when patch parsing fails.
  }

  const files = sections.map((section) => {
    const stats = statsBySectionKey.get(buildSectionKey(section.oldPath, section.newPath))
      ?? { additions: 0, deletions: 0, hunkCount: 0 };
    return {
      path: section.changeType === "deleted" ? section.oldPath : (section.newPath || section.oldPath),
      oldPath: section.oldPath || undefined,
      newPath: section.newPath || undefined,
      changeType: section.changeType,
      additions: stats.additions,
      deletions: stats.deletions,
      hunkCount: stats.hunkCount
    };
  });

  return toCodeDiffResult(output, files);
}

export function mergeCodeDiffs(diffs: CodeDiffResult[]): CodeDiffResult {
  const patch = joinPatchSegments(diffs.map((diff) => diff.patch));
  return {
    patch,
    files: mergeFileChanges(diffs.flatMap((diff) => diff.files)),
    patchIdentity: hashValue(patch)
  };
}

export function buildCodeDiffArtifact(
  promptEventId: string,
  diff: CodeDiffResult,
  metadata: CodeDiffArtifactMetadata = {}
): ArtifactRecord {
  return {
    id: createId("artifact"),
    promptEventId,
    type: "code_diff",
    role: "secondary",
    summary: `${diff.files.length} file(s) changed`,
    blobId: null,
    fileStatsJson: JSON.stringify(diff.files),
    metadataJson: JSON.stringify({
      generatedAt: nowIso(),
      patchIdentity: diff.patchIdentity,
      parserVersion: CURRENT_CODE_DIFF_PARSER_VERSION,
      ...metadata
    })
  };
}

export function repoRelativePath(repoPath: string, absolutePath: string): string {
  return relative(repoPath, absolutePath).replace(/\\/g, "/");
}

function toCodeDiffResult(patch: string, files: FileChange[]): CodeDiffResult | null {
  const mergedFiles = mergeFileChanges(files);
  if (mergedFiles.length === 0) {
    return null;
  }
  return {
    patch,
    files: mergedFiles,
    patchIdentity: hashValue(patch)
  };
}

function mergeFileChanges(files: FileChange[]): FileChange[] {
  const merged: FileChange[] = [];
  const indexByPath = new Map<string, number>();

  for (const file of files) {
    const normalizedPath = normalizeDiffPath(file.path);
    if (!normalizedPath) {
      continue;
    }
    const existingIndex = indexByPath.get(normalizedPath);
    if (existingIndex === undefined) {
      indexByPath.set(normalizedPath, merged.length);
      merged.push({ ...file, path: normalizedPath });
      continue;
    }
    merged[existingIndex] = { ...file, path: normalizedPath };
  }

  return merged;
}

function joinPatchSegments(segments: string[]): string {
  let merged = "";
  for (const segment of segments.filter((value) => value.length > 0)) {
    if (merged.length > 0 && !merged.endsWith("\n")) {
      merged += "\n";
    }
    if (merged.length > 0 && !segment.startsWith("\n")) {
      merged += "\n";
    }
    merged += segment;
  }
  return merged;
}

function normalizeDiffPath(path: string): string {
  return path.trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
}

function normalizePatchFileName(path: string | undefined): string {
  if (!path) {
    return "";
  }
  if (path === "/dev/null") {
    return path;
  }
  return normalizeDiffPath(path.replace(/^[ab]\//, ""));
}

function sanitizeUnifiedDiffText(output: string): string | null {
  const kept: string[] = [];
  let inDiff = false;
  let inHunk = false;
  let inBinaryPatch = false;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      kept.push(line);
      inDiff = true;
      inHunk = false;
      inBinaryPatch = false;
      continue;
    }

    if (!inDiff) {
      continue;
    }

    if (isCapturedDiffNoise(line)) {
      inHunk = false;
      inBinaryPatch = false;
      continue;
    }

    if (inBinaryPatch) {
      kept.push(line);
      continue;
    }

    if (line.startsWith("@@ ")) {
      kept.push(line);
      inHunk = true;
      continue;
    }

    if (inHunk) {
      if (/^[ +\\-]/.test(line) || line === "\\ No newline at end of file") {
        kept.push(line);
        continue;
      }
      inHunk = false;
    }

    if (isUnifiedDiffMetadata(line)) {
      kept.push(line);
      if (line === "GIT binary patch") {
        inBinaryPatch = true;
      }
    }
  }

  return kept.some((line) => line.startsWith("diff --git ")) ? kept.join("\n") : null;
}

function isCapturedDiffNoise(line: string): boolean {
  return (
    line.startsWith("Chunk ID: ")
    || line.startsWith("Wall time: ")
    || line.startsWith("Process exited with code ")
    || line.startsWith("Original token count: ")
    || line === "Output:"
    || line.startsWith("warning: ")
  );
}

function isUnifiedDiffMetadata(line: string): boolean {
  return (
    line.startsWith("index ")
    || line.startsWith("old mode ")
    || line.startsWith("new mode ")
    || line.startsWith("deleted file mode ")
    || line.startsWith("new file mode ")
    || line.startsWith("copy from ")
    || line.startsWith("copy to ")
    || line.startsWith("rename from ")
    || line.startsWith("rename to ")
    || line.startsWith("similarity index ")
    || line.startsWith("dissimilarity index ")
    || line.startsWith("--- ")
    || line.startsWith("+++ ")
    || line.startsWith("Binary files ")
    || line === "GIT binary patch"
    || line.startsWith("literal ")
    || line.startsWith("delta ")
  );
}

function buildSectionKey(oldPath: string, newPath: string): string {
  return `${oldPath}::${newPath}`;
}

function summarizeParsedPatchFile(parsed: {
  hunks?: Array<{ lines?: string[] }>;
}): { additions: number; deletions: number; hunkCount: number } {
  let additions = 0;
  let deletions = 0;
  let hunkCount = 0;

  for (const hunk of parsed.hunks ?? []) {
    hunkCount += 1;
    for (const line of hunk.lines ?? []) {
      if (line.startsWith("+")) {
        additions += 1;
        continue;
      }
      if (line.startsWith("-")) {
        deletions += 1;
      }
    }
  }

  return { additions, deletions, hunkCount };
}

function collectUnifiedDiffSections(diffBody: string): Array<{
  oldPath: string;
  newPath: string;
  changeType: FileChange["changeType"];
}> {
  const sections: Array<{
    oldPath: string;
    newPath: string;
    changeType: FileChange["changeType"];
  }> = [];
  let current:
    | {
        oldPath: string;
        newPath: string;
        changeType: FileChange["changeType"];
      }
    | null = null;

  const flushCurrent = () => {
    if (!current) {
      return;
    }
    sections.push(current);
    current = null;
  };

  for (const line of diffBody.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      flushCurrent();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!match) {
        continue;
      }
      current = {
        oldPath: normalizeDiffPath(match[1] ?? ""),
        newPath: normalizeDiffPath(match[2] ?? ""),
        changeType: "modified"
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("new file mode ")) {
      current.changeType = "added";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.changeType = "deleted";
      continue;
    }
    if (line === "--- /dev/null") {
      current.changeType = "added";
      current.oldPath = "/dev/null";
      continue;
    }
    if (line === "+++ /dev/null") {
      current.changeType = "deleted";
      current.newPath = "/dev/null";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.oldPath = normalizeDiffPath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.newPath = normalizeDiffPath(line.slice("rename to ".length));
      continue;
    }
  }

  flushCurrent();
  return sections;
}

function countPatchDeltaLines(patch: string): { additions: number; deletions: number; hunkCount: number } {
  let additions = 0;
  let deletions = 0;
  let hunkCount = 0;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      hunkCount += 1;
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }
    if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { additions, deletions, hunkCount };
}

function buildUnifiedDiffDisplay(output: string): CodeDiffDisplayFile[] {
  const diffBody = sanitizeUnifiedDiffText(output);
  if (!diffBody) {
    return [];
  }

  try {
    return parsePatch(diffBody).map((parsed) => {
      const fromPath = normalizePatchFileName(parsed.oldFileName);
      const toPath = normalizePatchFileName(parsed.newFileName);
      const path = toPath === "/dev/null" ? fromPath : toPath;
      const blocks: CodeDiffDisplayBlock[] = [];
      const stats = summarizeParsedPatchFile(parsed);
      let previousOldLine: number | null = null;

      for (const hunk of parsed.hunks ?? []) {
        const oldStart = typeof hunk.oldStart === "number" ? hunk.oldStart : null;
        if (oldStart && oldStart > 1 && previousOldLine === null) {
          blocks.push({ kind: "collapsed", count: oldStart - 1 });
        } else if (oldStart && previousOldLine && oldStart > previousOldLine + 1) {
          blocks.push({ kind: "collapsed", count: oldStart - previousOldLine - 1 });
        }

        let oldLine = oldStart ?? null;
        let newLine = typeof hunk.newStart === "number" ? hunk.newStart : null;
        const rows: CodeDiffDisplayRow[] = [];

        for (const line of hunk.lines ?? []) {
          if (line === "\\ No newline at end of file") {
            continue;
          }
          if (line.startsWith("+")) {
            rows.push({
              kind: "add",
              text: line.slice(1),
              oldLineNumber: null,
              newLineNumber: newLine,
            });
            newLine = newLine === null ? null : newLine + 1;
            continue;
          }
          if (line.startsWith("-")) {
            rows.push({
              kind: "del",
              text: line.slice(1),
              oldLineNumber: oldLine,
              newLineNumber: null,
            });
            oldLine = oldLine === null ? null : oldLine + 1;
            continue;
          }
          if (line.startsWith(" ")) {
            rows.push({
              kind: "context",
              text: line.slice(1),
              oldLineNumber: oldLine,
              newLineNumber: newLine,
            });
            oldLine = oldLine === null ? null : oldLine + 1;
            newLine = newLine === null ? null : newLine + 1;
          }
        }

        previousOldLine = oldLine === null ? previousOldLine : oldLine - 1;
        blocks.push(...collapseDisplayRows(rows, true));
      }

      return {
        path,
        fromPath,
        toPath,
        changeType: fromPath === "/dev/null" ? "added" : toPath === "/dev/null" ? "deleted" : "modified",
        additions: stats.additions,
        deletions: stats.deletions,
        blocks,
      } satisfies CodeDiffDisplayFile;
    });
  } catch {
    return [];
  }
}

function buildCodexDiffDisplay(input: string): CodeDiffDisplayFile[] {
  const files: Array<CodeDiffDisplayFile & { isNew: boolean; isDeleted: boolean }> = [];
  const lines = input.split(/\r?\n/);
  let current: (CodeDiffDisplayFile & { isNew: boolean; isDeleted: boolean; sections: CodeDiffDisplayRow[][] }) | null = null;

  const flushCurrent = () => {
    if (!current) {
      return;
    }
    current.blocks = current.sections.flatMap((rows) => collapseDisplayRows(rows, false));
    files.push({
      path: current.path,
      fromPath: current.fromPath,
      toPath: current.toPath,
      changeType: current.changeType,
      additions: current.additions,
      deletions: current.deletions,
      blocks: current.blocks,
      isNew: current.isNew,
      isDeleted: current.isDeleted,
    });
    current = null;
  };

  const beginSection = () => {
    if (!current) {
      return;
    }
    current.sections.push([]);
  };

  const pushRow = (row: CodeDiffDisplayRow) => {
    if (!current) {
      return;
    }
    if (current.sections.length === 0) {
      current.sections.push([]);
    }
    current.sections[current.sections.length - 1]!.push(row);
  };

  for (const line of lines) {
    if (line === "*** Begin Patch" || line === "*** End Patch") {
      flushCurrent();
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      flushCurrent();
      const path = normalizeDiffPath(line.slice("*** Add File: ".length));
      current = {
        path,
        fromPath: "/dev/null",
        toPath: path,
        changeType: "added",
        additions: 0,
        deletions: 0,
        blocks: [],
        isNew: true,
        isDeleted: false,
        sections: [],
      };
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      flushCurrent();
      const path = normalizeDiffPath(line.slice("*** Delete File: ".length));
      current = {
        path,
        fromPath: path,
        toPath: "/dev/null",
        changeType: "deleted",
        additions: 0,
        deletions: 0,
        blocks: [],
        isNew: false,
        isDeleted: true,
        sections: [],
      };
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      flushCurrent();
      const path = normalizeDiffPath(line.slice("*** Update File: ".length));
      current = {
        path,
        fromPath: path,
        toPath: path,
        changeType: "modified",
        additions: 0,
        deletions: 0,
        blocks: [],
        isNew: false,
        isDeleted: false,
        sections: [],
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line === "@@") {
      beginSection();
      continue;
    }
    if (line.startsWith("+")) {
      current.additions += 1;
      pushRow({ kind: "add", text: line.slice(1), oldLineNumber: null, newLineNumber: null });
      continue;
    }
    if (line.startsWith("-")) {
      current.deletions += 1;
      pushRow({ kind: "del", text: line.slice(1), oldLineNumber: null, newLineNumber: null });
      continue;
    }
    if (line.startsWith(" ")) {
      pushRow({ kind: "context", text: line.slice(1), oldLineNumber: null, newLineNumber: null });
    }
  }

  flushCurrent();

  const grouped = new Map<string, Array<CodeDiffDisplayFile & { isNew: boolean; isDeleted: boolean }>>();
  for (const file of files) {
    grouped.set(file.path, [...(grouped.get(file.path) ?? []), file]);
  }

  return [...grouped.values()].map((entries) => {
    const first = entries[0]!;
    const additions = entries.reduce((sum, file) => sum + file.additions, 0);
    const deletions = entries.reduce((sum, file) => sum + file.deletions, 0);
    const isAddedOnly = entries.every((file) => file.isNew);
    const isDeletedOnly = entries.every((file) => file.isDeleted);
    return {
      path: first.path,
      fromPath: isAddedOnly ? "/dev/null" : first.fromPath,
      toPath: isDeletedOnly ? "/dev/null" : first.toPath,
      changeType: isAddedOnly ? "added" : isDeletedOnly ? "deleted" : "modified",
      additions,
      deletions,
      blocks: entries.flatMap((file) => file.blocks),
    } satisfies CodeDiffDisplayFile;
  });
}

function collapseDisplayRows(rows: CodeDiffDisplayRow[], includeBoundaryCollapse: boolean): CodeDiffDisplayBlock[] {
  const changeIndexes = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.kind !== "context")
    .map(({ index }) => index);

  if (changeIndexes.length === 0) {
    return rows.length > 0 ? [{ kind: "collapsed", count: rows.length }] : [];
  }

  const radius = 3;
  const ranges = changeIndexes
    .map((index) => ({
      start: Math.max(0, index - radius),
      end: Math.min(rows.length - 1, index + radius),
    }))
    .sort((left, right) => left.start - right.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end + 1) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }

  const blocks: CodeDiffDisplayBlock[] = [];
  let cursor = 0;

  for (const range of merged) {
    if (range.start > cursor && includeBoundaryCollapse) {
      blocks.push({ kind: "collapsed", count: range.start - cursor });
    }
    if (range.start > cursor && !includeBoundaryCollapse && range.start - cursor > 0) {
      blocks.push({ kind: "collapsed", count: range.start - cursor });
    }
    blocks.push({
      kind: "hunk",
      rows: rows.slice(range.start, range.end + 1),
    });
    cursor = range.end + 1;
  }

  if (cursor < rows.length) {
    blocks.push({ kind: "collapsed", count: rows.length - cursor });
  }

  return blocks;
}
