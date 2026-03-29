import { useEffect, useMemo, useState } from "react";

type Repo = {
  id: string;
  slug: string;
  rootPath: string;
};

type Prompt = {
  id: string;
  promptSummary: string;
  startedAt: string;
  status: "in_progress" | "completed" | "imported";
  filesTouched: string[];
  childCount: number;
  artifactCount: number;
};

type RepoIngestionStatus = {
  repoId: string;
  mode: "watching" | "error" | "idle";
  sessionFileCount: number;
  recentlyUpdatedSessionCount: number;
  openPromptCount: number;
  lastImportAt: string | null;
  lastImportResult: {
    importedFiles: number;
    importedPrompts: number;
  } | null;
  lastError: string | null;
};

type Health = {
  ok: true;
  daemonPid: number;
  homeDir: string;
  ingestion: {
    watcher: "running" | "stopped";
    pollingIntervalMs: number;
    sessionsRoot: string;
    lastScanAt: string | null;
    repoStatuses: RepoIngestionStatus[];
  };
};

const API_BASE = "http://127.0.0.1:4312/api";

export function App() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string>("");
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.id === selectedRepoId) ?? null,
    [repos, selectedRepoId]
  );
  const selectedRepoStatus = useMemo(
    () => health?.ingestion.repoStatuses.find((status) => status.repoId === selectedRepoId) ?? null,
    [health, selectedRepoId]
  );

  useEffect(() => {
    const refreshRepos = () => {
      fetch(`${API_BASE}/repos`)
        .then((response) => response.json())
        .then((data: { repos: Repo[] }) => {
          setRepos(data.repos);
          if (data.repos.length > 0) {
            setSelectedRepoId((current) => current || data.repos[0].id);
          }
        })
        .catch(() => {
          setRepos([]);
        });
    };

    refreshRepos();
    const interval = window.setInterval(refreshRepos, 5000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const refreshHealth = () => {
      fetch(`${API_BASE}/health`)
        .then((response) => response.json())
        .then((data: Health) => setHealth(data))
        .catch(() => setHealth(null));
    };

    refreshHealth();
    const interval = window.setInterval(refreshHealth, 3000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!selectedRepoId) {
      setPrompts([]);
      return;
    }
    const refreshPrompts = () => {
      fetch(`${API_BASE}/prompt-events?repoId=${encodeURIComponent(selectedRepoId)}`)
        .then((response) => response.json())
        .then((data: { prompts: Prompt[] }) => setPrompts(data.prompts))
        .catch(() => setPrompts([]));
    };

    refreshPrompts();
    const interval = window.setInterval(refreshPrompts, 3000);
    return () => window.clearInterval(interval);
  }, [selectedRepoId]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Promptline</p>
          <h1>Prompt Stream</h1>
          <p className="subtle">Artifact-first causal history for your registered repos.</p>
        </div>
        <div className="repo-list">
          {repos.map((repo) => (
            <button
              key={repo.id}
              className={repo.id === selectedRepoId ? "repo-button active" : "repo-button"}
              onClick={() => setSelectedRepoId(repo.id)}
            >
              <strong>{repo.slug}</strong>
              <span>{repo.rootPath}</span>
            </button>
          ))}
        </div>
      </aside>
      <main className="content">
        <header className="content-header">
          <div>
            <p className="eyebrow">Selected Repo</p>
            <h2>{selectedRepo?.slug ?? "No repo selected"}</h2>
            {selectedRepoStatus && (
              <p className="subtle">
                {selectedRepoStatus.mode === "watching"
                  ? `Watching ${selectedRepoStatus.sessionFileCount} Codex session files`
                  : selectedRepoStatus.mode === "error"
                    ? `Ingestion error: ${selectedRepoStatus.lastError ?? "unknown error"}`
                    : "Waiting for a registered repo to attach"}
                {selectedRepoStatus.mode === "watching" && selectedRepoStatus.openPromptCount > 0
                  ? ` · ${selectedRepoStatus.openPromptCount} open prompt${selectedRepoStatus.openPromptCount === 1 ? "" : "s"}`
                  : ""}
              </p>
            )}
          </div>
          <div className="badge">{prompts.length} prompt events</div>
        </header>
        {selectedRepoStatus && (
          <section className="prompt-card">
            <div className="prompt-meta">
              <span>{selectedRepoStatus.mode}</span>
              <span>{selectedRepoStatus.sessionFileCount} session files</span>
              <span>{selectedRepoStatus.recentlyUpdatedSessionCount} recently updated</span>
              <span>{selectedRepoStatus.openPromptCount} open prompts</span>
            </div>
            <h3>Codex Attachment Status</h3>
            <p className="subtle">
              {selectedRepoStatus.lastImportAt
                ? `Last import ${new Date(selectedRepoStatus.lastImportAt).toLocaleTimeString()}`
                : "No imports yet."}
              {selectedRepoStatus.lastImportResult
                ? ` Imported ${selectedRepoStatus.lastImportResult.importedPrompts} prompt windows from ${selectedRepoStatus.lastImportResult.importedFiles} session files in the latest scan.`
                : ""}
            </p>
          </section>
        )}
        <section className="stream">
          {prompts.map((prompt) => (
            <article className="prompt-card" key={prompt.id}>
              <div className="prompt-meta">
                <span>{new Date(prompt.startedAt).toLocaleString()}</span>
                <span>{prompt.status}</span>
                <span>{prompt.artifactCount} artifacts</span>
                <span>{prompt.childCount} child prompts</span>
              </div>
              <h3>{prompt.promptSummary}</h3>
              <div className="file-row">
                {prompt.filesTouched.length > 0 ? prompt.filesTouched.map((path) => <code key={path}>{path}</code>) : <span className="subtle">No file diff artifact recorded.</span>}
              </div>
            </article>
          ))}
          {prompts.length === 0 && (
            <p className="empty">
              No prompt events yet. The daemon now watches `~/.codex/sessions` automatically for registered repos, so active and resumed Codex threads should appear here as they are imported.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
