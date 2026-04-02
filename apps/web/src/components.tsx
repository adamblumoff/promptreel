import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Info,
  ListTodo,
  RefreshCw,
  Search,
  Terminal,
  TestTube2,
} from "lucide-react";
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
import type { ArtifactSubtype, Workspace } from "./types";
import { cn } from "@/lib/utils";
import { DiffViewer } from "./diff-viewer";
import { MarkdownPlanDocument, normalizePlanDocument } from "./plan-renderer";

/* ════════════════════════════════════════════════════════════════════════════
   TOP BAR
   ════════════════════════════════════════════════════════════════════════════ */

export function TopBar({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  isRescanning,
  onRescan,
}: {
  workspaces: WorkspaceSidebarItemViewModel[];
  selectedWorkspaceId: string;
  onSelectWorkspace: (id: string) => void;
  isRescanning: boolean;
  onRescan: () => void;
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const selected = workspaces.find((w) => w.id === selectedWorkspaceId);

  return (
    <header className="sticky top-0 z-50 h-13 flex items-center justify-between px-5 bg-white/80 backdrop-blur-xl border-b border-brd">
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <div className="size-7 rounded-md bg-t1 flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="white">
              <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h2A1.5 1.5 0 0 1 7 3.5v2A1.5 1.5 0 0 1 5.5 7H4v3h3.5A1.5 1.5 0 0 0 9 8.5V7h2v1.5A3.5 3.5 0 0 1 7.5 12H3.75a.75.75 0 0 1-.75-.75V7a2 2 0 0 1-1-1.732V3.5Z" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-t1 tracking-tight">Promptline</span>
        </div>

        <div className="w-px h-5 bg-brd" />

        {/* Workspace dropdown */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setDropdownOpen((o) => !o)}
            className="flex items-center gap-2 h-8 px-3 rounded-lg border border-brd bg-white text-t2 text-sm cursor-pointer hover:bg-gz-1 hover:text-t1 hoverlift-sm transition-colors"
          >
            {selected && (
              <span className="size-5 rounded bg-gz-3 text-[9px] font-bold flex items-center justify-center text-t2">
                {selected.slug.slice(0, 2).toUpperCase()}
              </span>
            )}
            <span className="max-w-[180px] truncate">{selected?.slug ?? "Select workspace"}</span>
            <ChevronDown className={cn("size-3 opacity-40 transition-transform duration-200", dropdownOpen && "rotate-180")} />
          </button>

          {dropdownOpen && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-40 bg-transparent border-0 cursor-default"
                onClick={() => setDropdownOpen(false)}
              />
              <div className="absolute left-0 top-full mt-1 z-50 w-72 max-h-80 overflow-y-auto rounded-xl border border-brd-strong bg-white shadow-xl shadow-black/8 popout">
                <div className="p-1.5">
                  {workspaces.map((ws, i) => (
                    <button
                      key={ws.id}
                      type="button"
                      onClick={() => { onSelectWorkspace(ws.id); setDropdownOpen(false); }}
                      style={{ animationDelay: `${i * 30}ms` }}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2 rounded-lg border-0 cursor-pointer text-left transition-colors fadein pressable",
                        ws.id === selectedWorkspaceId
                          ? "bg-gz-1 text-t1"
                          : "bg-transparent text-t2 hover:bg-gz-1 hover:text-t1"
                      )}
                    >
                      <span className={cn(
                        "shrink-0 size-7 rounded-md text-[10px] font-bold flex items-center justify-center transition-colors",
                        ws.id === selectedWorkspaceId
                          ? "bg-t1 text-white"
                          : "bg-gz-3 text-t3"
                      )}>
                        {ws.slug.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium truncate">{ws.slug}</p>
                        <p className="text-[11px] text-t3 truncate">{ws.pathLabel}</p>
                      </div>
                      {ws.isGenerating && <span className="shrink-0 size-2 rounded-full bg-green breathe" />}
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

      {/* Right */}
      <div className="flex items-center gap-3">
        {selected?.isGenerating && (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-green">
            <span className="size-1.5 rounded-full bg-green breathe" />
            Generating
          </span>
        )}
        <button
          type="button"
          onClick={onRescan}
          disabled={isRescanning}
          title="Rescan sessions"
          className="size-7 flex items-center justify-center rounded-md border-0 bg-transparent text-t3 hover:text-t2 hover:bg-gz-1 disabled:opacity-30 cursor-pointer transition-colors pressable"
        >
          <RefreshCw className={cn("size-[13px]", isRescanning && "spinner")} />
        </button>
      </div>
    </header>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   THREAD BAR
   Horizontal scrollable row of thread chips with staggered entrance.
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
      <div className="border-b border-brd px-5 py-4 fadein">
        <p className="text-[13px] text-t3">
          {isLoading ? "Loading threads\u2026" : "No threads yet. Threads appear when sessions produce prompt data."}
        </p>
      </div>
    );
  }

  return (
    <div className="border-b border-brd">
      <div ref={scrollRef} className="flex gap-1.5 px-5 py-2.5 overflow-x-auto">
        {threads.map((thread, i) => {
          const active = thread.id === selectedThreadId;
          return (
            <button
              key={thread.id}
              type="button"
              onClick={() => onSelectThread(thread.id)}
              style={{ animationDelay: `${i * 40}ms` }}
              className={cn(
                "shrink-0 flex items-center gap-2 h-9 px-3.5 rounded-full border text-[12px] cursor-pointer transition-all duration-200 threadslide pressable",
                active
                  ? "border-t1 bg-t1 text-white font-medium shadow-sm"
                  : "border-brd bg-white text-t2 hover:bg-gz-1 hover:text-t1 hover:border-brd-strong hoverlift-sm"
              )}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full transition-colors",
                  thread.isGenerating
                    ? active ? "bg-green-400 breathe" : "bg-green"
                    : "bg-amber"
                )}
              />
              <span className="max-w-[200px] truncate">{thread.title}</span>
              {thread.isGenerating && thread.openPromptCount > 0 && (
                <span className={cn(
                  "size-4 rounded-full text-[9px] font-bold flex items-center justify-center transition-colors",
                  active
                    ? "bg-white/20 text-white"
                    : "bg-green-dim text-green"
                )}>
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
   ════════════════════════════════════════════════════════════════════════════ */

export type ContentTab = "prompts" | "health";

export function ContentHeader({
  thread,
  activeTab,
  onTabChange,
  promptCount,
}: {
  thread: ThreadRowViewModel | null;
  activeTab: ContentTab;
  onTabChange: (t: ContentTab) => void;
  promptCount: number;
}) {
  if (!thread) {
    return (
      <div className="py-12 text-center fadein">
        <p className="text-t3 text-[14px]">Select a thread above to view its prompt history.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 mb-6 slidein">
      <div>
        <h1 className="text-xl font-semibold text-t1 leading-tight mb-2 tracking-tight">{thread.title}</h1>
        <div className="flex items-center gap-3 flex-wrap">
          <StatusBadge isGenerating={thread.isGenerating} />
          <span className="text-[11px] text-t3 tabular-nums">{thread.promptCountLabel}</span>
          <span className="text-[11px] text-t4">&middot;</span>
          <span className="text-[11px] text-t3 tabular-nums">{thread.activityLabel}</span>
          <code className="text-[10px] text-t4 font-mono">{thread.id.slice(-8)}</code>
        </div>
      </div>

      <div className="flex items-center gap-0.5 border-b border-brd pb-px">
        <TabButton active={activeTab === "prompts"} onClick={() => onTabChange("prompts")}>
          Prompts
          <span className={cn(
            "text-[10px] tabular-nums ml-1 countup",
            activeTab === "prompts" ? "text-t2" : "text-t4"
          )}>
            {promptCount}
          </span>
        </TabButton>
        <TabButton active={activeTab === "health"} onClick={() => onTabChange("health")}>
          Health
        </TabButton>
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
        "h-9 px-3 text-[13px] font-medium border-0 border-b-2 cursor-pointer transition-all duration-200 bg-transparent flex items-center",
        active
          ? "text-t1 border-b-t1"
          : "text-t3 border-b-transparent hover:text-t2"
      )}
    >
      {children}
    </button>
  );
}

function StatusBadge({ isGenerating }: { isGenerating: boolean }) {
  const label = isGenerating ? "generating" : "stopped";

  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 h-5 px-2 rounded-full text-[10px] font-semibold uppercase tracking-wider",
      isGenerating
        ? "bg-green-dim text-green"
        : "bg-amber-dim text-amber"
    )}>
      <span className={cn("size-1.5 rounded-full", isGenerating ? "bg-green breathe" : "bg-amber")} />
      {label}
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   PROMPT FEED — staggered card entrance
   ════════════════════════════════════════════════════════════════════════════ */

export function PromptFeed({
  rows,
  details,
  loadingById,
  errorById,
  expandedId,
  onToggle,
  promptOrder,
  onTogglePromptOrder,
  isLoading,
  blobCache,
  blobLoadingById,
}: {
  rows: PromptRowViewModel[];
  details: Record<string, PromptDetailViewModel>;
  loadingById: Record<string, boolean>;
  errorById: Record<string, string | null>;
  expandedId: string | null;
  onToggle: (id: string) => void;
  promptOrder: "desc" | "asc";
  onTogglePromptOrder: () => void;
  isLoading: boolean;
  blobCache?: Record<string, string>;
  blobLoadingById?: Record<string, boolean>;
}) {
  if (rows.length === 0) {
    return (
      <div className="py-20 text-center slidein">
        <div className="size-14 rounded-2xl bg-gz-1 border border-brd flex items-center justify-center mx-auto mb-4">
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
    <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
      <section className="min-w-0 rounded-xl border border-brd bg-white overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gz-1 border-b border-brd">
          <div>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-t4">Thread</h2>
            <p className="text-[12px] text-t3 mt-1">Prompt events in review order.</p>
          </div>
          <div className="flex items-center gap-2">
            {isLoading && <span className="text-[11px] text-t4">Refreshing…</span>}
            <button
              type="button"
              onClick={onTogglePromptOrder}
              aria-label="toggle ascending/descending"
              title="toggle ascending/descending"
              className="size-7 rounded-md border border-brd bg-white text-t3 flex items-center justify-center transition-colors hover:bg-gz-1 hover:text-t1 pressable"
            >
              {promptOrder === "desc" ? <ArrowDownAZ className="size-3.5" aria-hidden="true" /> : <ArrowUpAZ className="size-3.5" aria-hidden="true" />}
            </button>
          </div>
        </div>

        <div className="relative px-4 py-3">
          <div className="absolute left-[27.5px] top-5 bottom-5 w-px bg-brd" />
          <div key={`thread-order-${promptOrder}`} className="flex flex-col gap-2">
            {rows.map((prompt, i) => (
              <PromptTimelineItem
                key={`${promptOrder}:${prompt.id}`}
                prompt={prompt}
                isSelected={expandedId === prompt.id}
                isLoading={loadingById[prompt.id] ?? false}
                onSelect={() => onToggle(prompt.id)}
                index={i}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="min-w-0">
        {expandedId ? (
          <PromptReviewPane
            prompt={rows.find((row) => row.id === expandedId) ?? null}
            detail={details[expandedId]}
            isLoading={loadingById[expandedId] ?? false}
            error={errorById[expandedId] ?? null}
            blobCache={blobCache}
            blobLoadingById={blobLoadingById}
          />
        ) : (
          <EmptyPromptReview />
        )}
      </section>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   PROMPT CARD — with entrance animation + hover lift + expand transition
   ════════════════════════════════════════════════════════════════════════════ */

function PromptTimelineItem({
  prompt,
  isSelected,
  isLoading,
  onSelect,
  index,
}: {
  prompt: PromptRowViewModel;
  isSelected: boolean;
  isLoading: boolean;
  onSelect: () => void;
  index: number;
}) {
  return (
    <div
      style={{ animationDelay: `${Math.min(index * 50, 400)}ms` }}
      className="grid grid-cols-[24px_minmax(0,1fr)] items-stretch gap-3 cardenter"
    >
      <div className="relative flex self-stretch items-center justify-center">
        <span
          className={cn(
            "size-4 rounded-full border-[3px] transition-colors",
            isSelected
              ? "border-t1 bg-t1 shadow-sm"
              : "border-white bg-gz-4"
          )}
        />
      </div>

      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "group rounded-xl border px-4 py-3 text-left transition-all duration-200",
          isSelected
            ? "border-brd-strong bg-white shadow-md shadow-black/5"
            : "border-brd bg-white hover:border-brd-strong hover:bg-gz-1 hoverlift"
        )}
      >
        <div className="flex items-start gap-3 mb-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5">
              <span className="text-[11px] font-mono text-t4 tabular-nums">{prompt.timestampLabel}</span>
            </div>
            <p className={cn(
              "text-[13px] leading-snug transition-colors duration-150",
              isSelected ? "text-t1 font-medium" : "text-t2"
            )}>
              {prompt.promptSummary}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap text-[10px] text-t3">
          <ChipBadge label={prompt.primaryLabel} />
          {prompt.filesTouchedCount > 0 && <ChipBadge label={prompt.filesLabel} />}
          {prompt.artifactCount > 0 && <ChipBadge label={prompt.artifactLabel} />}
          {prompt.childCount > 0 && <ChipBadge label={prompt.childLabel} />}
          {isLoading && <span className="text-t4">Loading…</span>}
        </div>
      </button>
    </div>
  );
}

function PromptReviewPane({
  prompt,
  detail,
  isLoading,
  error,
  blobCache,
  blobLoadingById,
}: {
  prompt: PromptRowViewModel | null;
  detail: PromptDetailViewModel | undefined;
  isLoading: boolean;
  error: string | null;
  blobCache?: Record<string, string>;
  blobLoadingById?: Record<string, boolean>;
}) {
  return (
    <div className="rounded-xl border border-brd bg-white shadow-sm shadow-black/5 overflow-hidden">
      {prompt && (
        <div className="px-5 py-4 border-b border-brd bg-gz-1">
          <div className="min-w-0 mb-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-t4 mb-1">
              Selected Prompt
            </h2>
            <p className="text-[15px] leading-snug text-t1 font-medium">{prompt.promptSummary}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap text-[11px] text-t3">
            <span className="font-mono tabular-nums">{prompt.timestampLabel}</span>
            <Dot />
            <span>{prompt.executionPathLabel}</span>
          </div>
        </div>
      )}

      {isLoading && !detail && (
        <div className="px-5 py-10 flex items-center justify-center">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="spinner text-t3">
            <path d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      )}
      {error && !detail && (
        <div className="px-5 py-5">
          <p className="text-[13px] text-red">{error}</p>
        </div>
      )}
      {detail && <ExpandedDetail detail={detail} blobCache={blobCache} blobLoadingById={blobLoadingById} />}
    </div>
  );
}

function EmptyPromptReview() {
  return (
    <div className="rounded-xl border border-dashed border-brd bg-gz-1/70 px-6 py-10 text-center">
      <p className="text-[14px] text-t2 mb-1">Select a prompt event</p>
      <p className="text-[12px] text-t4">Choose a point in the thread to inspect its artifacts and diff.</p>
    </div>
  );
}

function Dot() {
  return <span className="text-t4">&middot;</span>;
}

/* ════════════════════════════════════════════════════════════════════════════
   EXPANDED DETAIL — sections stagger in
   ════════════════════════════════════════════════════════════════════════════ */

function ExpandedDetail({ detail, blobCache, blobLoadingById }: {
  detail: PromptDetailViewModel;
  blobCache?: Record<string, string>;
  blobLoadingById?: Record<string, boolean>;
}) {
  const hasDiffPane = detail.diffBlobIds.length > 0 || detail.hasCodeDiffArtifacts;
  const leadingSectionCount =
    (detail.featuredFinalResponseArtifact ? 1 : 0)
    + (detail.featuredPlanArtifact ? 1 : 0);

  return (
    <div className="px-5 py-5 flex flex-col gap-5">
      {detail.featuredFinalResponseArtifact && (
        <div className="slidein">
          <FinalResponseSection
            promptEventId={detail.id}
            blobId={detail.featuredFinalResponseBlobId}
            blobCache={blobCache ?? {}}
            blobLoadingById={blobLoadingById ?? {}}
            hasFinalResponseArtifact
          />
        </div>
      )}

      {detail.featuredPlanArtifact && (
        <div className="slidein" style={{ animationDelay: detail.featuredFinalResponseArtifact ? "50ms" : undefined }}>
          <PlanSection
            promptEventId={detail.id}
            blobId={detail.featuredPlanBlobId}
            blobCache={blobCache ?? {}}
            blobLoadingById={blobLoadingById ?? {}}
            fallbackSteps={detail.planTraceSteps}
            hasPlanArtifact
          />
        </div>
      )}

      {hasDiffPane && (
        <div className="slidein" style={{ animationDelay: leadingSectionCount > 0 ? `${leadingSectionCount * 50}ms` : undefined }}>
          <DiffSection
            promptEventId={detail.id}
            blobIds={detail.diffBlobIds}
            blobCache={blobCache ?? {}}
            blobLoadingById={blobLoadingById ?? {}}
            hasCodeDiffArtifacts={detail.hasCodeDiffArtifacts}
          />
        </div>
      )}

      {detail.artifactSummaries.length > 0 && (
        <div className="slidein" style={{ animationDelay: `${Math.max(leadingSectionCount, hasDiffPane ? leadingSectionCount + 1 : leadingSectionCount) * 50}ms` }}>
          <ArtifactSection key={detail.id} artifacts={detail.artifactSummaries} />
        </div>
      )}

      {detail.fileGroups.length > 0 && (
        <div className="slidein" style={{ animationDelay: `${(Math.max(leadingSectionCount, hasDiffPane ? leadingSectionCount + 1 : leadingSectionCount) + 1) * 50}ms` }}>
          <Section title="Files changed" badge={detail.touchedFilesLabel}>
            {detail.fileGroups.map((g) => (
              <FileGroupRow key={g.extension} promptEventId={detail.id} group={g} />
            ))}
          </Section>
        </div>
      )}

      {detail.gitSummaries.length > 0 && (
        <div className="slidein" style={{ animationDelay: `${(Math.max(leadingSectionCount, hasDiffPane ? leadingSectionCount + 1 : leadingSectionCount) + 2) * 50}ms` }}>
          <Section title="Git">
            {detail.gitSummaries.map((gl) => (
              <GitRow key={gl.id} link={gl} />
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}

function FinalResponseSection({
  promptEventId,
  blobId,
  blobCache,
  blobLoadingById,
  hasFinalResponseArtifact,
}: {
  promptEventId: string;
  blobId: string | null;
  blobCache: Record<string, string>;
  blobLoadingById: Record<string, boolean>;
  hasFinalResponseArtifact: boolean;
}) {
  const [open, setOpen] = usePromptDisclosureState(promptEventId, "final-response");
  const rawContent = blobId ? blobCache[blobId] : null;
  const isLoading = blobId ? Boolean(blobLoadingById[blobId]) && rawContent === undefined : false;
  const markdown = rawContent?.trim() ?? "";

  return (
    <div>
      <div className="rounded-xl border border-brd bg-white overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="w-full flex items-center gap-3 px-4 py-3 border-0 bg-gz-1 text-left cursor-pointer hover:bg-gz-2 transition-colors"
        >
          <ChevronRight className={cn("size-3 shrink-0 text-t4 transition-transform duration-200", open && "rotate-90")} />
          <div className="min-w-0 flex-1">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-t4 mb-1">Final response</h3>
            <p className="text-[12px] text-t2">Rendered markdown final response</p>
          </div>
          {markdown && (
            <span className="text-[10px] text-t3 bg-white px-1.5 py-px rounded border border-brd">markdown</span>
          )}
        </button>

        {open && (
          <div className="p-3 border-t border-brd slidedown">
            {isLoading && (
              <div className="rounded-xl border border-brd bg-white flex items-center gap-2 py-6 justify-center">
                <RefreshCw className="size-3.5 spinner text-t4" />
                <span className="text-[11px] text-t3">Loading final response...</span>
              </div>
            )}
            {!isLoading && markdown && <MarkdownPlanDocument markdown={markdown} />}
            {!isLoading && !markdown && hasFinalResponseArtifact && !blobId && (
              <div className="rounded-xl border border-brd bg-white px-4 py-3">
                <p className="text-[11px] text-t3">Final response content not stored for this artifact.</p>
              </div>
            )}
            {!isLoading && !markdown && hasFinalResponseArtifact && blobId && (
              <div className="rounded-xl border border-brd bg-white px-4 py-3">
                <p className="text-[11px] text-t3">Failed to load final response content.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PlanSection({
  promptEventId,
  blobId,
  blobCache,
  blobLoadingById,
  fallbackSteps = [],
  hasPlanArtifact,
}: {
  promptEventId: string;
  blobId: string | null;
  blobCache: Record<string, string>;
  blobLoadingById: Record<string, boolean>;
  fallbackSteps?: string[];
  hasPlanArtifact: boolean;
}) {
  const [open, setOpen] = usePromptDisclosureState(promptEventId, "plan");
  const rawContent = blobId ? blobCache[blobId] : null;
  const isLoading = blobId ? Boolean(blobLoadingById[blobId]) && rawContent === undefined : false;
  const normalized = normalizePlanDocument(rawContent, fallbackSteps);

  return (
    <div>
      <div className="rounded-xl border border-brd bg-white overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="w-full flex items-center gap-3 px-4 py-3 border-0 bg-gz-1 text-left cursor-pointer hover:bg-gz-2 transition-colors"
        >
          <ChevronRight className={cn("size-3 shrink-0 text-t4 transition-transform duration-200", open && "rotate-90")} />
          <div className="min-w-0 flex-1">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-t4 mb-1">Plan</h3>
            <p className="text-[12px] text-t2">Rendered markdown plan review</p>
          </div>
          {normalized && (
            <span className="text-[10px] text-t3 bg-white px-1.5 py-px rounded border border-brd">markdown</span>
          )}
        </button>

        {open && (
          <div className="p-3 border-t border-brd slidedown">
            {isLoading && (
              <div className="rounded-xl border border-brd bg-white flex items-center gap-2 py-6 justify-center">
                <RefreshCw className="size-3.5 spinner text-t4" />
                <span className="text-[11px] text-t3">Loading plan...</span>
              </div>
            )}
            {!isLoading && normalized && <MarkdownPlanDocument markdown={normalized.markdown} />}
            {!isLoading && !normalized && hasPlanArtifact && !blobId && (
              <div className="rounded-xl border border-brd bg-white px-4 py-3">
                <p className="text-[11px] text-t3">Plan content not stored for this artifact.</p>
              </div>
            )}
            {!isLoading && !normalized && hasPlanArtifact && blobId && (
              <div className="rounded-xl border border-brd bg-white px-4 py-3">
                <p className="text-[11px] text-t3">Failed to load plan content.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DiffSection({ promptEventId, blobIds, blobCache, blobLoadingById, hasCodeDiffArtifacts }: {
  promptEventId: string;
  blobIds: string[];
  blobCache: Record<string, string>;
  blobLoadingById: Record<string, boolean>;
  hasCodeDiffArtifacts: boolean;
}) {
  const [open, setOpen] = usePromptDisclosureState(promptEventId, "diff");
  const anyLoading = blobIds.some((id) => blobLoadingById[id]);
  const combinedPatch = blobIds
    .map((id) => blobCache[id])
    .filter((c): c is string => c !== undefined)
    .join("\n");

  return (
    <div>
      <div className="rounded-xl border border-brd bg-white overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="w-full flex items-center gap-3 px-4 py-3 border-0 bg-gz-1 text-left cursor-pointer hover:bg-gz-2 transition-colors"
        >
          <ChevronRight className={cn("size-3 shrink-0 text-t4 transition-transform duration-200", open && "rotate-90")} />
          <div className="min-w-0 flex-1">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-t4 mb-1">Code changes</h3>
            <p className="text-[12px] text-t2">Focused git-style diff review</p>
          </div>
          {blobIds.length > 0 && (
            <span className="text-[10px] text-t3 bg-white px-1.5 py-px rounded border border-brd">git diff</span>
          )}
        </button>

        {open && (
          <div className="p-3 border-t border-brd slidedown">
            {anyLoading && !combinedPatch && (
              <div className="rounded-xl border border-brd bg-white flex items-center gap-2 py-6 justify-center">
                <RefreshCw className="size-3.5 spinner text-t4" />
                <span className="text-[11px] text-t3">Loading diff...</span>
              </div>
            )}
            {combinedPatch && <DiffViewer patch={combinedPatch} mode="focused" />}
            {!anyLoading && !combinedPatch && hasCodeDiffArtifacts && blobIds.length === 0 && (
              <div className="rounded-xl border border-brd bg-white px-4 py-3">
                <p className="text-[11px] text-t3">Diff content not stored for this artifact.</p>
              </div>
            )}
            {!anyLoading && !combinedPatch && blobIds.length > 0 && (
              <div className="rounded-xl border border-brd bg-white px-4 py-3">
                <p className="text-[11px] text-t3">Failed to load diff content.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  badge,
  actions,
  children,
}: {
  title: string;
  badge?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-t4">{title}</h3>
          {badge && <span className="text-[10px] text-t3 bg-gz-1 px-1.5 py-px rounded">{badge}</span>}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      <div className="rounded-lg border border-brd overflow-hidden divide-y divide-brd">
        {children}
      </div>
    </div>
  );
}

const artifactPageSizeOptions = [10, 20, 50] as const;

function ArtifactSection({ artifacts }: { artifacts: PromptDetailArtifactViewModel[] }) {
  const [pageSize, setPageSize] = useState<(typeof artifactPageSizeOptions)[number] | "all">(10);
  const [visibleCount, setVisibleCount] = useState(10);

  const visibleArtifacts =
    pageSize === "all" ? artifacts : artifacts.slice(0, visibleCount);
  const remainingCount = artifacts.length - visibleArtifacts.length;
  const nextBatchCount =
    pageSize === "all" ? 0 : Math.min(pageSize, Math.max(remainingCount, 0));

  return (
    <Section
      title="Artifacts"
      badge={`${artifacts.length} item${artifacts.length === 1 ? "" : "s"}`}
      actions={
        <label className="flex items-center gap-2 text-[10px] text-t3">
          <span className="uppercase tracking-[0.1em] text-t4">Show</span>
          <select
            aria-label="Artifacts per page"
            className="h-6 rounded-md border border-brd bg-white px-2 text-[11px] text-t2 outline-none transition-colors hover:border-brd-strong focus:border-brd-strong"
            value={pageSize}
            onChange={(event) => {
              const nextValue =
                event.target.value === "all" ? "all" : Number(event.target.value) as (typeof artifactPageSizeOptions)[number];
              setPageSize(nextValue);
              setVisibleCount(nextValue === "all" ? artifacts.length : nextValue);
            }}
          >
            {artifactPageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
            <option value="all">All</option>
          </select>
        </label>
      }
    >
      {visibleArtifacts.map((artifact) => (
        <ArtifactRow key={artifact.id} artifact={artifact} />
      ))}
      {pageSize !== "all" && remainingCount > 0 && (
        <div className="bg-white px-3 py-2.5">
          <button
            type="button"
            onClick={() => setVisibleCount((current) => Math.min(current + pageSize, artifacts.length))}
            className="w-full rounded-md border border-brd bg-gz-1 px-3 py-2 text-[11px] font-medium text-t2 transition-colors hover:bg-gz-2 hover:text-t1"
          >
            Show {nextBatchCount} more
          </button>
        </div>
      )}
    </Section>
  );
}

/* ─── Artifact row ──────────────────────────────────────────────────────── */

function ArtifactRow({ artifact }: { artifact: PromptDetailArtifactViewModel }) {
  const iconMap = {
    code_diff: FileCode2,
    final_output: FileText,
    plan: ListTodo,
    test_run: TestTube2,
    command_run: Terminal,
    commit_ref: GitCommitHorizontal,
    pr_ref: GitPullRequest,
  } as const;
  const classificationIconMap: Partial<Record<ArtifactSubtype, typeof Terminal>> = {
    "verification.test": TestTube2,
    "verification.typecheck": TestTube2,
    "execution.search": Search,
    "execution.git_status": GitBranch,
    "execution.command": Terminal,
    "final.answer": FileText,
    "reference.commit": GitCommitHorizontal,
    "reference.pr": GitPullRequest,
  } as const;
  const Icon =
    (artifact.subtype ? classificationIconMap[artifact.subtype] : undefined)
    ?? iconMap[artifact.type]
    ?? Info;

  return (
    <div className="flex items-start gap-3 px-3 py-2.5 bg-white hover:bg-gz-1 transition-colors">
      <Icon className="size-3.5 shrink-0 text-t4 mt-0.5" strokeWidth={1.75} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          <span className="text-[12px] font-medium text-t1">{artifact.label}</span>
          {artifact.fileCountLabel && <ChipBadge label={artifact.fileCountLabel} />}
          {artifact.relationCountLabel && <ChipBadge label={artifact.relationCountLabel} />}
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

function ChipBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center h-[16px] px-1.5 rounded text-[9px] font-medium bg-gz-2 text-t3">
      {label}
    </span>
  );
}

/* ─── File group (collapsible with animation) ───────────────────────────── */

function FileGroupRow({ promptEventId, group }: { promptEventId: string; group: FileGroupViewModel }) {
  const [open, setOpen] = usePromptDisclosureState(promptEventId, `file-group:${group.extension}`);

  return (
    <div className="bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 border-0 bg-transparent text-left cursor-pointer hover:bg-gz-1 transition-colors"
      >
        <ChevronRight className={cn("size-3 shrink-0 text-t4 transition-transform duration-200 ease-out", open && "rotate-90")} />
        <code className="text-[11px] font-mono font-semibold text-t2">{group.extension}</code>
        <span className="text-[10px] text-t4 ml-auto tabular-nums">{group.files.length}</span>
      </button>
      {open && (
        <div className="flex flex-col pl-7 pr-3 pb-2 slidedown">
          {group.files.map((path) => (
            <code key={path} className="block py-px text-[10px] text-t3 font-mono truncate">{path}</code>
          ))}
        </div>
      )}
    </div>
  );
}

const disclosureStatePrefix = "promptline:prompt-disclosure";

function readDisclosureState(storageKey: string, defaultOpen: boolean): boolean {
  if (typeof window === "undefined") {
    return defaultOpen;
  }

  try {
    const rawValue = window.localStorage.getItem(storageKey);
    if (rawValue === null) {
      return defaultOpen;
    }
    return rawValue === "1";
  } catch {
    return defaultOpen;
  }
}

function usePromptDisclosureState(promptEventId: string, sectionId: string, defaultOpen = false) {
  const storageKey = `${disclosureStatePrefix}:${promptEventId}:${sectionId}`;
  const [open, setOpen] = useState(() => readDisclosureState(storageKey, defaultOpen));

  useEffect(() => {
    setOpen(readDisclosureState(storageKey, defaultOpen));
  }, [storageKey, defaultOpen]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(storageKey, open ? "1" : "0");
    } catch {
      // Ignore storage errors and fall back to in-memory state.
    }
  }, [open, storageKey]);

  return [open, setOpen] as const;
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
    default: "bg-gz-2 text-t3",
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-white hover:bg-gz-1 transition-colors">
      <GitCommitHorizontal className="size-3.5 shrink-0 text-t4" strokeWidth={1.75} />
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
   HEALTH VIEW — with count-up entrance
   ════════════════════════════════════════════════════════════════════════════ */

export function HealthView({ status }: { status: WorkspaceStatusViewModel | null }) {
  if (!status) {
    return (
      <div className="py-16 text-center fadein">
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
        {cards.map((c, i) => (
          <div
            key={c.label}
            style={{ animationDelay: `${i * 60}ms` }}
            className={cn(
              "rounded-xl border p-5 cardenter hoverlift",
              c.glow
                ? "border-green/20 bg-green-dim"
                : "border-brd bg-white"
            )}
          >
            <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-t4 mb-2">{c.label}</p>
            <p className={cn(
              "text-2xl font-bold tabular-nums countup",
              c.glow ? "text-green" : "text-t1"
            )}
              style={{ animationDelay: `${i * 60 + 150}ms` }}
            >
              {c.value}
            </p>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-t4 mt-5">{status.lastImportLabel}</p>
    </div>
  );
}
