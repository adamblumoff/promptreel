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
} from "@promptline/domain";
import { createId, hashValue, nowIso } from "@promptline/domain";

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

export function buildCodeDiffArtifact(promptEventId: string, diff: CodeDiffResult): ArtifactRecord {
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
      patchIdentity: diff.patchIdentity
    })
  };
}

export function repoRelativePath(repoPath: string, absolutePath: string): string {
  return relative(repoPath, absolutePath).replace(/\\/g, "/");
}
