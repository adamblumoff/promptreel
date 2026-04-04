import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AuthDevice, AuthUserProfile } from "@promptreel/domain";
import { createId, nowIso } from "@promptreel/domain";

type RegistryContext = {
  homeDir: string;
  openRegistry(): DatabaseSync;
};

type AuthUserRow = {
  id: string;
  clerkUserId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

type AuthDeviceRow = {
  id: string;
  userId: string;
  deviceId: string;
  deviceName: string | null;
  createdAt: string;
  lastSeenAt: string;
};

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

export interface CloudAuthState {
  apiBaseUrl: string;
  webBaseUrl: string;
  userId: string | null;
  deviceId: string;
  deviceName: string | null;
  daemonToken: string;
  linkedAt: string;
}

function safeJsonParse<T>(input: string | null | undefined, fallback: T): T {
  if (!input) {
    return fallback;
  }
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function compareTokenHashes(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isExpiredIso(value: string): boolean {
  return Date.parse(value) <= Date.now();
}

export function getCloudAuthState(homeDir: string): CloudAuthState | null {
  const file = join(homeDir, "cloud-auth.json");
  if (!existsSync(file)) {
    return null;
  }
  const parsed = safeJsonParse<Partial<CloudAuthState> | null>(readFileSync(file, "utf8"), null);
  if (!parsed?.apiBaseUrl || !parsed?.webBaseUrl || !parsed?.deviceId || !parsed?.daemonToken || !parsed?.linkedAt) {
    return null;
  }
  return {
    apiBaseUrl: parsed.apiBaseUrl,
    webBaseUrl: parsed.webBaseUrl,
    userId: parsed.userId ?? null,
    deviceId: parsed.deviceId,
    deviceName: parsed.deviceName ?? null,
    daemonToken: parsed.daemonToken,
    linkedAt: parsed.linkedAt,
  };
}

export function setCloudAuthState(homeDir: string, state: CloudAuthState): void {
  writeFileSync(join(homeDir, "cloud-auth.json"), JSON.stringify(state, null, 2));
}

export function clearCloudAuthState(homeDir: string): void {
  const file = join(homeDir, "cloud-auth.json");
  if (existsSync(file)) {
    writeFileSync(file, "");
  }
}

export function resetCloudAuth(
  context: RegistryContext,
  deviceId: string | null
): { revokedTokens: number; clearedLoginRequests: number } {
  const db = context.openRegistry();
  const now = nowIso();
  let revokedTokens = 0;
  let clearedLoginRequests = 0;

  if (deviceId) {
    const revoked = db.prepare(
      `UPDATE auth_daemon_tokens
       SET revoked_at = ?
       WHERE revoked_at IS NULL
         AND device_id IN (
           SELECT id FROM auth_devices WHERE device_id = ?
         )`
    ).run(now, deviceId);
    revokedTokens = Number(revoked.changes ?? 0);

    const cleared = db.prepare(`DELETE FROM cli_login_requests WHERE device_id = ?`).run(deviceId);
    clearedLoginRequests = Number(cleared.changes ?? 0);
  }

  db.close();
  clearCloudAuthState(context.homeDir);
  return { revokedTokens, clearedLoginRequests };
}

export function createCliLoginRequest(
  context: RegistryContext,
  deviceId: string,
  deviceName: string | null,
  ttlMs = 10 * 60 * 1000
): CliLoginRequestRow {
  const requestedAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const loginCode = randomBytes(12).toString("hex");
  const db = context.openRegistry();
  db.prepare(
    `INSERT INTO cli_login_requests
     (login_code, device_id, device_name, requested_at, expires_at, approved_at, completed_at, user_id, daemon_token)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`
  ).run(loginCode, deviceId, deviceName, requestedAt, expiresAt);
  db.close();
  return {
    loginCode,
    deviceId,
    deviceName,
    requestedAt,
    expiresAt,
    approvedAt: null,
    completedAt: null,
    userId: null,
    daemonToken: null,
  };
}

export function getCliLoginRequest(context: RegistryContext, loginCode: string): CliLoginRequestRow | null {
  const db = context.openRegistry();
  const row = db.prepare(
    `SELECT
       login_code AS loginCode,
       device_id AS deviceId,
       device_name AS deviceName,
       requested_at AS requestedAt,
       expires_at AS expiresAt,
       approved_at AS approvedAt,
       completed_at AS completedAt,
       user_id AS userId,
       daemon_token AS daemonToken
     FROM cli_login_requests
     WHERE login_code = ?`
  ).get(loginCode) as CliLoginRequestRow | undefined;
  db.close();
  return row ?? null;
}

export function approveCliLoginRequest(
  context: RegistryContext,
  input: {
    loginCode: string;
    clerkUserId: string;
    email: string | null;
    name: string | null;
    avatarUrl: string | null;
    deviceId: string;
    deviceName: string | null;
  }
): { user: AuthUserProfile; device: AuthDevice; daemonToken: string } | null {
  const db = context.openRegistry();
  const row = db.prepare(
    `SELECT
       login_code AS loginCode,
       device_id AS deviceId,
       device_name AS deviceName,
       requested_at AS requestedAt,
       expires_at AS expiresAt,
       approved_at AS approvedAt,
       completed_at AS completedAt,
       user_id AS userId,
       daemon_token AS daemonToken
     FROM cli_login_requests
     WHERE login_code = ?`
  ).get(input.loginCode) as CliLoginRequestRow | undefined;

  if (!row || row.deviceId !== input.deviceId || isExpiredIso(row.expiresAt)) {
    db.close();
    return null;
  }

  db.exec("BEGIN");
  try {
    const now = nowIso();
    const existingUser = db.prepare(
      `SELECT
         id,
         clerk_user_id AS clerkUserId,
         email,
         name,
         avatar_url AS avatarUrl,
         created_at AS createdAt,
         updated_at AS updatedAt
       FROM auth_users
       WHERE clerk_user_id = ?`
    ).get(input.clerkUserId) as AuthUserRow | undefined;

    const userId = existingUser?.id ?? createId("user");
    db.prepare(
      `INSERT INTO auth_users
       (id, clerk_user_id, email, name, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         avatar_url = excluded.avatar_url,
         updated_at = excluded.updated_at`
    ).run(
      userId,
      input.clerkUserId,
      input.email,
      input.name,
      input.avatarUrl,
      existingUser?.createdAt ?? now,
      now
    );

    const existingDevice = db.prepare(
      `SELECT
         id,
         user_id AS userId,
         device_id AS deviceId,
         device_name AS deviceName,
         created_at AS createdAt,
         last_seen_at AS lastSeenAt
       FROM auth_devices
       WHERE user_id = ? AND device_id = ?`
    ).get(userId, input.deviceId) as AuthDeviceRow | undefined;

    const deviceId = existingDevice?.id ?? createId("device");
    db.prepare(
      `INSERT INTO auth_devices
       (id, user_id, device_id, device_name, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         device_name = excluded.device_name,
         last_seen_at = excluded.last_seen_at`
    ).run(
      deviceId,
      userId,
      input.deviceId,
      input.deviceName,
      existingDevice?.createdAt ?? now,
      now
    );

    const daemonToken = `pltok_${randomBytes(24).toString("hex")}`;
    const daemonTokenHash = hashToken(daemonToken);
    db.prepare(
      `INSERT INTO auth_daemon_tokens
       (id, user_id, device_id, token_hash, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`
    ).run(createId("token"), userId, deviceId, daemonTokenHash, now);

    db.prepare(
      `UPDATE cli_login_requests
       SET device_name = ?, approved_at = ?, user_id = ?, daemon_token = ?
       WHERE login_code = ?`
    ).run(input.deviceName, now, userId, daemonToken, input.loginCode);

    db.exec("COMMIT");

    const user: AuthUserProfile = {
      id: userId,
      clerkUserId: input.clerkUserId,
      email: input.email,
      name: input.name,
      avatarUrl: input.avatarUrl,
      createdAt: existingUser?.createdAt ?? now,
      updatedAt: now,
    };
    const device: AuthDevice = {
      id: deviceId,
      userId,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      createdAt: existingDevice?.createdAt ?? now,
      lastSeenAt: now,
    };
    db.close();
    return { user, device, daemonToken };
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
}

export function exchangeCliLoginRequest(
  context: RegistryContext,
  loginCode: string,
  deviceId: string
): {
  status: "pending" | "approved" | "expired" | "not_found";
  daemonToken?: string;
  user?: AuthUserProfile;
  device?: AuthDevice;
} {
  const row = getCliLoginRequest(context, loginCode);
  if (!row || row.deviceId !== deviceId) {
    return { status: "not_found" };
  }
  if (isExpiredIso(row.expiresAt)) {
    return { status: "expired" };
  }
  if (!row.approvedAt || !row.userId || !row.daemonToken) {
    return { status: "pending" };
  }

  const db = context.openRegistry();
  const user = db.prepare(
    `SELECT
       id,
       clerk_user_id AS clerkUserId,
       email,
       name,
       avatar_url AS avatarUrl,
       created_at AS createdAt,
       updated_at AS updatedAt
     FROM auth_users
     WHERE id = ?`
  ).get(row.userId) as AuthUserProfile | undefined;
  const device = db.prepare(
    `SELECT
       id,
       user_id AS userId,
       device_id AS deviceId,
       device_name AS deviceName,
       created_at AS createdAt,
       last_seen_at AS lastSeenAt
     FROM auth_devices
     WHERE user_id = ? AND device_id = ?`
  ).get(row.userId, deviceId) as AuthDevice | undefined;
  db.prepare(`UPDATE cli_login_requests SET completed_at = ? WHERE login_code = ?`).run(nowIso(), loginCode);
  db.close();

  return {
    status: "approved",
    daemonToken: row.daemonToken,
    user,
    device,
  };
}

export function authenticateDaemonToken(
  context: RegistryContext,
  daemonToken: string
): { user: AuthUserProfile; device: AuthDevice } | null {
  const tokenHash = hashToken(daemonToken);
  const db = context.openRegistry();
  const rows = db.prepare(
    `SELECT
       t.id AS tokenId,
       u.id AS userId,
       u.clerk_user_id AS clerkUserId,
       u.email AS email,
       u.name AS name,
       u.avatar_url AS avatarUrl,
       u.created_at AS userCreatedAt,
       u.updated_at AS userUpdatedAt,
       d.id AS deviceRowId,
       d.device_id AS deviceId,
       d.device_name AS deviceName,
       d.created_at AS deviceCreatedAt,
       d.last_seen_at AS deviceLastSeenAt,
       t.token_hash AS tokenHash,
       t.revoked_at AS revokedAt
     FROM auth_daemon_tokens t
     JOIN auth_users u ON u.id = t.user_id
     JOIN auth_devices d ON d.id = t.device_id
     WHERE t.revoked_at IS NULL`
  ).all() as Array<{
    tokenId: string;
    userId: string;
    clerkUserId: string;
    email: string | null;
    name: string | null;
    avatarUrl: string | null;
    userCreatedAt: string;
    userUpdatedAt: string;
    deviceRowId: string;
    deviceId: string;
    deviceName: string | null;
    deviceCreatedAt: string;
    deviceLastSeenAt: string;
    tokenHash: string;
    revokedAt: string | null;
  }>;

  const match = rows.find((row) => compareTokenHashes(row.tokenHash, tokenHash));
  if (!match) {
    db.close();
    return null;
  }

  const now = nowIso();
  db.prepare(`UPDATE auth_daemon_tokens SET last_used_at = ? WHERE id = ?`).run(now, match.tokenId);
  db.prepare(`UPDATE auth_devices SET last_seen_at = ? WHERE id = ?`).run(now, match.deviceRowId);
  db.close();

  return {
    user: {
      id: match.userId,
      clerkUserId: match.clerkUserId,
      email: match.email,
      name: match.name,
      avatarUrl: match.avatarUrl,
      createdAt: match.userCreatedAt,
      updatedAt: match.userUpdatedAt,
    },
    device: {
      id: match.deviceRowId,
      userId: match.userId,
      deviceId: match.deviceId,
      deviceName: match.deviceName,
      createdAt: match.deviceCreatedAt,
      lastSeenAt: now,
    },
  };
}

export function getAuthUserByClerkUserId(context: RegistryContext, clerkUserId: string): AuthUserProfile | null {
  const db = context.openRegistry();
  const row = db.prepare(
    `SELECT
       id,
       clerk_user_id AS clerkUserId,
       email,
       name,
       avatar_url AS avatarUrl,
       created_at AS createdAt,
       updated_at AS updatedAt
     FROM auth_users
     WHERE clerk_user_id = ?`
  ).get(clerkUserId) as AuthUserProfile | undefined;
  db.close();
  return row ?? null;
}

export function getLatestAuthDeviceForUser(context: RegistryContext, userId: string): AuthDevice | null {
  const db = context.openRegistry();
  const row = db.prepare(
    `SELECT
       id,
       user_id AS userId,
       device_id AS deviceId,
       device_name AS deviceName,
       created_at AS createdAt,
       last_seen_at AS lastSeenAt
     FROM auth_devices
     WHERE user_id = ?
     ORDER BY last_seen_at DESC, id ASC
     LIMIT 1`
  ).get(userId) as AuthDevice | undefined;
  db.close();
  return row ?? null;
}
