import type { Health, Prompt, Repo, RepoIngestionStatus } from "./types";

export type RepoViewModel = Repo;

export type RepoIngestionStatusViewModel = RepoIngestionStatus & {
  headline: string;
  tone: "watching" | "error" | "idle";
  lastImportLabel: string;
};

export type PromptCardViewModel = Prompt & {
  timestampLabel: string;
  statusLabel: string;
  artifactLabel: string;
  childLabel: string;
  filesLabel: string;
  primaryLabel: string;
  primarySummary: string;
  tone: "live" | "history";
};

const formatters = {
  timestamp: new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }),
  timeOnly: new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  })
};

export function getSelectedRepo(repos: RepoViewModel[], selectedRepoId: string): RepoViewModel | null {
  return repos.find((repo) => repo.id === selectedRepoId) ?? null;
}

export function getSelectedRepoStatus(
  health: Health | null,
  selectedRepoId: string
): RepoIngestionStatusViewModel | null {
  const status = health?.ingestion.repoStatuses.find((item) => item.repoId === selectedRepoId);
  if (!status) {
    return null;
  }

  const headline =
    status.mode === "watching"
      ? `Watching ${status.sessionFileCount} Codex session file${status.sessionFileCount === 1 ? "" : "s"}`
      : status.mode === "error"
        ? `Watcher error: ${status.lastError ?? "unknown error"}`
        : "Watcher is waiting for a registered repo session";

  return {
    ...status,
    headline,
    tone: status.mode,
    lastImportLabel: status.lastImportAt
      ? `Last import ${formatters.timeOnly.format(new Date(status.lastImportAt))}`
      : "No imports yet"
  };
}

export function toPromptCardViewModel(prompt: Prompt): PromptCardViewModel {
  const statusLabel =
    prompt.status === "in_progress"
      ? "Open now"
      : prompt.status === "completed"
        ? "Completed"
        : "Imported";

  const primaryLabel = prompt.primaryArtifactType
    ? prompt.primaryArtifactType.replace(/_/g, " ")
    : "conversation";

  const filesLabel =
    prompt.filesTouchedCount > 0
      ? `${prompt.filesTouchedCount} file${prompt.filesTouchedCount === 1 ? "" : "s"} touched`
      : prompt.hasCodeDiff
        ? "Diff recorded"
        : "No file diff yet";

  return {
    ...prompt,
    timestampLabel: formatters.timestamp.format(new Date(prompt.startedAt)),
    statusLabel,
    artifactLabel: `${prompt.artifactCount} artifact${prompt.artifactCount === 1 ? "" : "s"}`,
    childLabel: `${prompt.childCount} child prompt${prompt.childCount === 1 ? "" : "s"}`,
    filesLabel,
    primaryLabel,
    primarySummary: prompt.primaryArtifactSummary ?? "No primary artifact preview recorded yet.",
    tone: prompt.status === "in_progress" ? "live" : "history"
  };
}
