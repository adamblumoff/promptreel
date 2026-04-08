import type {
  Health,
  PromptDetail,
  PromptListItem,
  PromptSearchItem,
  ThreadSummary,
  ViewerStatus,
  Workspace
} from "./types";
import { IS_CLOUD_VIEWER_MODE } from "./runtime-mode";

const configuredApiBase = import.meta.env.VITE_API_BASE_URL?.trim();
const API_BASE = configuredApiBase
  ? configuredApiBase.replace(/\/+$/, "")
  : typeof window !== "undefined" && IS_CLOUD_VIEWER_MODE
    ? `${window.location.origin}/api`
    : "http://127.0.0.1:4312/api";

let authTokenProvider: (() => Promise<string | null>) | null = null;

type RequestOptions = {
  signal?: AbortSignal;
};

export type LocalViewerEvent = {
  kind: "ingest" | "cloud";
  at: string;
  workspaceIds?: string[];
  threadKeys?: string[];
};

type SseEventHandler = (eventName: string, data: string) => void;

export function setApiAuthTokenProvider(provider: (() => Promise<string | null>) | null): void {
  authTokenProvider = provider;
}

async function getJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = await authTokenProvider?.();
  const response = await fetch(`${API_BASE}${path}`, {
    signal: options.signal,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(token && IS_CLOUD_VIEWER_MODE ? { "x-promptreel-cloud-viewer": "1" } : {}),
    }
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = await authTokenProvider?.();
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(token && IS_CLOUD_VIEWER_MODE ? { "x-promptreel-cloud-viewer": "1" } : {}),
    },
    body: "{}",
    signal: options.signal
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJsonWithBody<T>(
  path: string,
  body: unknown,
  options: RequestOptions & { headers?: Record<string, string> } = {}
): Promise<T> {
  const token = await authTokenProvider?.();
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(token && IS_CLOUD_VIEWER_MODE ? { "x-promptreel-cloud-viewer": "1" } : {}),
      ...(options.headers ?? {})
    },
    body: JSON.stringify(body),
    signal: options.signal
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchWorkspaces(options: RequestOptions = {}): Promise<Workspace[]> {
  const data = await getJson<{ workspaces: Workspace[] }>("/workspaces", options);
  return data.workspaces;
}

export async function fetchHealth(options: RequestOptions = {}): Promise<Health> {
  return getJson<Health>("/health", options);
}

export async function fetchViewerStatus(options: RequestOptions = {}): Promise<ViewerStatus> {
  return getJson<ViewerStatus>("/viewer-status", options);
}

export async function fetchThreads(workspaceId: string, options: RequestOptions = {}): Promise<ThreadSummary[]> {
  const data = await getJson<{ threads: ThreadSummary[] }>(
    `/threads?workspaceId=${encodeURIComponent(workspaceId)}`,
    options
  );
  return data.threads;
}

export async function fetchPrompts(
  workspaceId: string,
  threadId: string,
  options: RequestOptions = {}
): Promise<PromptListItem[]> {
  const data = await getJson<{ prompts: PromptListItem[] }>(
    `/prompt-events?workspaceId=${encodeURIComponent(workspaceId)}&threadId=${encodeURIComponent(threadId)}`,
    options
  );
  return data.prompts;
}

