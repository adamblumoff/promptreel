export type Repo = {
  id: string;
  slug: string;
  rootPath: string;
};

export type PromptStatus = "in_progress" | "completed" | "imported";
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
export type GitSurvivalState =
  | "uncommitted"
  | "survived"
  | "mutated"
  | "superseded"
  | "reverted"
  | "abandoned";

export type PromptListItem = {
  id: string;
  repoId: string;
  sessionId: string | null;
  threadId: string | null;
  parentPromptEventId: string | null;
  startedAt: string;
  endedAt: string | null;
  boundaryReason: "next_user_prompt" | "turn_completed" | "thread_idle" | "import_end" | null;
  status: PromptStatus;
  promptText: string;
  promptSummary: string;
  primaryArtifactId: string | null;
  baselineSnapshotId: string | null;
  endSnapshotId: string | null;
  filesTouched: string[];
  filesTouchedCount: number;
  childCount: number;
  artifactCount: number;
  primaryArtifactType: ArtifactType | null;
  primaryArtifactSummary: string | null;
  hasCodeDiff: boolean;
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
  artifacts: Artifact[];
  artifactLinks: ArtifactLink[];
  gitLinks: GitLink[];
};

export type RepoIngestionStatus = {
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
    repoStatuses: RepoIngestionStatus[];
  };
};
