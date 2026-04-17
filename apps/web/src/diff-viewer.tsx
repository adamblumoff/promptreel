import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type {
  CodeDiffDisplayArtifact,
  CodeDiffDisplayBlock,
  CodeDiffDisplayFile,
  CodeDiffDisplayRow,
} from "./types";

type DiffViewerFile = {
  id: string;
  artifactId: string;
  path: string;
  changeType: CodeDiffDisplayFile["changeType"];
  additions: number;
  deletions: number;
  blocks: CodeDiffDisplayBlock[];
};

export function DiffViewer({
  artifacts,
  mode = "focused",
}: {
  artifacts: CodeDiffDisplayArtifact[];
  mode?: "stacked" | "focused";
}) {
  const files = useMemo<DiffViewerFile[]>(
    () =>
      artifacts.flatMap((artifact) =>
        artifact.files.map((file, index) => ({
          id: `${artifact.artifactId}:${file.path}:${index}`,
          artifactId: artifact.artifactId,
          path: file.path,
          changeType: file.changeType,
          additions: file.additions,
          deletions: file.deletions,
          blocks: file.blocks,
        }))
      ),
    [artifacts]
  );

  if (files.length === 0) {
    return (
      <div className="rounded-xl border border-brd bg-white px-4 py-3 text-[11px] text-t3">
        No diff content was captured for this prompt.
      </div>
    );
  }

  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);

  if (mode === "stacked") {
    return (
      <div className="flex flex-col gap-3">
        <DiffSummaryBar
          fileCount={files.length}
          additions={totalAdditions}
          deletions={totalDeletions}
        />
        {files.map((file) => (
          <StackedDiffFileCard key={file.id} file={file} />
        ))}
      </div>
    );
  }

  if (files.length === 1) {
    return (
      <SingleFileDiffViewer
        file={files[0]!}
        totalAdditions={totalAdditions}
        totalDeletions={totalDeletions}
      />
    );
  }

  return (
    <FocusedDiffViewer
      files={files}
      totalAdditions={totalAdditions}
      totalDeletions={totalDeletions}
    />
  );
}

function SingleFileDiffViewer({
  file,
  totalAdditions,
  totalDeletions,
}: {
  file: DiffViewerFile;
  totalAdditions: number;
  totalDeletions: number;
}) {
  return (
    <div className="rounded-xl border border-brd bg-white overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2.5 bg-gz-1 border-b border-brd">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-t2">1 file changed</p>
          <code className="mt-0.5 block truncate text-[11px] font-mono text-t1" title={file.path}>
            {file.path}
          </code>
        </div>
        <DiffStatLine additions={totalAdditions} deletions={totalDeletions} />
      </div>
      <DiffFileSurface file={file} maxHeightClass="max-h-[640px]" />
    </div>
  );
}

