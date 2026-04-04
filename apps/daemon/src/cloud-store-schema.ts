import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  PromptEventDetail,
  PromptEventListItem,
  ThreadSummary,
  WorkspaceListItem,
} from "@promptreel/domain";

export const authUsers = pgTable("auth_users", {
  id: text("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  email: text("email"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const authDevices = pgTable(
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

export const authDaemonTokens = pgTable(
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

export const cliLoginRequests = pgTable("cli_login_requests", {
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

export const cloudWorkspaces = pgTable(
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

export const cloudThreads = pgTable(
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

export const cloudPrompts = pgTable(
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
    threadIdx: index("cloud_prompts_user_workspace_thread_idx").on(
      table.userId,
      table.workspaceId,
      table.threadLookupKey,
      table.startedAt
    ),
  })
);

export const cloudPromptDetails = pgTable(
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

export const cloudBlobs = pgTable(
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
