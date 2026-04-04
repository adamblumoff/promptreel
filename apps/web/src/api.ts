import type {
  Health,
  PromptDetail,
  PromptListItem,
  ThreadSummary,
  ViewerStatus,
  Workspace
} from "./types";

const configuredApiBase = import.meta.env.VITE_API_BASE_URL?.trim();
const API_BASE = configuredApiBase
  ? configuredApiBase.replace(/\/+$/, "")
  : typeof window !== "undefined" && !["127.0.0.1", "localhost"].includes(window.location.hostname)
    ? `${window.location.origin}/api`
    : "http://127.0.0.1:4312/api";
const CLOUD_VIEWER_MODE = typeof window !== "undefined" && !["127.0.0.1", "localhost"].includes(window.location.hostname);

let authTokenProvider: (() => Promise<string | null>) | null = null;

type RequestOptions = {
  signal?: AbortSignal;
};

export function setApiAuthTokenProvider(provider: (() => Promise<string | null>) | null): void {
  authTokenProvider = provider;
}

async function getJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = await authTokenProvider?.();
  const response = await fetch(`${API_BASE}${path}`, {
    signal: options.signal,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(token && CLOUD_VIEWER_MODE ? { "x-promptreel-cloud-viewer": "1" } : {}),
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
      ...(token && CLOUD_VIEWER_MODE ? { "x-promptreel-cloud-viewer": "1" } : {}),
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
      ...(token && CLOUD_VIEWER_MODE ? { "x-promptreel-cloud-viewer": "1" } : {}),
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

export function subscribeToLocalViewerEvents(onUpdate: () => void): () => void {
  const eventSource = new EventSource(`${API_BASE}/events`);
  const handleUpdate = () => {
    onUpdate();
  };
  eventSource.addEventListener("update", handleUpdate);
  return () => {
    eventSource.removeEventListener("update", handleUpdate);
    eventSource.close();
  };
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
