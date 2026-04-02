import { createHash, randomUUID, type BinaryLike } from "node:crypto";
import { basename } from "node:path";

export type WorkspaceStatus = "active" | "missing";
export type WorkspaceSource = "auto_discovered" | "manual";
export type RawEventSource = "codex-session" | "codex-app-server";
export type ArtifactType =
  | "final_output"
  | "plan"
  | "code_diff"
  | "test_run"
  | "command_run"
  | "commit_ref"
  | "pr_ref";
export type ArtifactFamily =
  | "final"
  | "execution"
  | "tool"
  | "verification"
  | "reference"
  | "unknown";
export type ArtifactSubtype =
  | "final.answer"
  | "execution.command"
  | "execution.search"
  | "execution.git_status"
  | "tool.exec_command"
  | "tool.apply_patch"
  | "tool.write_stdin"
  | "verification.typecheck"
  | "verification.test"
  | "reference.commit"
  | "reference.pr"
  | "unknown.raw";
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
export type PromptMode = "default" | "plan";
export type ThreadStatus = "open" | "closed";
export type GitSurvivalState =
  | "uncommitted"
  | "survived"
  | "mutated"
  | "superseded"
  | "reverted"
  | "abandoned";

export interface WorkspaceGroup {
  id: string;
  slug: string;
  folderPath: string | null;
  gitRootPath: string | null;
  gitDir: string | null;
  createdAt: string;
  lastSeenAt: string;
  status: WorkspaceStatus;
  source: WorkspaceSource;
}

export interface WorkspaceListItem extends WorkspaceGroup {
  threadCount: number;
  openThreadCount: number;
  isGenerating: boolean;
  lastActivityAt: string | null;
  sessionFileCount: number;
  recentlyUpdatedSessionCount: number;
  mode: "watching" | "error" | "idle";
}

export interface RepoRegistration {
  id: string;
  slug: string;
  rootPath: string;
  gitDir: string;
  createdAt: string;
  lastSeenAt: string;
  status: WorkspaceStatus;
}

export interface ThreadSummary {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  threadId: string | null;
  folderPath: string | null;
  startedAt: string;
  lastActivityAt: string;
  promptCount: number;
  openPromptCount: number;
  isGenerating: boolean;
  lastPromptSummary: string;
  status: ThreadStatus;
}

export interface RawEventRecord {
  id: string;
  workspaceId: string;
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
  workspaceId: string;
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

export interface ArtifactClassification {
  family: ArtifactFamily;
  subtype: ArtifactSubtype;
  displayLabel: string;
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
  workspaceId: string;
  executionPath: string | null;
  sessionId: string | null;
  threadId: string | null;
  parentPromptEventId: string | null;
  startedAt: string;
  endedAt: string | null;
  boundaryReason: PromptBoundaryReason | null;
  status: PromptEventStatus;
  mode: PromptMode;
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

export interface PromptEventListItem {
  id: string;
  workspaceId: string;
  executionPath: string | null;
  sessionId: string | null;
  threadId: string | null;
  parentPromptEventId: string | null;
  startedAt: string;
  endedAt: string | null;
  boundaryReason: PromptBoundaryReason | null;
  status: PromptEventStatus;
  mode: PromptMode;
  artifactCount: number;
  childCount: number;
  filesTouched: string[];
  filesTouchedCount: number;
  promptSummary: string;
  primaryArtifactId: string | null;
  baselineSnapshotId: string | null;
  endSnapshotId: string | null;
  primaryArtifactType: ArtifactType | null;
  primaryArtifactSummary: string | null;
  hasCodeDiff: boolean;
  hasPlanArtifact: boolean;
  hasFinalResponse: boolean;
  isLiveDerived: boolean;
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

export interface WorkspaceIngestionStatus {
  workspaceId: string;
  folderPath: string | null;
  mode: "watching" | "error" | "idle";
  threadCount: number;
  openThreadCount: number;
  sessionFileCount: number;
  recentlyUpdatedSessionCount: number;
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
  workspaceStatuses: WorkspaceIngestionStatus[];
  repoStatuses?: Array<{
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
  }>;
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function slugifyPath(pathValue: string | null): string {
  if (!pathValue) {
    return "unknown-folder";
  }
  const raw = basename(pathValue).toLowerCase();
  return raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "folder";
}

export function slugifyRepoPath(repoPath: string): string {
  return slugifyPath(repoPath);
}

export function hashValue(value: BinaryLike): string {
  return createHash("sha256").update(value).digest("hex");
}

export function workspaceGroupId(folderPath: string | null): string {
  const stableValue = folderPath ?? "__unknown_folder__";
  const slug = slugifyPath(folderPath);
  const hash = hashValue(stableValue).slice(0, 10);
  return `${slug}--${hash}`;
}

export function repoRegistrationId(repoPath: string): string {
  return workspaceGroupId(repoPath);
}

export function threadSummaryId(workspaceId: string, threadKey: string): string {
  return `${workspaceId}::${hashValue(threadKey).slice(0, 12)}`;
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

export function looksLikeTestCommand(commandSummary: string): boolean {
  const normalized = commandSummary.trim().toLowerCase();
  const patterns = [
    /^(?:pnpm|npm|yarn|bun)\b(?:\s+--[^\s]+(?:=[^\s]+)?|\s+--filter\s+[^\s]+|\s+-[^\s]+)*\s+(?:run\s+)?test\b/,
    /^(?:pnpm|npm|yarn|bun|npx|pnpx)\b(?:\s+--[^\s]+(?:=[^\s]+)?|\s+--filter\s+[^\s]+|\s+-[^\s]+)*\s+(?:exec\s+)?(?:vitest|jest|playwright(?:\s+test)?|pytest|phpunit|rspec)\b/,
    /^(?:vitest|jest)\b/,
    /^playwright(?:\s+test)?\b/,
    /^(?:pytest|phpunit|rspec)\b/,
    /^uv\s+run\s+pytest\b/,
    /^cargo\s+test\b/,
    /^go\s+test\b/,
    /^dotnet\s+test\b/,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

export function nowIso(): string {
  return new Date().toISOString();
}
