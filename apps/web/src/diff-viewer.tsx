import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type {
  CodeDiffDisplayArtifact,
  CodeDiffDisplayFile,
} from "./types";

type DiffViewerFile = CodeDiffDisplayFile & {
  id: string;
  artifactId: string;
  fileDiff: FileDiffMetadata | null;
};

type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

type RawPatchEntry = {
  artifactId: string;
  summary: string;
  text: string;
  reason: string;
};

const DIFF_THEME = "pierre-light";

export function DiffViewer({
  artifacts,
  mode = "focused",
}: {
  artifacts: CodeDiffDisplayArtifact[];
  mode?: "stacked" | "focused";
}) {
  const { files, rawPatches } = useMemo(() => buildDiffViewerState(artifacts), [artifacts]);

  if (files.length === 0 && rawPatches.length === 0) {
    return (
      <div className="rounded-xl border border-brd bg-white px-4 py-3 text-[11px] text-t3">
        No diff content was captured for this prompt.
      </div>
    );
  }

  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);

  if (files.length === 0) {
    return <RawPatchFallbackList entries={rawPatches} />;
  }

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
        {rawPatches.length > 0 && <RawPatchFallbackList entries={rawPatches} />}
      </div>
    );
  }

  if (files.length === 1) {
    return (
      <div className="flex flex-col gap-3">
        <SingleFileDiffViewer
          file={files[0]!}
          totalAdditions={totalAdditions}
          totalDeletions={totalDeletions}
        />
        {rawPatches.length > 0 && <RawPatchFallbackList entries={rawPatches} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <FocusedDiffViewer
        files={files}
        totalAdditions={totalAdditions}
        totalDeletions={totalDeletions}
      />
      {rawPatches.length > 0 && <RawPatchFallbackList entries={rawPatches} />}
    </div>
  );
}

function buildDiffViewerState(artifacts: CodeDiffDisplayArtifact[]): {
  files: DiffViewerFile[];
  rawPatches: RawPatchEntry[];
} {
  const files: DiffViewerFile[] = [];
  const rawPatches: RawPatchEntry[] = [];

  for (const artifact of artifacts) {
    const renderablePatch = getRenderablePatch(artifact.renderPatch, artifact.artifactId);
    if (!renderablePatch) {
      continue;
    }

    if (renderablePatch.kind === "raw") {
      rawPatches.push({
        artifactId: artifact.artifactId,
        summary: artifact.summary,
        text: renderablePatch.text,
        reason: renderablePatch.reason,
      });
      continue;
    }

    for (const [index, file] of artifact.files.entries()) {
      files.push({
        ...file,
        id: `${artifact.artifactId}:${file.path}:${index}`,
        artifactId: artifact.artifactId,
        fileDiff: findMatchingFileDiff(renderablePatch.files, file),
      });
    }
  }

  return { files, rawPatches };
}

function getRenderablePatch(
  patch: string | undefined,
  cacheScope: string,
): RenderablePatch | null {
  if (!patch) {
    return null;
  }

  const normalizedPatch = patch.trim();
  if (!normalizedPatch) {
    return null;
  }

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

function findMatchingFileDiff(
  fileDiffs: FileDiffMetadata[],
  file: CodeDiffDisplayFile,
): FileDiffMetadata | null {
  const normalizedPath = normalizeDiffPath(file.path);
  const normalizedFromPath = normalizeDiffPath(file.fromPath);
  const normalizedToPath = normalizeDiffPath(file.toPath);

  return (
    fileDiffs.find((candidate) => {
      const candidatePath = normalizeDiffPath(resolveFileDiffPath(candidate));
      const candidateFromPath = normalizeDiffPath(candidate.prevName);
      const candidateToPath = normalizeDiffPath(candidate.name);
      return (
        candidatePath === normalizedPath
        || candidateToPath === normalizedToPath
        || candidateFromPath === normalizedFromPath
        || (
          normalizedFromPath
          && normalizedToPath
          && candidateFromPath === normalizedFromPath
          && candidateToPath === normalizedToPath
        )
      );
    })
    ?? null
  );
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const rawPath = fileDiff.type === "deleted"
    ? (fileDiff.prevName ?? fileDiff.name ?? "")
    : (fileDiff.name ?? fileDiff.prevName ?? "");
  return normalizeDiffPath(rawPath);
}

function normalizeDiffPath(path: string | null | undefined): string {
  if (!path) {
    return "";
  }
  return path.replace(/^[ab]\//, "").replace(/\\/g, "/");
}

function buildPatchCacheKey(patch: string, scope = "diff-viewer"): string {
  const normalizedPatch = patch.trim();
  const primary = fnv1a32(normalizedPatch).toString(36);
  const secondary = fnv1a32(normalizedPatch, 0x9e3779b9, 0x85ebca6b).toString(36);
  return `${scope}:${normalizedPatch.length}:${primary}:${secondary}`;
}

function fnv1a32(input: string, seed = 0x811c9dc5, multiplier = 0x01000193): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
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
    <div className="overflow-hidden rounded-xl border border-brd bg-white">
      <div className="flex items-center gap-3 border-b border-brd bg-gz-1 px-3 py-2.5">
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
    <div className="overflow-hidden rounded-xl border border-brd bg-white">
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
                    isActive
                      ? "border-brd-strong bg-gz-1"
                      : "border-transparent bg-transparent hover:bg-gz-1",
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
          <div className="flex items-center gap-2 border-b border-brd bg-white px-3 py-2">
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
    <div className="overflow-hidden rounded-lg border border-brd">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full cursor-pointer border-0 border-b border-brd bg-gz-1 px-3 py-2 text-left transition-colors hover:bg-gz-2"
      >
        <div className="flex items-center gap-2.5">
          <code className="min-w-0 flex-1 truncate text-[12px] font-mono text-t1">{file.path}</code>
          {file.changeType === "added" && <DiffBadge tone="green" label="new" />}
          {file.changeType === "deleted" && <DiffBadge tone="red" label="deleted" />}
          <DiffStatLine additions={file.additions} deletions={file.deletions} compact />
        </div>
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
    <div className="flex items-center justify-between gap-3 border-b border-brd bg-gz-1 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-t2">
          {fileCount} file{fileCount === 1 ? "" : "s"} changed
        </p>
        {activePath && <p className="truncate text-[10px] text-t4">{activePath}</p>}
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
  if (!file.fileDiff) {
    return (
      <div className={cn("bg-white px-4 py-6 text-[12px] text-t3", maxHeightClass)}>
        No line-level diff content is available for this file.
      </div>
    );
  }

  return (
    <div className={cn("overflow-auto bg-white px-3 py-3", maxHeightClass)}>
      <FileDiff
        fileDiff={file.fileDiff}
        options={{
          diffStyle: "unified",
          lineDiffType: "none",
          overflow: "wrap",
          theme: DIFF_THEME,
          themeType: "light",
          disableFileHeader: true,
        }}
      />
    </div>
  );
}

function RawPatchFallbackList({ entries }: { entries: RawPatchEntry[] }) {
  return (
    <div className="flex flex-col gap-3">
      {entries.map((entry) => (
        <div key={entry.artifactId} className="overflow-hidden rounded-xl border border-brd bg-white">
          <div className="border-b border-brd bg-gz-1 px-3 py-2.5">
            <p className="text-[11px] font-medium text-t2">{entry.summary}</p>
            <p className="mt-0.5 text-[10px] text-t4">{entry.reason}</p>
          </div>
          <pre className="max-h-[640px] overflow-auto whitespace-pre-wrap break-words bg-white px-4 py-4 font-mono text-[11px] leading-5 text-t2">
            {entry.text}
          </pre>
        </div>
      ))}
    </div>
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
    <div className="flex shrink-0 items-center gap-2">
      {additions > 0 && (
        <span className={cn("font-mono text-green", compact ? "text-[10px]" : "text-[10px]")}>
          +{additions}
        </span>
      )}
      {deletions > 0 && (
        <span className={cn("font-mono text-red", compact ? "text-[10px]" : "text-[10px]")}>
          -{deletions}
        </span>
      )}
      <DiffBar additions={additions} deletions={deletions} />
    </div>
  );
}

function DiffBadge({ tone, label }: { tone: "green" | "red"; label: string }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider",
        tone === "green" ? "bg-green-dim text-green" : "bg-red-dim text-red",
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
