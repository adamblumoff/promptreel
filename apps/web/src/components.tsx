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
        <div className="brand-block sidebar-brand">
          <div className="sidebar-brand-copy">
            <p className="eyebrow">Promptline</p>
            {!isCollapsed && (
              <>
                <h1>Workspace Threads</h1>
                <p className="intro-copy">
                  Every Codex thread grouped by the folder it ran in, with prompt history one level deeper.
                </p>
              </>
            )}
          </div>
          <div className="sidebar-controls">
            {!isCollapsed && (
              <button className="sidebar-toggle" onClick={onRescan} type="button">
                {isRescanning ? "Rescanning..." : "Rescan"}
              </button>
            )}
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
            <p className="eyebrow">{isCollapsed ? "Folders" : "Workspace Folders"}</p>
          </div>
          <div className={isCollapsed ? "project-pill-list" : "project-list"}>
            {workspaces.length > 0 ? (
              workspaces.map((workspace) => (
                <button
                  aria-pressed={workspace.id === selectedWorkspaceId}
                  className={workspace.id === selectedWorkspaceId ? "project-button active" : "project-button"}
                  key={workspace.id}
                  onClick={() => onSelectWorkspace(workspace.id)}
                  title={isCollapsed ? `${workspace.slug}\n${workspace.pathLabel}` : workspace.pathLabel}
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
                        <span className={`project-open-count tone-${workspace.statusTone}`}>
                          {workspace.openThreadLabel}
                        </span>
                      </div>
                      <span className="project-root-path" title={workspace.pathLabel}>
                        {workspace.pathLabel}
                      </span>
                      <div className="workspace-meta-row">
                        <span className="project-activity">{workspace.threadCountLabel}</span>
                        <span className="project-activity">{workspace.activityLabel}</span>
                        <span className={`evidence-chip ${workspace.gitRootPath ? "" : "muted"}`}>
                          {workspace.gitBadgeLabel}
                        </span>
                      </div>
                    </>
                  )}
                </button>
              ))
            ) : (
              <div className="rail-note">
                <strong>No Codex threads found yet</strong>
                {!isCollapsed && (
                  <p>
                    Promptline only lists Windows session folders whose exact `cwd` contains a local `.git` directory.
                  </p>
                )}
              </div>
            )}
          </div>
        </section>

        <section className="rail-section rail-footer">
          <div className="compact-status">
            <span className={`status-dot ${workspaces.some((workspace) => workspace.mode === "watching") ? "live" : "idle"}`} />
            {!isCollapsed && (
              <div>
                <strong>
                  {workspaces.some((workspace) => workspace.mode === "watching") ? "Watcher running" : "Waiting for eligible threads"}
                </strong>
                <p>Sidebar counts come directly from discovered workspace data.</p>
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
  return (
    <main className="main-column">
      <header className="main-header">
        <div className="main-heading">
          <div className="main-heading-topline">
            <button className="mobile-project-button" onClick={onOpenSidebarDrawer} type="button">
              Folders
            </button>
            <p className="eyebrow">Selected Workspace</p>
          </div>
          <h2>{selectedWorkspace?.slug ?? "No workspace selected"}</h2>
          <p className="subtle header-copy">
            {selectedWorkspace?.folderPath ?? "Pick a workspace folder to view discovered Codex threads."}
          </p>
        </div>
        <div className="header-badges">
          <div className="count-badge">{threadRows.length} threads</div>
          <div className="count-badge">{promptRows.length} prompt events</div>
          {selectedWorkspaceStatus && (
            <div className={`count-badge tone-${selectedWorkspaceStatus.tone}`}>
              {selectedWorkspaceStatus.openThreadCount} open
            </div>
          )}
        </div>
      </header>

      {selectedWorkspaceStatus && <AttachmentBanner status={selectedWorkspaceStatus} />}

      <section className="thread-section">
        <div className="section-head section-stack">
          <div>
            <p className="eyebrow">Threads</p>
            <h3>Discovered Codex threads for this folder</h3>
          </div>
          {isThreadsLoading && <p className="subtle loading-inline">Refreshing thread list...</p>}
        </div>
        <ThreadList
          selectedThreadId={selectedThreadId}
          threadRows={threadRows}
          onSelectThread={onSelectThread}
        />
      </section>

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
          {isPromptsLoading && <span>Refreshing...</span>}
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
  status: WorkspaceStatusViewModel;
};

export function AttachmentBanner({ status }: AttachmentBannerProps) {
  return (
    <section className={`attachment-banner tone-${status.tone}`}>
      <div className="banner-copy">
        <p className="eyebrow">Live Attachment</p>
        <h3>{status.headline}</h3>
        <p className="subtle">
          {status.mode === "watching"
            ? `${status.openThreadCount} open thread${status.openThreadCount === 1 ? "" : "s"} across ${status.recentlyUpdatedSessionCount} recently updated session file${status.recentlyUpdatedSessionCount === 1 ? "" : "s"}.`
            : status.mode === "error"
              ? status.lastError ?? "Watcher error"
              : "Promptline will attach as soon as Codex starts writing session activity for this folder."}
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

type ThreadListProps = {
  threadRows: ThreadRowViewModel[];
  selectedThreadId: string;
  onSelectThread: (threadId: string) => void;
};

export function ThreadList({ threadRows, selectedThreadId, onSelectThread }: ThreadListProps) {
  if (threadRows.length === 0) {
    return (
      <div className="empty-inline">
        <strong>No threads in this folder yet</strong>
        <p className="subtle">As soon as Codex records session activity for this execution path, the thread list will appear here.</p>
      </div>
    );
  }

  return (
    <div className="thread-list">
      {threadRows.map((thread) => (
        <button
          className={thread.id === selectedThreadId ? `thread-button active tone-${thread.tone}` : `thread-button tone-${thread.tone}`}
          key={thread.id}
          onClick={() => onSelectThread(thread.id)}
          type="button"
        >
          <div className="thread-heading">
            <strong>{thread.title}</strong>
            <span className={`status-pill ${thread.status === "open" ? "status-in_progress" : "status-completed"}`}>
              {thread.status}
            </span>
          </div>
          <p className="subtle">{thread.folderPath ?? "Unknown folder"}</p>
          <div className="thread-meta">
            <span>{thread.promptCountLabel}</span>
            <span>{thread.openLabel}</span>
            <span>{thread.activityLabel}</span>
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
        eyebrow="Grouping Rule"
        title="Folder metadata defines the workspace"
        body="Promptline only shows Windows session folders whose exact cwd contains a local .git directory, then groups each Codex thread under that folder."
      />
      <ExplainerCard
        eyebrow="Thread Scope"
        title="One folder, many threads"
        body="Each folder can contain multiple Codex threads. The thread list lets you switch between them before drilling into individual prompt events."
      />
      <ExplainerCard
        eyebrow="Prompt Detail"
        title="Prompt, artifacts, evidence"
        body="Each prompt event still expands inline so you can inspect the reasoning trail without losing your place in the thread."
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
      <p className="eyebrow">Codex Attachment Status</p>
      <h3>{status?.headline ?? "Waiting for workspace selection"}</h3>
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
            <dt>Threads</dt>
            <dd>{status.threadCount}</dd>
          </div>
          <div>
            <dt>Open threads</dt>
            <dd>{status.openThreadCount}</dd>
          </div>
        </dl>
      ) : (
        <p className="subtle">Select a workspace folder to see live watcher health.</p>
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
        Promptline discovers Codex session files from `~/.codex/sessions`, keeps only exact Windows cwd folders with a
        direct `.git` directory, and stores prompt history inside each thread.
      </p>
      <ol className="empty-steps">
        <li>Keep `pnpm dev` running while you work in Codex.</li>
        <li>Rescan if you started a new session recently and want to refresh immediately.</li>
        <li>Switch threads above if this folder has more than one Codex conversation.</li>
      </ol>
    </section>
  );
}
