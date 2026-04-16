import { lazy, Suspense, type ReactNode, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  GitCommitHorizontal,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { normalizePlanDocument } from "./plan-document";
import type {
  FileGroupViewModel,
  PlanDecisionViewModel,
  PromptDetailGitLinkViewModel,
  PromptDetailViewModel,
} from "./view-models";

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

const transcriptPageSizeOptions = [10, 20, 50] as const;
const disclosureStatePrefix = "promptreel:prompt-disclosure";

export function ExpandedDetail({
  detail,
  transcriptOrder,
  onToggleTranscriptOrder,
  onLoadBlob,
  blobCache,
  blobLoadingById,
}: {
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
  const leadingSectionCount = transcriptSectionCount + planSectionCount;
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
                : undefined,
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
            fileStats={detail.diffFileStats}
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

export function PromptOutcomeBadge({
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

export function OrderToggleButton({
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

function DiffSection({
  promptEventId,
  blobIds,
  fileStats,
  onLoadBlob,
  blobCache,
  blobLoadingById,
  hasCodeDiffArtifacts,
}: {
  promptEventId: string;
  blobIds: string[];
  fileStats: PromptDetailViewModel["diffFileStats"];
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
                <LazyDiffViewer patch={combinedPatch} mode="focused" fileStats={fileStats} />
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
