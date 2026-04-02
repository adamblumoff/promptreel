import { lazy, Suspense, type ReactNode, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  GitCommitHorizontal,
  RefreshCw,
} from "lucide-react";
import type {
  FileGroupViewModel,
  PlanDecisionViewModel,
  PromptDetailGitLinkViewModel,
  PromptDetailViewModel,
  PromptRowViewModel,
  ThreadRowViewModel,
  WorkspaceSidebarItemViewModel,
  WorkspaceStatusViewModel,
} from "./view-models";
import type { Workspace } from "./types";
import { cn } from "@/lib/utils";
import { normalizePlanDocument } from "./plan-document";

const LazyDiffViewer = lazy(async () => {
  const module = await import("./diff-viewer");
  return { default: module.DiffViewer };
});

const LazyMarkdownPlanDocument = lazy(async () => {
  const module = await import("./plan-renderer");
  return { default: module.MarkdownPlanDocument };
});

const decisionTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function PromptlineMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect
        x="1"
        y="1"
        width="14"
        height="14"
        rx="3"
        fill="#fcfcfd"
        stroke="#d8dde5"
      />
      <path
        d="M5.5 3.5v9"
        stroke="#b6bdc8"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle
        cx="5.5"
        cy="4.25"
        r="1.35"
        fill="#ffffff"
        stroke="#c8cfd8"
        strokeWidth="0.9"
      />
      <circle
        cx="5.5"
        cy="8"
        r="1.55"
        fill="#34d399"
      />
      <circle
        cx="5.5"
        cy="11.75"
        r="1.35"
        fill="#ffffff"
        stroke="#c8cfd8"
        strokeWidth="0.9"
      />
      <rect
        x="8.4"
        y="6.4"
        width="3.6"
        height="3.2"
        rx="1.05"
        fill="#161b22"
        opacity="0.9"
      />
    </svg>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   TOP BAR
   ════════════════════════════════════════════════════════════════════════════ */

