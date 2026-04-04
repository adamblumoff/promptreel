import { type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { PromptDetailViewModel, PromptRowViewModel } from "./view-models";
import { ExpandedDetail, PromptOutcomeBadge } from "./prompt-detail-sections";
import { ExpandablePromptText } from "./prompt-text";

export function PromptReviewPane({
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
          <PromptDetailLoadingState showDiffPlaceholder={Boolean(prompt?.hasCodeDiff)} isLoading={isLoading} />
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

export function EmptyPromptReview() {
  return (
    <div className="rounded-xl border border-dashed border-brd bg-gz-1/70 px-6 py-10 text-center">
      <p className="text-[14px] text-t2 mb-1">Select a prompt event</p>
      <p className="text-[12px] text-t4">Choose a point in the thread to inspect its artifacts and diff.</p>
    </div>
  );
}

function PromptDetailLoadingState({
  showDiffPlaceholder,
  isLoading,
}: {
  showDiffPlaceholder: boolean;
  isLoading: boolean;
}) {
  return (
    <div className="flex flex-col gap-5">
      <LoadingSectionCard
        title="Transcript"
        subtitle={isLoading ? "Loading prompt, assistant messages, and tool activity..." : "Waiting for prompt details..."}
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

      {showDiffPlaceholder && (
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
      )}
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
