import type { ReactNode } from "react";
import type { Workspace } from "./types";
import type {
  PromptDetailViewModel,
  PromptRowViewModel,
  ThreadRowViewModel,
  WorkspaceSidebarItemViewModel,
  WorkspaceStatusViewModel
} from "./view-models";

type AppShellProps = {
  sidebar: ReactNode;
  main: ReactNode;
  contextRail: ReactNode;
  isSidebarCollapsed: boolean;
  onOpenSidebarDrawer: () => void;
};

export function AppShell({ sidebar, main, contextRail, isSidebarCollapsed, onOpenSidebarDrawer }: AppShellProps) {
  return (
    <div className={isSidebarCollapsed ? "page-shell sidebar-collapsed" : "page-shell"}>
      <header className="global-header">
        <div className="global-header-left">
          <button
            aria-label="Toggle workspace drawer"
            className="icon-button"
            onClick={onOpenSidebarDrawer}
            type="button"
          >
            <span />
            <span />
            <span />
          </button>
          <div className="brand-lockup">
            <div className="brand-mark">P</div>
            <strong>Promptline</strong>
          </div>
        </div>
        <div className="global-search">Type / to search workspaces, threads, and prompt history</div>
        <div className="global-header-right">
          <button aria-label="Notifications" className="icon-button" type="button">
            <span className="dot" />
          </button>
          <button aria-label="Profile" className="avatar-button" type="button">
            AB
          </button>
        </div>
      </header>

      {sidebar}

      <div className="app-shell">
        {main}
        {contextRail}
      </div>
    </div>
  );
}

type WorkspaceSidebarProps = {
  workspaces: WorkspaceSidebarItemViewModel[];
  selectedWorkspaceId: string;
  onSelectWorkspace: (workspaceId: string) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isDrawerOpen: boolean;
  onCloseDrawer: () => void;
  isRescanning: boolean;
  onRescan: () => void;
};

export function WorkspaceSidebar({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  isCollapsed,
  onToggleCollapse,
  isDrawerOpen,
  onCloseDrawer,
  isRescanning,
  onRescan
}: WorkspaceSidebarProps) {
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
        <div className="sidebar-header">
          <div>
            <p className="eyebrow">Workspace Switcher</p>
            <h2>Repositories</h2>
            {!isCollapsed && (
              <p className="subtle">
                Only exact Windows execution folders with a direct `.git` directory are listed here.
              </p>
            )}
          </div>
          <div className="sidebar-controls">
            <button className="sidebar-toggle" onClick={onRescan} type="button">
              {isRescanning ? "Rescanning..." : "Rescan"}
            </button>
            <button className="sidebar-toggle" onClick={onToggleCollapse} type="button">
              {isCollapsed ? "Expand" : "Collapse"}
            </button>
            <button className="sidebar-toggle mobile-only" onClick={onCloseDrawer} type="button">
              Close
            </button>
          </div>
        </div>

        <section className="sidebar-section">
          <div className={isCollapsed ? "project-pill-list" : "project-list"}>
            {workspaces.length > 0 ? (
              workspaces.map((workspace) => (
                <button
                  aria-pressed={workspace.id === selectedWorkspaceId}
                  className={workspace.id === selectedWorkspaceId ? "project-button active" : "project-button"}
                  key={workspace.id}
                  onClick={() => onSelectWorkspace(workspace.id)}
                  title={workspace.pathLabel}
                  type="button"
                >
                  {isCollapsed ? (
                    <span className={`project-pill tone-${workspace.statusTone}`}>
                      {workspace.slug.slice(0, 2).toUpperCase()}
                    </span>
                  ) : (
                    <>
                      <div className="project-button-heading">
                        <strong>{workspace.slug}</strong>
                        <span className={`status-pill status-${workspace.mode === "watching" ? "in_progress" : "completed"}`}>
                          {workspace.openThreadLabel}
                        </span>
                      </div>
                      <span className="project-root-path" title={workspace.pathLabel}>
                        {workspace.pathLabel}
                      </span>
                      <div className="workspace-meta-row">
                        <span>{workspace.threadCountLabel}</span>
                        <span>{workspace.activityLabel}</span>
                      </div>
                    </>
                  )}
                </button>
              ))
            ) : (
              <div className="rail-note">
                <strong>No eligible repos found</strong>
                {!isCollapsed && (
                  <p>Promptline will populate this list when Codex writes a session whose exact cwd contains `.git`.</p>
                )}
              </div>
            )}
          </div>
        </section>
      </aside>
    </>
  );
}

