import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyToken } from "@clerk/backend";
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
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceListResponse
} from "@promptreel/api-contracts";
import { CodexSessionTailer } from "@promptreel/codex-adapter";
import { PromptreelStore } from "@promptreel/storage";
import type { AuthUserProfile, WorkspaceListItem } from "@promptreel/domain";
import { createCloudStore } from "./cloud-store.js";

loadDaemonEnvFiles();

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function loadDaemonEnvFiles(): void {
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

function buildWorkspaceListItem(store: PromptreelStore, tailer: CodexSessionTailer, workspaceId: string): WorkspaceListItem | null {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) {
    return null;
  }
  const status = tailer.getStatus().workspaceStatuses.find((item) => item.workspaceId === workspaceId);
  const threads = store.listThreads(workspace.id);
  return {
    ...workspace,
    threadCount: threads.length,
    openThreadCount: threads.filter((thread) => thread.status === "open").length,
    isGenerating: (status?.recentlyUpdatedSessionCount ?? 0) > 0,
    lastActivityAt: threads[0]?.lastActivityAt ?? null,
    sessionFileCount: status?.sessionFileCount ?? 0,
    recentlyUpdatedSessionCount: status?.recentlyUpdatedSessionCount ?? 0,
    mode: status?.mode ?? "idle",
  };
}

function buildCloudBootstrapBundle(
  store: PromptreelStore,
  tailer: CodexSessionTailer,
  workspaceId: string
): CloudBootstrapSyncRequest | null {
  const workspace = buildWorkspaceListItem(store, tailer, workspaceId);
  if (!workspace) {
    return null;
  }
  const threads = store.listThreads(workspaceId);
  const prompts = store.listPrompts(workspaceId);
  if (prompts.length === 0) {
    return null;
  }
  const promptDetails = prompts
    .map((prompt) => store.getPromptDetail(workspaceId, prompt.id))
    .filter((detail): detail is NonNullable<typeof detail> => detail !== null);
  const blobMap = new Map<string, string>();

  for (const detail of promptDetails) {
    for (const artifact of detail.artifacts) {
      if (!artifact.blobId || blobMap.has(artifact.blobId)) {
        continue;
      }
      blobMap.set(artifact.blobId, store.readBlob(workspaceId, artifact.blobId));
    }
  }

  return {
    workspace,
    threads,
    prompts,
    promptDetails,
    blobs: [...blobMap.entries()].map(([blobId, content]) => ({ blobId, content })),
  };
}

async function postJsonWithToken<TResponse, TBody extends object>(
  apiBaseUrl: string,
  path: string,
  token: string,
  body: TBody
): Promise<TResponse> {
  const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Cloud sync request failed: ${response.status}`);
  }
  return response.json() as Promise<TResponse>;
}

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
  const cloudStore = createCloudStore(store);
  const tailer = new CodexSessionTailer(store);
  const webDistDir = resolveWebDistDir();
  const httpError = (statusCode: number, message: string) => {
    const error = new Error(message) as Error & { statusCode?: number };
    error.statusCode = statusCode;
    return error;
  };
  const notFound = (message: string) => httpError(404, message);
  const resolveCloudViewerUser = async (headers: Record<string, unknown>): Promise<AuthUserProfile | null> => {
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
  };

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

  app.get("/api/workspaces", async (request): Promise<WorkspaceListResponse> => {
    const cloudUser = await resolveCloudViewerUser(request.headers as Record<string, unknown>);
    return {
      workspaces: cloudUser ? await cloudStore.listCloudWorkspaces(cloudUser.id) : listWorkspaceItems()
    };
  });

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
    const cloudUser = await resolveCloudViewerUser(request.headers as Record<string, unknown>);
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
      const cloudUser = await resolveCloudViewerUser(request.headers as Record<string, unknown>);
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
      const cloudUser = await resolveCloudViewerUser(request.headers as Record<string, unknown>);
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
        const cloudUser = await resolveCloudViewerUser(request.headers as Record<string, unknown>);
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

  return { app, store, tailer, cloudStore };
}

export async function startDaemon() {
  const { app, store, tailer, cloudStore } = buildServer();
  const port = Number(process.env.PORT ?? process.env.PROMPTLINE_PORT ?? "4312");
  const host = process.env.PROMPTLINE_HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
  const syncedWorkspaceFingerprints = new Map<string, string>();
  let syncInFlight = false;

  const syncCloudWorkspaces = async () => {
    if (syncInFlight) {
      return;
    }
    const authState = store.getCloudAuthState();
    if (!authState?.daemonToken) {
      return;
    }

    syncInFlight = true;
    try {
      const statusByWorkspace = new Map(
        tailer.getStatus().workspaceStatuses.map((status) => [status.workspaceId, status])
      );
      const workspaces = store.listWorkspaces();
      for (const workspace of workspaces) {
        const promptCount = store.listPrompts(workspace.id).length;
        if (promptCount === 0) {
          continue;
        }
        const status = statusByWorkspace.get(workspace.id);
        const fingerprint = [
          status?.lastImportAt ?? "",
          String(status?.recentlyUpdatedSessionCount ?? 0),
          String(promptCount),
        ].join("|");
        if (syncedWorkspaceFingerprints.get(workspace.id) === fingerprint) {
          continue;
        }
        const bundle = buildCloudBootstrapBundle(store, tailer, workspace.id);
        if (!bundle) {
          continue;
        }
        await postJsonWithToken<CloudBootstrapSyncResponse, CloudBootstrapSyncRequest>(
          authState.apiBaseUrl,
          "/cloud/sync/bootstrap",
          authState.daemonToken,
          bundle
        );
        syncedWorkspaceFingerprints.set(workspace.id, fingerprint);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      syncInFlight = false;
    }
  };

  await cloudStore.ensureReady();
  await app.listen({
    host,
    port
  });
  tailer.start();
  void syncCloudWorkspaces();
  const cloudSyncTimer = setInterval(() => {
    void syncCloudWorkspaces();
  }, 5_000);
  store.setDaemonState(process.pid);
  const shutdown = async () => {
    clearInterval(cloudSyncTimer);
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
