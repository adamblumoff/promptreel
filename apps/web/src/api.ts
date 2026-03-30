import type { Health, PromptDetail, PromptListItem, Repo } from "./types";

const API_BASE = "http://127.0.0.1:4312/api";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchRepos(): Promise<Repo[]> {
  const data = await getJson<{ repos: Repo[] }>("/repos");
  return data.repos;
}

export async function fetchHealth(): Promise<Health> {
  return getJson<Health>("/health");
}

export async function fetchPrompts(repoId: string): Promise<PromptListItem[]> {
  const data = await getJson<{ prompts: PromptListItem[] }>(
    `/prompt-events?repoId=${encodeURIComponent(repoId)}`
  );
  return data.prompts;
}

export async function fetchPromptDetail(repoId: string, promptId: string): Promise<PromptDetail> {
  const data = await getJson<{ prompt: PromptDetail }>(
    `/prompt-events/${encodeURIComponent(promptId)}?repoId=${encodeURIComponent(repoId)}`
  );
  return data.prompt;
}
