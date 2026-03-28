import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type {
  ArtifactLinkRecord,
  ArtifactRecord,
  LiveDoctorResult,
  PromptEventRecord,
  RawEventRecord,
  RepoRegistration,
  WorkspaceSnapshot
} from "@promptline/domain";
import {
  choosePrimaryArtifactType,
  createId,
  extractPlan,
  hashValue,
  looksLikeTestCommand,
  nowIso,
  summarizePrompt,
  type GitLinkRecord
} from "@promptline/domain";
import {
  buildCodeDiff,
  buildCodeDiffArtifact,
  captureWorkspaceSnapshot,
  createPlaceholderSnapshot
} from "@promptline/git-integration";
import { PromptlineStore, getFileMtimeMs } from "@promptline/storage";

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

function asFunctionCall(line: SessionLine): { name: string; arguments: string } | null {
  if (line.type !== "response_item" || line.payload?.type !== "function_call") {
    return null;
  }
  return {
    name: String(line.payload.name ?? ""),
    arguments: String(line.payload.arguments ?? "")
  };
}

function asFunctionCallOutput(line: SessionLine): string | null {
  if (line.type !== "response_item" || line.payload?.type !== "function_call_output") {
    return null;
  }
  return String(line.payload.output ?? "");
}

function createHistoricalSnapshots(
  store: PromptlineStore,
  repoId: string,
  repoPath: string,
  seed: string
): WorkspaceSnapshot[] {
  const note = JSON.stringify(
    createPlaceholderSnapshot(repoPath, "historical import cannot reconstruct exact workspace state"),
    null,
    2
  );
  const baselineBlobId = store.writeBlob(repoId, note);
  const endBlobId = store.writeBlob(repoId, note);
  return [
    {
      id: stableId("snapshot", `${seed}:baseline`),
      repoId,
      capturedAt: nowIso(),
      headSha: null,
      branchName: null,
      dirtyFileHashes: {},
      gitStatusSummary: "historical import placeholder",
      blobId: baselineBlobId
    },
    {
      id: stableId("snapshot", `${seed}:end`),
      repoId,
      capturedAt: nowIso(),
      headSha: null,
      branchName: null,
      dirtyFileHashes: {},
      gitStatusSummary: "historical import placeholder",
      blobId: endBlobId
    }
  ];
}

export function importCodexSessionsForRepo(
  store: PromptlineStore,
  repo: RepoRegistration,
  sessionsRoot = join(homedir(), ".codex", "sessions")
): { importedFiles: number; importedPrompts: number } {
  const files = walkFiles(sessionsRoot).filter((filePath) => filePath.endsWith(".jsonl")).sort();
  let importedFiles = 0;
  let importedPrompts = 0;

  for (const filePath of files) {
    const cursorKey = `codex-session:${filePath}`;
    const mtimeMs = getFileMtimeMs(filePath);
    const cursor = store.getIngestCursor(repo.id, cursorKey);
    if (cursor && cursor.cursorValue === String(mtimeMs)) {
      continue;
    }
    const lines = readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionLine);
    const meta = lines.find((line) => line.type === "session_meta");
    const cwd = String(meta?.payload?.cwd ?? "");
    if (!cwd || cwd.toLowerCase() !== repo.rootPath.toLowerCase()) {
      continue;
    }

    importedFiles += 1;
    const sessionId = String(meta?.payload?.id ?? "");
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

      const promptSeed = `${filePath}:${promptIndex}`;
      const promptId = stableId("prompt", promptSeed);
      const snapshots = createHistoricalSnapshots(store, repo.id, repo.rootPath, promptSeed);
      const prompt: PromptEventRecord = {
        id: promptId,
        repoId: repo.id,
        sessionId,
        threadId: sessionId || null,
        parentPromptEventId: null,
        startedAt: userLine?.timestamp ?? nowIso(),
        endedAt: window.at(-1)?.timestamp ?? userLine?.timestamp ?? nowIso(),
        boundaryReason: endExclusive < lines.length ? "next_user_prompt" : "import_end",
        status: "imported",
        promptText,
        promptSummary: summarizePrompt(promptText),
        primaryArtifactId: null,
        baselineSnapshotId: snapshots[0].id,
        endSnapshotId: snapshots[1].id
      };

      const artifacts: ArtifactRecord[] = [];
      const artifactLinks: ArtifactLinkRecord[] = [];
      const finalText = window
        .map((line) => isAgentMessage(line))
        .filter((value): value is string => Boolean(value))
        .join("\n\n")
        .trim();

      if (finalText) {
        const blobId = store.writeBlob(repo.id, finalText);
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
        const planArtifactId = stableId("artifact", `${promptSeed}:plan`);
        const blobId = store.writeBlob(repo.id, JSON.stringify(plan, null, 2));
        artifacts.push({
          id: planArtifactId,
          promptEventId: promptId,
          type: "plan",
          role: "secondary",
          summary: plan.steps[0] ?? "Plan",
          blobId,
          fileStatsJson: null,
          metadataJson: JSON.stringify(plan)
        });
      }

      const functionCalls = window
        .map((line) => asFunctionCall(line))
        .filter((value): value is { name: string; arguments: string } => Boolean(value));
      for (const [index, call] of functionCalls.entries()) {
        const commandSummary = `${call.name} ${call.arguments}`.trim();
        const artifactType = looksLikeTestCommand(commandSummary) ? "test_run" : "command_run";
        artifacts.push({
          id: stableId("artifact", `${promptSeed}:call:${index}`),
          promptEventId: promptId,
          type: artifactType,
          role: "evidence",
          summary: summarizePrompt(commandSummary),
          blobId: store.writeBlob(repo.id, commandSummary),
          fileStatsJson: null,
          metadataJson: JSON.stringify({ name: call.name, arguments: call.arguments })
        });
      }

      const primaryType = choosePrimaryArtifactType(Boolean(plan), false, Boolean(finalText));
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
          repoId: repo.id,
          source: "codex-session" as const,
          sessionId,
          threadId: sessionId || null,
          eventType: `${line.type}:${String(line.payload?.type ?? "none")}`,
          occurredAt: line.timestamp ?? nowIso(),
          ingestPath: filePath,
          payloadBlobId: ""
        },
        payload: line
      }));

      const outputs = window
        .map((line) => asFunctionCallOutput(line))
        .filter((value): value is string => Boolean(value));
      if (outputs.length > 0) {
        artifacts.push({
          id: stableId("artifact", `${promptSeed}:function_output`),
          promptEventId: promptId,
          type: "command_run",
          role: "evidence",
          summary: "Function call output",
          blobId: store.writeBlob(repo.id, outputs.join("\n\n")),
          fileStatsJson: null,
          metadataJson: null
        });
      }

      store.persistPromptBundle(repo.id, {
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
    store.setIngestCursor(repo.id, cursorKey, String(mtimeMs ?? 0));
  }

  return { importedFiles, importedPrompts };
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
            repoId: repo.id,
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
      repoId: repo.id,
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
      const planArtifactId = createId("artifact");
      artifacts.push({
        id: planArtifactId,
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
      const diffArtifact = buildCodeDiffArtifact(promptEventId, chosenDiff);
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
