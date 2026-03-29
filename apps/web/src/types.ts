export type Repo = {
  id: string;
  slug: string;
  rootPath: string;
};

export type Prompt = {
  id: string;
  promptSummary: string;
  startedAt: string;
  status: "in_progress" | "completed" | "imported";
  filesTouched: string[];
  filesTouchedCount: number;
  childCount: number;
  artifactCount: number;
  primaryArtifactType: "final_output" | "plan" | "code_diff" | "test_run" | "command_run" | "commit_ref" | "pr_ref" | null;
  primaryArtifactSummary: string | null;
  hasCodeDiff: boolean;
  isLiveDerived: boolean;
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
