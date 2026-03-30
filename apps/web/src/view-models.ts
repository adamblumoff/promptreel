import type {
  Artifact,
  ArtifactType,
  Health,
  PromptDetail,
  PromptListItem,
  Repo,
  RepoIngestionStatus
} from "./types";

export type ProjectSidebarItemViewModel = Repo & {
  isSelected: boolean;
  openPromptCount: number;
  openPromptLabel: string;
  activityLabel: string;
  statusTone: "watching" | "error" | "idle";
};

export type RepoIngestionStatusViewModel = RepoIngestionStatus & {
  headline: string;
  tone: "watching" | "error" | "idle";
  lastImportLabel: string;
};

export type PromptRowViewModel = PromptListItem & {
  timestampLabel: string;
  statusLabel: string;
  artifactLabel: string;
  childLabel: string;
  filesLabel: string;
  primaryLabel: string;
  primarySummary: string;
  tone: "live" | "history";
};

export type PromptDetailArtifactViewModel = {
  id: string;
  label: string;
  summary: string;
  fileCountLabel: string | null;
  relationCountLabel: string | null;
};

export type PromptDetailGitLinkViewModel = {
  id: string;
  headline: string;
  detail: string;
};

export type PromptDetailViewModel = {
  id: string;
  promptText: string;
  primaryArtifactSummary: string;
  touchedFiles: string[];
  touchedFilesLabel: string;
  artifactSummaries: PromptDetailArtifactViewModel[];
  gitSummaries: PromptDetailGitLinkViewModel[];
};

type FileStat = {
  path: string;
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

export function sortProjectsAlphabetically(repos: Repo[]): Repo[] {
  return [...repos].sort((left, right) => left.slug.localeCompare(right.slug));
}

export function resolveSelectedProjectId(repos: Repo[], selectedProjectId: string): string {
  if (repos.some((repo) => repo.id === selectedProjectId)) {
    return selectedProjectId;
  }
  return repos[0]?.id ?? "";
}

export function buildProjectSidebarItems(
  repos: Repo[],
  health: Health | null,
  selectedProjectId: string
): ProjectSidebarItemViewModel[] {
  const repoStatuses = new Map(
    (health?.ingestion.repoStatuses ?? []).map((status) => [status.repoId, status])
  );

  return sortProjectsAlphabetically(repos).map((repo) => {
    const status = repoStatuses.get(repo.id);
    const openPromptCount = status?.openPromptCount ?? 0;
    const sessionFileCount = status?.sessionFileCount ?? 0;
    const activityLabel = status
      ? `${sessionFileCount} session file${sessionFileCount === 1 ? "" : "s"}`
      : "Waiting for watcher";

    return {
      ...repo,
      isSelected: repo.id === selectedProjectId,
      openPromptCount,
      openPromptLabel: `${openPromptCount} open`,
      activityLabel,
      statusTone: status?.mode ?? "idle"
    };
  });
}

export function getSelectedProject(repos: Repo[], selectedProjectId: string): Repo | null {
  return repos.find((repo) => repo.id === selectedProjectId) ?? null;
}

export function getSelectedRepoStatus(
  health: Health | null,
  selectedProjectId: string
): RepoIngestionStatusViewModel | null {
  const status = health?.ingestion.repoStatuses.find((item) => item.repoId === selectedProjectId);
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

export function toPromptRowViewModel(prompt: PromptListItem): PromptRowViewModel {
  const statusLabel =
    prompt.status === "in_progress"
      ? "Open now"
      : prompt.status === "completed"
        ? "Completed"
        : "Imported";

  const primaryLabel = prompt.primaryArtifactType
    ? formatArtifactType(prompt.primaryArtifactType)
    : "conversation";

  const filesLabel =
    prompt.filesTouchedCount > 0
      ? `${prompt.filesTouchedCount} file${prompt.filesTouchedCount === 1 ? "" : "s"}`
      : prompt.hasCodeDiff
        ? "Diff recorded"
        : "No file diff";

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

export function toPromptDetailViewModel(prompt: PromptDetail): PromptDetailViewModel {
  const touchedFiles = collectTouchedFiles(prompt.artifacts);
  const primaryArtifact =
    prompt.artifacts.find((artifact) => artifact.id === prompt.primaryArtifactId)
    ?? prompt.artifacts.find((artifact) => artifact.role === "primary")
    ?? null;

  const relationCounts = new Map<string, number>();
  for (const artifact of prompt.artifactLinks) {
    relationCounts.set(artifact.fromArtifactId, (relationCounts.get(artifact.fromArtifactId) ?? 0) + 1);
    relationCounts.set(artifact.toArtifactId, (relationCounts.get(artifact.toArtifactId) ?? 0) + 1);
  }

  return {
    id: prompt.id,
    promptText: prompt.promptText,
    primaryArtifactSummary: primaryArtifact?.summary ?? "No primary artifact preview recorded yet.",
    touchedFiles,
    touchedFilesLabel:
      touchedFiles.length > 0
        ? `${touchedFiles.length} touched file${touchedFiles.length === 1 ? "" : "s"}`
        : "No touched files recorded",
    artifactSummaries: prompt.artifacts.map((artifact) => {
      const fileCount = parseArtifactFiles(artifact).length;
      const relationCount = relationCounts.get(artifact.id) ?? 0;
      return {
        id: artifact.id,
        label: `${formatArtifactType(artifact.type)} · ${artifact.role}`,
        summary: artifact.summary,
        fileCountLabel: fileCount > 0 ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : null,
        relationCountLabel:
          relationCount > 0
            ? `${relationCount} link${relationCount === 1 ? "" : "s"}`
            : null
      };
    }),
    gitSummaries: prompt.gitLinks.map((gitLink) => ({
      id: gitLink.id,
      headline: gitLink.commitSha
        ? `Commit ${gitLink.commitSha.slice(0, 7)} · ${gitLink.survivalState}`
        : `Patch ${gitLink.patchIdentity.slice(0, 8)} · ${gitLink.survivalState}`,
      detail: `Matched ${formatters.timestamp.format(new Date(gitLink.matchedAt))}`
    }))
  };
}

function collectTouchedFiles(artifacts: Artifact[]): string[] {
  const files = new Set<string>();
  for (const artifact of artifacts) {
    for (const file of parseArtifactFiles(artifact)) {
      files.add(file.path);
    }
  }
  return [...files];
}

function parseArtifactFiles(artifact: Artifact): FileStat[] {
  if (!artifact.fileStatsJson) {
    return [];
  }
  try {
    const parsed = JSON.parse(artifact.fileStatsJson) as FileStat[];
    return Array.isArray(parsed) ? parsed.filter((file): file is FileStat => typeof file?.path === "string") : [];
  } catch {
    return [];
  }
}

function formatArtifactType(type: ArtifactType): string {
  return type.replace(/_/g, " ");
}
