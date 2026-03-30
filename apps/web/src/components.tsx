import type { ReactNode } from "react";
import type { Health, Repo } from "./types";
import type {
  ProjectSidebarItemViewModel,
  PromptDetailViewModel,
  PromptRowViewModel,
  RepoIngestionStatusViewModel
} from "./view-models";

type AppShellProps = {
  sidebar: ReactNode;
  main: ReactNode;
  contextRail: ReactNode;
  isSidebarCollapsed: boolean;
};

export function AppShell({ sidebar, main, contextRail, isSidebarCollapsed }: AppShellProps) {
  return (
    <div className={isSidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      {sidebar}
      {main}
      {contextRail}
    </div>
  );
}

type ProjectSidebarProps = {
  projects: ProjectSidebarItemViewModel[];
  selectedProjectId: string;
  onSelectProject: (projectId: string) => void;
  health: Health | null;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isDrawerOpen: boolean;
  onCloseDrawer: () => void;
};

export function ProjectSidebar({
  projects,
  selectedProjectId,
  onSelectProject,
  health,
  isCollapsed,
  onToggleCollapse,
  isDrawerOpen,
  onCloseDrawer
}: ProjectSidebarProps) {
  return (
    <>
      <button
        aria-hidden={!isDrawerOpen}
        className={isDrawerOpen ? "sidebar-scrim visible" : "sidebar-scrim"}
        onClick={onCloseDrawer}
        tabIndex={isDrawerOpen ? 0 : -1}
        type="button"
      />
      <aside
        className={[
          "project-sidebar",
          isCollapsed ? "collapsed" : "",
          isDrawerOpen ? "drawer-open" : ""
        ].filter(Boolean).join(" ")}
      >
        <div className="brand-block sidebar-brand">
          <div className="sidebar-brand-copy">
            <p className="eyebrow">Promptline</p>
            {!isCollapsed && (
              <>
                <h1>Prompt Stream</h1>
                <p className="intro-copy">
                  Review software work by the prompt that caused it, not the commit that happened to contain it.
                </p>
              </>
            )}
          </div>
          <div className="sidebar-controls">
            <button className="sidebar-toggle mobile-only" onClick={onCloseDrawer} type="button">
              Close
            </button>
            <button className="sidebar-toggle desktop-only" onClick={onToggleCollapse} type="button">
              {isCollapsed ? "Expand" : "Collapse"}
            </button>
          </div>
        </div>

        <section className="rail-section project-section">
          <div className="section-head">
            <p className="eyebrow">{isCollapsed ? "Projects" : "Registered Projects"}</p>
          </div>
          <div className={isCollapsed ? "project-pill-list" : "project-list"}>
            {projects.length > 0 ? (
              projects.map((project) => (
                <button
                  aria-pressed={project.id === selectedProjectId}
                  className={project.id === selectedProjectId ? "project-button active" : "project-button"}
                  key={project.id}
                  onClick={() => onSelectProject(project.id)}
                  title={isCollapsed ? `${project.slug}\n${project.rootPath}` : project.rootPath}
                  type="button"
                >
                  {isCollapsed ? (
                    <span className={`project-pill tone-${project.statusTone}`}>
                      {project.slug.slice(0, 2).toUpperCase()}
                    </span>
                  ) : (
                    <>
                      <div className="project-button-heading">
                        <strong>{project.slug}</strong>
                        <span className={`project-open-count tone-${project.statusTone}`}>
                          {project.openPromptLabel}
                        </span>
                      </div>
                      <span className="project-root-path" title={project.rootPath}>
                        {project.rootPath}
                      </span>
                      <span className="project-activity">{project.activityLabel}</span>
                    </>
                  )}
                </button>
              ))
            ) : (
              <div className="rail-note">
                <strong>No projects registered</strong>
                {!isCollapsed && <p>Run `pnpm dev:cli -- repo add .` to attach this workspace.</p>}
              </div>
            )}
          </div>
        </section>

        <section className="rail-section rail-footer">
          <div className="compact-status">
            <span className={`status-dot ${health?.ingestion.watcher === "running" ? "live" : "idle"}`} />
            {!isCollapsed && (
              <div>
                <strong>{health?.ingestion.watcher === "running" ? "Watcher running" : "Watcher stopped"}</strong>
                <p>{health?.ingestion.sessionsRoot ?? "Waiting for daemon health"}</p>
              </div>
            )}
          </div>
        </section>
      </aside>
    </>
  );
}

type MainColumnProps = {
  selectedProject: Repo | null;
  selectedProjectStatus: RepoIngestionStatusViewModel | null;
  promptRows: PromptRowViewModel[];
  promptDetails: Record<string, PromptDetailViewModel>;
  detailLoadingById: Record<string, boolean>;
  detailErrorById: Record<string, string | null>;
  expandedPromptId: string | null;
  filter: "all" | "open" | "imported";
  onFilterChange: (filter: "all" | "open" | "imported") => void;
  onTogglePrompt: (promptId: string) => void;
  onOpenSidebarDrawer: () => void;
};

export function MainColumn({
  selectedProject,
  selectedProjectStatus,
  promptRows,
  promptDetails,
  detailLoadingById,
  detailErrorById,
  expandedPromptId,
  filter,
  onFilterChange,
  onTogglePrompt,
  onOpenSidebarDrawer
}: MainColumnProps) {
  return (
    <main className="main-column">
      <header className="main-header">
        <div className="main-heading">
          <div className="main-heading-topline">
            <button className="mobile-project-button" onClick={onOpenSidebarDrawer} type="button">
              Projects
            </button>
            <p className="eyebrow">Selected Project</p>
          </div>
          <h2>{selectedProject?.slug ?? "No project selected"}</h2>
          <p className="subtle header-copy">
            {selectedProject?.rootPath ?? "Pick a project to view its prompt stream."}
          </p>
        </div>
        <div className="header-badges">
          <div className="count-badge">{promptRows.length} prompt events</div>
          {selectedProjectStatus && (
            <div className={`count-badge tone-${selectedProjectStatus.tone}`}>
              {selectedProjectStatus.openPromptCount} open
            </div>
          )}
        </div>
      </header>

      {selectedProjectStatus && <AttachmentBanner status={selectedProjectStatus} />}

      <section className="stream-toolbar">
        <div className="toolbar-group">
          <button
            className={filter === "all" ? "toolbar-chip active" : "toolbar-chip"}
            onClick={() => onFilterChange("all")}
            type="button"
          >
            All
          </button>
          <button
            className={filter === "open" ? "toolbar-chip active" : "toolbar-chip"}
            onClick={() => onFilterChange("open")}
            type="button"
          >
            Open
          </button>
          <button
            className={filter === "imported" ? "toolbar-chip active" : "toolbar-chip"}
            onClick={() => onFilterChange("imported")}
            type="button"
          >
            Imported
          </button>
        </div>
        <div className="toolbar-meta">
          <span>Newest first</span>
          <span>Inline detail</span>
        </div>
      </section>

      <PromptStream
        detailErrorById={detailErrorById}
        detailLoadingById={detailLoadingById}
        expandedPromptId={expandedPromptId}
        onTogglePrompt={onTogglePrompt}
        promptDetails={promptDetails}
        promptRows={promptRows}
      />
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
  promptRows: PromptRowViewModel[];
  promptDetails: Record<string, PromptDetailViewModel>;
  detailLoadingById: Record<string, boolean>;
  detailErrorById: Record<string, string | null>;
  expandedPromptId: string | null;
  onTogglePrompt: (promptId: string) => void;
};

export function PromptStream({
  promptRows,
  promptDetails,
  detailLoadingById,
  detailErrorById,
  expandedPromptId,
  onTogglePrompt
}: PromptStreamProps) {
  if (promptRows.length === 0) {
    return <EmptyState />;
  }

  return (
    <section className="prompt-stream">
      {promptRows.map((prompt) => (
        <PromptRow
          detail={promptDetails[prompt.id]}
          error={detailErrorById[prompt.id] ?? null}
          isExpanded={expandedPromptId === prompt.id}
          isLoading={detailLoadingById[prompt.id] ?? false}
          key={prompt.id}
          onToggle={() => onTogglePrompt(prompt.id)}
          prompt={prompt}
        />
      ))}
    </section>
  );
}

type PromptRowProps = {
  prompt: PromptRowViewModel;
  detail: PromptDetailViewModel | undefined;
  isExpanded: boolean;
  isLoading: boolean;
  error: string | null;
  onToggle: () => void;
};

export function PromptRow({ prompt, detail, isExpanded, isLoading, error, onToggle }: PromptRowProps) {
  return (
    <article className={`prompt-row tone-${prompt.tone} ${isExpanded ? "expanded" : ""}`}>
      <button
        aria-controls={`prompt-detail-${prompt.id}`}
        aria-expanded={isExpanded}
        className="prompt-row-button"
        onClick={onToggle}
        type="button"
      >
        <div className="prompt-row-leading">
          <span className={`status-pill status-${prompt.status}`}>{prompt.statusLabel}</span>
          <span className="prompt-row-time">{prompt.timestampLabel}</span>
        </div>
        <div className="prompt-row-summary">
          <strong>{prompt.promptSummary}</strong>
          <span>{prompt.primaryLabel}</span>
        </div>
        <div className="prompt-row-meta">
          <span>{prompt.filesLabel}</span>
          <span>{prompt.artifactLabel}</span>
          <span>{prompt.childLabel}</span>
          {prompt.isLiveDerived && <span className="evidence-chip live">Live</span>}
        </div>
      </button>

      {isExpanded && (
        <div className="prompt-detail-panel" id={`prompt-detail-${prompt.id}`}>
          {isLoading && !detail && (
            <div className="prompt-detail-state">
              <strong>Loading prompt detail</strong>
              <p className="subtle">Pulling artifacts, touched files, and git links for this prompt event.</p>
            </div>
          )}

          {error && !detail && (
            <div className="prompt-detail-state error">
              <strong>Prompt detail unavailable</strong>
              <p className="subtle">{error}</p>
            </div>
          )}

          {detail && (
            <div className="prompt-detail-grid">
              <section className="prompt-detail-card">
                <p className="eyebrow">Prompt</p>
                <p className="prompt-detail-text">{detail.promptText}</p>
              </section>

              <section className="prompt-detail-card">
                <p className="eyebrow">Primary Artifact</p>
                <p className="subtle">{detail.primaryArtifactSummary}</p>
              </section>

              <section className="prompt-detail-card">
                <div className="detail-section-head">
                  <p className="eyebrow">Touched Files</p>
                  <span className="evidence-chip">{detail.touchedFilesLabel}</span>
                </div>
                <div className="detail-file-list">
                  {detail.touchedFiles.length > 0 ? (
                    detail.touchedFiles.map((path) => <code key={path}>{path}</code>)
                  ) : (
                    <p className="subtle">No touched files were recorded for this prompt event.</p>
                  )}
                </div>
              </section>

              <section className="prompt-detail-card">
                <p className="eyebrow">Artifacts</p>
                <div className="detail-list">
                  {detail.artifactSummaries.map((artifact) => (
                    <div className="detail-list-item" key={artifact.id}>
                      <strong>{artifact.label}</strong>
                      <p className="subtle">{artifact.summary}</p>
                      <div className="prompt-detail-meta">
                        {artifact.fileCountLabel && <span className="evidence-chip">{artifact.fileCountLabel}</span>}
                        {artifact.relationCountLabel && (
                          <span className="evidence-chip">{artifact.relationCountLabel}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="prompt-detail-card">
                <p className="eyebrow">Git Links</p>
                {detail.gitSummaries.length > 0 ? (
                  <div className="detail-list">
                    {detail.gitSummaries.map((gitLink) => (
                      <div className="detail-list-item" key={gitLink.id}>
                        <strong>{gitLink.headline}</strong>
                        <p className="subtle">{gitLink.detail}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="subtle">No git links were recorded for this prompt event.</p>
                )}
              </section>
            </div>
          )}
        </div>
      )}
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
      <h3>{status?.headline ?? "Waiting for project selection"}</h3>
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
        <p className="subtle">Register and select a project to see live watcher health.</p>
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
        Promptline automatically tails `~/.codex/sessions` for registered projects. Once Codex writes activity for
        this workspace, prompt events will appear here with inline detail and live attachment status.
      </p>
      <ol className="empty-steps">
        <li>Register the project once with `pnpm dev:cli -- repo add .`.</li>
        <li>Keep `pnpm dev` running while you work in Codex.</li>
        <li>Watch the banner and context rail for open prompts and fresh imports.</li>
      </ol>
    </section>
  );
}
