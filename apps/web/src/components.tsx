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
  isSidebarCollapsed: boolean;
  onOpenSidebarDrawer: () => void;
};

export function AppShell({ sidebar, main, isSidebarCollapsed, onOpenSidebarDrawer }: AppShellProps) {
  return (
    <div className={isSidebarCollapsed ? "page-shell sidebar-collapsed" : "page-shell"}>
      <header className="global-header">
        <div className="global-header-left">
          <button
            aria-label="Toggle workspace drawer"
            className="icon-button hamburger-button"
            onClick={onOpenSidebarDrawer}
            type="button"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 2.75A.75.75 0 0 1 1.75 2h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 2.75Zm0 5A.75.75 0 0 1 1.75 7h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 7.75ZM1.75 12h12.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5Z" />
            </svg>
          </button>
          <div className="brand-lockup">
            <div className="brand-mark">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h2A1.5 1.5 0 0 1 7 3.5v2A1.5 1.5 0 0 1 5.5 7H4v3h3.5A1.5 1.5 0 0 0 9 8.5V7h2v1.5A3.5 3.5 0 0 1 7.5 12H3.75a.75.75 0 0 1-.75-.75V7a2 2 0 0 1-1-1.732V3.5Z" />
              </svg>
            </div>
            <strong>Promptline</strong>
          </div>
        </div>
        <label className="global-search">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="search-icon">
            <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 1 1-1.06 1.06l-3.04-3.04ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z" />
          </svg>
          <input
            type="text"
            placeholder="Search workspaces, threads, and prompts"
            readOnly
          />
        </label>
        <div className="global-header-right">
          <button aria-label="Profile" className="avatar-button" type="button">
            AB
          </button>
        </div>
      </header>

      {sidebar}

      <div className="app-shell">
        {main}
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
            <h2>Repositories</h2>
            {!isCollapsed && (
              <p className="subtle">
                Workspaces with a direct `.git` directory.
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

export type ContentTab = "threads" | "prompts" | "health";

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
  activeTab: ContentTab;
  onTabChange: (tab: ContentTab) => void;
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
  isPromptsLoading,
  activeTab,
  onTabChange
}: MainColumnProps) {
  const selectedThread = threadRows.find((thread) => thread.id === selectedThreadId) ?? null;
  const threadHeadline = selectedThread?.title ?? "Select a thread to inspect its prompt history";

  return (
    <main className="main-column">
      <section className="repo-bar">
        <div className="repo-bar-copy">
          <div className="repo-breadcrumb">
            <button className="icon-button hamburger-button repo-menu-button" onClick={onOpenSidebarDrawer} type="button">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1 2.75A.75.75 0 0 1 1.75 2h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 2.75Zm0 5A.75.75 0 0 1 1.75 7h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 7.75ZM1.75 12h12.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5Z" />
              </svg>
            </button>
            <span className="repo-owner">{selectedWorkspace?.slug ?? "workspace"}</span>
            <span className="repo-separator">/</span>
            <strong>{selectedThread?.title ? truncate(selectedThread.title, 40) : "threads"}</strong>
          </div>
        </div>
      </section>

      <section className="hero-panel">
        <div className="hero-copy">
          <h1>{threadHeadline}</h1>
          <div className="hero-meta">
            <span className={`hero-state ${selectedWorkspaceStatus?.mode === "watching" ? "watching" : "idle"}`}>
              {selectedWorkspaceStatus?.mode === "watching" ? "Watching" : "Idle"}
            </span>
            <span>{selectedWorkspace?.folderPath ?? "Select a workspace to begin."}</span>
          </div>
        </div>
      </section>

      <nav className="content-tabs">
        <button
          className={activeTab === "threads" ? "content-tab active" : "content-tab"}
          onClick={() => onTabChange("threads")}
          type="button"
        >
          Threads <span>{threadRows.length}</span>
        </button>
        <button
          className={activeTab === "prompts" ? "content-tab active" : "content-tab"}
          onClick={() => onTabChange("prompts")}
          type="button"
        >
          Prompt events <span>{promptRows.length}</span>
        </button>
        <button
          className={activeTab === "health" ? "content-tab active" : "content-tab"}
          onClick={() => onTabChange("health")}
          type="button"
        >
          Workspace health
        </button>
      </nav>

      {activeTab === "threads" && (
        <section className="content-panel">
          <div className="panel-header">
            <h3>Threads in this repository</h3>
            {isThreadsLoading && <p className="subtle loading-inline">Refreshing...</p>}
          </div>
          <ThreadList
            selectedThreadId={selectedThreadId}
            threadRows={threadRows}
            onSelectThread={(threadId) => {
              onSelectThread(threadId);
              onTabChange("prompts");
            }}
          />
        </section>
      )}

      {activeTab === "prompts" && (
        <section className="content-panel">
          <div className="panel-header">
            <h3>Conversation history</h3>
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
          {isPromptsLoading && <p className="subtle loading-inline" style={{ padding: "8px 16px" }}>Refreshing...</p>}
          <PromptStream
            detailErrorById={detailErrorById}
            detailLoadingById={detailLoadingById}
            expandedPromptId={expandedPromptId}
            onTogglePrompt={onTogglePrompt}
            promptDetails={promptDetails}
            promptRows={promptRows}
          />
        </section>
      )}

      {activeTab === "health" && (
        <section className="content-panel">
          <div className="panel-header">
            <h3>Workspace health</h3>
          </div>
          <div className="health-panel-body">
            <HealthCard status={selectedWorkspaceStatus} />
          </div>
        </section>
      )}
    </main>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
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
        <p className="subtle">Threads will appear when Codex sessions write prompt data here.</p>
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
          <span className={`status-dot ${thread.status === "open" ? "dot-open" : "dot-closed"}`} />
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
        <span className={`status-dot ${prompt.status === "in_progress" ? "dot-open" : "dot-closed"}`} />
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
              <strong>Loading prompt detail...</strong>
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
                    <p className="subtle">No touched files recorded.</p>
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
                  <p className="subtle">No git links recorded.</p>
                )}
              </section>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

type HealthCardProps = {
  status: WorkspaceStatusViewModel | null;
};

export function HealthCard({ status }: HealthCardProps) {
  if (!status) {
    return (
      <div className="empty-inline">
        <strong>No workspace selected</strong>
        <p className="subtle">Select a repository to see health status.</p>
      </div>
    );
  }

  return (
    <div className="health-content">
      <h3>{status.headline}</h3>
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
    </div>
  );
}

export function EmptyState() {
  return (
    <section className="empty-state">
      <h3>No prompt events yet</h3>
      <p className="subtle">
        Events will appear when the selected thread writes prompts.
      </p>
    </section>
  );
}
