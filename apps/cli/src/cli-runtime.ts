import { existsSync, readFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { trimTrailingSlash } from "@promptreel/api-contracts";

export function loadCliEnvFiles(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "../../..");
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), ".env.local"),
    resolve(repoRoot, ".env"),
    resolve(repoRoot, ".env.local"),
    resolve(repoRoot, "apps/cli/.env"),
    resolve(repoRoot, "apps/cli/.env.local"),
    resolve(repoRoot, "apps/daemon/.env"),
    resolve(repoRoot, "apps/daemon/.env.local"),
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

export const DEFAULT_CLOUD_BASE_URL = trimTrailingSlash(
  process.env.PROMPTREEL_CLOUD_URL
  ?? process.env.PROMPTREEL_CLOUD_WEB_URL
  ?? "https://promptreeldaemon-production.up.railway.app"
);
export const DEFAULT_API_BASE_URL = trimTrailingSlash(process.env.PROMPTREEL_CLOUD_API_URL ?? `${DEFAULT_CLOUD_BASE_URL}/api`);
export const DEFAULT_WEB_BASE_URL = trimTrailingSlash(process.env.PROMPTREEL_CLOUD_WEB_URL ?? DEFAULT_CLOUD_BASE_URL);

export function getDeviceName(): string {
  return `${hostname()} (${platform()})`;
}

export async function postJson<TResponse, TRequest extends object>(
  apiBaseUrl: string,
  path: string,
  body: TRequest,
  token?: string
): Promise<TResponse> {
  const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<TResponse>;
}

export async function getJson<TResponse>(apiBaseUrl: string, path: string, token?: string): Promise<TResponse> {
  const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<TResponse>;
}

export function openBrowser(url: string): void {
  if (process.platform === "win32") {
    const escapedUrl = url.replace(/'/g, "''");
    spawn("powershell", ["-NoProfile", "-Command", `Start-Process '${escapedUrl}'`], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

export async function pollForCliLoginApproval<TResponse extends { status: string }>(
  apiBaseUrl: string,
  loginCode: string,
  deviceId: string
): Promise<TResponse> {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const result = await postJson<TResponse, { loginCode: string; deviceId: string }>(
      apiBaseUrl,
      "/auth/cli/exchange",
      { loginCode, deviceId }
    );
    if (result.status === "approved" || result.status === "expired" || result.status === "not_found") {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Timed out waiting for browser login approval.");
}
