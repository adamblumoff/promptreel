import type {
  Artifact,
  ArtifactClassification,
  ArtifactFamily,
  ArtifactRole,
  ArtifactSubtype,
  ArtifactType,
  GitSurvivalState,
  Health,
  PromptDetail,
  PromptListItem,
  ThreadSummary,
  Workspace,
  WorkspaceIngestionStatus
} from "./types";

export type WorkspaceSidebarItemViewModel = Workspace & {
  isSelected: boolean;
  threadCountLabel: string;
  openThreadLabel: string;
  activityLabel: string;
  statusTone: "watching" | "error" | "idle";
  pathLabel: string;
  gitBadgeLabel: string;
};

export type WorkspaceStatusViewModel = WorkspaceIngestionStatus & {
  headline: string;
  tone: "watching" | "error" | "idle";
  lastImportLabel: string;
};

export type ThreadRowViewModel = ThreadSummary & {
  title: string;
  activityLabel: string;
  promptCountLabel: string;
  openLabel: string;
  tone: "open" | "closed";
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
  executionPathLabel: string;
};

export type PromptDetailArtifactViewModel = {
  id: string;
  type: ArtifactType;
  family: ArtifactFamily | null;
  subtype: ArtifactSubtype | null;
  role: ArtifactRole;
  label: string;
  summary: string;
  fileCountLabel: string | null;
  relationCountLabel: string | null;
  files: string[];
  blobId: string | null;
  planTraceSteps: string[];
};

export type PromptDetailGitLinkViewModel = {
  id: string;
  commitSha: string | null;
  survivalState: GitSurvivalState;
  headline: string;
  detail: string;
};

export type FileGroupViewModel = {
  extension: string;
  files: string[];
};

