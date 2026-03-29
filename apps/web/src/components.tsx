import type { ReactNode } from "react";
import type { Health } from "./types";
import type {
  PromptCardViewModel,
  RepoIngestionStatusViewModel,
  RepoViewModel
} from "./view-models";

type AppShellProps = {
  leftRail: ReactNode;
  main: ReactNode;
  contextRail: ReactNode;
};

export function AppShell({ leftRail, main, contextRail }: AppShellProps) {
  return (
    <div className="app-shell">
      {leftRail}
      {main}
      {contextRail}
    </div>
  );
}

type LeftRailProps = {
  repos: RepoViewModel[];
  selectedRepoId: string;
  onSelectRepo: (repoId: string) => void;
  health: Health | null;
};

export function LeftRail({ repos, selectedRepoId, onSelectRepo, health }: LeftRailProps) {
  return (
    <aside className="left-rail">
      <div className="brand-block">
        <p className="eyebrow">Promptline</p>
        <h1>Prompt Stream</h1>
        <p className="intro-copy">
          Review software work by the prompt that caused it, not the commit that happened to contain it.
        </p>
      </div>

      <section className="rail-section">
        <div className="section-head">
          <p className="eyebrow">Registered Repos</p>
        </div>
        <div className="repo-list">
          {repos.length > 0 ? (
            repos.map((repo) => (
              <button
                key={repo.id}
                className={repo.id === selectedRepoId ? "repo-button active" : "repo-button"}
                onClick={() => onSelectRepo(repo.id)}
                type="button"
              >
                <strong>{repo.slug}</strong>
                <span title={repo.rootPath}>{repo.rootPath}</span>
              </button>
            ))
          ) : (
            <div className="rail-note">
              <strong>No repos registered</strong>
              <p>Run `pnpm dev:cli -- repo add .` to attach this workspace.</p>
            </div>
          )}
        </div>
      </section>

      <section className="rail-section rail-footer">
        <div className="compact-status">
          <span className={`status-dot ${health?.ingestion.watcher === "running" ? "live" : "idle"}`} />
          <div>
            <strong>{health?.ingestion.watcher === "running" ? "Watcher running" : "Watcher stopped"}</strong>
            <p>{health?.ingestion.sessionsRoot ?? "Waiting for daemon health"}</p>
          </div>
        </div>
      </section>
    </aside>
  );
}

type MainColumnProps = {
  selectedRepo: RepoViewModel | null;
  selectedRepoStatus: RepoIngestionStatusViewModel | null;
  promptCards: PromptCardViewModel[];
  filter: "all" | "open" | "imported";
  onFilterChange: (filter: "all" | "open" | "imported") => void;
};

export function MainColumn({
  selectedRepo,
  selectedRepoStatus,
  promptCards,
  filter,
  onFilterChange
}: MainColumnProps) {
  return (
    <main className="main-column">
      <header className="main-header">
        <div className="main-heading">
          <p className="eyebrow">Selected Repo</p>
          <h2>{selectedRepo?.slug ?? "No repo selected"}</h2>
          <p className="subtle header-copy">
            {selectedRepo?.rootPath ?? "Pick a repo to view its causal prompt stream."}
          </p>
        </div>
        <div className="header-badges">
          <div className="count-badge">{promptCards.length} prompt events</div>
          {selectedRepoStatus && (
            <div className={`count-badge tone-${selectedRepoStatus.tone}`}>
              {selectedRepoStatus.openPromptCount} open
            </div>
          )}
        </div>
      </header>

      {selectedRepoStatus && <AttachmentBanner status={selectedRepoStatus} />}

      <section className="stream-toolbar">
        <div className="toolbar-group">
          <button className={filter === "all" ? "toolbar-chip active" : "toolbar-chip"} onClick={() => onFilterChange("all")} type="button">All</button>
          <button className={filter === "open" ? "toolbar-chip active" : "toolbar-chip"} onClick={() => onFilterChange("open")} type="button">Open</button>
          <button className={filter === "imported" ? "toolbar-chip active" : "toolbar-chip"} onClick={() => onFilterChange("imported")} type="button">Imported</button>
        </div>
        <div className="toolbar-meta">
          <span>Newest first</span>
          <span>Polling for changes</span>
        </div>
      </section>

      <PromptStream promptCards={promptCards} />
    </main>
  );
}

type AttachmentBannerProps = {
  status: RepoIngestionStatusViewModel;
};

export function AttachmentBanner({ status }: AttachmentBannerProps) {
  return (
    <section className={`attachment-banner tone-${status.tone}`}>
      <div className="banner-copy">
        <p className="eyebrow">Live Attachment</p>
        <h3>{status.headline}</h3>
        <p className="subtle">
          {status.mode === "watching"
            ? `${status.openPromptCount} open prompt${status.openPromptCount === 1 ? "" : "s"} across ${status.recentlyUpdatedSessionCount} recently updated session file${status.recentlyUpdatedSessionCount === 1 ? "" : "s"}.`
            : status.mode === "error"
              ? status.lastError ?? "Watcher error"
              : "Promptline will attach as soon as Codex starts writing session activity for this repo."}
        </p>
      </div>
      <div className="banner-stats">
        <span>{status.lastImportLabel}</span>
        {status.lastImportResult && (
          <span>
            {status.lastImportResult.importedPrompts} windows from {status.lastImportResult.importedFiles} files
          </span>
        )}
      </div>
    </section>
  );
}

