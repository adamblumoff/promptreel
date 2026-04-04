import type { AuthWhoamiResponse, CloudBootstrapSyncResponse } from "@promptreel/api-contracts";
import type { PromptreelStore } from "@promptreel/storage";

export function printBlock(lines: Array<string | null | undefined>): void {
  console.log(lines.filter(Boolean).join("\n"));
}

export function formatValue(value: string | null | undefined, fallback = "none"): string {
  return value && value.trim() ? value : fallback;
}

export function printRepoSummary(repo: { id: string; slug: string; rootPath?: string; gitDir?: string; status?: string }): void {
  printBlock([
    `Repo ready: ${repo.slug}`,
    `ID: ${repo.id}`,
    `Path: ${formatValue(repo.rootPath)}`,
    repo.gitDir ? `Git dir: ${repo.gitDir}` : null,
    repo.status ? `Status: ${repo.status}` : null,
  ]);
}

export function printRepoList(repos: Array<{ id: string; slug: string; rootPath: string; status: string }>): void {
  if (repos.length === 0) {
    console.log("No repos registered yet.");
    return;
  }
  printBlock([
    `Registered repos: ${repos.length}`,
    ...repos.map((repo, index) => `${index + 1}. ${repo.slug}  [${repo.status}]  ${repo.rootPath}`),
  ]);
}

export function printPromptList(prompts: Array<{ id: string; startedAt: string; promptSummary: string; status: string }>): void {
  if (prompts.length === 0) {
    console.log("No prompt events found.");
    return;
  }
  printBlock([
    `Prompt events: ${prompts.length}`,
    ...prompts.map((prompt, index) => `${index + 1}. ${prompt.startedAt}  [${prompt.status}]  ${prompt.promptSummary}  (${prompt.id})`),
  ]);
}

export function printPromptDetail(detail: ReturnType<PromptreelStore["getPromptDetail"]>): void {
  if (!detail) {
    console.log("Prompt not found.");
    return;
  }
  printBlock([
    `Prompt: ${detail.promptSummary}`,
    `ID: ${detail.id}`,
    `Started: ${detail.startedAt}`,
    `Status: ${detail.status}`,
    `Artifacts: ${detail.artifacts.length}`,
    `Transcript entries: ${detail.transcript.length}`,
    "",
    detail.promptText,
  ]);
}

export function printCloudLoginSuccess(input: {
  apiBaseUrl: string;
  webBaseUrl: string;
  deviceId: string;
  userName: string | null | undefined;
  userEmail: string | null | undefined;
}): void {
  printBlock([
    "Promptreel Cloud login succeeded.",
    `User: ${formatValue(input.userName, input.userEmail ?? "unknown user")}`,
    input.userEmail ? `Email: ${input.userEmail}` : null,
    `Device: ${input.deviceId}`,
    `Web: ${input.webBaseUrl}`,
    `API: ${input.apiBaseUrl}`,
    "",
    "Next steps:",
    "  pl start",
    "  pl whoami",
    "  Optional: pl sync bootstrap",
    "",
    "For local-only development, keep using `pnpm dev`, `pnpm dev:web`, or `pnpm dev:daemon`.",
  ]);
}

export function printWhoAmI(result: AuthWhoamiResponse): void {
  if (!result.authenticated || !result.user || !result.device) {
    console.log("Not connected to Promptreel Cloud.");
    return;
  }
  printBlock([
    "Promptreel Cloud connection is active.",
    `User: ${formatValue(result.user.name, result.user.email ?? "unknown user")}`,
    result.user.email ? `Email: ${result.user.email}` : null,
    `Device: ${formatValue(result.device.deviceName, result.device.deviceId)}`,
    `Device ID: ${result.device.deviceId}`,
    `Last seen: ${result.device.lastSeenAt}`,
  ]);
}

export function printBootstrapSyncResult(result: { workspaceCount: number; synced: CloudBootstrapSyncResponse[] }): void {
  printBlock([
    `Bootstrap sync complete for ${result.workspaceCount} workspace${result.workspaceCount === 1 ? "" : "s"}.`,
    ...result.synced.map((item) =>
      `- ${item.workspaceId}: ${item.threadCount} threads, ${item.promptCount} prompts, ${item.blobCount} blobs`
    ),
  ]);
}

export function printResetResult(result: { revokedTokens: number; clearedLoginRequests: number }): void {
  printBlock([
    "Promptreel Cloud credentials reset.",
    `Revoked daemon tokens: ${result.revokedTokens}`,
    `Cleared pending login requests: ${result.clearedLoginRequests}`,
    "",
    "You can now run:",
    "  pl login",
    "",
    "Local development still works with `pnpm dev`, `pnpm dev:web`, or `pnpm dev:daemon`.",
  ]);
}