export function TopBar({
  workspaces,
  isWorkspacesLoading,
  selectedWorkspaceId,
  onSelectWorkspace,
  threads,
  selectedThreadId,
  onSelectThread,
  isThreadsLoading,
  isRescanning,
  onRescan,
}: {
  workspaces: WorkspaceSidebarItemViewModel[];
  isWorkspacesLoading: boolean;
  selectedWorkspaceId: string;
  onSelectWorkspace: (id: string) => void;
  threads: ThreadRowViewModel[];
  selectedThreadId: string;
  onSelectThread: (id: string) => void;
  isThreadsLoading: boolean;
  isRescanning: boolean;
  onRescan: () => void;
}) {
  const [workspaceDropdownOpen, setWorkspaceDropdownOpen] = useState(false);
  const [threadDropdownOpen, setThreadDropdownOpen] = useState(false);
  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId);
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;

  return (
    <header className="sticky top-0 z-50 h-13 flex items-center justify-between px-5 bg-white/80 backdrop-blur-xl border-b border-brd">
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <div className="size-7 shrink-0">
            <PromptlineMark className="size-7" />
          </div>
          <span className="text-sm font-semibold text-t1 tracking-tight">Promptline</span>
        </div>

        <div className="w-px h-5 bg-brd" />

        {/* Workspace dropdown */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setWorkspaceDropdownOpen((open) => !open);
              setThreadDropdownOpen(false);
            }}
            className="flex items-center gap-2 h-8 px-3 rounded-lg border border-brd bg-white text-t2 text-sm cursor-pointer hover:bg-gz-1 hover:text-t1 hoverlift-sm transition-colors"
          >
            {selectedWorkspace && (
              <span className="size-5 rounded bg-gz-3 text-[9px] font-bold flex items-center justify-center text-t2">
                {selectedWorkspace.slug.slice(0, 2).toUpperCase()}
              </span>
            )}
            <span className="max-w-[180px] truncate">
              {selectedWorkspace?.slug ?? (isWorkspacesLoading ? "Loading workspaces..." : "Select workspace")}
            </span>
            <ChevronDown className={cn("size-3 opacity-40 transition-transform duration-200", workspaceDropdownOpen && "rotate-180")} />
          </button>

          {workspaceDropdownOpen && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-40 bg-transparent border-0 cursor-default"
                onClick={() => setWorkspaceDropdownOpen(false)}
              />
              <div className="absolute left-0 top-full mt-1 z-50 w-72 max-h-80 overflow-y-auto rounded-xl border border-brd-strong bg-white shadow-xl shadow-black/8 popout">
                <div className="p-1.5">
                  {workspaces.map((ws, i) => (
                    <button
                      key={ws.id}
                      type="button"
                      onClick={() => {
                        onSelectWorkspace(ws.id);
                        setWorkspaceDropdownOpen(false);
                      }}
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
                    <p className="text-[13px] text-t3 text-center py-6">
                      {isWorkspacesLoading ? "Loading workspaces..." : "No workspaces discovered"}
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => {
              if (threads.length === 0 && !isThreadsLoading) return;
              setThreadDropdownOpen((open) => !open);
              setWorkspaceDropdownOpen(false);
            }}
            className={cn(
              "flex items-center gap-2 h-8 px-3 rounded-lg border border-brd bg-white text-t2 text-sm cursor-pointer transition-colors",
              threads.length === 0 && !isThreadsLoading
                ? "opacity-60"
                : "hover:bg-gz-1 hover:text-t1 hoverlift-sm"
            )}
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                selectedThread?.isGenerating ? "bg-green breathe" : "bg-amber"
              )}
            />
            <span className="max-w-[240px] truncate">
              {selectedThread?.title ?? (isThreadsLoading ? "Loading threads..." : "No threads")}
            </span>
            {selectedThread?.isGenerating && selectedThread.openPromptCount > 0 && (
              <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-green-dim text-[9px] font-bold text-green">
                {selectedThread.openPromptCount}
              </span>
            )}
            <ChevronDown className={cn("size-3 opacity-40 transition-transform duration-200", threadDropdownOpen && "rotate-180")} />
          </button>

          {threadDropdownOpen && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-40 bg-transparent border-0 cursor-default"
                onClick={() => setThreadDropdownOpen(false)}
              />
              <div className="absolute left-0 top-full mt-1 z-50 w-[28rem] max-h-80 overflow-y-auto rounded-xl border border-brd-strong bg-white shadow-xl shadow-black/8 popout">
                <div className="p-1.5">
                  {threads.map((thread, i) => {
                    const active = thread.id === selectedThreadId;
                    return (
                      <button
                        key={thread.id}
                        type="button"
                        onClick={() => {
                          onSelectThread(thread.id);
                          setThreadDropdownOpen(false);
                        }}
                        style={{ animationDelay: `${i * 30}ms` }}
                        className={cn(
                          "w-full flex items-center gap-3 px-3 py-2 rounded-lg border-0 cursor-pointer text-left transition-colors fadein pressable",
                          active
                            ? "bg-gz-1 text-t1"
                            : "bg-transparent text-t2 hover:bg-gz-1 hover:text-t1"
                        )}
                      >
                        <span
                          className={cn(
                            "mt-0.5 size-2 shrink-0 rounded-full",
                            thread.isGenerating ? "bg-green breathe" : "bg-amber"
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium">{thread.title}</p>
                          <p className="text-[11px] text-t3">
                            {thread.promptCountLabel} · {thread.activityLabel}
                          </p>
                        </div>
                        {thread.isGenerating && thread.openPromptCount > 0 && (
                          <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-green-dim text-[9px] font-bold text-green">
                            {thread.openPromptCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {threads.length === 0 && (
                    <p className="py-6 text-center text-[13px] text-t3">
                      {isThreadsLoading ? "Loading threads..." : "No threads yet."}
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Right */}
      <div className="flex items-center gap-3">
        {selectedWorkspace?.isGenerating && (
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
  transcriptOrder,
  onToggleTranscriptOrder,
  isLoading,
  isInitializing,
  onLoadBlob,
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
  transcriptOrder: "desc" | "asc";
  onToggleTranscriptOrder: () => void;
  isLoading: boolean;
  isInitializing: boolean;
  onLoadBlob: (blobId: string) => void;
  blobCache?: Record<string, string>;
  blobLoadingById?: Record<string, boolean>;
}) {
  if (rows.length === 0) {
    if (isInitializing) {
      return <PromptFeedLoadingState />;
    }

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
    <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)] lg:items-start">
      <section className="min-w-0 rounded-xl border border-brd bg-white overflow-hidden lg:sticky lg:top-6 lg:flex lg:max-h-[calc(100dvh-8rem)] lg:flex-col">
        <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gz-1 border-b border-brd">
          <div>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-t4">Thread</h2>
            <p className="text-[12px] text-t3 mt-1">Prompt events in review order.</p>
          </div>
          <div className="flex items-center gap-2">
            {isLoading && <span className="text-[11px] text-t4">Refreshing…</span>}
            <OrderToggleButton
              order={promptOrder}
              onToggle={onTogglePromptOrder}
              label="toggle ascending/descending"
            />
          </div>
        </div>

        <div className="relative px-4 py-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <div className="absolute left-[27.5px] top-5 bottom-5 w-px bg-brd" />
          <div key={`thread-order-${promptOrder}`} className="flex flex-col gap-2">
            {rows.map((prompt, i) => (
              <PromptTimelineItem
                key={`${promptOrder}:${prompt.id}`}
                prompt={prompt}
                promptText={details[prompt.id]?.promptText ?? null}
                isSelected={expandedId === prompt.id}
                isLoading={prompt.status === "in_progress" ? false : (loadingById[prompt.id] ?? false)}
                onSelect={() => onToggle(prompt.id)}
                index={i}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="min-w-0 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-8rem)] lg:min-h-0">
        {expandedId ? (
          <PromptReviewPane
            prompt={rows.find((row) => row.id === expandedId) ?? null}
            detail={details[expandedId]}
            isLoading={loadingById[expandedId] ?? false}
            error={errorById[expandedId] ?? null}
            transcriptOrder={transcriptOrder}
            onToggleTranscriptOrder={onToggleTranscriptOrder}
            onLoadBlob={onLoadBlob}
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

function PromptFeedLoadingState() {
  return (
    <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)] lg:items-start">
      <section className="min-w-0 rounded-xl border border-brd bg-white overflow-hidden slidein lg:sticky lg:top-6 lg:flex lg:max-h-[calc(100dvh-8rem)] lg:flex-col">
        <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gz-1 border-b border-brd">
          <div>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-t4">Thread</h2>
            <p className="text-[12px] text-t3 mt-1">Loading prompt events...</p>
          </div>
        </div>

        <div className="relative px-4 py-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <div className="absolute left-[27.5px] top-5 bottom-5 w-px bg-brd" />
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }, (_, index) => (
              <div
                key={index}
                style={{ animationDelay: `${index * 40}ms` }}
                className="grid grid-cols-[24px_minmax(0,1fr)] items-stretch gap-3 cardenter"
              >
                <div className="relative flex self-stretch items-center justify-center">
                  <span className="size-4 rounded-full border-[3px] border-white bg-gz-4" />
                </div>
                <div className="rounded-xl border border-brd bg-white px-4 py-3">
                  <div className="mb-2 h-3 w-24 rounded bg-gz-2 animate-pulse" />
                  <div className="space-y-2">
                    <div className="h-3.5 w-full rounded bg-gz-2 animate-pulse" />
                    <div className="h-3.5 w-4/5 rounded bg-gz-2 animate-pulse" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        className="min-w-0 slidein lg:sticky lg:top-6 lg:max-h-[calc(100dvh-8rem)] lg:min-h-0"
        style={{ animationDelay: "80ms" }}
      >
        <div className="rounded-xl border border-brd bg-white shadow-sm shadow-black/5 overflow-hidden">
          <div className="px-5 py-4 border-b border-brd bg-gz-1">
            <div className="mb-2 h-3 w-28 rounded bg-gz-2 animate-pulse" />
            <div className="space-y-2">
              <div className="h-4 w-full rounded bg-gz-2 animate-pulse" />
              <div className="h-4 w-5/6 rounded bg-gz-2 animate-pulse" />
              <div className="h-4 w-2/3 rounded bg-gz-2 animate-pulse" />
            </div>
          </div>
          <div className="px-5 py-5 space-y-5 lg:max-h-[calc(100dvh-16rem)] lg:overflow-y-auto">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="rounded-xl border border-brd bg-white overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3 bg-gz-1 border-b border-brd">
                  <div className="h-3 w-20 rounded bg-gz-2 animate-pulse" />
                </div>
                <div className="p-4 space-y-2">
                  <div className="h-3.5 w-full rounded bg-gz-2 animate-pulse" />
                  <div className="h-3.5 w-11/12 rounded bg-gz-2 animate-pulse" />
                  <div className="h-3.5 w-3/4 rounded bg-gz-2 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   PROMPT CARD — with entrance animation + hover lift + expand transition
   ════════════════════════════════════════════════════════════════════════════ */

function PromptTimelineItem({
  prompt,
  promptText,
  isSelected,
  isLoading,
  onSelect,
  index,
}: {
  prompt: PromptRowViewModel;
  promptText: string | null;
  isSelected: boolean;
  isLoading: boolean;
  onSelect: () => void;
  index: number;
}) {
  const displayedPromptText = isSelected ? (promptText ?? prompt.promptSummary) : prompt.promptSummary;
  const {
    expanded: isPromptExpanded,
    setExpanded: setIsPromptExpanded,
    canExpand: canExpandPrompt,
    textRef: promptTextRef,
  } = useExpandablePromptText(displayedPromptText);

  useEffect(() => {
    if (!isSelected) {
      setIsPromptExpanded(false);
    }
  }, [isSelected, setIsPromptExpanded]);

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

      <div
        className={cn(
          "rounded-xl border transition-all duration-200",
          isSelected
            ? "border-brd-strong bg-white shadow-md shadow-black/5"
            : "border-brd bg-white hover:border-brd-strong hover:bg-gz-1 hoverlift"
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          className="group block w-full rounded-xl border-0 bg-transparent px-4 py-3 text-left"
        >
          <div className="flex items-start gap-3 mb-2">
            <div className="min-w-0 flex-1">
              <div className="mb-1.5">
                <span className="text-[11px] font-mono text-t4 tabular-nums">{prompt.timestampLabel}</span>
              </div>
              <p
                ref={promptTextRef}
                className={cn(
                  "text-[13px] leading-snug transition-colors duration-150 whitespace-pre-wrap break-words",
                  isSelected ? "text-t1 font-medium" : "text-t2",
                  !isPromptExpanded && "overflow-hidden"
                )}
                style={getPromptClampStyle(!isPromptExpanded, 3)}
              >
                {displayedPromptText}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap text-[10px] text-t3">
            {prompt.outcomeLabel && <PromptOutcomeBadge label={prompt.outcomeLabel} tone={prompt.outcomeTone} />}
            {isLoading && <span className="text-t4">Loading…</span>}
          </div>
        </button>

        {isSelected && canExpandPrompt && (
          <div className="px-4 pb-3">
            <PromptTextToggle
              expanded={isPromptExpanded}
              onToggle={() => setIsPromptExpanded((current) => !current)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function PromptReviewPane({
  prompt,
  detail,
  isLoading,
  error,
  transcriptOrder,
  onToggleTranscriptOrder,
  onLoadBlob,
  blobCache,
  blobLoadingById,
}: {
  prompt: PromptRowViewModel | null;
  detail: PromptDetailViewModel | undefined;
  isLoading: boolean;
  error: string | null;
  transcriptOrder: "desc" | "asc";
  onToggleTranscriptOrder: () => void;
  onLoadBlob: (blobId: string) => void;
  blobCache?: Record<string, string>;
  blobLoadingById?: Record<string, boolean>;
}) {
  return (
    <div className="rounded-xl border border-brd bg-white shadow-sm shadow-black/5 overflow-hidden lg:flex lg:max-h-[calc(100dvh-8rem)] lg:flex-col">
      {prompt && (
        <div className="px-5 py-4 border-b border-brd bg-gz-1">
          <div className="min-w-0 mb-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-t4 mb-1">
              Selected Prompt
            </h2>
            <ExpandablePromptText
              text={detail?.promptText ?? prompt.promptSummary}
              collapsedLines={3}
              textClassName="text-[15px] leading-snug text-t1 font-medium"
              toggleClassName="mt-2"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap text-[11px] text-t3">
            <span className="font-mono tabular-nums">{prompt.timestampLabel}</span>
            {prompt.outcomeLabel && (
              <>
                <Dot />
                <PromptOutcomeBadge label={prompt.outcomeLabel} tone={prompt.outcomeTone} compact />
              </>
            )}
            <Dot />
            <span>{prompt.executionPathLabel}</span>
          </div>
        </div>
      )}

      {!detail && !error && (
        <div className="px-5 py-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <PromptDetailLoadingState />
        </div>
      )}
      {error && !detail && (
        <div className="px-5 py-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <p className="text-[13px] text-red">{error}</p>
        </div>
      )}
      {detail && (
        <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <ExpandedDetail
            detail={detail}
            transcriptOrder={transcriptOrder}
            onToggleTranscriptOrder={onToggleTranscriptOrder}
            onLoadBlob={onLoadBlob}
            blobCache={blobCache}
            blobLoadingById={blobLoadingById}
          />
        </div>
      )}
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

function PromptDetailLoadingState() {
  return (
    <div className="flex flex-col gap-5">
      <LoadingSectionCard
        title="Transcript"
        subtitle="Loading prompt, assistant messages, and tool activity..."
      >
        <div className="relative px-4 py-4">
          <div className="absolute left-[14px] top-4 bottom-4 w-px bg-brd" />
          <div className="space-y-5">
            {[0, 1, 2].map((index) => (
              <LoadingTranscriptRow key={index} />
            ))}
          </div>
        </div>
      </LoadingSectionCard>

      <LoadingSectionCard
        title="Code changes"
        subtitle="Loading focused git-style diff review..."
      >
        <div className="px-4 py-4">
          <div className="rounded-xl border border-brd bg-white p-4">
            <div className="animate-pulse space-y-3">
              <div className="h-3 w-32 rounded bg-gz-2" />
              <div className="h-3 w-full rounded bg-gz-2" />
              <div className="h-3 w-[92%] rounded bg-gz-2" />
              <div className="h-3 w-[88%] rounded bg-gz-2" />
              <div className="h-3 w-[76%] rounded bg-gz-2" />
            </div>
          </div>
        </div>
      </LoadingSectionCard>
    </div>
  );
}

function LoadingSectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-brd bg-white overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 bg-gz-1">
        <RefreshCw className="size-3.5 shrink-0 spinner text-t4" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-t4 mb-1">{title}</h3>
          <p className="text-[12px] text-t2">{subtitle}</p>
        </div>
      </div>
      <div className="border-t border-brd">{children}</div>
    </div>
  );
}

function LoadingTranscriptRow() {
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-4">
      <div className="relative flex justify-center">
        <span className="mt-[5px] size-2.5 rounded-full bg-gz-3" />
      </div>
      <div className="min-w-0 animate-pulse space-y-2">
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3">
          <div className="h-3 w-20 rounded bg-gz-2" />
          <div className="h-3 w-full rounded bg-gz-2" />
          <div className="h-3 w-16 rounded bg-gz-2" />
        </div>
        <div className="h-3 w-[78%] rounded bg-gz-2" />
      </div>
    </div>
  );
}

function Dot() {
  return <span className="text-t4">&middot;</span>;
}

function ExpandablePromptText({
  text,
  collapsedLines = 3,
  textClassName,
  toggleClassName,
}: {
  text: string;
  collapsedLines?: number;
  textClassName: string;
  toggleClassName?: string;
}) {
  const {
    expanded,
    setExpanded,
    canExpand,
    textRef,
  } = useExpandablePromptText(text);

  return (
    <div className="min-w-0">
      <p
        ref={textRef}
        className={cn(
          textClassName,
          "whitespace-pre-wrap break-words",
          !expanded && "overflow-hidden"
        )}
        style={getPromptClampStyle(!expanded, collapsedLines)}
      >
        {text}
      </p>
      {canExpand && (
        <div className={toggleClassName}>
          <PromptTextToggle
            expanded={expanded}
            onToggle={() => setExpanded((current) => !current)}
          />
        </div>
      )}
    </div>
  );
}

function PromptTextToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-[11px] font-medium text-t3 transition-colors hover:text-t1"
    >
      {expanded ? "Show less" : "Show more"}
    </button>
  );
}

function useExpandablePromptText(text: string) {
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [text]);

  useEffect(() => {
    const element = textRef.current;
    if (!element) {
      setCanExpand(false);
      return;
    }

    if (expanded) {
      setCanExpand(true);
      return;
    }

    let frame = 0;
    const measure = () => {
      setCanExpand(element.scrollHeight > element.clientHeight + 1);
    };

    frame = window.requestAnimationFrame(measure);

    if (typeof ResizeObserver === "undefined") {
      return () => window.cancelAnimationFrame(frame);
    }

    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    });
    observer.observe(element);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [expanded, text]);

  return { expanded, setExpanded, canExpand, textRef };
}

function getPromptClampStyle(collapsed: boolean, collapsedLines: number) {
  if (!collapsed) {
    return undefined;
  }

  return {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: String(collapsedLines),
  } as const;
}

/* ════════════════════════════════════════════════════════════════════════════
   EXPANDED DETAIL — sections stagger in
   ════════════════════════════════════════════════════════════════════════════ */

function ExpandedDetail({ detail, transcriptOrder, onToggleTranscriptOrder, onLoadBlob, blobCache, blobLoadingById }: {
  detail: PromptDetailViewModel;
  transcriptOrder: "desc" | "asc";
  onToggleTranscriptOrder: () => void;
  onLoadBlob: (blobId: string) => void;
  blobCache?: Record<string, string>;
  blobLoadingById?: Record<string, boolean>;
}) {
  const hasDiffPane = detail.diffBlobIds.length > 0 || detail.hasCodeDiffArtifacts;
  const transcriptSectionCount = detail.transcript.length > 0 ? 1 : 0;
  const planSectionCount = detail.featuredPlanArtifact ? 1 : 0;
  const leadingSectionCount =
    transcriptSectionCount
    + planSectionCount;
  const detailSectionCount = leadingSectionCount + (hasDiffPane ? 1 : 0);

  return (
    <div className="px-5 py-5 flex flex-col gap-5">
      {detail.transcript.length > 0 && (
        <div className="slidein">
          <TranscriptSection
            promptEventId={detail.id}
            transcript={detail.transcript}
            transcriptOrder={transcriptOrder}
            onToggleTranscriptOrder={onToggleTranscriptOrder}
          />
        </div>
      )}

      {detail.featuredPlanArtifact && (
        <div
          className="slidein"
          style={{
            animationDelay:
              transcriptSectionCount + planSectionCount > 0
                ? `${transcriptSectionCount * 50}ms`
                : undefined
          }}
        >
          <PlanSection
            promptEventId={detail.id}
            blobId={detail.featuredPlanBlobId}
            onLoadBlob={onLoadBlob}
            blobCache={blobCache ?? {}}
            blobLoadingById={blobLoadingById ?? {}}
            fallbackSteps={detail.planTraceSteps}
            decisions={detail.featuredPlanArtifact.planDecisions}
            hasPlanArtifact
          />
        </div>
      )}

      {hasDiffPane && (
        <div className="slidein" style={{ animationDelay: leadingSectionCount > 0 ? `${leadingSectionCount * 50}ms` : undefined }}>
          <DiffSection
            promptEventId={detail.id}
            blobIds={detail.diffBlobIds}
            onLoadBlob={onLoadBlob}
            blobCache={blobCache ?? {}}
            blobLoadingById={blobLoadingById ?? {}}
            hasCodeDiffArtifacts={detail.hasCodeDiffArtifacts}
          />
        </div>
      )}

      {detail.gitSummaries.length > 0 && (
        <div className="slidein" style={{ animationDelay: `${detailSectionCount * 50}ms` }}>
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

function TranscriptSection({
  promptEventId,
  transcript,
  transcriptOrder,
  onToggleTranscriptOrder,
}: {
  promptEventId: string;
  transcript: PromptDetailViewModel["transcript"];
  transcriptOrder: "desc" | "asc";
  onToggleTranscriptOrder: () => void;
}) {
  const [open, setOpen] = usePromptDisclosureState(promptEventId, "transcript");
  const [pageSize, setPageSize] = useState<(typeof transcriptPageSizeOptions)[number] | "all">(10);
  const [visibleCount, setVisibleCount] = useState(10);
  const [expandedEntries, setExpandedEntries] = useState<Record<string, boolean>>({});
  const transcriptEntries = transcript.map((entry, index) => ({
    entry,
    entryId: `${entry.kind}:${entry.occurredAt}:${index}`,
  }));
  const orderedTranscript =
    transcriptOrder === "desc"
      ? [...transcriptEntries].reverse()
      : transcriptEntries;
  const visibleTranscript =
    pageSize === "all" ? orderedTranscript : orderedTranscript.slice(0, visibleCount);
  const remainingCount = transcript.length - visibleTranscript.length;
  const nextBatchCount =
    pageSize === "all" ? 0 : Math.min(pageSize, Math.max(remainingCount, 0));

  return (
    <div className="rounded-xl border border-brd bg-white overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 bg-gz-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-3 border-0 bg-transparent p-0 text-left cursor-pointer hover:text-t1 transition-colors"
        >
          <ChevronRight className={cn("size-3 shrink-0 text-t4 transition-transform duration-200", open && "rotate-90")} />
          <div className="min-w-0 flex-1">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-t4 mb-1">Transcript</h3>
            <p className="text-[12px] text-t2">Prompt, assistant messages, and tool activity in turn order</p>
          </div>
        </button>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-t3 bg-white px-1.5 py-px rounded border border-brd">
            {transcript.length} item{transcript.length === 1 ? "" : "s"}
          </span>
          <OrderToggleButton
            order={transcriptOrder}
            onToggle={onToggleTranscriptOrder}
            label="toggle transcript order"
          />
          <label className="flex items-center gap-2 text-[10px] text-t3">
            <span className="uppercase tracking-[0.1em] text-t4">Show</span>
            <select
              aria-label="Transcript items per page"
              className="h-6 rounded-md border border-brd bg-white px-2 text-[11px] text-t2 outline-none transition-colors hover:border-brd-strong focus:border-brd-strong"
              value={pageSize}
              onChange={(event) => {
                const nextValue =
                  event.target.value === "all" ? "all" : Number(event.target.value) as (typeof transcriptPageSizeOptions)[number];
                setPageSize(nextValue);
                setVisibleCount(nextValue === "all" ? transcript.length : nextValue);
              }}
            >
              {transcriptPageSizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
              <option value="all">All</option>
            </select>
          </label>
        </div>
      </div>

      {open && (
        <div className="border-t border-brd px-4 py-4 slidedown">
          <div className="relative">
            <div className="absolute left-[10px] top-2 bottom-2 w-px bg-brd" />
            <div className="space-y-5">
              {visibleTranscript.map(({ entry, entryId }, index) => {
                const isFinalMessage =
                  entry.kind === "message"
                  && isTranscriptMarkdownEntry(entry);
                const entryExpanded =
                  expandedEntries[entryId]
                  ?? (isFinalMessage ? true : false);
                return (
                  <div
                    key={`${transcriptOrder}:${entryId}`}
                    style={{ animationDelay: `${Math.min(index * 50, 400)}ms` }}
                    className="cardenter"
                  >
                    <TranscriptEntryRow
                      entry={entry}
                      expanded={entryExpanded}
                      onToggle={() =>
                        setExpandedEntries((current) => ({
                          ...current,
                          [entryId]: !entryExpanded,
                        }))
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
          {pageSize !== "all" && remainingCount > 0 && (
            <div className="mt-4 pl-8">
              <button
                type="button"
                onClick={() => setVisibleCount((current) => Math.min(current + pageSize, transcript.length))}
                className="text-[11px] font-medium text-t3 transition-colors hover:text-t1"
              >
                Show {nextBatchCount} more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TranscriptEntryRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: PromptDetailViewModel["transcript"][number];
  expanded: boolean;
  onToggle: () => void;
}) {
  const isMessage = entry.kind === "message";
  const markerClassName = isMessage
    ? entry.role === "user"
      ? "bg-t1"
      : "bg-white border border-brd-strong"
    : "bg-gz-3";
  const isExpandable = isTranscriptEntryExpandable(entry);
  const summaryText = getTranscriptEntrySummary(entry);
  const detailText = entry.kind === "activity" ? entry.detail : null;
  const isFinalMessage = entry.kind === "message" && isTranscriptMarkdownEntry(entry);
  const shouldShowExpanded = expanded;
  const shouldShowExpandedBody =
    expanded
    && (
      isFinalMessage
      || (entry.kind === "activity" && Boolean(detailText))
    );
  const entryLabel =
    isFinalMessage
      ? "final message"
      : entry.kind === "message"
      ? entry.role === "user" ? "prompt" : "assistant"
      : entry.label;

  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-4">
      <div className="relative flex justify-center">
        <span className={cn("mt-[5px] size-2.5 rounded-full", markerClassName)} />
      </div>
      <div className="min-w-0">
        <TranscriptEntryLine
          entry={entry}
          entryLabel={entryLabel}
          summaryText={isFinalMessage ? "" : summaryText}
          timestampLabel={entry.timestampLabel}
          expandable={isExpandable}
          expanded={expanded}
          onToggle={onToggle}
        />
        {shouldShowExpandedBody && (
          <TranscriptEntryBody
            entry={entry}
            detailText={detailText}
          />
        )}
      </div>
    </div>
  );
}

function TranscriptEntryLine({
  entry,
  entryLabel,
  summaryText,
  timestampLabel,
  expandable,
  expanded,
  onToggle,
}: {
  entry: PromptDetailViewModel["transcript"][number];
  entryLabel: string;
  summaryText: string;
  timestampLabel: string;
  expandable: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const line = (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5">
      <div className="flex min-w-0 items-baseline gap-2 text-[10px] uppercase tracking-[0.08em] text-t4">
        <span className="shrink-0 font-semibold">{entryLabel}</span>
      </div>
      <div
        className={cn(
          "min-w-0 normal-case tracking-normal",
          entry.kind === "activity"
            ? "font-mono text-[11px] font-semibold text-t1"
            : "text-[12px] text-t2"
        )}
      >
        {summaryText ? (
          <span
            className={cn(
              "block min-w-0 leading-5",
              expanded ? "whitespace-pre-wrap break-words" : "truncate"
            )}
          >
            {summaryText}
            {expandable && !expanded && "…"}
          </span>
        ) : (
          <span className="invisible block min-w-0 leading-5" aria-hidden="true">
            .
          </span>
        )}
      </div>
      <span className="shrink-0 pt-px font-mono text-[10px] text-t4 tabular-nums normal-case">
        {timestampLabel}
      </span>
    </div>
  );

  return (
    <button
      type="button"
      onClick={onToggle}
      className="block w-full border-0 bg-transparent p-0 text-left cursor-pointer"
    >
      {line}
    </button>
  );
}

function TranscriptEntryBody({
  entry,
  detailText,
}: {
  entry: PromptDetailViewModel["transcript"][number];
  detailText: string | null;
}) {
  if (entry.kind === "message") {
    if (isTranscriptMarkdownEntry(entry)) {
      return (
        <div className="mt-1.5 border-l border-brd pl-3">
          <Suspense fallback={<ContentRendererFallback text="Rendering message..." />}>
            <LazyMarkdownPlanDocument markdown={entry.text} variant="thread" />
          </Suspense>
        </div>
      );
    }

    return null;
  }

  if (!detailText) {
    return null;
  }

  return (
    <div className="mt-1.5 border-l border-brd pl-3">
      <p className="text-[11px] leading-5 font-mono text-t4 whitespace-pre-wrap break-words">
        {detailText}
      </p>
    </div>
  );
}

function getTranscriptEntrySummary(entry: PromptDetailViewModel["transcript"][number]): string {
  if (entry.kind === "activity") {
    return entry.summary;
  }

  return entry.text
    .replace(/[#>*_`[\]\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isTranscriptEntryExpandable(entry: PromptDetailViewModel["transcript"][number]): boolean {
  if (entry.kind === "message") {
    return entry.text.length > 140 || entry.text.includes("\n");
  }

  return (
    entry.summary.length > 120
    || Boolean(entry.detail && entry.detail.trim().length > 0)
  );
}

function isTranscriptMarkdownEntry(entry: PromptDetailViewModel["transcript"][number]) {
  return entry.kind === "message"
    && entry.role === "assistant"
    && (entry.phase === "final_answer" || entry.phase === null);
}

function PlanSection({
  promptEventId,
  blobId,
  onLoadBlob,
  blobCache,
  blobLoadingById,
  fallbackSteps = [],
  decisions,
  hasPlanArtifact,
}: {
  promptEventId: string;
  blobId: string | null;
  onLoadBlob: (blobId: string) => void;
  blobCache: Record<string, string>;
  blobLoadingById: Record<string, boolean>;
  fallbackSteps?: string[];
  decisions: PlanDecisionViewModel[];
  hasPlanArtifact: boolean;
}) {
  const [open, setOpen] = usePromptDisclosureState(promptEventId, "plan");
  const rawContent = blobId ? blobCache[blobId] : null;
  const shouldRequestContent = Boolean(open && blobId && rawContent === undefined && !blobLoadingById[blobId]);
  const isLoading = blobId
    ? shouldRequestContent || (Boolean(blobLoadingById[blobId]) && rawContent === undefined)
    : false;
  const normalized = normalizePlanDocument(rawContent, fallbackSteps);

  useEffect(() => {
    if (shouldRequestContent && blobId) {
      onLoadBlob(blobId);
    }
  }, [blobId, onLoadBlob, shouldRequestContent]);

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
            {decisions.length > 0 && (
              <div className="mb-3">
                <div className="mb-2 px-1">
                  <h4 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-t4 mb-1">Decision log</h4>
                  <p className="text-[12px] text-t2">Direction choices made during plan building</p>
                </div>
                <PlanDecisionLog decisions={decisions} />
              </div>
            )}

            {decisions.length > 0 && <div className="mb-3 border-t border-brd" />}

            {isLoading && (
              <div className="rounded-xl border border-brd bg-white flex items-center gap-2 py-6 justify-center">
                <RefreshCw className="size-3.5 spinner text-t4" />
                <span className="text-[11px] text-t3">Loading plan...</span>
              </div>
            )}
            {!isLoading && normalized && (
              <Suspense fallback={<ContentRendererFallback text="Rendering plan..." />}>
                <LazyMarkdownPlanDocument markdown={normalized.markdown} />
              </Suspense>
            )}
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

function PlanDecisionLog({ decisions }: { decisions: PlanDecisionViewModel[] }) {
  return (
    <div className="space-y-3">
      {decisions.map((decision, index) => (
        <div key={`${decision.promptEventId}:${decision.askedAt}:${index}`} className="rounded-xl border border-brd bg-white px-4 py-4 text-[13px] leading-6 text-t2">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h5 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-t4">Decision {index + 1}</h5>
            <span className="text-[10px] font-mono text-t4 tabular-nums">{formatDecisionTimestamp(decision.answeredAt)}</span>
          </div>

          <div className="mb-4">
            <h6 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-t4">Question</h6>
            <p className="text-pretty">{decision.question}</p>
          </div>

          <div className="mb-4">
            <h6 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-t4">Options</h6>
            <div className="space-y-2">
              {decision.options.map((option) => (
                <div
                  key={option.id}
                  className={cn(
                    "rounded-lg border px-3 py-2",
                    option.isSelected ? "border-sky-200 bg-sky-50" : "border-brd bg-gz-1"
                  )}
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-white px-1.5 text-[10px] font-semibold text-t3 border border-brd">
                      {option.id}
                    </span>
                    <p className="text-pretty">{option.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-brd bg-gz-1 px-3 py-2">
              <h6 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-t4">Chosen direction</h6>
              <p>{decision.selectedText ?? "No exact option match recorded."}</p>
            </div>
            <div className="rounded-lg border border-brd bg-gz-1 px-3 py-2">
              <h6 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-t4">User response</h6>
              <p>{decision.userAnswer}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function formatDecisionTimestamp(timestamp: string): string {
  try {
    return decisionTimestampFormatter.format(new Date(timestamp));
  } catch {
    return timestamp;
  }
}

function DiffSection({ promptEventId, blobIds, onLoadBlob, blobCache, blobLoadingById, hasCodeDiffArtifacts }: {
  promptEventId: string;
  blobIds: string[];
  onLoadBlob: (blobId: string) => void;
  blobCache: Record<string, string>;
  blobLoadingById: Record<string, boolean>;
  hasCodeDiffArtifacts: boolean;
}) {
  const [open, setOpen] = usePromptDisclosureState(promptEventId, "diff");
  const pendingBlobIds = open
    ? blobIds.filter((id) => blobCache[id] === undefined && !blobLoadingById[id])
    : [];
  const anyLoading = blobIds.some((id) => blobLoadingById[id]);
  const combinedPatch = blobIds
    .map((id) => blobCache[id])
    .filter((c): c is string => c !== undefined)
    .join("\n");
  const isLoading = pendingBlobIds.length > 0 || (anyLoading && !combinedPatch);

  useEffect(() => {
    for (const blobId of pendingBlobIds) {
      onLoadBlob(blobId);
    }
  }, [onLoadBlob, pendingBlobIds]);

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
            {isLoading && !combinedPatch && (
              <div className="rounded-xl border border-brd bg-white flex items-center gap-2 py-6 justify-center">
                <RefreshCw className="size-3.5 spinner text-t4" />
                <span className="text-[11px] text-t3">Loading diff...</span>
              </div>
            )}
            {combinedPatch && (
              <Suspense fallback={<ContentRendererFallback text="Rendering diff..." />}>
                <LazyDiffViewer patch={combinedPatch} mode="focused" />
              </Suspense>
            )}
            {!isLoading && !combinedPatch && hasCodeDiffArtifacts && blobIds.length === 0 && (
              <div className="rounded-xl border border-brd bg-white px-4 py-3">
                <p className="text-[11px] text-t3">Diff content not stored for this artifact.</p>
              </div>
            )}
            {!isLoading && !combinedPatch && blobIds.length > 0 && (
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

function ContentRendererFallback({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-brd bg-white flex items-center gap-2 py-6 justify-center">
      <RefreshCw className="size-3.5 spinner text-t4" />
      <span className="text-[11px] text-t3">{text}</span>
    </div>
  );
}

const transcriptPageSizeOptions = [10, 20, 50] as const;

function OrderToggleButton({
  order,
  onToggle,
  label,
}: {
  order: "desc" | "asc";
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      aria-label={label}
      title={label}
      className="size-7 rounded-md border border-brd bg-white text-t3 flex items-center justify-center transition-colors hover:bg-gz-1 hover:text-t1 pressable"
    >
      {order === "desc"
        ? <ArrowDown className="size-4" strokeWidth={1.5} aria-hidden="true" />
        : <ArrowUp className="size-4" strokeWidth={1.5} aria-hidden="true" />}
    </button>
  );
}

function PromptOutcomeBadge({
  label,
  tone,
  compact = false,
}: {
  label: string;
  tone: "steered" | "plan" | null;
  compact?: boolean;
}) {
  const classes =
    tone === "plan"
      ? "bg-sky-50 text-sky-700"
      : "bg-amber-dim text-amber";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded font-medium uppercase tracking-[0.08em]",
        compact ? "h-[18px] px-2 text-[9px]" : "h-[16px] px-1.5 text-[9px]",
        classes
      )}
    >
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
