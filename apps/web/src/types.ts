export type Workspace = {
  id: string;
  slug: string;
  folderPath: string | null;
  gitRootPath: string | null;
  gitDir: string | null;
  createdAt: string;
  lastSeenAt: string;
  status: "active" | "missing";
  source: "auto_discovered" | "manual";
  threadCount: number;
  openThreadCount: number;
  isGenerating: boolean;
  lastActivityAt: string | null;
  sessionFileCount: number;
  recentlyUpdatedSessionCount: number;
  mode: "watching" | "error" | "idle";
};

export type ThreadSummary = {
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
  status: "open" | "closed";
};

export type PromptStatus = "in_progress" | "completed" | "imported";
export type PromptMode = "default" | "plan";
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
export type GitSurvivalState =
  | "uncommitted"
  | "survived"
  | "mutated"
  | "superseded"
  | "reverted"
  | "abandoned";

export type PromptListItem = {
  id: string;
  workspaceId: string;
  executionPath: string | null;
  sessionId: string | null;
  threadId: string | null;
  parentPromptEventId: string | null;
  startedAt: string;
  endedAt: string | null;
  boundaryReason: "next_user_prompt" | "turn_completed" | "thread_idle" | "import_end" | null;
  status: PromptStatus;
  mode: PromptMode;
  promptSummary: string;
  primaryArtifactId: string | null;
  baselineSnapshotId: string | null;
  endSnapshotId: string | null;
  filesTouched: string[];
  filesTouchedCount: number;
  childCount: number;
  artifactCount: number;
  additions?: number;
  deletions?: number;
  primaryArtifactType: ArtifactType | null;
  primaryArtifactSummary: string | null;
  hasCodeDiff: boolean;
  hasPlanArtifact: boolean;
  hasFinalResponse: boolean;
  isLiveDerived: boolean;
};

export type Artifact = {
  id: string;
  promptEventId: string;
  type: ArtifactType;
  role: ArtifactRole;
  summary: string;
  blobId: string | null;
  fileStatsJson: string | null;
  metadataJson: string | null;
};

export type ArtifactClassification = {
  family: ArtifactFamily;
  subtype: ArtifactSubtype;
  displayLabel: string;
};

export type ArtifactLink = {
  id: string;
  fromArtifactId: string;
  toArtifactId: string;
  relationType: ArtifactRelationType;
};

export type GitLink = {
  id: string;
  promptEventId: string;
  commitSha: string | null;
  patchIdentity: string;
  survivalState: GitSurvivalState;
  matchedAt: string;
};

export type PromptDetail = Omit<PromptListItem, "filesTouched" | "filesTouchedCount" | "childCount" | "artifactCount" | "primaryArtifactType" | "primaryArtifactSummary" | "hasCodeDiff" | "isLiveDerived"> & {
  promptText: string;
  transcript: Array<
    | {
        kind: "message";
        role: "user" | "assistant";
        occurredAt: string;
        phase: string | null;
        text: string;
      }
    | {
        kind: "activity";
        occurredAt: string;
        activityType: "command" | "tool" | "search";
        label: string;
        summary: string;
        detail: string | null;
        status: string | null;
      }
  >;
  artifacts: Artifact[];
  artifactLinks: ArtifactLink[];
  gitLinks: GitLink[];
};

export type WorkspaceIngestionStatus = {
  workspaceId: string;
  folderPath: string | null;
  mode: "watching" | "error" | "idle";
  threadCount: number;
  openThreadCount: number;
  sessionFileCount: number;
  recentlyUpdatedSessionCount: number;
  lastSessionUpdateAt: string | null;
  lastImportAt: string | null;
  lastImportResult: {
    importedFiles: number;
    importedPrompts: number;
  } | null;
  lastError: string | null;
};

export type Health = {
  ok: true;
  daemonPid: number;
  homeDir: string;
  ingestion: {
    watcher: "running" | "stopped";
    pollingIntervalMs: number;
    sessionsRoot: string;
    lastScanAt: string | null;
    workspaceStatuses: WorkspaceIngestionStatus[];
  };
};

export type ViewerStatus = {
  mode: "local" | "cloud";
  daemon: {
    connected: boolean;
    source: "local" | "cloud";
    label: string;
    detail: string | null;
    lastSeenAt: string | null;
    syncState: "active" | "idle" | "error" | "disconnected";
    sync: {
      phase: "idle" | "pending" | "syncing" | "retrying" | "error" | "unavailable";
      pendingDirtyWorkspaceCount: number;
      summary: string | null;
      lastSuccessfulSyncAt: string | null;
      lastSuccessfulSyncStats: {
        workspaceCount: number;
        promptCount: number;
        blobCount: number;
      } | null;
      nextScheduledSyncAt: string | null;
      lastErrorMessage: string | null;
    };
  };
};