type MainColumnProps = {
  selectedWorkspace: Workspace | null;
  selectedWorkspaceStatus: WorkspaceStatusViewModel | null;
  threadRows: ThreadRowViewModel[];
  selectedThreadId: string;
  onSelectThread: (threadId: string) => void;
  promptRows: PromptRowViewModel[];
  promptDetails: Record<string, PromptDetailViewModel>;
  detailLoadingById: Record<string, boolean>;
  detailErrorById: Record<string, string | null>;
  expandedPromptId: string | null;
  filter: "all" | "open" | "imported";
  onFilterChange: (filter: "all" | "open" | "imported") => void;
  onTogglePrompt: (promptId: string) => void;
  onOpenSidebarDrawer: () => void;
  isThreadsLoading: boolean;
  isPromptsLoading: boolean;
};

export function MainColumn({
  selectedWorkspace,
  selectedWorkspaceStatus,
  threadRows,
  selectedThreadId,
  onSelectThread,
  promptRows,
  promptDetails,
  detailLoadingById,
  detailErrorById,
  expandedPromptId,
  filter,
  onFilterChange,
  onTogglePrompt,
  onOpenSidebarDrawer,
  isThreadsLoading,
  isPromptsLoading
}: MainColumnProps) {
  const selectedThread = threadRows.find((thread) => thread.id === selectedThreadId) ?? null;
  const title = selectedWorkspace?.slug ?? "No workspace selected";
  const threadHeadline = selectedThread?.title ?? "Select a thread to inspect its prompt history";

  return (
    <main className="main-column">
      <section className="repo-bar">
        <div className="repo-bar-copy">
          <div className="repo-breadcrumb">
            <button className="icon-button repo-menu-button" onClick={onOpenSidebarDrawer} type="button">
              <span />
              <span />
              <span />
            </button>
            <span className="repo-owner">adamb</span>
            <span className="repo-separator">/</span>
            <strong>{selectedWorkspace?.slug ?? "workspace"}</strong>
          </div>
          <nav className="repo-nav" aria-label="Repository sections">
            <span className="repo-nav-item">Code</span>
            <span className="repo-nav-item">Issues</span>
            <span className="repo-nav-item active">Pull requests</span>
            <span className="repo-nav-item">Actions</span>
            <span className="repo-nav-item">Projects</span>
            <span className="repo-nav-item">Insights</span>
          </nav>
        </div>
      </section>

      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Pull request style thread review</p>
          <h1>{threadHeadline}</h1>
          <div className="hero-meta">
            <span className={`hero-state ${selectedWorkspaceStatus?.mode === "watching" ? "watching" : "idle"}`}>
              {selectedWorkspaceStatus?.mode === "watching" ? "Watching" : "Idle"}
            </span>
            <span>{title}</span>
            <span>{selectedWorkspace?.folderPath ?? "Select a workspace to inspect Codex history."}</span>
          </div>
        </div>
        <div className="hero-actions">
          <span className="count-badge">{threadRows.length} threads</span>
          <span className="count-badge">{promptRows.length} prompt events</span>
          <span className="count-badge">
            {selectedWorkspaceStatus?.openThreadCount ?? 0} open
          </span>
        </div>
      </section>

      <section className="content-tabs">
        <button className="content-tab active" type="button">
          Threads <span>{threadRows.length}</span>
        </button>
        <button className="content-tab" type="button">
          Prompt events <span>{promptRows.length}</span>
        </button>
        <button className="content-tab" type="button">
          Workspace health <span>{selectedWorkspaceStatus?.sessionFileCount ?? 0}</span>
        </button>
      </section>

      <section className="content-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Threads</p>
            <h3>Threads in this repository</h3>
          </div>
          {isThreadsLoading && <p className="subtle loading-inline">Refreshing thread list...</p>}
        </div>
        <ThreadList
          selectedThreadId={selectedThreadId}
          threadRows={threadRows}
          onSelectThread={onSelectThread}
        />
      </section>

      <section className="content-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Prompt Events</p>
            <h3>Conversation history for the selected thread</h3>
          </div>
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
        </div>
        {isPromptsLoading && <p className="subtle loading-inline">Refreshing prompt events...</p>}
        <PromptStream
          detailErrorById={detailErrorById}
          detailLoadingById={detailLoadingById}
          expandedPromptId={expandedPromptId}
          onTogglePrompt={onTogglePrompt}
          promptDetails={promptDetails}
          promptRows={promptRows}
        />
      </section>
    </main>
  );
}

