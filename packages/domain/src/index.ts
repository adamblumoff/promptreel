import { createHash, randomUUID, type BinaryLike } from "node:crypto";
import { basename } from "node:path";

export type RepoStatus = "active" | "missing";
export type RawEventSource = "codex-session" | "codex-app-server";
export type ArtifactType =
  | "final_output"
  | "plan"
  | "code_diff"
  | "test_run"
  | "command_run"
  | "commit_ref"
  | "pr_ref";
export type ArtifactRole = "primary" | "secondary" | "evidence";
export type ArtifactRelationType =
  | "implements"
  | "supersedes"
  | "reverts"
  | "evidence_for"
  | "child_of";
export type PromptBoundaryReason =
  | "next_user_prompt"
  | "turn_completed"
  | "thread_idle"
  | "import_end";
export type PromptEventStatus = "in_progress" | "completed" | "imported";
export type GitSurvivalState =
  | "uncommitted"
  | "survived"
  | "mutated"
  | "superseded"
  | "reverted"
  | "abandoned";

export interface RepoRegistration {
  id: string;
  slug: string;
  rootPath: string;
  gitDir: string;
  createdAt: string;
  lastSeenAt: string;
  status: RepoStatus;
}

export interface RawEventRecord {
  id: string;
  repoId: string;
  source: RawEventSource;
  sessionId: string | null;
  threadId: string | null;
  eventType: string;
  occurredAt: string;
  ingestPath: string | null;
  payloadBlobId: string;
}

export interface WorkspaceFileState {
  path: string;
  status: string;
  hash: string | null;
  content: string | null;
}

export interface WorkspaceSnapshotData {
  repoPath: string;
  headSha: string | null;
  branchName: string | null;
  gitStatusSummary: string;
  dirtyFileHashes: Record<string, string | null>;
  files: WorkspaceFileState[];
  note?: string;
}

export interface WorkspaceSnapshot {
  id: string;
  repoId: string;
  capturedAt: string;
  headSha: string | null;
  branchName: string | null;
  dirtyFileHashes: Record<string, string | null>;
  gitStatusSummary: string;
  blobId: string;
}

export interface ArtifactRecord {
  id: string;
  promptEventId: string;
  type: ArtifactType;
  role: ArtifactRole;
  summary: string;
  blobId: string | null;
  fileStatsJson: string | null;
  metadataJson: string | null;
}

export interface ArtifactLinkRecord {
  id: string;
  fromArtifactId: string;
  toArtifactId: string;
  relationType: ArtifactRelationType;
}

export interface GitLinkRecord {
  id: string;
  promptEventId: string;
  commitSha: string | null;
  patchIdentity: string;
  survivalState: GitSurvivalState;
  matchedAt: string;
}

export interface PromptEventRecord {
  id: string;
  repoId: string;
  sessionId: string | null;
  threadId: string | null;
  parentPromptEventId: string | null;
  startedAt: string;
  endedAt: string | null;
  boundaryReason: PromptBoundaryReason | null;
  status: PromptEventStatus;
  promptText: string;
  promptSummary: string;
  primaryArtifactId: string | null;
  baselineSnapshotId: string | null;
  endSnapshotId: string | null;
}

export interface PromptEventDetail extends PromptEventRecord {
  artifacts: ArtifactRecord[];
  artifactLinks: ArtifactLinkRecord[];
  gitLinks: GitLinkRecord[];
}

export interface PromptEventListItem extends PromptEventRecord {
  artifactCount: number;
  childCount: number;
  filesTouched: string[];
}

export interface CodeDiffResult {
  patch: string;
  files: Array<{ path: string; changeType: "added" | "modified" | "deleted" }>;
  patchIdentity: string;
}

export interface ParsedPlan {
  explanation: string | null;
  steps: string[];
}

export interface HistoricalImportResult {
  promptEvents: PromptEventRecord[];
  artifacts: ArtifactRecord[];
  artifactLinks: ArtifactLinkRecord[];
  snapshots: WorkspaceSnapshot[];
  gitLinks: GitLinkRecord[];
  rawEvents: RawEventRecord[];
}

export interface LiveDoctorResult {
  ok: boolean;
  endpoint: string;
  threadId: string | null;
  turnId: string | null;
  notificationCount: number;
  promptEventId: string | null;
  message: string;
}

export interface RepoIngestionStatus {
  repoId: string;
  mode: "watching" | "error" | "idle";
  sessionFileCount: number;
  recentlyUpdatedSessionCount: number;
  openPromptCount: number;
  lastImportAt: string | null;
  lastImportResult: {
    importedFiles: number;
    importedPrompts: number;
  } | null;
  lastError: string | null;
}

export interface IngestionStatus {
  watcher: "running" | "stopped";
  pollingIntervalMs: number;
  sessionsRoot: string;
  lastScanAt: string | null;
  repoStatuses: RepoIngestionStatus[];
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function slugifyRepoPath(repoPath: string): string {
  const raw = basename(repoPath).toLowerCase();
  return raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

export function hashValue(value: BinaryLike): string {
  return createHash("sha256").update(value).digest("hex");
}

export function repoRegistrationId(repoPath: string): string {
  const slug = slugifyRepoPath(repoPath);
  const hash = hashValue(repoPath).slice(0, 10);
  return `${slug}--${hash}`;
}

export function summarizePrompt(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

export function extractPlan(text: string): ParsedPlan | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const steps = lines
    .filter((line) => /^([-*]|\d+\.)\s+/.test(line))
    .map((line) => line.replace(/^([-*]|\d+\.)\s+/, "").trim());

  if (steps.length < 2) {
    return null;
  }

  const explanationLines = lines.filter((line) => !/^([-*]|\d+\.)\s+/.test(line));
  return {
    explanation: explanationLines.length > 0 ? explanationLines.join(" ") : null,
    steps
  };
}

export function choosePrimaryArtifactType(
  hasPlan: boolean,
  hasCodeDiff: boolean,
  hasFinalOutput: boolean
): ArtifactType | null {
  if (hasPlan && hasCodeDiff) {
    return "plan";
  }
  if (hasCodeDiff) {
    return "code_diff";
  }
  if (hasPlan) {
    return "plan";
  }
  if (hasFinalOutput) {
    return "final_output";
  }
  return null;
}

export function looksLikeTestCommand(command: string): boolean {
  return /\b(test|vitest|jest|playwright|pytest|cargo test|pnpm test|npm test)\b/i.test(command);
}

export function nowIso(): string {
  return new Date().toISOString();
}
