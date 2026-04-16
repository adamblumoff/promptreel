import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AuthWhoamiResponse,
  BlobResponse,
  CloudBootstrapSyncRequest,
  CloudBootstrapSyncResponse,
  CliLoginCompleteRequest,
  CliLoginCompleteResponse,
  CliLoginExchangeRequest,
  CliLoginExchangeResponse,
  CliLoginStartRequest,
  CliLoginStartResponse,
  FileHistoryResponse,
  HealthResponse,
  PlanTraceResponse,
  PromptEventListResponse,
  PromptEventResponse,
  PromptSearchResponse,
  RepoCreateRequest,
  RepoCreateResponse,
  RepoListResponse,
  RescanSessionsResponse,
  ThreadListResponse,
  ViewerStatusResponse,
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceListResponse,
} from "@promptreel/api-contracts";
import { CodexSessionTailer } from "@promptreel/codex-adapter";
import { PromptreelStore } from "@promptreel/storage";
import { threadSummaryId, type PromptEventListItem, type ThreadSummary, type WorkspaceListItem } from "@promptreel/domain";
import { createCloudStore } from "./cloud-store.js";
import {
  CLOUD_DAEMON_ACTIVE_WINDOW_MS,
  CLOUD_DAEMON_CONNECTED_WINDOW_MS,
  CLOUD_SYNC_ENABLED,
  DAEMON_RUNTIME_MODE,
  buildWorkspaceListItem,
  createCloudSyncController,
  hasRecentWorkspaceActivity,
  type DaemonRuntimeStatus,
} from "./daemon-cloud-sync.js";
import {
  buildCliLoginUrl,
  getBearerToken,
  loadDaemonEnvFiles,
  resolveCloudViewerUser,
  verifyClerkSessionToken,
} from "./daemon-auth.js";
import { buildViewerStatus, listLocalWorkspaceItems } from "./daemon-viewer.js";
import { buildCodeDiffDisplayArtifact, type CodeDiffArtifactMetadata } from "@promptreel/git-integration";

loadDaemonEnvFiles();

function resolveWebDistDir(): string | null {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "apps/web/dist"),
    resolve(process.cwd(), "../web/dist"),
    resolve(currentDir, "../../web/dist"),
    resolve(currentDir, "../../../../../web/dist"),
  ];

  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

