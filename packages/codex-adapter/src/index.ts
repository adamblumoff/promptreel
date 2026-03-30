import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import WebSocket from "ws";
import type {
  ArtifactLinkRecord,
  ArtifactRecord,
  CodeDiffResult,
  IngestionStatus,
  LiveDoctorResult,
  PromptEventRecord,
  RawEventRecord,
  RepoRegistration,
  WorkspaceSnapshot,
  WorkspaceIngestionStatus
} from "@promptline/domain";
import {
  choosePrimaryArtifactType,
  createId,
  extractPlan,
  hashValue,
  looksLikeTestCommand,
  nowIso,
  summarizePrompt,
  type GitLinkRecord,
  workspaceGroupId
} from "@promptline/domain";
import {
  buildCodeDiff,
  buildCodeDiffArtifact,
  captureWorkspaceSnapshot,
  createPlaceholderSnapshot,
  mergeCodeDiffs,
  parseApplyPatchToCodeDiff,
  parseUnifiedDiffToCodeDiff,
  repoRelativePath
} from "@promptline/git-integration";
import {
  PromptlineStore,
  getFileMtimeMs,
  toEligibleWorkspacePath
} from "@promptline/storage";

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { message: string };
}

type SessionLine = {
  timestamp: string;
  type: string;
  payload?: Record<string, unknown>;
};

type SessionToolEvent = {
  callId: string;
  kind: "function_call" | "custom_tool_call";
  occurredAt: string;
  name: string;
  status: string | null;
  input: string | null;
  arguments: string | null;
  output: string | null;
};

type HistoricalRecoveredDiff = {
  diff: CodeDiffResult;
  source: "apply_patch" | "git_diff_output";
  sourceFormat: "codex_apply_patch" | "unified_diff";
};

type SessionMeta = {
  sessionId: string;
  threadId: string | null;
  cwd: string | null;
  normalizedCwd: string | null;
  source: string | null;
};

type WorkspaceImportCount = {
  importedFiles: number;
  importedPrompts: number;
};

export interface ImportCodexSessionsOptions {
  tailOpenPrompt?: boolean;
}

export interface ImportCodexSessionsResult {
  importedFiles: number;
  importedPrompts: number;
  byWorkspace: Record<string, WorkspaceImportCount>;
}

