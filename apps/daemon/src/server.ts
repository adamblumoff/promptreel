import Fastify from "fastify";
import cors from "@fastify/cors";
import { fileURLToPath } from "node:url";
import type {
  BlobResponse,
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
import type { WorkspaceListItem } from "@promptline/domain";

export function buildServer() {
  const app = Fastify({ logger: false });
  const store = new PromptlineStore();
  const tailer = new CodexSessionTailer(store);
  const notFound = (message: string) => {
    const error = new Error(message) as Error & { statusCode?: number };
    error.statusCode = 404;
    return error;
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

  return { app, store, tailer };
}

export async function startDaemon() {
  const { app, store, tailer } = buildServer();
  const port = Number(process.env.PROMPTLINE_PORT ?? "4312");
  await app.listen({
    host: "127.0.0.1",
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
