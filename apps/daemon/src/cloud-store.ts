import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
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
import { createId, nowIso } from "@promptreel/domain";

type CliLoginRequestRow = {
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

type CloudBundle = {
  workspace: WorkspaceListItem;
  threads: ThreadSummary[];
  prompts: PromptEventListItem[];
  promptDetails: PromptEventDetail[];
  blobs: Array<{ blobId: string; content: string }>;
};

const CLOUD_SYNC_INSERT_CHUNK_SIZE = 100;

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

const authUsers = pgTable("auth_users", {
  id: text("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  email: text("email"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

const authDevices = pgTable(
  "auth_devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    deviceName: text("device_name"),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => ({
    userDeviceUnique: uniqueIndex("auth_devices_user_device_unique").on(table.userId, table.deviceId),
  })
);

const authDaemonTokens = pgTable(
  "auth_daemon_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    deviceRowId: text("device_row_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("auth_daemon_tokens_token_hash_unique").on(table.tokenHash),
  })
);

const cliLoginRequests = pgTable("cli_login_requests", {
  loginCode: text("login_code").primaryKey(),
  deviceId: text("device_id").notNull(),
  deviceName: text("device_name"),
  requestedAt: text("requested_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  approvedAt: text("approved_at"),
  completedAt: text("completed_at"),
  userId: text("user_id"),
  daemonToken: text("daemon_token"),
});

const cloudWorkspaces = pgTable(
  "cloud_workspaces",
  {
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    lastActivityAt: text("last_activity_at"),
    payloadJson: jsonb("payload_json").$type<WorkspaceListItem>().notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.workspaceId] }),
    activityIdx: index("cloud_workspaces_user_activity_idx").on(table.userId, table.lastActivityAt),
  })
);

const cloudThreads = pgTable(
  "cloud_threads",
  {
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    threadId: text("thread_id").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
    payloadJson: jsonb("payload_json").$type<ThreadSummary>().notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.workspaceId, table.threadId] }),
    activityIdx: index("cloud_threads_user_workspace_activity_idx").on(table.userId, table.workspaceId, table.lastActivityAt),
  })
);

const cloudPrompts = pgTable(
  "cloud_prompts",
  {
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    promptId: text("prompt_id").notNull(),
    threadLookupKey: text("thread_lookup_key").notNull(),
    startedAt: text("started_at").notNull(),
    payloadJson: jsonb("payload_json").$type<PromptEventListItem>().notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.workspaceId, table.promptId] }),
    threadIdx: index("cloud_prompts_user_workspace_thread_idx").on(table.userId, table.workspaceId, table.threadLookupKey, table.startedAt),
  })
);

const cloudPromptDetails = pgTable(
  "cloud_prompt_details",
  {
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    promptId: text("prompt_id").notNull(),
    payloadJson: jsonb("payload_json").$type<PromptEventDetail>().notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.workspaceId, table.promptId] }),
  })
);

const cloudBlobs = pgTable(
  "cloud_blobs",
  {
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    blobId: text("blob_id").notNull(),
    content: text("content").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.workspaceId, table.blobId] }),
  })
);

class DisabledCloudStore implements CloudStore {
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

class DrizzleCloudStore implements CloudStore {
  private readonly db;
  private schemaReady = false;

  constructor(private readonly pool: Pool) {
    this.db = drizzle(pool);
  }