type PromptStreamProps = {
  promptCards: PromptCardViewModel[];
};

export function PromptStream({ promptCards }: PromptStreamProps) {
  if (promptCards.length === 0) {
    return <EmptyState />;
  }

  return (
    <section className="prompt-stream">
      {promptCards.map((prompt) => (
        <PromptCard key={prompt.id} prompt={prompt} />
      ))}
    </section>
  );
}

type PromptCardProps = {
  prompt: PromptCardViewModel;
};

export function PromptCard({ prompt }: PromptCardProps) {
  return (
    <article className={`prompt-card tone-${prompt.tone}`}>
      <div className="prompt-topline">
        <span className={`status-pill status-${prompt.status}`}>{prompt.statusLabel}</span>
        <span>{prompt.timestampLabel}</span>
        <span>{prompt.artifactLabel}</span>
        <span>{prompt.childLabel}</span>
      </div>

      <div className="prompt-body">
        <div className="prompt-copy">
          <p className="eyebrow">Primary Artifact</p>
          <h3>{prompt.promptSummary}</h3>
          <p className="prompt-preview">
            <strong>{prompt.primaryLabel}</strong>
            <span>{prompt.primarySummary}</span>
          </p>
        </div>

        <div className="prompt-files">
          <p className="eyebrow">Touched Files</p>
          <div className="file-row">
            {prompt.filesTouched.length > 0 ? (
              prompt.filesTouched.slice(0, 5).map((path) => (
                <code key={path} title={path}>
                  {path}
                </code>
              ))
            ) : (
              <span className="subtle">No file diff artifact recorded.</span>
            )}
            {prompt.filesTouched.length > 5 && (
              <span className="file-overflow">+{prompt.filesTouched.length - 5} more</span>
            )}
          </div>
        </div>
      </div>

      <div className="prompt-footer">
        <span className="evidence-chip">{prompt.filesLabel}</span>
        {prompt.isLiveDerived && <span className="evidence-chip live">Live derived</span>}
        {prompt.hasCodeDiff && <span className="evidence-chip">Has diff</span>}
      </div>
    </article>
  );
}

type ContextRailProps = {
  selectedRepoStatus: RepoIngestionStatusViewModel | null;
};

export function ContextRail({ selectedRepoStatus }: ContextRailProps) {
  return (
    <aside className="context-rail">
      <HealthCard status={selectedRepoStatus} />
      <ExplainerCard
        eyebrow="What Promptline Tracks"
        title="Prompt, artifact, evidence, durability"
        body="Promptline groups prompts by the work they caused: plans, diffs, commands, tests, and the live state around them."
      />
      <ExplainerCard
        eyebrow="Coming Next"
        title="Code Story"
        body="Trace any file by prompt, not just by commit, and see why a line exists in the first place."
      />
      <ExplainerCard
        eyebrow="Coming Next"
        title="Plan Trace"
        body="Line up a plan with the prompts, diffs, and tests that eventually implemented each step."
      />
    </aside>
  );
}

type HealthCardProps = {
  status: RepoIngestionStatusViewModel | null;
};

export function HealthCard({ status }: HealthCardProps) {
  return (
    <section className="context-card">
      <p className="eyebrow">Codex Attachment Status</p>
      <h3>{status?.headline ?? "Waiting for repo selection"}</h3>
      {status ? (
        <dl className="metric-grid">
          <div>
            <dt>Mode</dt>
            <dd>{status.mode}</dd>
          </div>
          <div>
            <dt>Session files</dt>
            <dd>{status.sessionFileCount}</dd>
          </div>
          <div>
            <dt>Recently updated</dt>
            <dd>{status.recentlyUpdatedSessionCount}</dd>
          </div>
          <div>
            <dt>Open prompts</dt>
            <dd>{status.openPromptCount}</dd>
          </div>
        </dl>
      ) : (
        <p className="subtle">Register and select a repo to see live watcher health.</p>
      )}
    </section>
  );
}

type ExplainerCardProps = {
  eyebrow: string;
  title: string;
  body: string;
};

export function ExplainerCard({ eyebrow, title, body }: ExplainerCardProps) {
  return (
    <section className="context-card">
      <p className="eyebrow">{eyebrow}</p>
      <h3>{title}</h3>
      <p className="subtle">{body}</p>
    </section>
  );
}

export function EmptyState() {
  return (
    <section className="empty-state">
      <p className="eyebrow">No Prompt Events Yet</p>
      <h3>The stream is ready and watching.</h3>
      <p className="subtle">
        Promptline automatically tails `~/.codex/sessions` for registered repos. Once Codex writes activity for this workspace, prompt events will appear here with live attachment status and artifact context.
      </p>
      <ol className="empty-steps">
        <li>Register the repo once with `pnpm dev:cli -- repo add .`.</li>
        <li>Keep `pnpm dev` running while you work in Codex.</li>
        <li>Watch the banner and context rail for open prompts and fresh imports.</li>
      </ol>
    </section>
  );
}
