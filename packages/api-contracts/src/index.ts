import { createHash } from "node:crypto";
import type {
  AuthDevice,
  AuthUserProfile,
  IngestionStatus,
  LiveDoctorResult,
  PromptEventDetail,
  PromptEventListItem,
  RepoRegistration,
  ThreadSummary,
  WorkspaceGroup,
  WorkspaceListItem
} from "@promptreel/domain";

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

export interface CliLoginStartRequest {
  deviceId: string;
  deviceName: string | null;
}

export interface CliLoginStartResponse {
  loginCode: string;
  expiresAt: string;
  loginUrl: string;
}

export interface CliLoginExchangeRequest {
  loginCode: string;
  deviceId: string;
}

export interface CliLoginExchangeResponse {
  status: "pending" | "approved" | "expired" | "not_found";
  daemonToken?: string;
  user?: AuthUserProfile;
  device?: AuthDevice;
}

export interface CliLoginCompleteRequest {
  loginCode: string;
  deviceId: string;
  deviceName: string | null;
}

export interface CliLoginCompleteResponse {
  ok: true;
}

export interface AuthWhoamiResponse {
  authenticated: boolean;
  user: AuthUserProfile | null;
  device: AuthDevice | null;
}

export interface ViewerStatusResponse {
  mode: "local" | "cloud";
  daemon: {
    connected: boolean;
    source: "local" | "cloud";
    label: string;
    detail: string | null;
    syncDetail: string | null;
    lastSeenAt: string | null;
    syncState: "active" | "idle" | "error" | "disconnected";
  };
}

export interface CloudSyncBlobInput {
  blobId: string;
  content: string;
}

export interface CloudBootstrapSyncRequest {
  workspace: WorkspaceListItem;
  threads: ThreadSummary[];
  prompts: PromptEventListItem[];
  promptDetails: PromptEventDetail[];
  blobs: CloudSyncBlobInput[];
}

export interface CloudBootstrapSyncResponse {
  ok: true;
  workspaceId: string;
  threadCount: number;
  promptCount: number;
  blobCount: number;
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function buildCloudSyncScope(authState: { userId: string | null; deviceId: string }): string {
  return authState.userId ? `user:${authState.userId}` : `device:${authState.deviceId}`;
}

export function buildCloudSyncCursorKey(syncScope: string): string {
  return `cloud-sync:${syncScope}:state`;
}

export function getPromptSyncFingerprint(detail: CloudBootstrapSyncRequest["promptDetails"][number]): string {
  return createHash("sha256").update(JSON.stringify(detail)).digest("hex");
}