type ThreadListProps = {
  threadRows: ThreadRowViewModel[];
  selectedThreadId: string;
  onSelectThread: (threadId: string) => void;
};

export function ThreadList({ threadRows, selectedThreadId, onSelectThread }: ThreadListProps) {
  if (threadRows.length === 0) {
    return (
      <div className="empty-inline">
        <strong>No threads in this repository yet</strong>
        <p className="subtle">As soon as an eligible Codex session writes prompt windows here, the thread list will appear.</p>
      </div>
    );
  }

  return (
    <div className="thread-list">
      {threadRows.map((thread) => (
        <button
          className={thread.id === selectedThreadId ? "thread-button active" : "thread-button"}
          key={thread.id}
          onClick={() => onSelectThread(thread.id)}
          type="button"
        >
          <div className="thread-main">
            <strong>{thread.title}</strong>
            <p className="subtle">
              {thread.promptCountLabel} · {thread.openLabel} · {thread.activityLabel}
            </p>
          </div>
          <div className="thread-side">
            <span className={`status-pill ${thread.status === "open" ? "status-in_progress" : "status-completed"}`}>
              {thread.status}
            </span>
            <code>{thread.id.slice(-7)}</code>
          </div>
        </button>
      ))}
    </div>
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
    <article className={isExpanded ? "prompt-row expanded" : "prompt-row"}>
      <button
        aria-controls={`prompt-detail-${prompt.id}`}
        aria-expanded={isExpanded}
        className="prompt-row-button"
        onClick={onToggle}
        type="button"
      >
        <div className="prompt-row-main">
          <div className="prompt-row-title">
            <strong>{prompt.promptSummary}</strong>
            {prompt.isLiveDerived && <span className="status-pill status-in_progress">Live</span>}
          </div>
          <p className="subtle">
            {prompt.timestampLabel} · {prompt.primaryLabel} · {prompt.filesLabel} · {prompt.artifactLabel}
          </p>
        </div>
        <div className="prompt-row-side">
          <span className={`status-pill status-${prompt.status}`}>{prompt.statusLabel}</span>
          <code>{prompt.id.slice(-7)}</code>
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
                <p className="eyebrow">Execution Folder</p>
                <p className="subtle">{detail.executionPathLabel}</p>
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
  selectedWorkspaceStatus: WorkspaceStatusViewModel | null;
};

export function ContextRail({ selectedWorkspaceStatus }: ContextRailProps) {
  return (
    <aside className="context-rail">
      <HealthCard status={selectedWorkspaceStatus} />
      <ExplainerCard
        eyebrow="Visibility Rule"
        title="Exact `.git` cwd only"
        body="Promptline only exposes workspaces whose exact Windows execution folder contains a `.git` directory."
      />
      <ExplainerCard
        eyebrow="Prompt Detail"
        title="Detail stays one click away"
        body="Prompt rows stay compact in the list, then expand inline with prompt text, touched files, artifacts, and git links."
      />
    </aside>
  );
}

type HealthCardProps = {
  status: WorkspaceStatusViewModel | null;
};

export function HealthCard({ status }: HealthCardProps) {
  return (
    <section className="context-card">
      <p className="eyebrow">Workspace Health</p>
      <h3>{status?.headline ?? "Waiting for workspace selection"}</h3>
      {status ? (
        <dl className="metric-grid">
          <div>
            <dt>Mode</dt>
            <dd>{status.mode}</dd>
          </div>
          <div>
            <dt>Threads</dt>
            <dd>{status.threadCount}</dd>
          </div>
          <div>
            <dt>Open</dt>
            <dd>{status.openThreadCount}</dd>
          </div>
          <div>
            <dt>Session files</dt>
            <dd>{status.sessionFileCount}</dd>
          </div>
        </dl>
      ) : (
        <p className="subtle">Select a repository to see watcher health and import status.</p>
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
      <h3>This thread has not produced prompt windows yet.</h3>
      <p className="subtle">
        Promptline will populate this section as soon as the selected thread writes prompt events into the local
        session history.
      </p>
    </section>
  );
}
