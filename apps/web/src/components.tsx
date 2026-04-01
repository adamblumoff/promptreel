import { type ReactNode, useRef, useState } from "react";
import type {
  FileGroupViewModel,
  PromptDetailArtifactViewModel,
  PromptDetailGitLinkViewModel,
  PromptDetailViewModel,
  PromptRowViewModel,
  ThreadRowViewModel,
  WorkspaceSidebarItemViewModel,
  WorkspaceStatusViewModel,
} from "./view-models";
import type { Workspace } from "./types";
import { cn } from "@/lib/utils";

/* ════════════════════════════════════════════════════════════════════════════
   TOP BAR
   Workspace dropdown on the left, status on the right. Thin, minimal.
   ════════════════════════════════════════════════════════════════════════════ */

export function TopBar({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  workspaceStatus,
  isRescanning,
  onRescan,
}: {
  workspaces: WorkspaceSidebarItemViewModel[];
  selectedWorkspaceId: string;
  onSelectWorkspace: (id: string) => void;
  workspaceStatus: WorkspaceStatusViewModel | null;
  isRescanning: boolean;
  onRescan: () => void;
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const selected = workspaces.find((w) => w.id === selectedWorkspaceId);

  return (
    <header className="sticky top-0 z-50 h-13 flex items-center justify-between px-5 bg-white/80 backdrop-blur-xl border-b border-brd">
      {/* Left: logo + workspace picker */}
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <div className="size-7 rounded-md bg-t1 flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="white" className="invert">
              <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h2A1.5 1.5 0 0 1 7 3.5v2A1.5 1.5 0 0 1 5.5 7H4v3h3.5A1.5 1.5 0 0 0 9 8.5V7h2v1.5A3.5 3.5 0 0 1 7.5 12H3.75a.75.75 0 0 1-.75-.75V7a2 2 0 0 1-1-1.732V3.5Z" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-t1 tracking-tight">Promptline</span>
        </div>

        {/* Divider */}
        <div className="w-px h-5 bg-brd" />

        {/* Workspace dropdown */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setDropdownOpen((o) => !o)}
            className="flex items-center gap-2 h-8 px-3 rounded-lg border border-brd bg-white text-t2 text-sm cursor-pointer hover:bg-gz-2 hover:text-t1 transition-colors"
          >
            {selected && (
              <span className="size-5 rounded bg-gz-4 text-[9px] font-bold flex items-center justify-center text-t2">
                {selected.slug.slice(0, 2).toUpperCase()}
              </span>
            )}
            <span className="max-w-[180px] truncate">{selected?.slug ?? "Select workspace"}</span>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="opacity-40">
              <path d="M4.427 9.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 9H4.604a.25.25 0 00-.177.427zM4.423 6.573l3.396-3.396a.25.25 0 01.354 0l3.396 3.396A.25.25 0 0111.396 7H4.604a.25.25 0 01-.177-.427z" />
            </svg>
          </button>

          {dropdownOpen && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-40 bg-transparent border-0 cursor-default"
                onClick={() => setDropdownOpen(false)}
              />
              <div className="absolute left-0 top-full mt-1 z-50 w-72 max-h-80 overflow-y-auto rounded-xl border border-brd-strong bg-white shadow-xl shadow-black/8 slidein">
                <div className="p-1.5">
                  {workspaces.map((ws) => (
                    <button
                      key={ws.id}
                      type="button"
                      onClick={() => { onSelectWorkspace(ws.id); setDropdownOpen(false); }}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2 rounded-lg border-0 cursor-pointer text-left transition-colors",
                        ws.id === selectedWorkspaceId
                          ? "bg-violet-dim text-t1"
                          : "bg-transparent text-t2 hover:bg-gz-2 hover:text-t1"
                      )}
                    >
                      <span className={cn(
                        "shrink-0 size-7 rounded-md text-[10px] font-bold flex items-center justify-center",
                        ws.id === selectedWorkspaceId
                          ? "bg-t1 text-white"
                          : "bg-gz-4 text-t3"
                      )}>
                        {ws.slug.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium truncate">{ws.slug}</p>
                        <p className="text-[11px] text-t3 truncate">{ws.pathLabel}</p>
                      </div>
                      {ws.mode === "watching" && (
                        <span className="shrink-0 size-2 rounded-full bg-green" />
                      )}
                    </button>
                  ))}
                  {workspaces.length === 0 && (
                    <p className="text-[13px] text-t3 text-center py-6">No workspaces discovered</p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Right: status + rescan */}
      <div className="flex items-center gap-3">
        {workspaceStatus && (
          <span className={cn(
            "inline-flex items-center gap-1.5 text-[11px] font-medium",
            workspaceStatus.mode === "watching" ? "text-green" : "text-t3"
          )}>
            {workspaceStatus.mode === "watching" && (
              <span className="size-1.5 rounded-full bg-green breathe" />
            )}
            {workspaceStatus.mode === "watching" ? "Watching" : workspaceStatus.mode}
          </span>
        )}
        <button
          type="button"
          onClick={onRescan}
          disabled={isRescanning}
          title="Rescan sessions"
          className="size-7 flex items-center justify-center rounded-md border-0 bg-transparent text-t3 hover:text-t2 hover:bg-gz-2 disabled:opacity-30 cursor-pointer transition-colors"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className={isRescanning ? "spinner" : undefined}>
            <path
              d="M13.25 4.75V2.5m0 0H11m2.25 0-2 2A5.5 5.5 0 1 0 13.5 8"
              stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"
            />
          </svg>
        </button>
      </div>
    </header>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   THREAD BAR
   Horizontal scrollable row of thread chips.
   ════════════════════════════════════════════════════════════════════════════ */

export function ThreadBar({
  threads,
  selectedThreadId,
  onSelectThread,
  isLoading,
}: {
  threads: ThreadRowViewModel[];
  selectedThreadId: string;
  onSelectThread: (id: string) => void;
  isLoading: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  if (threads.length === 0) {
    return (
      <div className="border-b border-brd px-5 py-4">
        <p className="text-[13px] text-t3">
          {isLoading ? "Loading threads\u2026" : "No threads yet. Threads appear when sessions produce prompt data."}
        </p>
      </div>
    );
  }

  return (
    <div className="border-b border-brd">
      <div ref={scrollRef} className="flex gap-1 px-5 py-2 overflow-x-auto">
        {threads.map((thread) => {
          const active = thread.id === selectedThreadId;
          const isOpen = thread.status === "open";
          return (
            <button
              key={thread.id}
              type="button"
              onClick={() => onSelectThread(thread.id)}
              className={cn(
                "shrink-0 flex items-center gap-2 h-9 px-3.5 rounded-full border text-[12px] cursor-pointer transition-all duration-150",
                active
                  ? "border-t1 bg-t1 text-white font-medium shadow-sm"
                  : "border-brd bg-white text-t2 hover:bg-white hover:text-t1 hover:border-brd-strong"
              )}
            >
              <span className={cn(
                "size-1.5 rounded-full shrink-0",
                isOpen ? "bg-green" : "bg-t4"
              )} />
              <span className="max-w-[200px] truncate">{thread.title}</span>
              {isOpen && thread.openPromptCount > 0 && (
                <span className="size-4 rounded-full bg-green-dim text-green text-[9px] font-bold flex items-center justify-center">
                  {thread.openPromptCount}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   CONTENT HEADER
   Shows selected thread info + filter/tab controls.
   ════════════════════════════════════════════════════════════════════════════ */

export type ContentTab = "prompts" | "health";

export function ContentHeader({
  thread,
  activeTab,
  onTabChange,
  filter,
  onFilterChange,
  promptCount,
}: {
  thread: ThreadRowViewModel | null;
  activeTab: ContentTab;
  onTabChange: (t: ContentTab) => void;
  filter: "all" | "open" | "imported";
  onFilterChange: (f: "all" | "open" | "imported") => void;
  promptCount: number;
}) {
  if (!thread) {
    return (
      <div className="py-12 text-center">
        <p className="text-t3 text-[14px]">Select a thread above to view its prompt history.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 mb-6">
      {/* Thread title + meta */}
      <div>
        <h1 className="text-xl font-semibold text-t1 leading-tight mb-2">{thread.title}</h1>
        <div className="flex items-center gap-3 flex-wrap">
          <StatusBadge status={thread.status} />
          <span className="text-[11px] text-t3 tabular-nums">{thread.promptCountLabel}</span>
          <span className="text-[11px] text-t4">&middot;</span>
          <span className="text-[11px] text-t3 tabular-nums">{thread.activityLabel}</span>
          <code className="text-[10px] text-t4 font-mono">{thread.id.slice(-8)}</code>
        </div>
      </div>

      {/* Tabs + filters */}
      <div className="flex items-center justify-between gap-4 border-b border-brd pb-px">
        <div className="flex items-center gap-0.5">
          <TabButton active={activeTab === "prompts"} onClick={() => onTabChange("prompts")}>
            Prompts
            <span className={cn("text-[10px] tabular-nums ml-1", activeTab === "prompts" ? "text-t2" : "text-t4")}>
              {promptCount}
            </span>
          </TabButton>
          <TabButton active={activeTab === "health"} onClick={() => onTabChange("health")}>
            Health
          </TabButton>
        </div>

        {activeTab === "prompts" && (
          <div className="flex items-center rounded-md overflow-hidden border border-brd">
            {(["all", "open", "imported"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => onFilterChange(f)}
                className={cn(
                  "h-6 px-2 text-[10px] font-medium border-0 cursor-pointer transition-colors uppercase tracking-wider",
                  filter === f ? "bg-gz-3 text-t1" : "bg-white text-t3 hover:text-t2"
                )}
              >
                {f}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-9 px-3 text-[13px] font-medium border-0 border-b-2 cursor-pointer transition-colors bg-transparent flex items-center",
        active
          ? "text-t1 border-b-t1"
          : "text-t3 border-b-transparent hover:text-t2"
      )}
    >
      {children}
    </button>
  );
}

function StatusBadge({ status }: { status: "open" | "closed" }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 h-5 px-2 rounded-full text-[10px] font-semibold uppercase tracking-wider",
      status === "open"
        ? "bg-green-dim text-green"
        : "bg-gz-2 text-t3"
    )}>
      {status === "open" && <span className="size-1.5 rounded-full bg-green breathe" />}
      {status}
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   PROMPT FEED
   Full-width vertical list of prompt cards.
   ════════════════════════════════════════════════════════════════════════════ */

export function PromptFeed({
  rows,
  details,
  loadingById,
  errorById,
  expandedId,
  onToggle,
  isLoading,
}: {
  rows: PromptRowViewModel[];
  details: Record<string, PromptDetailViewModel>;
  loadingById: Record<string, boolean>;
  errorById: Record<string, string | null>;
  expandedId: string | null;
  onToggle: (id: string) => void;
  isLoading: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="py-20 text-center slidein">
        <div className="size-14 rounded-2xl bg-gz-2 border border-brd flex items-center justify-center mx-auto mb-4">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
            <path d="M8 1v6m0 0 3-3m-3 3L5 4M3 9v3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              className="text-t4" />
          </svg>
        </div>
        <p className="text-[14px] text-t2 mb-1">No prompt events</p>
        <p className="text-[12px] text-t4">Events will appear when the thread produces prompts.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 slidein">
      {isLoading && rows.length === 0 && (
        <p className="text-[12px] text-t4 py-2">Loading...</p>
      )}
      {rows.map((prompt) => (
        <PromptCard
          key={prompt.id}
          prompt={prompt}
          detail={details[prompt.id]}
          isExpanded={expandedId === prompt.id}
          isLoading={loadingById[prompt.id] ?? false}
          error={errorById[prompt.id] ?? null}
          onToggle={() => onToggle(prompt.id)}
        />
      ))}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   PROMPT CARD
   ════════════════════════════════════════════════════════════════════════════ */

function PromptCard({
  prompt,
  detail,
  isExpanded,
  isLoading,
  error,
  onToggle,
}: {
  prompt: PromptRowViewModel;
  detail: PromptDetailViewModel | undefined;
  isExpanded: boolean;
  isLoading: boolean;
  error: string | null;
  onToggle: () => void;
}) {
  const live = prompt.status === "in_progress";

  return (
    <div className={cn(
      "rounded-xl border transition-all duration-150",
      isExpanded
        ? "border-brd-strong bg-white shadow-md shadow-black/5"
        : "border-brd bg-white hover:border-brd-strong"
    )}>
      {/* Header row */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full border-0 bg-transparent text-left cursor-pointer p-4 flex items-start gap-4"
      >
        {/* Left accent bar */}
        <div className={cn(
          "shrink-0 w-[3px] self-stretch rounded-full min-h-[32px]",
          live ? "bg-green" : prompt.status === "completed" ? "bg-t1" : "bg-gz-4"
        )} />

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3 mb-1.5">
            <p className={cn(
              "text-[14px] leading-snug line-clamp-2",
              isExpanded ? "text-t1 font-medium" : "text-t2"
            )}>
              {prompt.promptSummary}
            </p>
            <div className="shrink-0 flex items-center gap-2">
              {live && <span className="size-2 rounded-full bg-green breathe" />}
              <PromptStatusPill status={prompt.status} label={prompt.statusLabel} />
            </div>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-t3 flex-wrap">
            <span className="tabular-nums">{prompt.timestampLabel}</span>
            <Dot />
            <span>{prompt.primaryLabel}</span>
            <Dot />
            <span>{prompt.filesLabel}</span>
            {prompt.artifactCount > 0 && (
              <>
                <Dot />
                <span>{prompt.artifactLabel}</span>
              </>
            )}
            {prompt.childCount > 0 && (
              <>
                <Dot />
                <span>{prompt.childLabel}</span>
              </>
            )}
          </div>
        </div>
      </button>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="border-t border-brd slidein">
          {isLoading && !detail && (
            <div className="px-4 py-6 flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="spinner text-t3">
                <path d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
          )}
          {error && !detail && (
            <div className="px-4 py-4">
              <p className="text-[13px] text-red">{error}</p>
            </div>
          )}
          {detail && <ExpandedDetail detail={detail} />}
        </div>
      )}
    </div>
  );
}

function PromptStatusPill({ status, label }: { status: string; label: string }) {
  return (
    <span className={cn(
      "inline-flex items-center h-[20px] px-2 rounded-md text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap",
      status === "in_progress" && "bg-green-dim text-green",
      status === "completed" && "bg-gz-2 text-t1",
      status === "imported" && "bg-gz-3 text-t3"
    )}>
      {label}
    </span>
  );
}

function Dot() {
  return <span className="text-t4">&middot;</span>;
}

/* ════════════════════════════════════════════════════════════════════════════
   EXPANDED DETAIL
   Prompt text, artifacts, files, git — all inside the expanded card.
   ════════════════════════════════════════════════════════════════════════════ */

function ExpandedDetail({ detail }: { detail: PromptDetailViewModel }) {
  return (
    <div className="px-4 py-4 flex flex-col gap-5">
      {/* Prompt text block */}
      <div className="relative rounded-lg bg-white border border-brd overflow-hidden">
        <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-t1" />
        <div className="pl-5 pr-4 py-3 text-[13px] leading-relaxed text-t2 whitespace-pre-wrap font-sans">
          {detail.promptText}
        </div>
      </div>

      {/* Meta line */}
      <div className="flex items-center gap-3 flex-wrap">
        <code className="text-[11px] font-mono text-t3 bg-gz-2 border border-brd px-2 py-0.5 rounded-md">
          {detail.executionPathLabel}
        </code>
        {detail.primaryArtifactSummary && (
          <p className="text-[12px] text-t3 truncate">{detail.primaryArtifactSummary}</p>
        )}
      </div>

      {/* Artifacts */}
      {detail.artifactSummaries.length > 0 && (
        <Section title="Artifacts">
          {detail.artifactSummaries.map((a) => (
            <ArtifactRow key={a.id} artifact={a} />
          ))}
        </Section>
      )}

      {/* Files */}
      {detail.fileGroups.length > 0 && (
        <Section title="Files changed" badge={detail.touchedFilesLabel}>
          {detail.fileGroups.map((g) => (
            <FileGroupRow key={g.extension} group={g} />
          ))}
        </Section>
      )}

      {/* Git */}
      {detail.gitSummaries.length > 0 && (
        <Section title="Git">
          {detail.gitSummaries.map((gl) => (
            <GitRow key={gl.id} link={gl} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, badge, children }: { title: string; badge?: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-t4">{title}</h3>
        {badge && <span className="text-[10px] text-t3 bg-gz-2 px-1.5 py-px rounded">{badge}</span>}
      </div>
      <div className="rounded-lg border border-brd overflow-hidden divide-y divide-brd">
        {children}
      </div>
    </div>
  );
}

/* ─── Artifact row ──────────────────────────────────────────────────────── */

function ArtifactRow({ artifact }: { artifact: PromptDetailArtifactViewModel }) {
  const iconPaths: Record<string, string> = {
    code_diff: "M11.28 3.22a.75.75 0 0 1 0 1.06L7.56 8l3.72 3.72a.75.75 0 0 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z",
    final_output: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-2.75h-.75a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z",
    plan: "M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9Zm3.75 1a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5h-4.5Zm0 3a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5h-4.5Zm0 3a.75.75 0 0 0 0 1.5h2.5a.75.75 0 0 0 0-1.5h-2.5Z",
    test_run: "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM6.72 10.97l5.03-5.03a.75.75 0 0 0-1.06-1.06L6.19 9.38 5.31 8.47a.75.75 0 0 0-1.06 1.06l1.41 1.41a.75.75 0 0 0 1.06.03Z",
    command_run: "M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm7 3.47-2.22-2.22a.75.75 0 0 0-1.06 1.06l2.75 2.75a.75.75 0 0 0 1.06 0l2.75-2.75a.75.75 0 0 0-1.06-1.06L7 6.22Z",
    commit_ref: "M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z",
    pr_ref: "M7.177 3.073 9.573.677A.25.25 0 0 1 10 .854v4.792a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm-2.25.75a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25ZM11 2.5h-1V4h1a1 1 0 0 1 1 1v5.628a2.251 2.251 0 1 0 1.5 0V5A2.5 2.5 0 0 0 11 2.5Zm1 10.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0ZM3.75 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z",
  };
  const d = iconPaths[artifact.type] ?? "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z";

  return (
    <div className="flex items-start gap-3 px-3 py-2.5 bg-white">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 text-t4 mt-0.5">
        <path d={d} />
      </svg>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          <span className="text-[12px] font-medium text-t1">{artifact.label}</span>
          {artifact.fileCountLabel && <Chip label={artifact.fileCountLabel} />}
          {artifact.relationCountLabel && <Chip label={artifact.relationCountLabel} />}
        </div>
        <p className="text-[11px] text-t3 line-clamp-2">{artifact.summary}</p>
        {artifact.files.length > 0 && (
          <div className="mt-1.5 flex flex-col">
            {artifact.files.slice(0, 5).map((f) => (
              <code key={f} className="text-[10px] text-t4 font-mono truncate py-px">{f}</code>
            ))}
            {artifact.files.length > 5 && (
              <span className="text-[10px] text-t4">+{artifact.files.length - 5} more</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center h-[16px] px-1.5 rounded text-[9px] font-medium bg-gz-3 text-t3">
      {label}
    </span>
  );
}

/* ─── File group (collapsible) ──────────────────────────────────────────── */

function FileGroupRow({ group }: { group: FileGroupViewModel }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 border-0 bg-transparent text-left cursor-pointer hover:bg-gz-2 transition-colors"
      >
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="currentColor"
          className={cn("shrink-0 text-t4 transition-transform duration-150", open && "rotate-90")}
        >
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
        </svg>
        <code className="text-[11px] font-mono font-semibold text-t2">{group.extension}</code>
        <span className="text-[10px] text-t4 ml-auto tabular-nums">{group.files.length}</span>
      </button>
      {open && (
        <div className="flex flex-col pl-7 pr-3 pb-2 slidein">
          {group.files.map((path) => (
            <code key={path} className="block py-px text-[10px] text-t3 font-mono truncate">{path}</code>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Git row ───────────────────────────────────────────────────────────── */

function GitRow({ link }: { link: PromptDetailGitLinkViewModel }) {
  const variant = ({
    survived: "green",
    uncommitted: "amber",
    mutated: "amber",
    superseded: "default",
    reverted: "red",
    abandoned: "red",
  } as Record<string, string>)[link.survivalState] ?? "default";

  const colorMap: Record<string, string> = {
    green: "bg-green-dim text-green",
    amber: "bg-amber-dim text-amber",
    red: "bg-red-dim text-red",
    default: "bg-gz-3 text-t3",
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-white">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 text-t4">
        <path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z" />
      </svg>
      <code className="text-[12px] font-mono font-semibold text-t1">{link.headline}</code>
      <span className={cn(
        "inline-flex items-center h-[18px] px-1.5 rounded text-[9px] font-semibold uppercase tracking-wider",
        colorMap[variant]
      )}>
        {link.survivalState}
      </span>
      <span className="text-[10px] text-t4 ml-auto">{link.detail}</span>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   HEALTH VIEW
   ════════════════════════════════════════════════════════════════════════════ */

export function HealthView({ status }: { status: WorkspaceStatusViewModel | null }) {
  if (!status) {
    return (
      <div className="py-16 text-center">
        <p className="text-t3 text-[14px]">No health data available.</p>
      </div>
    );
  }

  const cards: { label: string; value: string | number; glow: boolean }[] = [
    { label: "Mode", value: status.mode, glow: status.mode === "watching" },
    { label: "Threads", value: status.threadCount, glow: false },
    { label: "Open threads", value: status.openThreadCount, glow: status.openThreadCount > 0 },
    { label: "Session files", value: status.sessionFileCount, glow: false },
  ];

  return (
    <div className="slidein">
      <p className="text-[14px] text-t2 mb-5">{status.headline}</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map((c) => (
          <div key={c.label} className={cn(
            "rounded-xl border p-5 transition-all",
            c.glow
              ? "border-green/20 bg-green-dim"
              : "border-brd bg-white"
          )}>
            <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-t4 mb-2">{c.label}</p>
            <p className={cn(
              "text-2xl font-bold tabular-nums",
              c.glow ? "text-green" : "text-t1"
            )}>
              {c.value}
            </p>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-t4 mt-5">{status.lastImportLabel}</p>
    </div>
  );
}
