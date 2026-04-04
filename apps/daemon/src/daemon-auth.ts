import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyToken } from "@clerk/backend";
import { trimTrailingSlash } from "@promptreel/api-contracts";
import type { AuthUserProfile } from "@promptreel/domain";
import type { CloudStore } from "./cloud-store-support.js";

export function loadDaemonEnvFiles(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "../../..");
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), ".env.local"),
    resolve(repoRoot, ".env"),
    resolve(repoRoot, ".env.local"),
    resolve(repoRoot, "apps/daemon/.env"),
    resolve(repoRoot, "apps/daemon/.env.local"),
    resolve(repoRoot, "apps/web/.env"),
    resolve(repoRoot, "apps/web/.env.local"),
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) {
      continue;
    }
    const contents = readFileSync(filePath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) {
        continue;
      }
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) {
        continue;
      }
      let value = rawValue.trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

export function getBearerToken(headers: Record<string, unknown>): string | null {
  const raw = typeof headers.authorization === "string" ? headers.authorization : null;
  if (!raw) {
    return null;
  }
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

export async function verifyClerkSessionToken(token: string): Promise<{ clerkUserId: string } | null> {
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) {
    return null;
  }

  try {
    const verified = await verifyToken(token, {
      secretKey,
      authorizedParties: process.env.CLERK_AUTHORIZED_PARTIES
        ? process.env.CLERK_AUTHORIZED_PARTIES.split(",").map((value) => value.trim()).filter(Boolean)
        : undefined,
    });
    const clerkUserId = typeof verified.sub === "string" ? verified.sub : null;
    return clerkUserId ? { clerkUserId } : null;
  } catch {
    return null;
  }
}

export function buildCliLoginUrl(loginCode: string, deviceId: string, deviceName: string | null): string {
  const baseUrl = trimTrailingSlash(
    process.env.PROMPTREEL_WEB_URL?.trim()
    || process.env.APP_URL?.trim()
    || "http://127.0.0.1:4175"
  );
  const url = new URL(`${baseUrl}/cli-login`);
  url.searchParams.set("code", loginCode);
  url.searchParams.set("deviceId", deviceId);
  if (deviceName) {
    url.searchParams.set("deviceName", deviceName);
  }
  return url.toString();
}

export async function resolveCloudViewerUser(
  headers: Record<string, unknown>,
  cloudStore: CloudStore
): Promise<AuthUserProfile | null> {
  const cloudViewerMode = headers["x-promptreel-cloud-viewer"] === "1";
  if (!cloudViewerMode) {
    return null;
  }
  const bearerToken = getBearerToken(headers);
  if (!bearerToken) {
    return null;
  }
  const clerkSession = await verifyClerkSessionToken(bearerToken);
  if (!clerkSession) {
    return null;
  }
  return cloudStore.getAuthUserByClerkUserId(clerkSession.clerkUserId);
}
