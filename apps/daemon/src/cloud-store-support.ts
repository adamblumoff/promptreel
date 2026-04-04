import { createHash } from "node:crypto";
import { Pool } from "pg";
import type {
  CloudBootstrapSyncRequest,
  CliLoginExchangeResponse,
} from "@promptreel/api-contracts";
import type {
  AuthDevice,
  AuthUserProfile,
  PromptEventDetail,
  PromptEventListItem,
  ThreadSummary,
  WorkspaceListItem,
} from "@promptreel/domain";
import { authDevices, authUsers } from "./cloud-store-schema.js";

export type CliLoginRequestRow = {
  loginCode: string;
  deviceId: string;
  deviceName: string | null;
  requestedAt: string;
  expiresAt: string;
  approvedAt: string | null;
  completedAt: string | null;
  userId: string | null;
  daemonToken: string | null;
};

export type CloudBundle = {
  workspace: WorkspaceListItem;
  threads: ThreadSummary[];
  prompts: PromptEventListItem[];
  promptDetails: PromptEventDetail[];
  blobs: Array<{ blobId: string; content: string }>;
};

export const CLOUD_SYNC_INSERT_CHUNK_SIZE = 100;

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function sanitizeCloudBootstrapBundle(bundle: CloudBootstrapSyncRequest): CloudBootstrapSyncRequest {
  return sanitizeForPostgresJson(bundle);
}

export function sanitizeForPostgresJson<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\u0000/g, "") as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForPostgresJson(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeForPostgresJson(item)])
    ) as T;
  }
  return value;
}

export function createCloudPool(): Pool | null {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    return null;
  }
  const sslMode = process.env.PROMPTREEL_CLOUD_DATABASE_SSL?.trim()?.toLowerCase();
  const ssl =
    sslMode === "require" || sslMode === "true"
      ? { rejectUnauthorized: false }
      : undefined;

  return new Pool({
    connectionString,
    ssl,
    max: Number(process.env.PROMPTREEL_CLOUD_DATABASE_POOL_MAX ?? "10"),
  });
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isExpiredIso(value: string): boolean {
  return Date.parse(value) <= Date.now();
}

export function getThreadLookupKey(prompt: {
  id: string;
  threadId: string | null;
  sessionId: string | null;
}): string {
  return prompt.threadId ?? prompt.sessionId ?? `prompt:${prompt.id}`;
}

export function toAuthUser(row: typeof authUsers.$inferSelect): AuthUserProfile {
  return {
    id: row.id,
    clerkUserId: row.clerkUserId,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toAuthDevice(row: typeof authDevices.$inferSelect): AuthDevice {
  return {
    id: row.id,
    userId: row.userId,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  };
}

export interface CloudStore {
  ensureReady(): Promise<void>;
  createCliLoginRequest(deviceId: string, deviceName: string | null, ttlMs?: number): Promise<CliLoginRequestRow>;
  approveCliLoginRequest(input: {
    loginCode: string;
    clerkUserId: string;
    email: string | null;
    name: string | null;
    avatarUrl: string | null;
    deviceId: string;
    deviceName: string | null;
  }): Promise<{ user: AuthUserProfile; device: AuthDevice; daemonToken: string } | null>;
  exchangeCliLoginRequest(loginCode: string, deviceId: string): Promise<CliLoginExchangeResponse>;
  authenticateDaemonToken(daemonToken: string): Promise<{ user: AuthUserProfile; device: AuthDevice } | null>;
  getAuthUserByClerkUserId(clerkUserId: string): Promise<AuthUserProfile | null>;
  getLatestAuthDeviceForUser(userId: string): Promise<AuthDevice | null>;
  upsertCloudWorkspaceBundle(
    userId: string,
    bundle: CloudBootstrapSyncRequest
  ): Promise<{ workspaceId: string; threadCount: number; promptCount: number; blobCount: number }>;
  listCloudWorkspaces(userId: string): Promise<WorkspaceListItem[]>;
  listCloudThreads(userId: string, workspaceId: string): Promise<ThreadSummary[]>;
  listCloudPrompts(userId: string, workspaceId: string, threadLookupKey?: string | null): Promise<PromptEventListItem[]>;
  getCloudPromptDetail(userId: string, workspaceId: string, promptId: string): Promise<PromptEventDetail | null>;
  readCloudBlob(userId: string, workspaceId: string, blobId: string): Promise<string>;
}

export class DisabledCloudStore implements CloudStore {
  async ensureReady(): Promise<void> {}

  private unavailable(): never {
    throw new Error("Promptreel Cloud requires DATABASE_URL.");
  }

  async createCliLoginRequest(): Promise<CliLoginRequestRow> {
    return this.unavailable();
  }

  async approveCliLoginRequest(): Promise<{ user: AuthUserProfile; device: AuthDevice; daemonToken: string } | null> {
    return this.unavailable();
  }

  async exchangeCliLoginRequest(): Promise<CliLoginExchangeResponse> {
    return this.unavailable();
  }

  async authenticateDaemonToken(): Promise<{ user: AuthUserProfile; device: AuthDevice } | null> {
    return this.unavailable();
  }

  async getAuthUserByClerkUserId(): Promise<AuthUserProfile | null> {
    return this.unavailable();
  }

  async getLatestAuthDeviceForUser(): Promise<AuthDevice | null> {
    return this.unavailable();
  }

  async upsertCloudWorkspaceBundle(): Promise<{ workspaceId: string; threadCount: number; promptCount: number; blobCount: number }> {
    return this.unavailable();
  }

  async listCloudWorkspaces(): Promise<WorkspaceListItem[]> {
    return this.unavailable();
  }

  async listCloudThreads(): Promise<ThreadSummary[]> {
    return this.unavailable();
  }

  async listCloudPrompts(): Promise<PromptEventListItem[]> {
    return this.unavailable();
  }

  async getCloudPromptDetail(): Promise<PromptEventDetail | null> {
    return this.unavailable();
  }

  async readCloudBlob(): Promise<string> {
    return this.unavailable();
  }
}
