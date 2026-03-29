import Fastify from "fastify";
import cors from "@fastify/cors";
import { fileURLToPath } from "node:url";
import type {
  FileHistoryResponse,
  HealthResponse,
  PlanTraceResponse,
  PromptEventListResponse,
  PromptEventResponse,
  RepoCreateRequest,
  RepoCreateResponse,
  RepoListResponse
} from "@promptline/api-contracts";
import { CodexSessionTailer } from "@promptline/codex-adapter";
import { PromptlineStore } from "@promptline/storage";

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

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    ok: true,
    daemonPid: process.pid,
    homeDir: store.homeDir,
    ingestion: tailer.getStatus()
  }));

  app.get("/api/repos", async (): Promise<RepoListResponse> => ({
    repos: store.listRepos()
  }));

  app.post<{ Body: RepoCreateRequest }>("/api/repos", async (request): Promise<RepoCreateResponse> => ({
    repo: store.addRepo(request.body.path)
  }));

  app.get<{ Querystring: { repoId: string } }>("/api/prompt-events", async (request): Promise<PromptEventListResponse> => ({
    prompts: store.listPrompts(request.query.repoId)
  }));

  app.get<{ Querystring: { repoId: string }; Params: { id: string } }>(
    "/api/prompt-events/:id",
    async (request): Promise<PromptEventResponse> => {
      const prompt = store.getPromptDetail(request.query.repoId, request.params.id);
      if (!prompt) {
        throw notFound("Prompt not found");
      }
      return { prompt };
    }
  );

  app.get<{ Querystring: { repoId: string; filePath: string } }>(
    "/api/files/history",
    async (request): Promise<FileHistoryResponse> => ({
      filePath: request.query.filePath,
      prompts: store.getFileHistory(request.query.repoId, request.query.filePath)
    })
  );

  app.get<{ Querystring: { repoId: string }; Params: { artifactId: string } }>(
    "/api/plans/:artifactId/trace",
    async (request): Promise<PlanTraceResponse> => {
      const trace = store.getPlanTrace(request.query.repoId, request.params.artifactId);
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

  return { app, store, tailer };
}

export async function startDaemon() {
  const { app, store, tailer } = buildServer();
  const port = Number(process.env.PROMPTLINE_PORT ?? "4312");
  tailer.start();
  await app.listen({
    host: "127.0.0.1",
    port
  });
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
