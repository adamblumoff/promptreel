import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createTwoFilesPatch, parsePatch } from "diff";
import type {
  ArtifactRecord,
  CodeDiffDisplayArtifact,
  CodeDiffDisplayFile,
  CodeDiffResult,
  WorkspaceFileState,
  WorkspaceSnapshotData
} from "@promptreel/domain";
import { createId, hashValue, nowIso } from "@promptreel/domain";

type FileChange = CodeDiffResult["files"][number];

export interface CodeDiffArtifactMetadata {
  source?: "git_diff_output" | "app_server_diff" | "snapshot_diff";
  sourceFormat?: "unified_diff" | "codex_apply_patch";
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

function gitRead(repoPath: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return null;
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
  const allPaths = new Set([
    ...beforeFiles.keys(),
    ...afterFiles.keys(),
    ...listChangedPathsBetweenHeads(before, after)
  ]);
  const patches: string[] = [];
  const files: CodeDiffResult["files"] = [];
  const gitContentCache = new Map<string, string | null>();

  for (const path of [...allPaths].sort()) {
    const beforeContent = resolveSnapshotFileContent(before, beforeFiles, path, gitContentCache);
    const afterContent = resolveSnapshotFileContent(after, afterFiles, path, gitContentCache);
    if (beforeContent === afterContent) {
      continue;
    }
    const changeType = beforeContent === null ? "added" : afterContent === null ? "deleted" : "modified";
    const rawPatch = createTwoFilesPatch(
      path,
      path,
      beforeContent ?? "",
      afterContent ?? "",
      beforeContent === null ? "missing" : "before",
      afterContent === null ? "missing" : "after"
    );
    const patch = normalizeUnifiedDiffForRender(rawPatch);
    if (!patch) {
      continue;
    }
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

function listChangedPathsBetweenHeads(before: WorkspaceSnapshotData, after: WorkspaceSnapshotData): string[] {
  if (!before.headSha || !after.headSha || before.headSha === after.headSha) {
    return [];
  }
  const output = git(before.repoPath, ["diff", "--name-only", "--find-renames", before.headSha, after.headSha]);
  if (!output) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveSnapshotFileContent(
  snapshot: WorkspaceSnapshotData,
  dirtyFiles: Map<string, WorkspaceFileState>,
  path: string,
  cache: Map<string, string | null>
): string | null {
  const dirtyFile = dirtyFiles.get(path);
  if (dirtyFile) {
    return dirtyFile.content;
  }
  if (!snapshot.headSha) {
    return null;
  }
  const cacheKey = `${snapshot.repoPath}:${snapshot.headSha}:${path}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }
  const content = gitRead(snapshot.repoPath, ["show", `${snapshot.headSha}:${path}`]);
  cache.set(cacheKey, content);
  return content;
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
  if (sourceFormat === "unified_diff") {
    return parseUnifiedDiffToCodeDiff(patch);
  }
  if (sourceFormat === "codex_apply_patch") {
    return null;
  }
  return parseUnifiedDiffToCodeDiff(patch);
}

export function buildCodeDiffDisplayArtifact(input: {
  artifactId: string;
  summary: string;
  patch: string;
  sourceFormat?: CodeDiffArtifactMetadata["sourceFormat"] | null;
}): CodeDiffDisplayArtifact {
  const renderPatch = input.sourceFormat === "codex_apply_patch"
    ? null
    : normalizeUnifiedDiffForRender(input.patch);
  const parsedDiff = renderPatch ? parseUnifiedDiffToCodeDiff(renderPatch) : null;
  return {
    artifactId: input.artifactId,
    summary: input.summary,
    renderPatch: renderPatch ?? "",
    files: (parsedDiff?.files ?? []).map((file) => ({
      path: file.path,
      fromPath: file.oldPath ?? (file.changeType === "added" ? "/dev/null" : file.path),
      toPath: file.newPath ?? (file.changeType === "deleted" ? "/dev/null" : file.path),
      changeType: file.changeType,
      additions: typeof file.additions === "number" ? file.additions : 0,
      deletions: typeof file.deletions === "number" ? file.deletions : 0,
    })) satisfies CodeDiffDisplayFile[]
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
  if (containsTruncatedCapturedOutput(output)) {
    return null;
  }

  const kept: string[] = [];
  let inDiff = false;
  let inHunk = false;
  let inBinaryPatch = false;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("diff --git ") || line.startsWith("Index: ")) {
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

  return kept.some((line) => line.startsWith("diff --git ") || line.startsWith("Index: ")) ? kept.join("\n") : null;
}

export function normalizeUnifiedDiffForRender(output: string): string | null {
  const diffBody = sanitizeUnifiedDiffText(output);
  if (!diffBody) {
    return null;
  }
  if (diffBody.includes("diff --git ")) {
    return diffBody;
  }
  return normalizeIndexDiffToGitDiff(diffBody);
}

function containsTruncatedCapturedOutput(output: string): boolean {
  return output.split(/\r?\n/).some((line) => {
    if (!/tokens truncated/i.test(line)) {
      return false;
    }
    return !/^[ +\\-]/.test(line) && !line.startsWith("@@ ");
  });
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
    line.startsWith("Index: ")
    || /^=+$/.test(line)
    || line.startsWith("index ")
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

function normalizeIndexDiffToGitDiff(diffBody: string): string | null {
  const lines = diffBody.split(/\r?\n/);
  const sections: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.startsWith("Index: ")) {
      index += 1;
      continue;
    }

    const fallbackPath = normalizeDiffPath(line.slice("Index: ".length));
    index += 1;
    while (index < lines.length && /^=+$/.test(lines[index] ?? "")) {
      index += 1;
    }

    let oldPath = fallbackPath;
    let newPath = fallbackPath;
    const hunkLines: string[] = [];

    while (index < lines.length && !(lines[index] ?? "").startsWith("Index: ")) {
      const current = lines[index] ?? "";
      if (current.startsWith("--- ")) {
        oldPath = normalizeSnapshotPatchPath(current.slice(4), fallbackPath);
      } else if (current.startsWith("+++ ")) {
        newPath = normalizeSnapshotPatchPath(current.slice(4), fallbackPath);
      } else if (current.startsWith("@@ ") || hunkLines.length > 0) {
        hunkLines.push(current);
      }
      index += 1;
    }

    if (hunkLines.length === 0) {
      continue;
    }

    const headerOldPath = oldPath === "/dev/null" ? newPath : oldPath;
    const headerNewPath = newPath === "/dev/null" ? oldPath : newPath;
    const section = [
      `diff --git a/${headerOldPath} b/${headerNewPath}`,
      oldPath === "/dev/null" ? "--- /dev/null" : `--- a/${oldPath}`,
      newPath === "/dev/null" ? "+++ /dev/null" : `+++ b/${newPath}`,
      ...hunkLines,
    ].join("\n");
    sections.push(section);
  }

  return sections.length > 0 ? joinPatchSegments(sections) : null;
}

function normalizeSnapshotPatchPath(rawPath: string, fallbackPath: string): string {
  const normalized = normalizeDiffPath(rawPath);
  const suffixMatch = /^(.*)\s+(missing|before|after)$/.exec(normalized);
  if (!suffixMatch) {
    return normalized;
  }
  if (suffixMatch[2] === "missing") {
    return "/dev/null";
  }
  return normalizeDiffPath(suffixMatch[1] || fallbackPath);
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
