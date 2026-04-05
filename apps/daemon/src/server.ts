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
import type { AuthUserProfile, WorkspaceListItem } from "@promptreel/domain";
import { createCloudStore } from "./cloud-store.js";
import {
  CLOUD_DAEMON_ACTIVE_WINDOW_MS,
  CLOUD_DAEMON_CONNECTED_WINDOW_MS,
  CLOUD_SYNC_ENABLED,
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
  const streamSubscribers = new Set<(payload: DaemonEventPayload) => void>();
  const broadcastDaemonEvent = (payload: DaemonEventPayload) => {
    for (const subscriber of streamSubscribers) {
      subscriber(payload);
    }
  };
  tailer.subscribe((update) => {
    broadcastDaemonEvent(update);
  });

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
    const cloudUser = await resolveCloudViewerUser(request.headers as Record<string, unknown>, cloudStore);
    return buildViewerStatus(cloudUser, cloudStore, tailer, runtimeStatus);
  });

  app.get("/api/events", async (request, reply) => {
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
    streamSubscribers.add(subscriber);
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
      streamSubscribers.delete(subscriber);
      reply.raw.end();
    };
    request.raw.on("close", cleanup);
    request.raw.on("end", cleanup);
  });

  app.get("/api/workspaces", async (request): Promise<WorkspaceListResponse> => {
    const cloudUser = await resolveCloudViewerUser(request.headers as Record<string, unknown>, cloudStore);
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
    const cloudUser = await resolveCloudViewerUser(request.headers as Record<string, unknown>, cloudStore);
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
      const cloudUser = await resolveCloudViewerUser(request.headers as Record<string, unknown>, cloudStore);
      return {
        prompts: cloudUser
          ? await cloudStore.listCloudPrompts(cloudUser.id, workspaceId, request.query.threadId ?? null)
          : store.listPrompts(workspaceId, request.query.threadId ?? null)
      };
    }
  );

  app.get<{ Querystring: { workspaceId?: string; repoId?: string }; Params: { id: string } }>(
    "/api/prompt-events/:id",
    async (request): Promise<PromptEventResponse> => {
      const workspaceId = request.query.workspaceId ?? request.query.repoId ?? "";
      const cloudUser = await resolveCloudViewerUser(request.headers as Record<string, unknown>, cloudStore);
      const prompt = cloudUser
        ? await cloudStore.getCloudPromptDetail(cloudUser.id, workspaceId, request.params.id)
        : store.getPromptDetail(workspaceId, request.params.id);
      if (!prompt) {
        throw notFound("Prompt not found");
      }
      return { prompt };
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
        const cloudUser = await resolveCloudViewerUser(request.headers as Record<string, unknown>, cloudStore);
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

  return { app, store, tailer, cloudStore, runtimeStatus, broadcastDaemonEvent };
}

export async function startDaemon() {
  const { app, store, tailer, cloudStore, runtimeStatus, broadcastDaemonEvent } = buildServer();
  const port = Number(process.env.PORT ?? process.env.PROMPTREEL_PORT ?? "4312");
  const host = process.env.PROMPTREEL_HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
  const cloudSyncController = createCloudSyncController({
    store,
    tailer,
    runtimeStatus,
    notifyChange: () => {
      broadcastDaemonEvent({ kind: "cloud", at: new Date().toISOString() });
    },
  });

  await cloudStore.ensureReady();
  await app.listen({
    host,
    port
  });
  console.log(`Promptreel daemon listening on http://${host}:${port}`);
  console.log(CLOUD_SYNC_ENABLED ? "Cloud sync enabled." : "Local-only mode.");
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