function FocusedDiffViewer({
  files,
  totalAdditions,
  totalDeletions,
}: {
  files: DiffViewerFile[];
  totalAdditions: number;
  totalDeletions: number;
}) {
  const [activeId, setActiveId] = useState(files[0]?.id ?? "");

  useEffect(() => {
    if (!files.some((file) => file.id === activeId)) {
      setActiveId(files[0]?.id ?? "");
    }
  }, [activeId, files]);

  const activeFile = files.find((file) => file.id === activeId) ?? files[0];
  if (!activeFile) {
    return null;
  }

  return (
    <div className="rounded-xl border border-brd bg-white overflow-hidden">
      <DiffSummaryBar
        fileCount={files.length}
        additions={totalAdditions}
        deletions={totalDeletions}
        activePath={activeFile.path}
      />

      <div className="grid lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="border-b border-brd bg-white lg:border-b-0 lg:border-r">
          <div className="max-h-[280px] overflow-y-auto p-1.5">
            {files.map((file) => {
              const isActive = file.id === activeFile.id;
              return (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => setActiveId(file.id)}
                  className={cn(
                    "w-full rounded-lg border px-2.5 py-2 text-left transition-colors",
                    isActive ? "border-brd-strong bg-gz-1" : "border-transparent bg-transparent hover:bg-gz-1"
                  )}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate text-[11px] font-mono text-t2" title={file.path}>
                      {file.path}
                    </code>
                    {file.changeType === "added" && <DiffBadge tone="green" label="new" />}
                    {file.changeType === "deleted" && <DiffBadge tone="red" label="deleted" />}
                  </div>
                  <DiffStatLine additions={file.additions} deletions={file.deletions} />
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-brd bg-white">
            <code className="min-w-0 flex-1 truncate text-[11px] font-mono font-medium text-t1" title={activeFile.path}>
              {activeFile.path}
            </code>
            <DiffStatLine additions={activeFile.additions} deletions={activeFile.deletions} compact />
          </div>
          <DiffFileSurface file={activeFile} maxHeightClass="max-h-[560px]" />
        </div>
      </div>
    </div>
  );
}

function StackedDiffFileCard({ file }: { file: DiffViewerFile }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-lg border border-brd overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center gap-2.5 px-3 py-2 bg-gz-1 border-0 border-b border-brd text-left cursor-pointer hover:bg-gz-2 transition-colors"
      >
        <code className="min-w-0 flex-1 truncate text-[12px] font-mono text-t1">{file.path}</code>
        {file.changeType === "added" && <DiffBadge tone="green" label="new" />}
        {file.changeType === "deleted" && <DiffBadge tone="red" label="deleted" />}
        <DiffStatLine additions={file.additions} deletions={file.deletions} compact />
      </button>
      {open && <DiffFileSurface file={file} />}
    </div>
  );
}

function DiffSummaryBar({
  fileCount,
  additions,
  deletions,
  activePath,
}: {
  fileCount: number;
  additions: number;
  deletions: number;
  activePath?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-gz-1 border-b border-brd">
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-t2">
          {fileCount} file{fileCount === 1 ? "" : "s"} changed
        </p>
        {activePath && <p className="text-[10px] text-t4 truncate">{activePath}</p>}
      </div>
      <DiffStatLine additions={additions} deletions={deletions} />
    </div>
  );
}

function DiffFileSurface({
  file,
  maxHeightClass = "",
}: {
  file: DiffViewerFile;
  maxHeightClass?: string;
}) {
  const showLineNumbers = file.blocks.some(
    (block) =>
      block.kind === "hunk"
      && block.rows.some((row) => row.oldLineNumber !== null || row.newLineNumber !== null)
  );

  if (file.blocks.length === 0) {
    return (
      <div className={cn("bg-white px-4 py-6 text-[12px] text-t3", maxHeightClass)}>
        No line-level diff content is available for this file.
      </div>
    );
  }

  return (
    <div className={cn("overflow-x-auto bg-white", maxHeightClass)}>
      <table className="w-full border-collapse text-[11px] leading-[18px] font-mono">
        <tbody>
          {file.blocks.map((block, blockIndex) =>
            block.kind === "collapsed" ? (
              <CollapsedRowsRow
                key={`${file.id}:collapsed:${blockIndex}`}
                count={block.count}
                showLineNumbers={showLineNumbers}
              />
            ) : (
              <HunkRows
                key={`${file.id}:hunk:${blockIndex}`}
                rows={block.rows}
                showLineNumbers={showLineNumbers}
              />
            )
          )}
        </tbody>
      </table>
    </div>
  );
}

function HunkRows({
  rows,
  showLineNumbers,
}: {
  rows: CodeDiffDisplayRow[];
  showLineNumbers: boolean;
}) {
  return (
    <>
      {rows.map((row, index) => (
        <DiffLineRow
          key={`${row.kind}-${row.oldLineNumber ?? "x"}-${row.newLineNumber ?? "x"}-${index}`}
          row={row}
          showLineNumbers={showLineNumbers}
        />
      ))}
    </>
  );
}

function DiffLineRow({
  row,
  showLineNumbers,
}: {
  row: CodeDiffDisplayRow;
  showLineNumbers: boolean;
}) {
  return (
    <tr
      className={cn(
        row.kind === "add" && "bg-[rgba(22,163,74,0.06)]",
        row.kind === "del" && "bg-[rgba(220,38,38,0.05)]",
        row.kind === "context" && "bg-white"
      )}
    >
      {showLineNumbers && (
        <>
          <td className="w-[1px] whitespace-nowrap text-right select-none px-2 py-0 text-t4 border-r border-brd align-top">
            {row.oldLineNumber ?? ""}
          </td>
          <td className="w-[1px] whitespace-nowrap text-right select-none px-2 py-0 text-t4 border-r border-brd align-top">
            {row.newLineNumber ?? ""}
          </td>
        </>
      )}
      <td className="px-3 py-0 whitespace-pre">
        <span
          className={cn(
            "select-none inline-block w-3 text-center",
            row.kind === "add" && "text-green",
            row.kind === "del" && "text-red",
            row.kind === "context" && "text-t4"
          )}
        >
          {row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}
        </span>
        <span
          className={cn(
            row.kind === "add" && "text-green/80",
            row.kind === "del" && "text-red/80",
            row.kind === "context" && "text-t2"
          )}
        >
          {row.text}
        </span>
      </td>
    </tr>
  );
}

function CollapsedRowsRow({
  count,
  showLineNumbers,
}: {
  count: number;
  showLineNumbers: boolean;
}) {
  return (
    <tr className="bg-white">
      <td colSpan={showLineNumbers ? 3 : 1} className="px-3 py-2">
        <div className="rounded-md bg-gz-1 px-3 py-1 text-[11px] text-t2">
          {count} unmodified line{count === 1 ? "" : "s"}
        </div>
      </td>
    </tr>
  );
}

function DiffStatLine({
  additions,
  deletions,
  compact = false,
}: {
  additions: number;
  deletions: number;
  compact?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      {additions > 0 && <span className={cn("font-mono text-green", compact ? "text-[10px]" : "text-[10px]")}>+{additions}</span>}
      {deletions > 0 && <span className={cn("font-mono text-red", compact ? "text-[10px]" : "text-[10px]")}>-{deletions}</span>}
      <DiffBar additions={additions} deletions={deletions} />
    </div>
  );
}

function DiffBadge({ tone, label }: { tone: "green" | "red"; label: string }) {
  return (
    <span
      className={cn(
        "text-[9px] font-semibold uppercase tracking-wider px-1.5 py-px rounded",
        tone === "green" ? "text-green bg-green-dim" : "text-red bg-red-dim"
      )}
    >
      {label}
    </span>
  );
}

function DiffBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) {
    return null;
  }

  const segments = 5;
  const addSegments = Math.round((additions / total) * segments);
  const delSegments = segments - addSegments;

  return (
    <div className="flex gap-px">
      {Array.from({ length: addSegments }, (_, index) => (
        <span key={`a${index}`} className="size-[6px] rounded-[1px] bg-green" />
      ))}
      {Array.from({ length: delSegments }, (_, index) => (
        <span key={`d${index}`} className="size-[6px] rounded-[1px] bg-red" />
      ))}
    </div>
  );
}