export interface CodexSessionFileMatch {
  filePath: string;
  sessionId: string;
  threadId: string | null;
  cwd: string | null;
  normalizedCwd: string | null;
  source: string | null;
  workspaceId: string;
  mtimeMs: number | null;
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}_${hashValue(seed).slice(0, 24)}`;
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const results: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function readSessionLines(filePath: string): SessionLine[] {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionLine);
}

function readSessionMeta(lines: SessionLine[]): SessionMeta {
  const meta = lines.find((line) => line.type === "session_meta");
  const cwd = typeof meta?.payload?.cwd === "string" ? meta.payload.cwd : null;
  const normalizedCwd = normalizeSessionCwd(cwd);
  return {
    sessionId: typeof meta?.payload?.id === "string" ? meta.payload.id : "",
    threadId:
      typeof meta?.payload?.threadId === "string"
        ? meta.payload.threadId
        : typeof meta?.payload?.thread_id === "string"
          ? meta.payload.thread_id
          : null,
    cwd,
    normalizedCwd,
    source: typeof meta?.payload?.source === "string" ? meta.payload.source : null
  };
}

function normalizeSessionCwd(cwd: string | null): string | null {
  return toEligibleWorkspacePath(cwd);
}

function isUserMessage(line: SessionLine): string | null {
  if (line.type !== "event_msg" || line.payload?.type !== "user_message") {
    return null;
  }
  return String(line.payload.message ?? "");
}

function isAgentMessage(line: SessionLine): string | null {
  if (line.type !== "event_msg" || line.payload?.type !== "agent_message") {
    return null;
  }
  return String(line.payload.message ?? "");
}

function normalizeSessionToolEvents(window: SessionLine[]): SessionToolEvent[] {
  const events = new Map<string, SessionToolEvent>();
  const ordered: SessionToolEvent[] = [];

  const upsert = (
    callId: string,
    partial: Partial<SessionToolEvent> & Pick<SessionToolEvent, "kind" | "occurredAt">
  ): void => {
    const existing = events.get(callId);
    if (!existing) {
      const created: SessionToolEvent = {
        callId,
        kind: partial.kind,
        occurredAt: partial.occurredAt,
        name: partial.name ?? "",
        status: partial.status ?? null,
        input: partial.input ?? null,
        arguments: partial.arguments ?? null,
        output: partial.output ?? null
      };
      events.set(callId, created);
      ordered.push(created);
      return;
    }

    existing.kind = partial.kind ?? existing.kind;
    existing.occurredAt = partial.occurredAt ?? existing.occurredAt;
    if (partial.name !== undefined) {
      existing.name = partial.name;
    }
    if (partial.status !== undefined) {
      existing.status = partial.status;
    }
    if (partial.input !== undefined) {
      existing.input = partial.input;
    }
    if (partial.arguments !== undefined) {
      existing.arguments = partial.arguments;
    }
    if (partial.output !== undefined) {
      existing.output = partial.output;
    }
  };

  for (const line of window) {
    if (line.type !== "response_item") {
      continue;
    }
    const payloadType = String(line.payload?.type ?? "");
    const callId = typeof line.payload?.call_id === "string" ? line.payload.call_id : null;
    if (!callId) {
      continue;
    }

    if (payloadType === "function_call") {
      upsert(callId, {
        kind: "function_call",
        occurredAt: line.timestamp ?? nowIso(),
        name: String(line.payload?.name ?? ""),
        arguments: String(line.payload?.arguments ?? "")
      });
      continue;
    }
    if (payloadType === "function_call_output") {
      upsert(callId, {
        kind: "function_call",
        occurredAt: line.timestamp ?? nowIso(),
        output: String(line.payload?.output ?? "")
      });
      continue;
    }
    if (payloadType === "custom_tool_call") {
      upsert(callId, {
        kind: "custom_tool_call",
        occurredAt: line.timestamp ?? nowIso(),
        name: String(line.payload?.name ?? ""),
        status: typeof line.payload?.status === "string" ? line.payload.status : null,
        input: String(line.payload?.input ?? "")
      });
      continue;
    }
    if (payloadType === "custom_tool_call_output") {
      upsert(callId, {
        kind: "custom_tool_call",
        occurredAt: line.timestamp ?? nowIso(),
        output: String(line.payload?.output ?? "")
      });
    }
  }

  return ordered;
}

function recoverHistoricalCodeDiff(toolEvents: SessionToolEvent[]): HistoricalRecoveredDiff | null {
  const applyPatchDiffs = toolEvents
    .filter((event) => isSuccessfulApplyPatchEvent(event))
    .flatMap((event) => {
      const parsed = parseApplyPatchToCodeDiff(event.input ?? "");
      return parsed ? [parsed] : [];
    });

  if (applyPatchDiffs.length > 0) {
    return {
      diff: mergeCodeDiffs(applyPatchDiffs),
      source: "apply_patch",
      sourceFormat: "codex_apply_patch"
    };
  }

  const gitDiffOutputs = toolEvents
    .filter((event) => isGitDiffCommandEvent(event))
    .flatMap((event) => {
      const parsed = event.output ? parseUnifiedDiffToCodeDiff(event.output) : null;
      return parsed ? [parsed] : [];
    });

  if (gitDiffOutputs.length > 0) {
    return {
      diff: mergeCodeDiffs(gitDiffOutputs),
      source: "git_diff_output",
      sourceFormat: "unified_diff"
    };
  }

  return null;
}

function isSuccessfulApplyPatchEvent(event: SessionToolEvent): boolean {
  return (
    event.kind === "custom_tool_call"
    && event.name === "apply_patch"
    && Boolean(event.input?.trim())
    && (event.status === null || event.status === "completed")
    && !isApplyPatchFailure(event.output)
  );
}

function isApplyPatchFailure(output: string | null): boolean {
  return output?.trimStart().startsWith("apply_patch verification failed") ?? false;
}

function isGitDiffCommandEvent(event: SessionToolEvent): boolean {
  if (event.kind !== "function_call") {
    return false;
  }
  const command = extractCommandText(event);
  return command ? /\bgit\s+diff\b/i.test(command) : false;
}

function extractCommandText(event: SessionToolEvent): string | null {
  const parsedArguments = safeParseJsonRecord(event.arguments);
  if (typeof parsedArguments?.cmd === "string") {
    return parsedArguments.cmd;
  }
  return null;
}

function summarizeToolEvent(event: SessionToolEvent): string {
  const command = extractCommandText(event);
  if (command) {
    return command;
  }
  return `${event.name} ${event.arguments ?? event.input ?? ""}`.trim();
}

function normalizeRecoveredDiffPaths(diff: CodeDiffResult, repoPath: string | null): CodeDiffResult {
  return {
    ...diff,
    files: diff.files.map((file) => ({
      ...file,
      path: normalizeRecoveredFilePath(file.path, repoPath)
    }))
  };
}

function normalizeRecoveredFilePath(filePath: string, repoPath: string | null): string {
  if (!repoPath || !isAbsolute(filePath)) {
    return filePath.replace(/\\/g, "/");
  }
  const normalizedAbsolutePath = normalize(filePath);
  const normalizedRepoPath = normalize(repoPath);
  if (!normalizedAbsolutePath.toLowerCase().startsWith(normalizedRepoPath.toLowerCase())) {
    return filePath.replace(/\\/g, "/");
  }
  return repoRelativePath(repoPath, normalizedAbsolutePath);
}

function safeParseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function createHistoricalSnapshots(
  store: PromptlineStore,
  workspaceId: string,
  executionPath: string | null,
  seed: string
): WorkspaceSnapshot[] {
  const snapshotPath = executionPath ?? process.cwd();
  const note = JSON.stringify(
    createPlaceholderSnapshot(snapshotPath, "historical import cannot reconstruct exact workspace state"),
    null,
    2
  );
  const baselineBlobId = store.writeBlob(workspaceId, note);
  const endBlobId = store.writeBlob(workspaceId, note);
  return [
    {
      id: stableId("snapshot", `${seed}:baseline`),
      workspaceId,
      capturedAt: nowIso(),
      headSha: null,
      branchName: null,
      dirtyFileHashes: {},
      gitStatusSummary: "historical import placeholder",
      blobId: baselineBlobId
    },
    {
      id: stableId("snapshot", `${seed}:end`),
      workspaceId,
      capturedAt: nowIso(),
      headSha: null,
      branchName: null,
      dirtyFileHashes: {},
      gitStatusSummary: "historical import placeholder",
      blobId: endBlobId
    }
  ];
}

function accumulateWorkspaceResult(
  target: Record<string, WorkspaceImportCount>,
  workspaceId: string,
  addition: WorkspaceImportCount
): void {
  const existing = target[workspaceId] ?? { importedFiles: 0, importedPrompts: 0 };
  target[workspaceId] = {
    importedFiles: existing.importedFiles + addition.importedFiles,
    importedPrompts: existing.importedPrompts + addition.importedPrompts
  };
}

function importSessionFiles(
  store: PromptlineStore,
  files: CodexSessionFileMatch[],
  options: ImportCodexSessionsOptions = {}
): ImportCodexSessionsResult {
  const totals: ImportCodexSessionsResult = {
    importedFiles: 0,
    importedPrompts: 0,
    byWorkspace: {}
  };

  for (const file of files) {
    const workspace = store.ensureWorkspaceGroup(file.normalizedCwd, {
      gitRootPath: file.normalizedCwd,
      gitDir: file.normalizedCwd ? join(file.normalizedCwd, ".git") : null,
      source: "auto_discovered"
    });
    const cursorKey = `codex-session:v3:${file.filePath}`;
    const cursor = store.getIngestCursor(workspace.id, cursorKey);
    if (cursor && cursor.cursorValue === String(file.mtimeMs)) {
      continue;
    }

    const lines = readSessionLines(file.filePath);
    let importedPrompts = 0;
    let currentStart = -1;
    let promptIndex = 0;

    const flushWindow = (endExclusive: number) => {
      if (currentStart < 0) {
        return;
      }
      const window = lines.slice(currentStart, endExclusive);
      const userLine = window.find((line) => isUserMessage(line));
      const promptText = userLine ? isUserMessage(userLine) ?? "" : "";
      if (!promptText) {
        currentStart = -1;
        return;
      }

      const promptSeed = `${file.filePath}:${promptIndex}`;
      const promptId = stableId("prompt", promptSeed);
      const snapshots = createHistoricalSnapshots(store, workspace.id, file.normalizedCwd, promptSeed);
      const prompt: PromptEventRecord = {
        id: promptId,
        workspaceId: workspace.id,
        executionPath: file.normalizedCwd,
        sessionId: file.sessionId || null,
        threadId: (file.threadId ?? file.sessionId) || null,
        parentPromptEventId: null,
        startedAt: userLine?.timestamp ?? nowIso(),
        endedAt:
          options.tailOpenPrompt && endExclusive === lines.length
            ? null
            : window.at(-1)?.timestamp ?? userLine?.timestamp ?? nowIso(),
        boundaryReason:
          options.tailOpenPrompt && endExclusive === lines.length
            ? null
            : endExclusive < lines.length
              ? "next_user_prompt"
              : "import_end",
        status: options.tailOpenPrompt && endExclusive === lines.length ? "in_progress" : "imported",
        promptText,
        promptSummary: summarizePrompt(promptText),
        primaryArtifactId: null,
        baselineSnapshotId: snapshots[0].id,
        endSnapshotId: snapshots[1].id
      };

      const artifacts: ArtifactRecord[] = [];
      const artifactLinks: ArtifactLinkRecord[] = [];
      const toolEvents = normalizeSessionToolEvents(window);
      const finalText = window
        .map((line) => isAgentMessage(line))
        .filter((value): value is string => Boolean(value))
        .join("\n\n")
        .trim();

      if (finalText) {
        const blobId = store.writeBlob(workspace.id, finalText);
        artifacts.push({
          id: stableId("artifact", `${promptSeed}:final_output`),
          promptEventId: promptId,
          type: "final_output",
          role: "secondary",
          summary: summarizePrompt(finalText),
          blobId,
          fileStatsJson: null,
          metadataJson: null
        });
      }

      const plan = finalText ? extractPlan(finalText) : null;
      if (plan) {
        const blobId = store.writeBlob(workspace.id, JSON.stringify(plan, null, 2));
        artifacts.push({
          id: stableId("artifact", `${promptSeed}:plan`),
          promptEventId: promptId,
          type: "plan",
          role: "secondary",
          summary: plan.steps[0] ?? "Plan",
          blobId,
          fileStatsJson: null,
          metadataJson: JSON.stringify(plan)
        });
      }

      const recoveredDiff = recoverHistoricalCodeDiff(toolEvents);
      if (recoveredDiff) {
        const normalizedDiff = normalizeRecoveredDiffPaths(recoveredDiff.diff, file.normalizedCwd);
        const diffArtifact = buildCodeDiffArtifact(promptId, normalizedDiff, {
          source: recoveredDiff.source,
          sourceFormat: recoveredDiff.sourceFormat
        });
        diffArtifact.id = stableId("artifact", `${promptSeed}:code_diff`);
        diffArtifact.blobId = store.writeBlob(workspace.id, recoveredDiff.diff.patch);
        artifacts.push(diffArtifact);
      }

      const functionCalls = toolEvents.filter((event) => event.kind === "function_call");
      for (const [index, call] of functionCalls.entries()) {
        const commandSummary = summarizeToolEvent(call);
        const artifactType = looksLikeTestCommand(commandSummary) ? "test_run" : "command_run";
        artifacts.push({
          id: stableId("artifact", `${promptSeed}:call:${index}`),
          promptEventId: promptId,
          type: artifactType,
          role: "evidence",
          summary: summarizePrompt(commandSummary),
          blobId: store.writeBlob(workspace.id, commandSummary),
          fileStatsJson: null,
          metadataJson: JSON.stringify({ name: call.name, arguments: call.arguments })
        });
      }

      const primaryType = choosePrimaryArtifactType(Boolean(plan), Boolean(recoveredDiff), Boolean(finalText));
      if (primaryType) {
        const primary = artifacts.find((artifact) => artifact.type === primaryType);
        if (primary) {
          prompt.primaryArtifactId = primary.id;
          primary.role = "primary";
        }
      }

      const rawEvents = window.map((line, index) => ({
        record: {
          id: stableId("raw", `${promptSeed}:${index}`),
          workspaceId: workspace.id,
          source: "codex-session" as const,
          sessionId: file.sessionId || null,
          threadId: (file.threadId ?? file.sessionId) || null,
          eventType: `${line.type}:${String(line.payload?.type ?? "none")}`,
          occurredAt: line.timestamp ?? nowIso(),
          ingestPath: file.filePath,
          payloadBlobId: ""
        },
        payload: line
      }));

      const outputs = toolEvents
        .filter((event) => event.kind === "function_call" && Boolean(event.output))
        .map((event) => event.output ?? "");
      if (outputs.length > 0) {
        artifacts.push({
          id: stableId("artifact", `${promptSeed}:function_output`),
          promptEventId: promptId,
          type: "command_run",
          role: "evidence",
          summary: "Function call output",
          blobId: store.writeBlob(workspace.id, outputs.join("\n\n")),
          fileStatsJson: null,
          metadataJson: null
        });
      }

      store.persistPromptBundle(workspace.id, {
        prompt,
        snapshots,
        artifacts,
        artifactLinks,
        gitLinks: [],
        rawEvents
      });

      importedPrompts += 1;
      promptIndex += 1;
      currentStart = -1;
    };

    lines.forEach((line, index) => {
      if (isUserMessage(line)) {
        flushWindow(index);
        currentStart = index;
      }
    });
    flushWindow(lines.length);

    store.setIngestCursor(workspace.id, cursorKey, String(file.mtimeMs ?? 0));
    totals.importedFiles += 1;
    totals.importedPrompts += importedPrompts;
    accumulateWorkspaceResult(totals.byWorkspace, workspace.id, {
      importedFiles: 1,
      importedPrompts
    });
  }

  return totals;
}

export function discoverCodexSessionFiles(
  sessionsRoot = join(homedir(), ".codex", "sessions")
): CodexSessionFileMatch[] {
  const files = walkFiles(sessionsRoot).filter((filePath) => filePath.endsWith(".jsonl")).sort();
  const results: CodexSessionFileMatch[] = [];
  for (const filePath of files) {
    const lines = readSessionLines(filePath);
    const meta = readSessionMeta(lines);
    if (!meta.normalizedCwd) {
      continue;
    }
    results.push({
      filePath,
      sessionId: meta.sessionId,
      threadId: meta.threadId,
      cwd: meta.cwd,
      normalizedCwd: meta.normalizedCwd,
      source: meta.source,
      workspaceId: workspaceGroupId(meta.normalizedCwd),
      mtimeMs: getFileMtimeMs(filePath)
    });
  }
  return results;
}

export function importCodexSessions(
  store: PromptlineStore,
  sessionsRoot = join(homedir(), ".codex", "sessions"),
  options: ImportCodexSessionsOptions = {}
): ImportCodexSessionsResult {
  const files = discoverCodexSessionFiles(sessionsRoot);
  return importSessionFiles(store, files, options);
}

export function importCodexSessionsForRepo(
  store: PromptlineStore,
  repo: RepoRegistration,
  sessionsRoot = join(homedir(), ".codex", "sessions"),
  options: ImportCodexSessionsOptions = {}
): { importedFiles: number; importedPrompts: number } {
  const files = discoverCodexSessionFiles(sessionsRoot).filter(
    (file) => file.normalizedCwd?.toLowerCase() === normalize(repo.rootPath).toLowerCase()
  );
  const result = importSessionFiles(store, files, options);
  return {
    importedFiles: result.importedFiles,
    importedPrompts: result.importedPrompts
  };
}

export function discoverCodexSessionFilesForRepo(
  repo: RepoRegistration,
  sessionsRoot = join(homedir(), ".codex", "sessions")
): CodexSessionFileMatch[] {
  return discoverCodexSessionFiles(sessionsRoot).filter(
    (file) => file.normalizedCwd?.toLowerCase() === normalize(repo.rootPath).toLowerCase()
  );
}

export class CodexSessionTailer {
  private readonly statusByWorkspace = new Map<string, WorkspaceIngestionStatus>();
  private timer: NodeJS.Timeout | null = null;
  private lastScanAt: string | null = null;
  private scanning = false;

  constructor(
    private readonly store: PromptlineStore,
    private readonly pollingIntervalMs = 3_000,
    private readonly sessionsRoot = join(homedir(), ".codex", "sessions")
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.scanOnce();
    }, this.pollingIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  scanNow(): IngestionStatus {
    this.scanOnce();
    return this.getStatus();
  }

  getStatus(): IngestionStatus {
    const workspaces = this.store.listWorkspaces();
    const workspaceStatuses = workspaces.map((workspace) => {
      const existing = this.statusByWorkspace.get(workspace.id);
      if (existing) {
        return existing;
      }
      const threads = this.store.listThreads(workspace.id);
      return {
        workspaceId: workspace.id,
        folderPath: workspace.folderPath,
        mode: "idle" as const,
        threadCount: threads.length,
        openThreadCount: threads.filter((thread) => thread.status === "open").length,
        sessionFileCount: 0,
        recentlyUpdatedSessionCount: 0,
        lastImportAt: null,
        lastImportResult: null,
        lastError: null
      };
    });

    return {
      watcher: this.timer ? "running" : "stopped",
      pollingIntervalMs: this.pollingIntervalMs,
      sessionsRoot: this.sessionsRoot,
      lastScanAt: this.lastScanAt,
      workspaceStatuses,
      repoStatuses: workspaceStatuses.map((status) => ({
        repoId: status.workspaceId,
        mode: status.mode,
        sessionFileCount: status.sessionFileCount,
        recentlyUpdatedSessionCount: status.recentlyUpdatedSessionCount,
        openPromptCount: status.openThreadCount,
        lastImportAt: status.lastImportAt,
        lastImportResult: status.lastImportResult,
        lastError: status.lastError
      }))
    };
  }

  private scanOnce(): void {
    if (this.scanning) {
      return;
    }
    this.scanning = true;
    try {
      const matches = discoverCodexSessionFiles(this.sessionsRoot);
      const recentCutoff = Date.now() - this.pollingIntervalMs * 3;
      const groupedMatches = new Map<string, CodexSessionFileMatch[]>();
      for (const match of matches) {
        const bucket = groupedMatches.get(match.workspaceId) ?? [];
        bucket.push(match);
        groupedMatches.set(match.workspaceId, bucket);
        const folderPath = match.normalizedCwd;
        if (!folderPath) {
          continue;
        }
        this.store.ensureWorkspaceGroup(folderPath, {
          gitRootPath: folderPath,
          gitDir: join(folderPath, ".git"),
          source: "auto_discovered"
        });
      }

      const workspaces = this.store.listWorkspaces();
      for (const workspace of workspaces) {
        const workspaceMatches = groupedMatches.get(workspace.id) ?? [];
        try {
          const result = importSessionFiles(this.store, workspaceMatches, {
            tailOpenPrompt: true
          });
          const threads = this.store.listThreads(workspace.id);
          const previous = this.statusByWorkspace.get(workspace.id);
          this.statusByWorkspace.set(workspace.id, {
            workspaceId: workspace.id,
            folderPath: workspace.folderPath,
            mode: workspaceMatches.length > 0 ? "watching" : "idle",
            threadCount: threads.length,
            openThreadCount: threads.filter((thread) => thread.status === "open").length,
            sessionFileCount: workspaceMatches.length,
            recentlyUpdatedSessionCount: workspaceMatches.filter((match) => (match.mtimeMs ?? 0) >= recentCutoff).length,
            lastImportAt: workspaceMatches.length > 0 ? nowIso() : previous?.lastImportAt ?? null,
            lastImportResult: result.byWorkspace[workspace.id]
              ?? (workspaceMatches.length > 0
                ? { importedFiles: 0, importedPrompts: 0 }
                : previous?.lastImportResult ?? null),
            lastError: null
          });
        } catch (error) {
          const previous = this.statusByWorkspace.get(workspace.id);
          const threads = this.store.listThreads(workspace.id);
          this.statusByWorkspace.set(workspace.id, {
            workspaceId: workspace.id,
            folderPath: workspace.folderPath,
            mode: "error",
            threadCount: previous?.threadCount ?? threads.length,
            openThreadCount: previous?.openThreadCount ?? threads.filter((thread) => thread.status === "open").length,
            sessionFileCount: workspaceMatches.length,
            recentlyUpdatedSessionCount: workspaceMatches.filter((match) => (match.mtimeMs ?? 0) >= recentCutoff).length,
            lastImportAt: previous?.lastImportAt ?? null,
            lastImportResult: previous?.lastImportResult ?? null,
            lastError: error instanceof Error ? error.message : String(error)
          });
        }
      }

      this.lastScanAt = nowIso();
    } finally {
      this.scanning = false;
    }
  }
}

class CodexAppServerClient {
  private readonly endpoint: string;
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, (value: unknown) => void>();
  private readonly notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  private nextId = 1;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
    this.socket = new WebSocket(endpoint);
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${this.endpoint}`)), 10_000);
      this.socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    this.socket.on("message", (data: WebSocket.RawData) => {
      const message = JSON.parse(String(data)) as JsonRpcResponse & {
        method?: string;
        params?: Record<string, unknown>;
      };
      if (typeof message.id === "number") {
        const resolver = this.pending.get(message.id);
        if (resolver) {
          this.pending.delete(message.id);
          resolver(message.result ?? message.error ?? null);
        }
        return;
      }
      if (message.method) {
        this.notifications.push({
          method: message.method,
          params: (message.params ?? {}) as Record<string, unknown>
        });
      }
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "promptline",
        title: "Promptline",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const resultPromise = new Promise<T>((resolve) => {
      this.pending.set(id, (value) => resolve(value as T));
    });
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return resultPromise;
  }

  drainNotifications(): Array<{ method: string; params: Record<string, unknown> }> {
    return this.notifications.splice(0, this.notifications.length);
  }

  close(): void {
    this.socket.close();
  }
}