export type PromptDetailViewModel = {
  id: string;
  promptText: string;
  executionPathLabel: string;
  primaryArtifactSummary: string;
  touchedFiles: string[];
  touchedFilesLabel: string;
  fileGroups: FileGroupViewModel[];
  featuredFinalResponseArtifact: PromptDetailArtifactViewModel | null;
  featuredFinalResponseBlobId: string | null;
  featuredPlanArtifact: PromptDetailArtifactViewModel | null;
  featuredPlanBlobId: string | null;
  planTraceSteps: string[];
  artifactSummaries: PromptDetailArtifactViewModel[];
  diffBlobIds: string[];
  hasCodeDiffArtifacts: boolean;
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

export function sortWorkspacesByActivity(workspaces: Workspace[]): Workspace[] {
  return [...workspaces].sort((left, right) => {
    const leftActivity = left.lastActivityAt ?? left.lastSeenAt;
    const rightActivity = right.lastActivityAt ?? right.lastSeenAt;
    const activityComparison = rightActivity.localeCompare(leftActivity);
    if (activityComparison !== 0) {
      return activityComparison;
    }
    return (left.folderPath ?? "").localeCompare(right.folderPath ?? "");
  });
}

export function resolveSelectedWorkspaceId(workspaces: Workspace[], selectedWorkspaceId: string): string {
  if (workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) {
    return selectedWorkspaceId;
  }
  return workspaces[0]?.id ?? "";
}

export function resolveSelectedThreadId(threads: ThreadSummary[], selectedThreadId: string): string {
  if (threads.some((thread) => thread.id === selectedThreadId)) {
    return selectedThreadId;
  }
  return threads[0]?.id ?? "";
}

export function buildWorkspaceSidebarItems(
  workspaces: Workspace[],
  selectedWorkspaceId: string
): WorkspaceSidebarItemViewModel[] {
  return sortWorkspacesByActivity(workspaces).map((workspace) => {
    const pathLabel = workspace.folderPath ?? "Unknown folder";
    const sessionCount = workspace.sessionFileCount;
    const activityValue = workspace.lastActivityAt ?? workspace.lastSeenAt;
    return {
      ...workspace,
      isSelected: workspace.id === selectedWorkspaceId,
      threadCountLabel: `${workspace.threadCount} thread${workspace.threadCount === 1 ? "" : "s"}`,
      openThreadLabel: workspace.isGenerating ? "Generating" : "Stopped",
      activityLabel: activityValue
        ? `${sessionCount} session file${sessionCount === 1 ? "" : "s"} · ${formatters.timestamp.format(new Date(activityValue))}`
        : `${sessionCount} session file${sessionCount === 1 ? "" : "s"}`,
      statusTone: workspace.mode,
      pathLabel,
      gitBadgeLabel: "git"
    };
  });
}

export function getSelectedWorkspace(
  workspaces: Workspace[],
  selectedWorkspaceId: string
): Workspace | null {
  return workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
}

export function getSelectedWorkspaceStatus(
  workspace: Workspace | null,
  health: Health | null,
  selectedWorkspaceId: string
): WorkspaceStatusViewModel | null {
  const status = health?.ingestion.workspaceStatuses.find((item) => item.workspaceId === selectedWorkspaceId);
  if (!workspace && !status) {
    return null;
  }

  const fallbackStatus: WorkspaceIngestionStatus | null = workspace
    ? {
        workspaceId: workspace.id,
        folderPath: workspace.folderPath,
        mode: workspace.mode,
        threadCount: workspace.threadCount,
        openThreadCount: workspace.openThreadCount,
        sessionFileCount: workspace.sessionFileCount,
        recentlyUpdatedSessionCount: workspace.recentlyUpdatedSessionCount,
        lastImportAt: null,
        lastImportResult: null,
        lastError: null
      }
    : null;

  const resolved = status ?? fallbackStatus;
  if (!resolved) {
    return null;
  }

  const headline =
    resolved.mode === "watching"
      ? `Watching ${resolved.threadCount} thread${resolved.threadCount === 1 ? "" : "s"}`
      : resolved.mode === "error"
        ? `Watcher error: ${resolved.lastError ?? "unknown error"}`
        : "Waiting for Codex thread activity";

  return {
    ...resolved,
    headline,
    tone: resolved.mode,
    lastImportLabel: resolved.lastImportAt
      ? `Last import ${formatters.timeOnly.format(new Date(resolved.lastImportAt))}`
      : "No imports yet"
  };
}

export function toThreadRowViewModel(thread: ThreadSummary): ThreadRowViewModel {
  return {
    ...thread,
    title: thread.lastPromptSummary || "Untitled thread",
    activityLabel: formatters.timestamp.format(new Date(thread.lastActivityAt)),
    promptCountLabel: `${thread.promptCount} prompt${thread.promptCount === 1 ? "" : "s"}`,
    openLabel: thread.isGenerating ? "Generating" : "Stopped",
    tone: thread.status
  };
}

export function toPromptRowViewModel(prompt: PromptListItem): PromptRowViewModel {
  const statusLabel =
    prompt.status === "in_progress"
      ? "Generating"
      : "Stopped";

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
    tone: prompt.status === "in_progress" ? "live" : "history",
    executionPathLabel: prompt.executionPath ?? "Unknown folder"
  };
}

