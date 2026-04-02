import type {
  IngestionStatus,
  LiveDoctorResult,
  PromptEventDetail,
  PromptEventListItem,
  RepoRegistration,
  ThreadSummary,
  WorkspaceGroup,
  WorkspaceListItem
} from "@promptline/domain";

export interface HealthResponse {
  ok: true;
  daemonPid: number;
  homeDir: string;
  ingestion: IngestionStatus;
}

export interface WorkspaceListResponse {
  workspaces: WorkspaceListItem[];
}

export interface RepoListResponse {
  repos: WorkspaceListItem[];
}

export interface WorkspaceCreateRequest {
  path: string;
}

export interface WorkspaceCreateResponse {
  workspace: WorkspaceGroup;
}

export interface RepoCreateRequest {
  path: string;
}

export interface RepoCreateResponse {
  repo: WorkspaceGroup;
}

export interface ThreadListResponse {
  threads: ThreadSummary[];
}

export interface PromptEventListResponse {
  prompts: PromptEventListItem[];
}

export interface PromptEventResponse {
  prompt: PromptEventDetail;
}

export interface FileHistoryResponse {
  filePath: string;
  prompts: PromptEventListItem[];
}

export interface PlanTraceResponse {
  artifactId: string;
  promptId: string;
  steps: string[];
  linkedArtifactIds: string[];
}

export interface LiveDoctorResponse {
  result: LiveDoctorResult;
}

export interface RescanSessionsResponse {
  ok: true;
  ingestion: IngestionStatus;
}

export interface BlobResponse {
  blobId: string;
  content: string;
}