  async ensureReady(): Promise<void> {
    if (this.schemaReady) {
      return;
    }
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS auth_users (
        id text PRIMARY KEY,
        clerk_user_id text NOT NULL UNIQUE,
        email text,
        name text,
        avatar_url text,
        created_at text NOT NULL,
        updated_at text NOT NULL
      );
    `);
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS auth_devices (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        device_id text NOT NULL,
        device_name text,
        created_at text NOT NULL,
        last_seen_at text NOT NULL,
        UNIQUE (user_id, device_id)
      );
    `);
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS auth_daemon_tokens (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        device_row_id text NOT NULL REFERENCES auth_devices(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        created_at text NOT NULL,
        last_used_at text,
        revoked_at text
      );
    `);
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS cli_login_requests (
        login_code text PRIMARY KEY,
        device_id text NOT NULL,
        device_name text,
        requested_at text NOT NULL,
        expires_at text NOT NULL,
        approved_at text,
        completed_at text,
        user_id text REFERENCES auth_users(id) ON DELETE SET NULL,
        daemon_token text
      );
    `);
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS cloud_workspaces (
        user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        workspace_id text NOT NULL,
        last_activity_at text,
        payload_json jsonb NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (user_id, workspace_id)
      );
    `);
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS cloud_threads (
        user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        workspace_id text NOT NULL,
        thread_id text NOT NULL,
        last_activity_at text NOT NULL,
        payload_json jsonb NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (user_id, workspace_id, thread_id)
      );
    `);
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS cloud_prompts (
        user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        workspace_id text NOT NULL,
        prompt_id text NOT NULL,
        thread_lookup_key text NOT NULL,
        started_at text NOT NULL,
        payload_json jsonb NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (user_id, workspace_id, prompt_id)
      );
    `);
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS cloud_prompt_details (
        user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        workspace_id text NOT NULL,
        prompt_id text NOT NULL,
        payload_json jsonb NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (user_id, workspace_id, prompt_id)
      );
    `);
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS cloud_blobs (
        user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        workspace_id text NOT NULL,
        blob_id text NOT NULL,
        content text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (user_id, workspace_id, blob_id)
      );
    `);
    await this.db.execute(sql`CREATE INDEX IF NOT EXISTS cloud_workspaces_user_activity_idx ON cloud_workspaces(user_id, last_activity_at DESC);`);
    await this.db.execute(sql`CREATE INDEX IF NOT EXISTS cloud_threads_user_workspace_activity_idx ON cloud_threads(user_id, workspace_id, last_activity_at DESC);`);
    await this.db.execute(sql`CREATE INDEX IF NOT EXISTS cloud_prompts_user_workspace_thread_idx ON cloud_prompts(user_id, workspace_id, thread_lookup_key, started_at DESC);`);
    this.schemaReady = true;
  }

  async createCliLoginRequest(deviceId: string, deviceName: string | null, ttlMs = 10 * 60 * 1000): Promise<CliLoginRequestRow> {
    await this.ensureReady();
    const requestedAt = nowIso();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const loginCode = randomBytes(12).toString("hex");
    await this.db.insert(cliLoginRequests).values({
      loginCode,
      deviceId,
      deviceName,
      requestedAt,
      expiresAt,
      approvedAt: null,
      completedAt: null,
      userId: null,
      daemonToken: null,
    });
    return { loginCode, deviceId, deviceName, requestedAt, expiresAt, approvedAt: null, completedAt: null, userId: null, daemonToken: null };
  }

  async approveCliLoginRequest(input: {
    loginCode: string;
    clerkUserId: string;
    email: string | null;
    name: string | null;
    avatarUrl: string | null;
    deviceId: string;
    deviceName: string | null;
  }): Promise<{ user: AuthUserProfile; device: AuthDevice; daemonToken: string } | null> {
    await this.ensureReady();
    return this.db.transaction(async (tx) => {
      const request = (await tx
        .select()
        .from(cliLoginRequests)
        .where(eq(cliLoginRequests.loginCode, input.loginCode))
        .limit(1))[0];
      if (!request || request.deviceId !== input.deviceId || isExpiredIso(request.expiresAt)) {
        return null;
      }

      const now = nowIso();
      const existingUser = (await tx
        .select()
        .from(authUsers)
        .where(eq(authUsers.clerkUserId, input.clerkUserId))
        .limit(1))[0];
      const userId = existingUser?.id ?? createId("user");
      const userCreatedAt = existingUser?.createdAt ?? now;
      await tx
        .insert(authUsers)
        .values({
          id: userId,
          clerkUserId: input.clerkUserId,
          email: input.email,
          name: input.name,
          avatarUrl: input.avatarUrl,
          createdAt: userCreatedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: authUsers.clerkUserId,
          set: {
            email: input.email,
            name: input.name,
            avatarUrl: input.avatarUrl,
            updatedAt: now,
          },
        });

      const existingDevice = (await tx
        .select()
        .from(authDevices)
        .where(and(eq(authDevices.userId, userId), eq(authDevices.deviceId, input.deviceId)))
        .limit(1))[0];
      const deviceRowId = existingDevice?.id ?? createId("device");
      const deviceCreatedAt = existingDevice?.createdAt ?? now;
      await tx
        .insert(authDevices)
        .values({
          id: deviceRowId,
          userId,
          deviceId: input.deviceId,
          deviceName: input.deviceName,
          createdAt: deviceCreatedAt,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [authDevices.userId, authDevices.deviceId],
          set: {
            deviceName: input.deviceName,
            lastSeenAt: now,
          },
        });

      const daemonToken = `pltok_${randomBytes(24).toString("hex")}`;
      await tx.insert(authDaemonTokens).values({
        id: createId("token"),
        userId,
        deviceRowId,
        tokenHash: hashToken(daemonToken),
        createdAt: now,
        lastUsedAt: null,
        revokedAt: null,
      });
      await tx
        .update(cliLoginRequests)
        .set({
          deviceName: input.deviceName,
          approvedAt: now,
          userId,
          daemonToken,
        })
        .where(eq(cliLoginRequests.loginCode, input.loginCode));

      return {
        user: {
          id: userId,
          clerkUserId: input.clerkUserId,
          email: input.email,
          name: input.name,
          avatarUrl: input.avatarUrl,
          createdAt: userCreatedAt,
          updatedAt: now,
        },
        device: {
          id: deviceRowId,
          userId,
          deviceId: input.deviceId,
          deviceName: input.deviceName,
          createdAt: deviceCreatedAt,
          lastSeenAt: now,
        },
        daemonToken,
      };
    });
  }

  async exchangeCliLoginRequest(loginCode: string, deviceId: string): Promise<CliLoginExchangeResponse> {
    await this.ensureReady();
    const row = (await this.db
      .select()
      .from(cliLoginRequests)
      .where(eq(cliLoginRequests.loginCode, loginCode))
      .limit(1))[0];
    if (!row || row.deviceId !== deviceId) {
      return { status: "not_found" };
    }
    if (isExpiredIso(row.expiresAt)) {
      return { status: "expired" };
    }
    if (!row.approvedAt || !row.userId || !row.daemonToken) {
      return { status: "pending" };
    }
    const user = (await this.db.select().from(authUsers).where(eq(authUsers.id, row.userId)).limit(1))[0] ?? undefined;
    const device = (await this.db
      .select()
      .from(authDevices)
      .where(and(eq(authDevices.userId, row.userId), eq(authDevices.deviceId, deviceId)))
      .limit(1))[0] ?? undefined;
    await this.db.update(cliLoginRequests).set({ completedAt: nowIso() }).where(eq(cliLoginRequests.loginCode, loginCode));
    return {
      status: "approved",
      daemonToken: row.daemonToken,
      user: user ? toAuthUser(user) : undefined,
      device: device ? toAuthDevice(device) : undefined,
    };
  }

  async authenticateDaemonToken(daemonToken: string): Promise<{ user: AuthUserProfile; device: AuthDevice } | null> {
    await this.ensureReady();
    const tokenHash = hashToken(daemonToken);
    const row = (await this.db
      .select({
        tokenId: authDaemonTokens.id,
        user: authUsers,
        device: authDevices,
      })
      .from(authDaemonTokens)
      .innerJoin(authUsers, eq(authUsers.id, authDaemonTokens.userId))
      .innerJoin(authDevices, eq(authDevices.id, authDaemonTokens.deviceRowId))
      .where(and(eq(authDaemonTokens.tokenHash, tokenHash), sql`${authDaemonTokens.revokedAt} IS NULL`))
      .limit(1))[0];
    if (!row) {
      return null;
    }
    const now = nowIso();
    await this.db.update(authDaemonTokens).set({ lastUsedAt: now }).where(eq(authDaemonTokens.id, row.tokenId));
    await this.db.update(authDevices).set({ lastSeenAt: now }).where(eq(authDevices.id, row.device.id));
    return {
      user: toAuthUser({ ...row.user, updatedAt: row.user.updatedAt }),
      device: toAuthDevice({ ...row.device, lastSeenAt: now }),
    };
  }

  async getAuthUserByClerkUserId(clerkUserId: string): Promise<AuthUserProfile | null> {
    await this.ensureReady();
    const row = (await this.db.select().from(authUsers).where(eq(authUsers.clerkUserId, clerkUserId)).limit(1))[0];
    return row ? toAuthUser(row) : null;
  }

  async getLatestAuthDeviceForUser(userId: string): Promise<AuthDevice | null> {
    await this.ensureReady();
    const row = (
      await this.db
        .select()
        .from(authDevices)
        .where(eq(authDevices.userId, userId))
        .orderBy(desc(authDevices.lastSeenAt), authDevices.id)
        .limit(1)
    )[0];
    return row ? toAuthDevice(row) : null;
  }

  async upsertCloudWorkspaceBundle(
    userId: string,
    bundle: CloudBootstrapSyncRequest
  ): Promise<{ workspaceId: string; threadCount: number; promptCount: number; blobCount: number }> {
    await this.ensureReady();
    const sanitizedBundle = sanitizeCloudBootstrapBundle(bundle);
    await this.db.transaction(async (tx) => {
      const now = nowIso();
      await tx
        .insert(cloudWorkspaces)
        .values({
          userId,
          workspaceId: sanitizedBundle.workspace.id,
          lastActivityAt: sanitizedBundle.workspace.lastActivityAt,
          payloadJson: sanitizedBundle.workspace,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [cloudWorkspaces.userId, cloudWorkspaces.workspaceId],
          set: {
            lastActivityAt: sanitizedBundle.workspace.lastActivityAt,
            payloadJson: sanitizedBundle.workspace,
            updatedAt: now,
          },
        });

      for (const chunk of chunkArray(sanitizedBundle.threads, CLOUD_SYNC_INSERT_CHUNK_SIZE)) {
        await tx
          .insert(cloudThreads)
          .values(
            chunk.map((thread) => ({
              userId,
              workspaceId: sanitizedBundle.workspace.id,
              threadId: thread.id,
              lastActivityAt: thread.lastActivityAt,
              payloadJson: thread,
              updatedAt: now,
            }))
          )
          .onConflictDoUpdate({
            target: [cloudThreads.userId, cloudThreads.workspaceId, cloudThreads.threadId],
            set: {
              lastActivityAt: sql`excluded.last_activity_at`,
              payloadJson: sql`excluded.payload_json`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
      }
      for (const chunk of chunkArray(sanitizedBundle.prompts, CLOUD_SYNC_INSERT_CHUNK_SIZE)) {
        await tx
          .insert(cloudPrompts)
          .values(
            chunk.map((prompt) => ({
              userId,
              workspaceId: sanitizedBundle.workspace.id,
              promptId: prompt.id,
              threadLookupKey: getThreadLookupKey(prompt),
              startedAt: prompt.startedAt,
              payloadJson: prompt,
              updatedAt: now,
            }))
          )
          .onConflictDoUpdate({
            target: [cloudPrompts.userId, cloudPrompts.workspaceId, cloudPrompts.promptId],
            set: {
              threadLookupKey: sql`excluded.thread_lookup_key`,
              startedAt: sql`excluded.started_at`,
              payloadJson: sql`excluded.payload_json`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
      }
      for (const chunk of chunkArray(sanitizedBundle.promptDetails, CLOUD_SYNC_INSERT_CHUNK_SIZE)) {
        await tx
          .insert(cloudPromptDetails)
          .values(
            chunk.map((detail) => ({
              userId,
              workspaceId: sanitizedBundle.workspace.id,
              promptId: detail.id,
              payloadJson: detail,
              updatedAt: now,
            }))
          )
          .onConflictDoUpdate({
            target: [cloudPromptDetails.userId, cloudPromptDetails.workspaceId, cloudPromptDetails.promptId],
            set: {
              payloadJson: sql`excluded.payload_json`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
      }
      for (const chunk of chunkArray(sanitizedBundle.blobs, CLOUD_SYNC_INSERT_CHUNK_SIZE)) {
        await tx
          .insert(cloudBlobs)
          .values(
            chunk.map((blob) => ({
              userId,
              workspaceId: sanitizedBundle.workspace.id,
              blobId: blob.blobId,
              content: blob.content,
              updatedAt: now,
            }))
          )
          .onConflictDoUpdate({
            target: [cloudBlobs.userId, cloudBlobs.workspaceId, cloudBlobs.blobId],
            set: {
              content: sql`excluded.content`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
      }
    });

    return {
      workspaceId: sanitizedBundle.workspace.id,
      threadCount: sanitizedBundle.threads.length,
      promptCount: sanitizedBundle.prompts.length,
      blobCount: sanitizedBundle.blobs.length,
    };
  }

  async listCloudWorkspaces(userId: string): Promise<WorkspaceListItem[]> {
    await this.ensureReady();
    const rows = await this.db
      .select({ payloadJson: cloudWorkspaces.payloadJson })
      .from(cloudWorkspaces)
      .where(eq(cloudWorkspaces.userId, userId))
      .orderBy(desc(cloudWorkspaces.lastActivityAt), cloudWorkspaces.workspaceId);
    return rows.map((row) => row.payloadJson);
  }

  async listCloudThreads(userId: string, workspaceId: string): Promise<ThreadSummary[]> {
    await this.ensureReady();
    const rows = await this.db
      .select({ payloadJson: cloudThreads.payloadJson })
      .from(cloudThreads)
      .where(and(eq(cloudThreads.userId, userId), eq(cloudThreads.workspaceId, workspaceId)))
      .orderBy(desc(cloudThreads.lastActivityAt), cloudThreads.threadId);
    return rows.map((row) => row.payloadJson);
  }

  async listCloudPrompts(userId: string, workspaceId: string, threadLookupKey?: string | null): Promise<PromptEventListItem[]> {
    await this.ensureReady();
    const rows = threadLookupKey
      ? await this.db
          .select({ payloadJson: cloudPrompts.payloadJson })
          .from(cloudPrompts)
          .where(
            and(
              eq(cloudPrompts.userId, userId),
              eq(cloudPrompts.workspaceId, workspaceId),
              eq(cloudPrompts.threadLookupKey, threadLookupKey)
            )
          )
          .orderBy(desc(cloudPrompts.startedAt), cloudPrompts.promptId)
      : await this.db
          .select({ payloadJson: cloudPrompts.payloadJson })
          .from(cloudPrompts)
          .where(and(eq(cloudPrompts.userId, userId), eq(cloudPrompts.workspaceId, workspaceId)))
          .orderBy(desc(cloudPrompts.startedAt), cloudPrompts.promptId);
    return rows.map((row) => row.payloadJson);
  }

  async getCloudPromptDetail(userId: string, workspaceId: string, promptId: string): Promise<PromptEventDetail | null> {
    await this.ensureReady();
    const row = (await this.db
      .select({ payloadJson: cloudPromptDetails.payloadJson })
      .from(cloudPromptDetails)
      .where(
        and(
          eq(cloudPromptDetails.userId, userId),
          eq(cloudPromptDetails.workspaceId, workspaceId),
          eq(cloudPromptDetails.promptId, promptId)
        )
      )
      .limit(1))[0];
    return row?.payloadJson ?? null;
  }

  async readCloudBlob(userId: string, workspaceId: string, blobId: string): Promise<string> {
    await this.ensureReady();
    const row = (await this.db
      .select({ content: cloudBlobs.content })
      .from(cloudBlobs)
      .where(and(eq(cloudBlobs.userId, userId), eq(cloudBlobs.workspaceId, workspaceId), eq(cloudBlobs.blobId, blobId)))
      .limit(1))[0];
    if (!row) {
      throw new Error(`Cloud blob not found: ${blobId}`);
    }
    return row.content;
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function sanitizeCloudBootstrapBundle(bundle: CloudBootstrapSyncRequest): CloudBootstrapSyncRequest {
  return sanitizeForPostgresJson(bundle);
}

function sanitizeForPostgresJson<T>(value: T): T {
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

export function createCloudStore(): CloudStore {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    return new DisabledCloudStore();
  }
  const sslMode = process.env.PROMPTREEL_CLOUD_DATABASE_SSL?.trim()?.toLowerCase();
  const ssl =
    sslMode === "require" || sslMode === "true"
      ? { rejectUnauthorized: false }
      : undefined;
  const pool = new Pool({
    connectionString,
    ssl,
    max: Number(process.env.PROMPTREEL_CLOUD_DATABASE_POOL_MAX ?? "10"),
  });
  return new DrizzleCloudStore(pool);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isExpiredIso(value: string): boolean {
  return Date.parse(value) <= Date.now();
}

function getThreadLookupKey(prompt: {
  id: string;
  threadId: string | null;
  sessionId: string | null;
}): string {
  return prompt.threadId ?? prompt.sessionId ?? `prompt:${prompt.id}`;
}

function toAuthUser(row: typeof authUsers.$inferSelect): AuthUserProfile {
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

function toAuthDevice(row: typeof authDevices.$inferSelect): AuthDevice {
  return {
    id: row.id,
    userId: row.userId,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  };
}