export function toPromptDetailViewModel(prompt: PromptDetail): PromptDetailViewModel {
  const touchedFiles = collectTouchedFiles(prompt.artifacts);
  const primaryArtifact =
    prompt.artifacts.find((artifact) => artifact.id === prompt.primaryArtifactId)
    ?? prompt.artifacts.find((artifact) => artifact.role === "primary")
    ?? null;
  const featuredPlanArtifactId =
    prompt.artifacts.find((artifact) => artifact.type === "plan" && artifact.role === "primary")?.id
    ?? prompt.artifacts.find((artifact) => artifact.type === "plan")?.id
    ?? null;
  const featuredFinalResponseArtifactId =
    featuredPlanArtifactId
      ? null
      : prompt.artifacts.find((artifact) => artifact.type === "final_output" && artifact.role === "primary")?.id
        ?? prompt.artifacts.find((artifact) => artifact.type === "final_output")?.id
        ?? null;

  const relationCounts = new Map<string, number>();
  for (const artifact of prompt.artifactLinks) {
    relationCounts.set(artifact.fromArtifactId, (relationCounts.get(artifact.fromArtifactId) ?? 0) + 1);
    relationCounts.set(artifact.toArtifactId, (relationCounts.get(artifact.toArtifactId) ?? 0) + 1);
  }

  const artifactSummaries = prompt.artifacts.map((artifact) => {
    const artifactFiles = parseArtifactFiles(artifact);
    const fileCount = artifactFiles.length;
    const relationCount = relationCounts.get(artifact.id) ?? 0;
    return {
      id: artifact.id,
      type: artifact.type,
      family: parseArtifactClassification(artifact)?.family ?? null,
      subtype: parseArtifactClassification(artifact)?.subtype ?? null,
      role: artifact.role,
      label: getArtifactDisplayLabel(artifact),
      summary: artifact.summary,
      fileCountLabel: fileCount > 0 ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : null,
      relationCountLabel:
        relationCount > 0
          ? `${relationCount} link${relationCount === 1 ? "" : "s"}`
          : null,
      files: artifactFiles.map((f) => f.path),
      blobId: artifact.blobId,
      planTraceSteps: parseArtifactPlanSteps(artifact),
    };
  });

  const featuredPlanArtifact =
    (featuredPlanArtifactId
      ? artifactSummaries.find((artifact) => artifact.id === featuredPlanArtifactId)
      : null)
    ?? null;
  const featuredFinalResponseArtifact =
    (featuredFinalResponseArtifactId
      ? artifactSummaries.find((artifact) => artifact.id === featuredFinalResponseArtifactId)
      : null)
    ?? null;

  return {
    id: prompt.id,
    promptText: prompt.promptText,
    executionPathLabel: prompt.executionPath ?? "Unknown folder",
    primaryArtifactSummary: primaryArtifact?.summary ?? "No primary artifact preview recorded yet.",
    touchedFiles,
    touchedFilesLabel:
      touchedFiles.length > 0
        ? `${touchedFiles.length} touched file${touchedFiles.length === 1 ? "" : "s"}`
        : "No touched files recorded",
    fileGroups: groupFilesByExtension(touchedFiles),
    featuredFinalResponseArtifact,
    featuredFinalResponseBlobId: featuredFinalResponseArtifact?.blobId ?? null,
    featuredPlanArtifact,
    featuredPlanBlobId: featuredPlanArtifact?.blobId ?? null,
    planTraceSteps: featuredPlanArtifact?.planTraceSteps ?? [],
    artifactSummaries: artifactSummaries.filter(
      (artifact) =>
        artifact.id !== featuredPlanArtifactId
        && artifact.id !== featuredFinalResponseArtifactId
        && artifact.type !== "code_diff"
        && !(featuredPlanArtifactId && artifact.type === "final_output")
    ),
    diffBlobIds: prompt.artifacts
      .filter((a) => a.type === "code_diff" && a.blobId)
      .map((a) => a.blobId!),
    hasCodeDiffArtifacts: prompt.artifacts.some((a) => a.type === "code_diff"),
    gitSummaries: prompt.gitLinks.map((gitLink) => ({
      id: gitLink.id,
      commitSha: gitLink.commitSha,
      survivalState: gitLink.survivalState,
      headline: gitLink.commitSha
        ? `Commit ${gitLink.commitSha.slice(0, 7)}`
        : `Patch ${gitLink.patchIdentity.slice(0, 8)}`,
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

function parseArtifactPlanSteps(artifact: Artifact): string[] {
  if (!artifact.metadataJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(artifact.metadataJson) as { steps?: unknown };
    return Array.isArray(parsed.steps)
      ? parsed.steps.filter((step): step is string => typeof step === "string" && step.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function parseArtifactClassification(artifact: Artifact): ArtifactClassification | null {
  if (!artifact.metadataJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(artifact.metadataJson) as { classification?: ArtifactClassification };
    const classification = parsed.classification;
    if (!classification) {
      return null;
    }
    if (
      typeof classification.family !== "string"
      || typeof classification.subtype !== "string"
      || typeof classification.displayLabel !== "string"
    ) {
      return null;
    }
    return classification;
  } catch {
    return null;
  }
}

function getArtifactDisplayLabel(artifact: Artifact): string {
  if (artifact.type === "final_output") {
    return "final response";
  }
  return parseArtifactClassification(artifact)?.displayLabel ?? formatArtifactType(artifact.type);
}

function formatArtifactType(type: ArtifactType): string {
  if (type === "final_output") {
    return "final response";
  }
  return type.replace(/_/g, " ");
}

function groupFilesByExtension(files: string[]): FileGroupViewModel[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const lastDot = file.lastIndexOf(".");
    const ext = lastDot >= 0 ? file.slice(lastDot) : "(no ext)";
    const existing = groups.get(ext);
    if (existing) {
      existing.push(file);
    } else {
      groups.set(ext, [file]);
    }
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([extension, groupFiles]) => ({ extension, files: groupFiles.sort() }));
}
