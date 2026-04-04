import { useEffect } from "react";
import type { PromptDetailViewModel, PromptRowViewModel } from "./view-models";
import { cn } from "@/lib/utils";
import { OrderToggleButton, PromptOutcomeBadge } from "./prompt-detail-sections";
import {
  PromptTextToggle,
  getPromptClampStyle,
  useExpandablePromptText,
} from "./prompt-text";
import { PromptReviewPane, EmptyPromptReview } from "./prompt-review-pane";

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
          <div className="mb-2 flex items-start justify-between gap-3">
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
            {prompt.hasCodeDiff && (prompt.totalAdditions > 0 || prompt.totalDeletions > 0) && (
              <div className="shrink-0 pt-0.5">
                <InlineDiffSummary additions={prompt.totalAdditions} deletions={prompt.totalDeletions} />
              </div>
            )}
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

function InlineDiffSummary({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  const total = additions + deletions;
  if (total === 0) return null;

  const segments = 5;
  const addSegs = Math.round((additions / total) * segments);
  const delSegs = segments - addSegs;

  return (
    <div className="flex items-center gap-1 text-[11px]">
      {additions > 0 && <span className="text-green font-mono">+{additions}</span>}
      {deletions > 0 && <span className="text-red font-mono">-{deletions}</span>}
      <div className="ml-0.5 flex gap-px">
        {Array.from({ length: addSegs }, (_, index) => (
          <span key={`a${index}`} className="size-[6px] rounded-[1px] bg-green" />
        ))}
        {Array.from({ length: delSegs }, (_, index) => (
          <span key={`d${index}`} className="size-[6px] rounded-[1px] bg-red" />
        ))}
      </div>
    </div>
  );
}