export async function runLiveDoctor(
  store: PromptlineStore,
  repo: RepoRegistration
): Promise<LiveDoctorResult> {
  const port = 43123;
  const endpoint = `ws://127.0.0.1:${port}`;
  const child = spawn("codex", ["app-server", "--listen", endpoint], {
    stdio: "ignore",
    windowsHide: true
  });

  try {
    await waitForSocket(endpoint);
    const client = new CodexAppServerClient(endpoint);
    await client.connect();
    await client.initialize();
    const threadResponse = (await client.request<{ thread: { id: string } }>("thread/start", {
      cwd: repo.rootPath,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      ephemeral: true
    })) ?? { thread: { id: null } };
    const threadId = threadResponse.thread.id;
    const baselineSnapshot = store.createSnapshot(repo.id, captureWorkspaceSnapshot(repo.rootPath));

    await client.request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: "Run `git status -sb`, then reply with exactly `promptline live ok`.",
          text_elements: []
        }
      ]
    });

    const startedAt = nowIso();
    let turnId: string | null = null;
    let finalText = "";
    let latestDiff = "";
    let planExplanation: string | null = null;
    let planSteps: string[] = [];
    let completed = false;
    let notificationCount = 0;
    const rawEvents: Array<{ record: RawEventRecord; payload: unknown }> = [];
    const commandArtifacts: ArtifactRecord[] = [];

    while (!completed) {
      const notifications = client.drainNotifications();
      for (const notification of notifications) {
        notificationCount += 1;
        rawEvents.push({
          record: {
            id: createId("raw"),
            workspaceId: repo.id,
            source: "codex-app-server",
            sessionId: null,
            threadId,
            eventType: notification.method,
            occurredAt: nowIso(),
            ingestPath: endpoint,
            payloadBlobId: ""
          },
          payload: notification
        });

        if (notification.method === "turn/started") {
          turnId = String((notification.params.turn as { id: string }).id);
        } else if (notification.method === "item/agentMessage/delta") {
          finalText += String(notification.params.delta ?? "");
        } else if (notification.method === "turn/plan/updated") {
          planExplanation = (notification.params.explanation as string | null) ?? null;
          planSteps = Array.isArray(notification.params.plan)
            ? notification.params.plan.map((step) => String((step as { step: string }).step))
            : [];
        } else if (notification.method === "turn/diff/updated") {
          latestDiff = String(notification.params.diff ?? "");
        } else if (notification.method === "item/completed") {
          const item = notification.params.item as { type?: string; command?: string; status?: string };
          if (item?.type === "commandExecution") {
            const command = String(item.command ?? "commandExecution");
            commandArtifacts.push({
              id: createId("artifact"),
              promptEventId: "",
              type: looksLikeTestCommand(command) ? "test_run" : "command_run",
              role: "evidence",
              summary: summarizePrompt(command),
              blobId: store.writeBlob(repo.id, JSON.stringify(item, null, 2)),
              fileStatsJson: null,
              metadataJson: JSON.stringify(item)
            });
          }
        } else if (notification.method === "turn/completed") {
          completed = true;
          const completedTurn = notification.params.turn as { id: string };
          turnId = completedTurn.id;
        }
      }
      if (!completed) {
        await delay(200);
      }
    }

    const endSnapshot = store.createSnapshot(repo.id, captureWorkspaceSnapshot(repo.rootPath));
    const promptEventId = createId("prompt");
    const prompt: PromptEventRecord = {
      id: promptEventId,
      workspaceId: repo.id,
      executionPath: repo.rootPath,
      sessionId: null,
      threadId,
      parentPromptEventId: null,
      startedAt,
      endedAt: nowIso(),
      boundaryReason: "turn_completed",
      status: "completed",
      promptText: "Run `git status -sb`, then reply with exactly `promptline live ok`.",
      promptSummary: "Live Codex app-server doctor turn",
      primaryArtifactId: null,
      baselineSnapshotId: baselineSnapshot.id,
      endSnapshotId: endSnapshot.id
    };

    const artifacts: ArtifactRecord[] = [];
    const artifactLinks: ArtifactLinkRecord[] = [];
    const gitLinks: GitLinkRecord[] = [];

    if (finalText.trim()) {
      artifacts.push({
        id: createId("artifact"),
        promptEventId,
        type: "final_output",
        role: "secondary",
        summary: summarizePrompt(finalText),
        blobId: store.writeBlob(repo.id, finalText.trim()),
        fileStatsJson: null,
        metadataJson: null
      });
    }

    if (planSteps.length > 0) {
      artifacts.push({
        id: createId("artifact"),
        promptEventId,
        type: "plan",
        role: "secondary",
        summary: planSteps[0] ?? "Plan",
        blobId: store.writeBlob(repo.id, JSON.stringify({ explanation: planExplanation, steps: planSteps }, null, 2)),
        fileStatsJson: null,
        metadataJson: JSON.stringify({ explanation: planExplanation, steps: planSteps })
      });
    }

    const localDiff = buildCodeDiff(
      JSON.parse(store.readBlob(repo.id, baselineSnapshot.blobId)) as ReturnType<typeof captureWorkspaceSnapshot>,
      JSON.parse(store.readBlob(repo.id, endSnapshot.blobId)) as ReturnType<typeof captureWorkspaceSnapshot>
    );
    const chosenDiff = latestDiff.trim()
      ? {
          patch: latestDiff,
          files: [],
          patchIdentity: hashValue(latestDiff)
        }
      : localDiff;
    if (chosenDiff) {
      const diffArtifact = buildCodeDiffArtifact(promptEventId, chosenDiff, {
        source: latestDiff.trim() ? "app_server_diff" : "snapshot_diff",
        sourceFormat: "unified_diff"
      });
      diffArtifact.blobId = store.writeBlob(repo.id, chosenDiff.patch);
      artifacts.push(diffArtifact);
      gitLinks.push({
        id: createId("gitlink"),
        promptEventId,
        commitSha: endSnapshot.headSha,
        patchIdentity: chosenDiff.patchIdentity,
        survivalState: endSnapshot.headSha && endSnapshot.headSha !== baselineSnapshot.headSha ? "survived" : "uncommitted",
        matchedAt: nowIso()
      });
    }

    for (const artifact of commandArtifacts) {
      artifact.promptEventId = promptEventId;
      artifacts.push(artifact);
    }

    const primaryType = choosePrimaryArtifactType(planSteps.length > 0, Boolean(chosenDiff), Boolean(finalText.trim()));
    if (primaryType) {
      const primary = artifacts.find((artifact) => artifact.type === primaryType);
      if (primary) {
        primary.role = "primary";
        prompt.primaryArtifactId = primary.id;
      }
    }

    store.persistPromptBundle(repo.id, {
      prompt,
      snapshots: [baselineSnapshot, endSnapshot],
      artifacts,
      artifactLinks,
      gitLinks,
      rawEvents
    });
    client.close();

    return {
      ok: true,
      endpoint,
      threadId,
      turnId,
      notificationCount,
      promptEventId,
      message: "Live Codex app-server capture succeeded."
    };
  } catch (error) {
    return {
      ok: false,
      endpoint,
      threadId: null,
      turnId: null,
      notificationCount: 0,
      promptEventId: null,
      message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    child.kill();
  }
}

async function waitForSocket(endpoint: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(endpoint);
        const cleanup = () => {
          socket.removeAllListeners();
          socket.close();
        };
        socket.once("open", () => {
          cleanup();
          resolve();
        });
        socket.once("error", (error: Error) => {
          cleanup();
          reject(error);
        });
      });
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Timed out waiting for Codex app-server on ${endpoint}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