export async function fetchPromptSearchIndex(options: RequestOptions = {}): Promise<PromptSearchItem[]> {
  try {
    const data = await getJson<{ prompts: PromptSearchItem[] }>("/prompt-search", options);
    return data.prompts;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("404")) {
      throw error;
    }
  }

  const workspaces = await fetchWorkspaces(options);
  const promptGroups = await Promise.all(
    workspaces.map(async (workspace) => {
      const threads = await fetchThreads(workspace.id, options);
      const promptsByThread = await Promise.all(
        threads.map(async (thread) => {
          const lookupKey = thread.threadId ?? thread.sessionId;
          if (!lookupKey) {
            return [] as PromptSearchItem[];
          }
          const prompts = await fetchPrompts(workspace.id, lookupKey, options);
          return prompts.map((prompt) => ({
            promptId: prompt.id,
            workspaceId: workspace.id,
            threadId: thread.id,
            workspaceSlug: workspace.slug,
            threadTitle: thread.lastPromptSummary || prompt.promptSummary || "Untitled thread",
            promptSummary: prompt.promptSummary,
            startedAt: prompt.startedAt,
          }));
        })
      );
      return promptsByThread.flat();
    })
  );

  return promptGroups
    .flat()
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export async function fetchPromptDetail(
  workspaceId: string,
  promptId: string,
  options: RequestOptions = {}
): Promise<PromptDetail> {
  const data = await getJson<{ prompt: PromptDetail }>(
    `/prompt-events/${encodeURIComponent(promptId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    options
  );
  return data.prompt;
}

export async function rescanSessions(options: RequestOptions = {}): Promise<Health["ingestion"]> {
  const data = await postJson<{ ok: true; ingestion: Health["ingestion"] }>("/workspaces/rescan", options);
  return data.ingestion;
}

export async function fetchBlob(
  workspaceId: string,
  blobId: string,
  options: RequestOptions = {}
): Promise<string> {
  const data = await getJson<{ blobId: string; content: string }>(
    `/blobs/${encodeURIComponent(blobId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    options
  );
  return data.content;
}

export function getApiBaseUrl(): string {
  return API_BASE;
}

function subscribeToPublicViewerEvents(onUpdate: (event: LocalViewerEvent) => void): () => void {
  const eventSource = new EventSource(`${API_BASE}/events`);
  const handleUpdate = (event: Event) => {
    if (!(event instanceof MessageEvent)) {
      return;
    }
    onUpdate(JSON.parse(event.data) as LocalViewerEvent);
  };
  eventSource.addEventListener("update", handleUpdate);
  return () => {
    eventSource.removeEventListener("update", handleUpdate);
    eventSource.close();
  };
}

async function consumeSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: SseEventHandler
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }
    onEvent(eventName, dataLines.join("\n"));
    eventName = "message";
    dataLines = [];
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line === "") {
        dispatch();
        continue;
      }
      if (line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trimStart();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0 && buffer.startsWith("data:")) {
    dataLines.push(buffer.slice(5).trimStart());
  }
  dispatch();
}

function subscribeToAuthenticatedViewerEvents(onUpdate: (event: LocalViewerEvent) => void): () => void {
  let cancelled = false;
  let activeController: AbortController | null = null;
  let reconnectTimer: number | null = null;

  const clearReconnect = () => {
    if (reconnectTimer != null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (cancelled) {
      return;
    }
    clearReconnect();
    reconnectTimer = window.setTimeout(() => {
      void connect();
    }, 2_000);
  };

  const connect = async () => {
    clearReconnect();
    const token = await authTokenProvider?.();
    if (cancelled || !token) {
      scheduleReconnect();
      return;
    }

    const controller = new AbortController();
    activeController = controller;
    try {
      const response = await fetch(`${API_BASE}/events`, {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "x-promptreel-cloud-viewer": "1",
          Accept: "text/event-stream",
        },
      });
      if (!response.ok || !response.body) {
        throw new Error(`SSE request failed: ${response.status}`);
      }
      await consumeSseStream(response.body, (eventName, data) => {
        if (eventName !== "update") {
          return;
        }
        onUpdate(JSON.parse(data) as LocalViewerEvent);
      });
      if (!cancelled) {
        scheduleReconnect();
      }
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      if (!cancelled && !aborted) {
        scheduleReconnect();
      }
    } finally {
      if (activeController === controller) {
        activeController = null;
      }
    }
  };

  void connect();

  return () => {
    cancelled = true;
    clearReconnect();
    activeController?.abort();
  };
}

export function subscribeToViewerEvents(onUpdate: (event: LocalViewerEvent) => void): () => void {
  return IS_CLOUD_VIEWER_MODE
    ? subscribeToAuthenticatedViewerEvents(onUpdate)
    : subscribeToPublicViewerEvents(onUpdate);
}

export function subscribeToLocalViewerEvents(onUpdate: (event: LocalViewerEvent) => void): () => void {
  return subscribeToPublicViewerEvents(onUpdate);
}

export async function completeCliLogin(
  input: { loginCode: string; deviceId: string; deviceName: string | null },
  sessionToken: string,
  userProfile: { email: string | null; name: string | null; avatarUrl: string | null },
  options: RequestOptions = {}
): Promise<{ ok: true }> {
  return postJsonWithBody<{ ok: true }>("/auth/cli/complete", input, {
    ...options,
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      ...(userProfile.email ? { "x-promptreel-email": userProfile.email } : {}),
      ...(userProfile.name ? { "x-promptreel-name": userProfile.name } : {}),
      ...(userProfile.avatarUrl ? { "x-promptreel-avatar": userProfile.avatarUrl } : {}),
    },
  });
}
