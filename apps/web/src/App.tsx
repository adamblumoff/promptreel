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
  filesTouched: string[];
  childCount: number;
  artifactCount: number;
};

const API_BASE = "http://127.0.0.1:4312/api";

export function App() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string>("");
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.id === selectedRepoId) ?? null,
    [repos, selectedRepoId]
  );

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    if (!selectedRepoId) {
      setPrompts([]);
      return;
    }
    fetch(`${API_BASE}/prompt-events?repoId=${encodeURIComponent(selectedRepoId)}`)
      .then((response) => response.json())
      .then((data: { prompts: Prompt[] }) => setPrompts(data.prompts))
      .catch(() => setPrompts([]));
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
          </div>
          <div className="badge">{prompts.length} prompt events</div>
        </header>
        <section className="stream">
          {prompts.map((prompt) => (
            <article className="prompt-card" key={prompt.id}>
              <div className="prompt-meta">
                <span>{new Date(prompt.startedAt).toLocaleString()}</span>
                <span>{prompt.artifactCount} artifacts</span>
                <span>{prompt.childCount} child prompts</span>
              </div>
              <h3>{prompt.promptSummary}</h3>
              <div className="file-row">
                {prompt.filesTouched.length > 0 ? prompt.filesTouched.map((path) => <code key={path}>{path}</code>) : <span className="subtle">No file diff artifact recorded.</span>}
              </div>
            </article>
          ))}
          {prompts.length === 0 && <p className="empty">No prompt events yet. Register a repo, import Codex sessions, or run `pl doctor live`.</p>}
        </section>
      </main>
    </div>
  );
}

