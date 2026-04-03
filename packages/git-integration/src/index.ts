import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createTwoFilesPatch } from "diff";
import type {
  ArtifactRecord,
  CodeDiffResult,
  WorkspaceFileState,
  WorkspaceSnapshotData
} from "@promptreel/domain";
import { createId, hashValue, nowIso } from "@promptreel/domain";

type FileChange = CodeDiffResult["files"][number];

export interface CodeDiffArtifactMetadata {
  source?: "apply_patch" | "git_diff_output" | "app_server_diff" | "snapshot_diff";
  sourceFormat?: "codex_apply_patch" | "unified_diff";
}

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
  const files: Array<{ path: string; changeType: "added" | "modified" | "deleted" }> = [];

  for (const path of [...allPaths].sort()) {
    const left = beforeFiles.get(path);
    const right = afterFiles.get(path);
    const beforeContent = left?.content ?? "";
    const afterContent = right?.content ?? "";
    if (beforeContent === afterContent && left?.status === right?.status) {
      continue;
    }
    const changeType = !left ? "added" : !right ? "deleted" : "modified";
    files.push({ path, changeType });
    patches.push(
      createTwoFilesPatch(path, path, beforeContent, afterContent, left?.status ?? "before", right?.status ?? "after")
    );
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
  const files: FileChange[] = [];
  const lines = input.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("*** Add File: ")) {
      files.push({
        path: normalizeDiffPath(line.slice("*** Add File: ".length)),
        changeType: "added"
      });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      files.push({
        path: normalizeDiffPath(line.slice("*** Delete File: ".length)),
        changeType: "deleted"
      });
      continue;
    }
    if (!line.startsWith("*** Update File: ")) {
      continue;
    }

    const sourcePath = normalizeDiffPath(line.slice("*** Update File: ".length));
    const moveLine = lines[index + 1] ?? "";
    if (moveLine.startsWith("*** Move to: ")) {
      files.push({ path: sourcePath, changeType: "deleted" });
      files.push({
        path: normalizeDiffPath(moveLine.slice("*** Move to: ".length)),
        changeType: "added"
      });
      index += 1;
      continue;
    }

    files.push({ path: sourcePath, changeType: "modified" });
  }

  return toCodeDiffResult(input, files);
}

export function parseUnifiedDiffToCodeDiff(output: string): CodeDiffResult | null {
  const startIndex = output.search(/^diff --git /m);
  if (startIndex < 0) {
    return null;
  }

  const diffBody = output.slice(startIndex);
  const files: FileChange[] = [];
  let current: {
    oldPath: string;
    newPath: string;
    changeType: FileChange["changeType"];
  } | null = null;

  const flushCurrent = () => {
    if (!current) {
      return;
    }
    if (current.changeType === "added") {
      files.push({ path: current.newPath, changeType: "added" });
    } else if (current.changeType === "deleted") {
      files.push({ path: current.oldPath, changeType: "deleted" });
    } else {
      files.push({ path: current.newPath || current.oldPath, changeType: "modified" });
    }
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
      continue;
    }
    if (line === "+++ /dev/null") {
      current.changeType = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.oldPath = normalizeDiffPath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.newPath = normalizeDiffPath(line.slice("rename to ".length));
    }
  }

  flushCurrent();
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
      merged.push({ path: normalizedPath, changeType: file.changeType });
      continue;
    }
    merged[existingIndex] = {
      path: normalizedPath,
      changeType: file.changeType
    };
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
