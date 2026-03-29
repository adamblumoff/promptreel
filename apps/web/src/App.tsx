import { useEffect, useState } from "react";
import type { Health, Prompt, Repo } from "./types";
import {
  AppShell,
  ContextRail,
  LeftRail,
  MainColumn
} from "./components";
import {
  getSelectedRepo,
  getSelectedRepoStatus,
  toPromptCardViewModel
} from "./view-models";

const API_BASE = "http://127.0.0.1:4312/api";

export function App() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState("");
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [filter, setFilter] = useState<"all" | "open" | "imported">("all");

  useEffect(() => {
    let cancelled = false;

    const refreshRepos = async () => {
      try {
        const response = await fetch(`${API_BASE}/repos`);
        const data = (await response.json()) as { repos: Repo[] };
        if (cancelled) {
          return;
        }
        setRepos(data.repos);
        setSelectedRepoId((current) => current || data.repos[0]?.id || "");
      } catch {
        if (!cancelled) {
          setRepos([]);
        }
      }
    };

    void refreshRepos();
    const interval = window.setInterval(() => {
      void refreshRepos();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const refreshHealth = async () => {
      try {
        const response = await fetch(`${API_BASE}/health`);
        const data = (await response.json()) as Health;
        if (!cancelled) {
          setHealth(data);
        }
      } catch {
        if (!cancelled) {
          setHealth(null);
        }
      }
    };

    void refreshHealth();
    const interval = window.setInterval(() => {
      void refreshHealth();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!selectedRepoId) {
      setPrompts([]);
      return;
    }

    let cancelled = false;

    const refreshPrompts = async () => {
      try {
        const response = await fetch(`${API_BASE}/prompt-events?repoId=${encodeURIComponent(selectedRepoId)}`);
        const data = (await response.json()) as { prompts: Prompt[] };
        if (!cancelled) {
          setPrompts(data.prompts);
        }
      } catch {
        if (!cancelled) {
          setPrompts([]);
        }
      }
    };

    void refreshPrompts();
    const interval = window.setInterval(() => {
      void refreshPrompts();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedRepoId]);

  const selectedRepo = getSelectedRepo(repos, selectedRepoId);
  const selectedRepoStatus = getSelectedRepoStatus(health, selectedRepoId);
  const promptCards = prompts
    .filter((prompt) => {
      if (filter === "open") {
        return prompt.status === "in_progress";
      }
      if (filter === "imported") {
        return prompt.status !== "in_progress";
      }
      return true;
    })
    .map(toPromptCardViewModel);

  return (
    <AppShell
      leftRail={
        <LeftRail
          repos={repos}
          selectedRepoId={selectedRepoId}
          onSelectRepo={setSelectedRepoId}
          health={health}
        />
      }
      main={
        <MainColumn
          selectedRepo={selectedRepo}
          selectedRepoStatus={selectedRepoStatus}
          promptCards={promptCards}
          filter={filter}
          onFilterChange={setFilter}
        />
      }
      contextRail={<ContextRail selectedRepoStatus={selectedRepoStatus} />}
    />
  );
}
