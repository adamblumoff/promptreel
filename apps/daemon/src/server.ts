import Fastify from "fastify";
import cors from "@fastify/cors";
import { fileURLToPath } from "node:url";
import { verifyToken } from "@clerk/backend";
import type {
  AuthWhoamiResponse,
  BlobResponse,
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
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceListResponse
} from "@promptline/api-contracts";
import { CodexSessionTailer } from "@promptline/codex-adapter";
import { PromptlineStore } from "@promptline/storage";
import type { AuthUserProfile, WorkspaceListItem } from "@promptline/domain";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function getBearerToken(headers: Record<string, unknown>): string | null {
  const raw = typeof headers.authorization === "string" ? headers.authorization : null;
  if (!raw) {
    return null;
  }
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

async function verifyClerkSessionToken(token: string): Promise<{ clerkUserId: string } | null> {
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

function buildCliLoginUrl(loginCode: string, deviceId: string, deviceName: string | null): string {
  const baseUrl = trimTrailingSlash(
    process.env.PROMPTLINE_WEB_URL?.trim()
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

export function buildServer() {
  const app = Fastify({ logger: false });
  const store = new PromptlineStore();
  const tailer = new CodexSessionTailer(store);
  const httpError = (statusCode: number, message: string) => {
    const error = new Error(message) as Error & { statusCode?: number };
    error.statusCode = statusCode;
    return error;
  };
  const notFound = (message: string) => httpError(404, message);

  app.register(cors, {
    origin: true
  });

  const listWorkspaceItems = (): WorkspaceListItem[] => {
    const statusByWorkspace = new Map(
      tailer.getStatus().workspaceStatuses.map((status) => [status.workspaceId, status])
    );

    return store.listWorkspaces().map((workspace) => {
      const threads = store.listThreads(workspace.id);
      const status = statusByWorkspace.get(workspace.id);
      return {
        ...workspace,
        threadCount: threads.length,
        openThreadCount: threads.filter((thread) => thread.status === "open").length,
        isGenerating: (status?.recentlyUpdatedSessionCount ?? 0) > 0,
        lastActivityAt: threads[0]?.lastActivityAt ?? null,
        sessionFileCount: status?.sessionFileCount ?? 0,
        recentlyUpdatedSessionCount: status?.recentlyUpdatedSessionCount ?? 0,
        mode: status?.mode ?? "idle"
      };
    });
  };

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    ok: true,
    daemonPid: process.pid,
    homeDir: store.homeDir,
    ingestion: tailer.getStatus()
  }));

  app.get("/api/workspaces", async (): Promise<WorkspaceListResponse> => ({
    workspaces: listWorkspaceItems()
  }));

  app.get("/api/repos", async (): Promise<RepoListResponse> => ({
    repos: listWorkspaceItems()
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
    async (request): Promise<PromptEventListResponse> => ({
      prompts: store.listPrompts(request.query.workspaceId ?? request.query.repoId ?? "", request.query.threadId ?? null)
    })
  );

  app.get<{ Querystring: { workspaceId?: string; repoId?: string }; Params: { id: string } }>(
    "/api/prompt-events/:id",
    async (request): Promise<PromptEventResponse> => {
      const workspaceId = request.query.workspaceId ?? request.query.repoId ?? "";
      const prompt = store.getPromptDetail(workspaceId, request.params.id);
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
        const content = store.readBlob(workspaceId, request.params.blobId);
        return { blobId: request.params.blobId, content };
      } catch {
        throw notFound("Blob not found");
      }
    }
  );

  app.post<{ Body: CliLoginStartRequest }>("/api/auth/cli/start", async (request): Promise<CliLoginStartResponse> => {
    const loginRequest = store.createCliLoginRequest(request.body.deviceId, request.body.deviceName);
    return {
      loginCode: loginRequest.loginCode,
      expiresAt: loginRequest.expiresAt,
      loginUrl: buildCliLoginUrl(loginRequest.loginCode, request.body.deviceId, request.body.deviceName)
    };
  });

  app.post<{ Body: CliLoginExchangeRequest }>("/api/auth/cli/exchange", async (request): Promise<CliLoginExchangeResponse> => {
    return store.exchangeCliLoginRequest(request.body.loginCode, request.body.deviceId);
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

    const email = typeof request.headers["x-promptline-email"] === "string"
      ? request.headers["x-promptline-email"]
      : null;
    const name = typeof request.headers["x-promptline-name"] === "string"
      ? request.headers["x-promptline-name"]
      : null;
    const avatarUrl = typeof request.headers["x-promptline-avatar"] === "string"
      ? request.headers["x-promptline-avatar"]
      : null;

    const approved = store.approveCliLoginRequest({
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

    const auth = store.authenticateDaemonToken(bearerToken);
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

  return { app, store, tailer };
}

export async function startDaemon() {
  const { app, store, tailer } = buildServer();
  const port = Number(process.env.PORT ?? process.env.PROMPTLINE_PORT ?? "4312");
  const host = process.env.PROMPTLINE_HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
  await app.listen({
    host,
    port
  });
  tailer.start();
  store.setDaemonState(process.pid);
  const shutdown = async () => {
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
