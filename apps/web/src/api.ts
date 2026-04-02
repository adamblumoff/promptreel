import type {
  Health,
  PromptDetail,
  PromptListItem,
  ThreadSummary,
  Workspace
} from "./types";

const API_BASE = "http://127.0.0.1:4312/api";

type RequestOptions = {
  signal?: AbortSignal;
};

async function getJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    signal: options.signal
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: "{}",
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