export function buildServer() {
  const app = Fastify({
    logger: false,
    bodyLimit: 50 * 1024 * 1024,
  });
  const store = new PromptreelStore();
  const cloudStore = createCloudStore();
  const tailer = new CodexSessionTailer(store, undefined, undefined, (message) => {
    console.log(message);
  });
  const webDistDir = resolveWebDistDir();
  const httpError = (statusCode: number, message: string) => {
    const error = new Error(message) as Error & { statusCode?: number };
    error.statusCode = statusCode;
    return error;
  };
  const notFound = (message: string) => httpError(404, message);
  const runtimeStatus: DaemonRuntimeStatus = {
    lastCloudSyncAt: null as string | null,
    lastCloudSyncError: null as string | null,
    syncInFlight: false,
    pendingDirtyWorkspaceCount: 0,
    nextScheduledSyncAt: null as string | null,
    lastCloudSyncStats: null as null | {
      workspaceCount: number;
      promptCount: number;
      blobCount: number;
    },
  };
  type DaemonEventPayload = {
    kind: "ingest" | "cloud";
    at: string;
    workspaceIds?: string[];
    threadKeys?: string[];
  };
  const localStreamSubscribers = new Set<(payload: DaemonEventPayload) => void>();
  const cloudStreamSubscribersByUserId = new Map<string, Set<(payload: DaemonEventPayload) => void>>();
  const broadcastLocalDaemonEvent = (payload: DaemonEventPayload) => {
    for (const subscriber of localStreamSubscribers) {
      subscriber(payload);
    }
  };
  const broadcastCloudViewerEvent = (userId: string, payload: DaemonEventPayload) => {
    const subscribers = cloudStreamSubscribersByUserId.get(userId);
    if (!subscribers) {
      return;
    }
    for (const subscriber of subscribers) {
      subscriber(payload);
    }
  };
  tailer.subscribe((update) => {
    broadcastLocalDaemonEvent(update);
  });

  const resolveRequestCloudViewerUser = async (headers: Record<string, unknown>) => {
    const cloudViewerRequested = headers["x-promptreel-cloud-viewer"] === "1";
    const cloudUser = await resolveCloudViewerUser(headers, cloudStore);
    if (cloudViewerRequested && !cloudUser) {
      throw httpError(401, "Unable to verify cloud viewer");
    }
    return cloudUser;
  };

  const buildPromptDetailWithParsedDiffs = async (
    prompt: PromptEventResponse["prompt"],
    workspaceId: string,
    readBlob: (blobId: string) => Promise<string>
  ): Promise<PromptEventResponse["prompt"]> => {
    const parsedCodeDiffs = await Promise.all(
      prompt.artifacts
        .filter((artifact) => artifact.type === "code_diff" && artifact.blobId)
        .map(async (artifact) => {
          let metadata: CodeDiffArtifactMetadata | null = null;
          if (artifact.metadataJson) {
            try {
              metadata = JSON.parse(artifact.metadataJson) as CodeDiffArtifactMetadata;
            } catch {
              metadata = null;
            }
          }
          const patch = await readBlob(artifact.blobId!);
          return buildCodeDiffDisplayArtifact({
            artifactId: artifact.id,
            summary: artifact.summary,
            patch,
            sourceFormat: metadata?.sourceFormat ?? null,
          });
        })
    );

    return {
      ...prompt,
      parsedCodeDiffs,
    };
  };

  const toPromptSearchLookupKey = (prompt: Pick<PromptEventListItem, "id" | "threadId" | "sessionId">): string =>
    prompt.threadId ?? prompt.sessionId ?? `prompt:${prompt.id}`;

  const toThreadLookup = (threads: ThreadSummary[]): Map<string, ThreadSummary> => {
    const lookup = new Map<string, ThreadSummary>();
    for (const thread of threads) {
      const key = thread.threadId ?? thread.sessionId;
      if (key) {
        lookup.set(key, thread);
      }
    }
    return lookup;
  };

  const toPromptSearchItem = (
    workspace: WorkspaceListItem,
    prompt: PromptEventListItem,
    threadLookup: Map<string, ThreadSummary>
  ): PromptSearchResponse["prompts"][number] => {
    const lookupKey = toPromptSearchLookupKey(prompt);
    const matchedThread = threadLookup.get(prompt.threadId ?? prompt.sessionId ?? "");
    return {
      promptId: prompt.id,
      workspaceId: workspace.id,
      threadId: matchedThread?.id ?? threadSummaryId(workspace.id, lookupKey),
      workspaceSlug: workspace.slug,
      threadTitle: matchedThread?.lastPromptSummary || prompt.promptSummary || "Untitled thread",
      promptSummary: prompt.promptSummary,
      startedAt: prompt.startedAt,
    };
  };

  const listLocalPromptSearchItems = (): PromptSearchResponse["prompts"] => {
    const workspaces = listLocalWorkspaceItems(store, tailer);
    return workspaces
      .flatMap((workspace) => {
        const threadLookup = toThreadLookup(store.listThreads(workspace.id));
        return store
          .listPrompts(workspace.id)
          .map((prompt) => toPromptSearchItem(workspace, prompt, threadLookup));
      })
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  };

  const listCloudPromptSearchItems = async (userId: string): Promise<PromptSearchResponse["prompts"]> => {
    const workspaces = await cloudStore.listCloudWorkspaces(userId);
    const resultGroups = await Promise.all(
      workspaces.map(async (workspace) => {
        const [threads, prompts] = await Promise.all([
          cloudStore.listCloudThreads(userId, workspace.id),
          cloudStore.listCloudPrompts(userId, workspace.id),
        ]);
        const threadLookup = toThreadLookup(threads);
        return prompts.map((prompt) => toPromptSearchItem(workspace, prompt, threadLookup));
      })
    );
    return resultGroups
      .flat()
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  };

  app.register(cors, {
    origin: true
  });

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    ok: true,
    daemonPid: process.pid,
    homeDir: store.homeDir,
    ingestion: tailer.getStatus()
  }));

  app.get("/api/viewer-status", async (request): Promise<ViewerStatusResponse> => {
    const cloudUser = await resolveRequestCloudViewerUser(request.headers as Record<string, unknown>);
    return buildViewerStatus(cloudUser, cloudStore, tailer, runtimeStatus);
  });

  app.get("/api/events", async (request, reply) => {
    const cloudUser = await resolveRequestCloudViewerUser(request.headers as Record<string, unknown>);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const writeEvent = (event: string, data: DaemonEventPayload | { at: string }) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    writeEvent("ready", { at: new Date().toISOString() });
    const subscriber = (payload: DaemonEventPayload) => {
      writeEvent("update", payload);
    };
    if (cloudUser) {
      const existing = cloudStreamSubscribersByUserId.get(cloudUser.id) ?? new Set<(payload: DaemonEventPayload) => void>();
      existing.add(subscriber);
      cloudStreamSubscribersByUserId.set(cloudUser.id, existing);
    } else {
      localStreamSubscribers.add(subscriber);
    }
    const keepAlive = setInterval(() => {
      writeEvent("ping", { at: new Date().toISOString() });
    }, 25_000);
    let closed = false;
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(keepAlive);
      if (cloudUser) {
        const subscribers = cloudStreamSubscribersByUserId.get(cloudUser.id);
        subscribers?.delete(subscriber);
        if (subscribers && subscribers.size === 0) {
          cloudStreamSubscribersByUserId.delete(cloudUser.id);
        }
      } else {
        localStreamSubscribers.delete(subscriber);
      }
      reply.raw.end();
    };
    request.raw.on("close", cleanup);
    request.raw.on("end", cleanup);
  });

  app.get("/api/workspaces", async (request): Promise<WorkspaceListResponse> => {
    const cloudUser = await resolveRequestCloudViewerUser(request.headers as Record<string, unknown>);
    return {
      workspaces: cloudUser ? await cloudStore.listCloudWorkspaces(cloudUser.id) : listLocalWorkspaceItems(store, tailer)
    };
  });

  app.get("/api/repos", async (): Promise<RepoListResponse> => ({
    repos: listLocalWorkspaceItems(store, tailer)
  }));

  app.post<{ Body: WorkspaceCreateRequest }>("/api/workspaces", async (request): Promise<WorkspaceCreateResponse> => ({
    workspace: store.ensureWorkspaceGroup(request.body.path)
  }));

  app.post<{ Body: RepoCreateRequest }>("/api/repos", async (request): Promise<RepoCreateResponse> => ({
    repo: store.ensureWorkspaceGroup(request.body.path)
  }));

  app.post("/api/workspaces/rescan", async (): Promise<RescanSessionsResponse> => ({
    ok: true,
    ingestion: tailer.scanNow()
  }));

  app.get<{ Querystring: { workspaceId: string } }>("/api/threads", async (request): Promise<ThreadListResponse> => {
    const cloudUser = await resolveRequestCloudViewerUser(request.headers as Record<string, unknown>);
    if (cloudUser) {
      return {
        threads: await cloudStore.listCloudThreads(cloudUser.id, request.query.workspaceId)
      };
    }
    const recentlyUpdatedSessionIds = tailer.getRecentlyUpdatedSessionIds(request.query.workspaceId);
    return {
      threads: store.listThreads(request.query.workspaceId).map((thread) => ({
        ...thread,
        isGenerating: thread.sessionId ? recentlyUpdatedSessionIds.has(thread.sessionId) : false
      }))
    };
  });

  app.get<{ Querystring: { workspaceId?: string; repoId?: string; threadId?: string } }>(
    "/api/prompt-events",
    async (request): Promise<PromptEventListResponse> => {
      const workspaceId = request.query.workspaceId ?? request.query.repoId ?? "";
      const cloudUser = await resolveRequestCloudViewerUser(request.headers as Record<string, unknown>);
      return {
        prompts: cloudUser
          ? await cloudStore.listCloudPrompts(cloudUser.id, workspaceId, request.query.threadId ?? null)
          : store.listPrompts(workspaceId, request.query.threadId ?? null)
      };
    }
  );

  app.get("/api/prompt-search", async (request): Promise<PromptSearchResponse> => {
    const cloudUser = await resolveRequestCloudViewerUser(request.headers as Record<string, unknown>);
    return {
      prompts: cloudUser
        ? await listCloudPromptSearchItems(cloudUser.id)
        : listLocalPromptSearchItems(),
    };
  });

  app.get<{ Querystring: { workspaceId?: string; repoId?: string }; Params: { id: string } }>(
    "/api/prompt-events/:id",
    async (request): Promise<PromptEventResponse> => {
      const workspaceId = request.query.workspaceId ?? request.query.repoId ?? "";
      const cloudUser = await resolveRequestCloudViewerUser(request.headers as Record<string, unknown>);
      const prompt = cloudUser
        ? await cloudStore.getCloudPromptDetail(cloudUser.id, workspaceId, request.params.id)
        : store.getPromptDetail(workspaceId, request.params.id);
      if (!prompt) {
        throw notFound("Prompt not found");
      }
      return {
        prompt: await buildPromptDetailWithParsedDiffs(
          prompt,
          workspaceId,
          cloudUser
            ? (blobId) => cloudStore.readCloudBlob(cloudUser.id, workspaceId, blobId)
            : async (blobId) => store.readBlob(workspaceId, blobId)
        )
      };
    }
  );

  app.get<{ Querystring: { workspaceId?: string; repoId?: string; filePath: string } }>(
    "/api/files/history",
    async (request): Promise<FileHistoryResponse> => ({
      filePath: request.query.filePath,
      prompts: store.getFileHistory(request.query.workspaceId ?? request.query.repoId ?? "", request.query.filePath)
    })
  );

  app.get<{ Querystring: { workspaceId?: string; repoId?: string }; Params: { artifactId: string } }>(
    "/api/plans/:artifactId/trace",
    async (request): Promise<PlanTraceResponse> => {
      const trace = store.getPlanTrace(request.query.workspaceId ?? request.query.repoId ?? "", request.params.artifactId);
      if (!trace) {
        throw notFound("Plan artifact not found");
      }
      return {
        artifactId: request.params.artifactId,
        promptId: trace.promptId,
        steps: trace.steps,
        linkedArtifactIds: trace.linkedArtifactIds
      };
    }
  );

  app.get<{ Querystring: { workspaceId?: string; repoId?: string }; Params: { blobId: string } }>(
    "/api/blobs/:blobId",
    async (request, reply): Promise<BlobResponse> => {
      const workspaceId = request.query.workspaceId ?? request.query.repoId ?? "";
      try {
        const cloudUser = await resolveRequestCloudViewerUser(request.headers as Record<string, unknown>);
        const content = cloudUser
          ? await cloudStore.readCloudBlob(cloudUser.id, workspaceId, request.params.blobId)
          : store.readBlob(workspaceId, request.params.blobId);
        return { blobId: request.params.blobId, content };
      } catch {
        throw notFound("Blob not found");
      }
    }
  );

  app.post<{ Body: CloudBootstrapSyncRequest }>("/api/cloud/sync/bootstrap", async (request): Promise<CloudBootstrapSyncResponse> => {
    const bearerToken = getBearerToken(request.headers as Record<string, unknown>);
    if (!bearerToken) {
      throw httpError(401, "Missing authorization token");
    }
    const auth = await cloudStore.authenticateDaemonToken(bearerToken);
    if (!auth) {
      throw httpError(401, "Invalid daemon token");
    }
    const result = await cloudStore.upsertCloudWorkspaceBundle(auth.user.id, request.body);
    broadcastCloudViewerEvent(auth.user.id, {
      kind: "cloud",
      at: new Date().toISOString(),
      workspaceIds: [result.workspaceId],
    });
    return {
      ok: true,
      workspaceId: result.workspaceId,
      threadCount: result.threadCount,
      promptCount: result.promptCount,
      blobCount: result.blobCount,
    };
  });

  app.post<{ Body: CliLoginStartRequest }>("/api/auth/cli/start", async (request): Promise<CliLoginStartResponse> => {
    const loginRequest = await cloudStore.createCliLoginRequest(request.body.deviceId, request.body.deviceName);
    return {
      loginCode: loginRequest.loginCode,
      expiresAt: loginRequest.expiresAt,
      loginUrl: buildCliLoginUrl(loginRequest.loginCode, request.body.deviceId, request.body.deviceName)
    };
  });

  app.post<{ Body: CliLoginExchangeRequest }>("/api/auth/cli/exchange", async (request): Promise<CliLoginExchangeResponse> => {
    return cloudStore.exchangeCliLoginRequest(request.body.loginCode, request.body.deviceId);
  });

  app.post<{ Body: CliLoginCompleteRequest }>("/api/auth/cli/complete", async (request, reply): Promise<CliLoginCompleteResponse> => {
    const bearerToken = getBearerToken(request.headers as Record<string, unknown>);
    if (!bearerToken) {
      throw httpError(401, "Missing authorization token");
    }

    const clerkSession = await verifyClerkSessionToken(bearerToken);
    if (!clerkSession) {
      throw httpError(401, "Unable to verify Clerk session");
    }

    const email = typeof request.headers["x-promptreel-email"] === "string"
      ? request.headers["x-promptreel-email"]
      : null;
    const name = typeof request.headers["x-promptreel-name"] === "string"
      ? request.headers["x-promptreel-name"]
      : null;
    const avatarUrl = typeof request.headers["x-promptreel-avatar"] === "string"
      ? request.headers["x-promptreel-avatar"]
      : null;

    const approved = await cloudStore.approveCliLoginRequest({
      loginCode: request.body.loginCode,
      clerkUserId: clerkSession.clerkUserId,
      email,
      name,
      avatarUrl,
      deviceId: request.body.deviceId,
      deviceName: request.body.deviceName,
    });

    if (!approved) {
      throw notFound("Login request was not found or has expired");
    }

    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply): Promise<AuthWhoamiResponse> => {
    const bearerToken = getBearerToken(request.headers as Record<string, unknown>);
    if (!bearerToken) {
      reply.code(401);
      return {
        authenticated: false,
        user: null,
        device: null,
      };
    }

    const auth = await cloudStore.authenticateDaemonToken(bearerToken);
    if (!auth) {
      reply.code(401);
      return {
        authenticated: false,
        user: null,
        device: null,
      };
    }

    return {
      authenticated: true,
      user: auth.user,
      device: auth.device,
    };
  });

  if (webDistDir) {
    app.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/",
      decorateReply: true,
      index: false,
    });

    app.get("/", async (_request, reply) => {
      return reply.sendFile("index.html");
    });

    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        reply.code(404);
        return { message: "Not found" };
      }
      return reply.sendFile("index.html");
    });
  }

  return { app, store, tailer, cloudStore, runtimeStatus, broadcastLocalDaemonEvent };
}

export async function startDaemon() {
  const { app, store, tailer, cloudStore, runtimeStatus, broadcastLocalDaemonEvent } = buildServer();
  const port = Number(process.env.PORT ?? process.env.PROMPTREEL_PORT ?? "4312");
  const host = process.env.PROMPTREEL_HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
  const cloudSyncController = createCloudSyncController({
    store,
    tailer,
    runtimeStatus,
    notifyChange: () => {
      broadcastLocalDaemonEvent({ kind: "cloud", at: new Date().toISOString() });
    },
  });

  await cloudStore.ensureReady();
  await app.listen({
    host,
    port
  });
  console.log(`Promptreel daemon listening on http://${host}:${port}`);
  console.log(DAEMON_RUNTIME_MODE === "cloud" ? "Cloud mode." : "Local mode.");
  tailer.start();
  cloudSyncController.start();
  store.setDaemonState(process.pid);
  const shutdown = async () => {
    cloudSyncController.stop();
    tailer.stop();
    store.clearDaemonState();
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startDaemon().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
