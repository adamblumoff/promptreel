import type {
  LiveDoctorResult,
  PromptEventDetail,
  PromptEventListItem,
  RepoRegistration
} from "@promptline/domain";

export interface HealthResponse {
  ok: true;
  daemonPid: number;
  homeDir: string;
}

export interface RepoListResponse {
  repos: RepoRegistration[];
}

export interface RepoCreateRequest {
  path: string;
}

export interface RepoCreateResponse {
  repo: RepoRegistration;
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
