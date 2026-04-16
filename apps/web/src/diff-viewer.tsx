import { useEffect, useMemo, useState } from "react";
import { Diff, Hunk, isDelete, isInsert, parseDiff, type DiffType, type FileData, type HunkData } from "react-diff-view";
import "react-diff-view/style/index.css";
import { cn } from "@/lib/utils";
import type { DiffFileStat } from "./view-models";

type DiffLineType = "hunk" | "add" | "del" | "context";

type DiffLine = {
  type: DiffLineType;
  content: string;
  oldNum: number | null;
  newNum: number | null;
};

type CodexDiffFile = {
  id: string;
  kind: "codex";
  fromPath: string;
  toPath: string;
  displayPath: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
  isReplacement: boolean;
};

type UnifiedDiffFile = {
  id: string;
  kind: "unified";
  file: FileData;
  displayPath: string;
  additions: number;
  deletions: number;
};

type ParsedDiff =
  | { kind: "codex"; files: CodexDiffFile[] }
  | { kind: "unified"; files: UnifiedDiffFile[] };

function parseCodexPatch(raw: string): CodexDiffFile[] {
  const files: CodexDiffFile[] = [];
  const lines = raw.split("\n");
  let current: CodexDiffFile | null = null;
  let lineNum = 0;
  let fileIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line === "*** Begin Patch" || line === "*** End Patch") {
      current = null;
      continue;
    }

    const addMatch = line.match(/^\*\*\* Add File:\s*(.+)/);
    if (addMatch) {
      const path = normalizeLegacyPath(addMatch[1].trim());
      current = {
        id: createDiffFileId("codex", "/dev/null", path, "add", fileIndex),
        kind: "codex",
        fromPath: "/dev/null",
        toPath: path,
        displayPath: path,
        lines: [],
        additions: 0,
        deletions: 0,
        isNew: true,
        isDeleted: false,
        isReplacement: false
      };
      files.push(current);
      fileIndex += 1;
      lineNum = 0;
      continue;
    }

    const deleteMatch = line.match(/^\*\*\* Delete File:\s*(.+)/);
    if (deleteMatch) {
      const path = normalizeLegacyPath(deleteMatch[1].trim());
      const nextLine = lines[i + 1];
      if (nextLine) {
        const nextAdd = nextLine.match(/^\*\*\* Add File:\s*(.+)/);
        if (nextAdd && normalizeLegacyPath(nextAdd[1].trim()) === path) {
          continue;
        }
      }
      current = {
        id: createDiffFileId("codex", path, "/dev/null", "delete", fileIndex),
        kind: "codex",
        fromPath: path,
        toPath: "/dev/null",
        displayPath: path,
        lines: [],
        additions: 0,
        deletions: 0,
        isNew: false,
        isDeleted: true,
        isReplacement: false
      };
      files.push(current);
      fileIndex += 1;
      lineNum = 0;
      continue;
    }

    const updateMatch = line.match(/^\*\*\* Update File:\s*(.+)/);
    if (updateMatch) {
      const path = normalizeLegacyPath(updateMatch[1].trim());
      current = {
        id: createDiffFileId("codex", path, path, "modify", fileIndex),
        kind: "codex",
        fromPath: path,
        toPath: path,
        displayPath: path,
        lines: [],
        additions: 0,
        deletions: 0,
        isNew: false,
        isDeleted: false,
        isReplacement: false
      };
      files.push(current);
      fileIndex += 1;
      lineNum = 0;
      continue;
    }

    if (!current) {
      continue;
    }

    if (line === "@@") {
      current.lines.push({ type: "hunk", content: "@@", oldNum: null, newNum: null });
      continue;
    }

    if (line.startsWith("+")) {
      lineNum += 1;
      current.lines.push({ type: "add", content: line.slice(1), oldNum: null, newNum: lineNum });
      current.additions += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.lines.push({ type: "del", content: line.slice(1), oldNum: lineNum, newNum: null });
      current.deletions += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      lineNum += 1;
      current.lines.push({ type: "context", content: line.slice(1), oldNum: lineNum, newNum: lineNum });
    }
  }

  return files;
}

function normalizeCodexFiles(files: CodexDiffFile[], fileStats: DiffFileStat[] = []): CodexDiffFile[] {
  const statsByPath = buildDiffStatLookup(fileStats);
  const grouped = new Map<string, CodexDiffFile[]>();

  for (const file of files) {
    const key = file.displayPath;
    grouped.set(key, [...(grouped.get(key) ?? []), file]);
  }

  return [...grouped.entries()].flatMap(([path, entries]) => {
    const stats = statsByPath.get(path);
    const hasDeleted = entries.some((file) => file.isDeleted);
    const hasNonDeleted = entries.some((file) => !file.isDeleted);
    const hasNew = entries.some((file) => file.isNew);
    const hasMeaningfulDelete =
      entries.some((file) => file.isDeleted && file.lines.length > 0)
      || (typeof stats?.deletions === "number" && stats.deletions > 0);
    const isReplacement = hasDeleted && hasNonDeleted && hasMeaningfulDelete;
    const candidates = entries.filter((file) => {
      if (isReplacement) {
        return !file.isDeleted;
      }
      return !file.isDeleted || file.lines.length > 0;
    });
    const representative = (candidates.length > 0 ? candidates : entries)
      .slice()
      .sort((left, right) => scoreCodexFile(right) - scoreCodexFile(left))[0];

    if (!representative) {
      return [];
    }

    const fromPath = stats?.oldPath ? normalizeLegacyPath(stats.oldPath) : representative.fromPath;
    const toPath = stats?.newPath ? normalizeLegacyPath(stats.newPath) : representative.toPath;
    const resolvedIsDeleted = !isReplacement && (toPath === "/dev/null" || (hasDeleted && !hasNonDeleted));
    const resolvedIsNew = !isReplacement && !resolvedIsDeleted && (fromPath === "/dev/null" || hasNew);

    return [{
      ...representative,
      additions: stats?.additions ?? representative.additions,
      deletions: stats?.deletions ?? representative.deletions,
      fromPath,
      toPath,
      isNew: resolvedIsNew,
      isDeleted: resolvedIsDeleted,
      isReplacement,
    }];
  });
}

function buildDiffStatLookup(fileStats: DiffFileStat[]): Map<string, DiffFileStat> {
  const lookup = new Map<string, DiffFileStat>();
  for (const stat of fileStats) {
    const rawCandidates = [stat.path, stat.oldPath, stat.newPath].filter((value): value is string => typeof value === "string");
    for (const rawPath of rawCandidates) {
      for (const alias of getPathAliases(rawPath)) {
        if (!lookup.has(alias)) {
          lookup.set(alias, stat);
        }
      }
    }
  }
  return lookup;
}

function getPathAliases(path: string): string[] {
  const normalized = normalizeLegacyPath(path);
  const aliases = new Set<string>([normalized]);
  const knownPrefixes = ["desktop/", "backend/", "host/", "apps/"];

  for (const prefix of knownPrefixes) {
    if (normalized.startsWith(prefix) && normalized.length > prefix.length) {
      aliases.add(normalized.slice(prefix.length));
    }
  }

  const segments = normalized.split("/");
  if (segments.length > 2) {
    aliases.add(segments.slice(1).join("/"));
  }

  return [...aliases];
}

function sanitizeUnifiedDiffText(raw: string): string | null {
  const kept: string[] = [];
  let inDiff = false;
  let inHunk = false;
  let inBinaryPatch = false;

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      kept.push(line);
      inDiff = true;
      inHunk = false;
      inBinaryPatch = false;
      continue;
    }

    if (!inDiff) {
      continue;
    }

    if (isCapturedDiffNoise(line)) {
      inHunk = false;
      inBinaryPatch = false;
      continue;
    }

    if (inBinaryPatch) {
      kept.push(line);
      continue;
    }

    if (line.startsWith("@@ ")) {
      kept.push(line);
      inHunk = true;
      continue;
    }

    if (inHunk) {
      if (/^[ +\\-]/.test(line) || line === "\\ No newline at end of file") {
        kept.push(line);
        continue;
      }
      inHunk = false;
    }

    if (isUnifiedDiffMetadata(line)) {
      kept.push(line);
      if (line === "GIT binary patch") {
        inBinaryPatch = true;
      }
    }
  }

  return kept.some((line) => line.startsWith("diff --git ")) ? kept.join("\n") : null;
}

function isCapturedDiffNoise(line: string): boolean {
  return (
    line.trim() === ""
    || line.startsWith("Chunk ID: ")
    || line.startsWith("Wall time: ")
    || line.startsWith("Process exited with code ")
    || line.startsWith("Original token count: ")
    || line === "Output:"
    || line.startsWith("warning: ")
  );
}

function isUnifiedDiffMetadata(line: string): boolean {
  return (
    line.startsWith("index ")
    || line.startsWith("old mode ")
    || line.startsWith("new mode ")
    || line.startsWith("deleted file mode ")
    || line.startsWith("new file mode ")
    || line.startsWith("copy from ")
    || line.startsWith("copy to ")
    || line.startsWith("rename from ")
    || line.startsWith("rename to ")
    || line.startsWith("similarity index ")
    || line.startsWith("dissimilarity index ")
    || line.startsWith("--- ")
    || line.startsWith("+++ ")
    || line.startsWith("Binary files ")
    || line === "GIT binary patch"
    || line.startsWith("literal ")
    || line.startsWith("delta ")
  );
}

function parseUnifiedGitDiff(raw: string): UnifiedDiffFile[] {
  try {
    const sanitized = sanitizeUnifiedDiffText(raw);
    if (!sanitized) {
      return [];
    }
    return parseDiff(sanitized, { nearbySequences: "zip" }).map((file, index) => {
      const additions = file.hunks.reduce(
        (sum, hunk) => sum + hunk.changes.filter((change) => isInsert(change)).length,
        0
      );
      const deletions = file.hunks.reduce(
        (sum, hunk) => sum + hunk.changes.filter((change) => isDelete(change)).length,
        0
      );
      return {
        id: createDiffFileId("unified", file.oldPath, file.newPath, file.type, index),
        kind: "unified",
        file,
        displayPath: file.newPath === "/dev/null" ? file.oldPath : file.newPath,
        additions,
        deletions,
      };
    });
  } catch {
    return [];
  }
}

function parseDiffInput(raw: string): ParsedDiff {
  if (raw.includes("*** Begin Patch") || raw.includes("*** Add File:") || raw.includes("*** Update File:")) {
    return { kind: "codex", files: parseCodexPatch(raw) };
  }
  return { kind: "unified", files: parseUnifiedGitDiff(raw) };
}

export function DiffViewer({
  patch,
  fileStats = [],
  mode = "stacked"
}: {
  patch: string;
  fileStats?: DiffFileStat[];
  mode?: "stacked" | "focused";
}) {
  const parsed = useMemo(() => {
    const next = parseDiffInput(patch);
    if (next.kind === "codex") {
      return { kind: "codex" as const, files: normalizeCodexFiles(next.files, fileStats) };
    }
    return next;
  }, [fileStats, patch]);

  if (parsed.files.length === 0) {
    return (
      <div className="text-[12px] text-t3 py-3 px-4">
        No parseable diff content.
      </div>
    );
  }

  const totalAdd = parsed.files.reduce((sum, file) => sum + file.additions, 0);
  const totalDel = parsed.files.reduce((sum, file) => sum + file.deletions, 0);

  if (mode === "focused") {
    return parsed.kind === "unified"
      ? <FocusedUnifiedDiffViewer files={parsed.files} totalAdd={totalAdd} totalDel={totalDel} />
      : <FocusedCodexDiffViewer files={parsed.files} totalAdd={totalAdd} totalDel={totalDel} />;
  }

  return parsed.kind === "unified"
    ? <StackedUnifiedDiffViewer files={parsed.files} totalAdd={totalAdd} totalDel={totalDel} />
    : <StackedCodexDiffViewer files={parsed.files} totalAdd={totalAdd} totalDel={totalDel} />;
}

function FocusedUnifiedDiffViewer({
  files,
  totalAdd,
  totalDel
}: {
  files: UnifiedDiffFile[];
  totalAdd: number;
  totalDel: number;
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
      <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-gz-1 border-b border-brd">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-t2">
            {files.length} file{files.length !== 1 ? "s" : ""} changed
          </p>
          <p className="text-[10px] text-t4 truncate">{activeFile.displayPath}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {totalAdd > 0 && <span className="text-[10px] font-mono text-green">+{totalAdd}</span>}
          {totalDel > 0 && <span className="text-[10px] font-mono text-red">-{totalDel}</span>}
          <DiffBar additions={totalAdd} deletions={totalDel} />
        </div>
      </div>

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
                  <div className="flex items-center gap-2 mb-1">
                    <code className="min-w-0 flex-1 truncate text-[11px] font-mono text-t2" title={formatUnifiedFileLabel(file)}>
                      {formatUnifiedFileLabel(file)}
                    </code>
                    {file.file.type === "add" && (
                      <span className="text-[9px] font-semibold uppercase tracking-wider text-green bg-green-dim px-1.5 py-px rounded">
                        new
                      </span>
                    )}
                    {file.file.type === "delete" && (
                      <span className="text-[9px] font-semibold uppercase tracking-wider text-red bg-red-dim px-1.5 py-px rounded">
                        deleted
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[10px]">
                    {file.additions > 0 && <span className="font-mono text-green">+{file.additions}</span>}
                    {file.deletions > 0 && <span className="font-mono text-red">-{file.deletions}</span>}
                    <DiffBar additions={file.additions} deletions={file.deletions} />
                  </div>
                  {renderUnifiedFileMeta(file)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-brd bg-white">
            <code className="min-w-0 flex-1 truncate text-[11px] font-mono font-medium text-t1" title={formatUnifiedFileLabel(activeFile)}>
              {formatUnifiedFileLabel(activeFile)}
            </code>
            {activeFile.additions > 0 && <span className="text-[10px] font-mono text-green">+{activeFile.additions}</span>}
            {activeFile.deletions > 0 && <span className="text-[10px] font-mono text-red">-{activeFile.deletions}</span>}
          </div>
          <UnifiedDiffSurface file={activeFile.file} maxHeightClass="max-h-[560px]" />
        </div>
      </div>
    </div>
  );
}

function StackedUnifiedDiffViewer({
  files,
  totalAdd,
  totalDel
}: {
  files: UnifiedDiffFile[];
  totalAdd: number;
  totalDel: number;
}) {
  return (
    <div className="flex flex-col gap-3 slidein">
      <div className="flex items-center gap-3 text-[11px]">
        <span className="text-t2 font-medium">{files.length} file{files.length !== 1 ? "s" : ""} changed</span>
        {totalAdd > 0 && <span className="text-green font-mono">+{totalAdd}</span>}
        {totalDel > 0 && <span className="text-red font-mono">-{totalDel}</span>}
        <DiffBar additions={totalAdd} deletions={totalDel} />
      </div>
      {files.map((file, index) => (
        <UnifiedFileDiff key={`${file.displayPath}-${index}`} file={file} defaultOpen={files.length <= 3} index={index} />
      ))}
    </div>
  );
}

function UnifiedFileDiff({ file, defaultOpen, index }: { file: UnifiedDiffFile; defaultOpen: boolean; index: number }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      style={{ animationDelay: `${index * 40}ms` }}
      className="rounded-lg border border-brd overflow-hidden cardenter"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center gap-2.5 px-3 py-2 bg-gz-1 border-0 border-b border-brd text-left cursor-pointer hover:bg-gz-2 transition-colors"
      >
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="currentColor"
          className={cn("shrink-0 text-t4 transition-transform duration-200", open && "rotate-90")}
        >
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
        </svg>

        <code className="text-[12px] font-mono text-t1 font-medium truncate flex-1">{file.displayPath}</code>

        <div className="flex items-center gap-2 shrink-0">
          {file.file.type === "add" && <span className="text-[9px] font-semibold uppercase tracking-wider text-green bg-green-dim px-1.5 py-px rounded">new</span>}
          {file.file.type === "delete" && <span className="text-[9px] font-semibold uppercase tracking-wider text-red bg-red-dim px-1.5 py-px rounded">deleted</span>}
          {file.additions > 0 && <span className="text-[10px] font-mono text-green">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-[10px] font-mono text-red">-{file.deletions}</span>}
          <DiffBar additions={file.additions} deletions={file.deletions} />
        </div>
      </button>

      {open && <UnifiedDiffSurface file={file.file} maxHeightClass="" className="slidedown" />}
    </div>
  );
}

function UnifiedDiffSurface({
  file,
  maxHeightClass,
  className
}: {
  file: FileData;
  maxHeightClass: string;
  className?: string;
}) {
  return (
    <div className={cn("overflow-x-auto bg-white", maxHeightClass, className)}>
      <div className="rdv-host min-w-full text-[11px] font-mono">
        <Diff
          viewType="split"
          diffType={file.type as DiffType}
          hunks={file.hunks}
          className="rdv-host__diff"
        >
          {(hunks) => hunks.map((hunk, index) => <Hunk key={`${hunk.content}-${index}`} hunk={hunk as HunkData} />)}
        </Diff>
      </div>
    </div>
  );
}

function FocusedCodexDiffViewer({
  files,
  totalAdd,
  totalDel
}: {
  files: CodexDiffFile[];
  totalAdd: number;
  totalDel: number;
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
      <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-gz-1 border-b border-brd">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-t2">
            {files.length} file{files.length !== 1 ? "s" : ""} changed
          </p>
          <p className="text-[10px] text-t4 truncate">{activeFile.displayPath}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {totalAdd > 0 && <span className="text-[10px] font-mono text-green">+{totalAdd}</span>}
          {totalDel > 0 && <span className="text-[10px] font-mono text-red">-{totalDel}</span>}
          <DiffBar additions={totalAdd} deletions={totalDel} />
        </div>
      </div>

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
                  <div className="flex items-center gap-2 mb-1">
                    <code className="min-w-0 flex-1 truncate text-[11px] font-mono text-t2" title={formatCodexFileLabel(file)}>
                      {formatCodexFileLabel(file)}
                    </code>
                    {file.isReplacement && (
                      <span className="text-[9px] font-semibold uppercase tracking-wider text-amber-700 bg-amber-100 px-1.5 py-px rounded">
                        replaced
                      </span>
                    )}
                    {!file.isReplacement && file.isNew && (
                      <span className="text-[9px] font-semibold uppercase tracking-wider text-green bg-green-dim px-1.5 py-px rounded">
                        new
                      </span>
                    )}
                    {!file.isReplacement && file.isDeleted && (
                      <span className="text-[9px] font-semibold uppercase tracking-wider text-red bg-red-dim px-1.5 py-px rounded">
                        deleted
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[10px]">
                    {file.additions > 0 && <span className="font-mono text-green">+{file.additions}</span>}
                    {file.deletions > 0 && <span className="font-mono text-red">-{file.deletions}</span>}
                    <DiffBar additions={file.additions} deletions={file.deletions} />
                  </div>
                  {renderCodexFileMeta(file)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-brd bg-white">
            <code className="min-w-0 flex-1 truncate text-[11px] font-mono font-medium text-t1" title={formatCodexFileLabel(activeFile)}>
              {formatCodexFileLabel(activeFile)}
            </code>
            {activeFile.additions > 0 && <span className="text-[10px] font-mono text-green">+{activeFile.additions}</span>}
            {activeFile.deletions > 0 && <span className="text-[10px] font-mono text-red">-{activeFile.deletions}</span>}
          </div>
          <CodexDiffTable file={activeFile} maxHeightClass="max-h-[560px]" />
        </div>
      </div>
    </div>
  );
}

function StackedCodexDiffViewer({
  files,
  totalAdd,
  totalDel
}: {
  files: CodexDiffFile[];
  totalAdd: number;
  totalDel: number;
}) {
  return (
    <div className="flex flex-col gap-3 slidein">
      <div className="flex items-center gap-3 text-[11px]">
        <span className="text-t2 font-medium">{files.length} file{files.length !== 1 ? "s" : ""} changed</span>
        {totalAdd > 0 && <span className="text-green font-mono">+{totalAdd}</span>}
        {totalDel > 0 && <span className="text-red font-mono">-{totalDel}</span>}
        <DiffBar additions={totalAdd} deletions={totalDel} />
      </div>
      {files.map((file, index) => (
        <CodexFileDiff key={`${file.displayPath}-${index}`} file={file} defaultOpen={files.length <= 3} index={index} />
      ))}
    </div>
  );
}

function CodexFileDiff({ file, defaultOpen, index }: { file: CodexDiffFile; defaultOpen: boolean; index: number }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      style={{ animationDelay: `${index * 40}ms` }}
      className="rounded-lg border border-brd overflow-hidden cardenter"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center gap-2.5 px-3 py-2 bg-gz-1 border-0 border-b border-brd text-left cursor-pointer hover:bg-gz-2 transition-colors"
      >
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="currentColor"
          className={cn("shrink-0 text-t4 transition-transform duration-200", open && "rotate-90")}
        >
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
        </svg>

        <code className="text-[12px] font-mono text-t1 font-medium truncate flex-1">{file.displayPath}</code>

        <div className="flex items-center gap-2 shrink-0">
          {file.isReplacement && <span className="text-[9px] font-semibold uppercase tracking-wider text-amber-700 bg-amber-100 px-1.5 py-px rounded">replaced</span>}
          {!file.isReplacement && file.isNew && <span className="text-[9px] font-semibold uppercase tracking-wider text-green bg-green-dim px-1.5 py-px rounded">new</span>}
          {!file.isReplacement && file.isDeleted && <span className="text-[9px] font-semibold uppercase tracking-wider text-red bg-red-dim px-1.5 py-px rounded">deleted</span>}
          {file.additions > 0 && <span className="text-[10px] font-mono text-green">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-[10px] font-mono text-red">-{file.deletions}</span>}
          <DiffBar additions={file.additions} deletions={file.deletions} />
        </div>
      </button>

      {open && (
        <CodexDiffTable file={file} maxHeightClass="" className="slidedown" />
      )}
    </div>
  );
}

function CodexDiffTable({
  file,
  maxHeightClass,
  className
}: {
  file: CodexDiffFile;
  maxHeightClass: string;
  className?: string;
}) {
  if (file.lines.length === 0) {
    return (
      <div className={cn("bg-white", maxHeightClass, className)}>
        <div className="px-4 py-6 text-[12px] text-t3">
          {file.isDeleted
            ? "Deleted file content was not captured in this patch."
            : "No line-level diff content is available for this file."}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("overflow-x-auto", maxHeightClass, className)}>
      <table className="w-full border-collapse text-[11px] leading-[18px] font-mono">
        <tbody>
          {file.lines.map((line, index) => (
            <CodexDiffLineRow key={index} line={line} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodexDiffLineRow({ line }: { line: DiffLine }) {
  if (line.type === "hunk") {
    return (
      <tr className="bg-gz-1">
        <td colSpan={3} className="px-3 py-1 text-t3 select-none">
          {line.content}
        </td>
      </tr>
    );
  }

  return (
    <tr className={cn(
      "group border-0",
      line.type === "add" && "bg-[rgba(22,163,74,0.06)]",
      line.type === "del" && "bg-[rgba(220,38,38,0.05)]",
      line.type === "context" && "bg-white"
    )}>
      <td className="w-[1px] whitespace-nowrap text-right select-none px-2 py-0 text-t4 border-r border-brd align-top">
        {line.oldNum ?? ""}
      </td>
      <td className="w-[1px] whitespace-nowrap text-right select-none px-2 py-0 text-t4 border-r border-brd align-top">
        {line.newNum ?? ""}
      </td>
      <td className="px-3 py-0 whitespace-pre">
        <span className={cn(
          "select-none inline-block w-3 text-center",
          line.type === "add" && "text-green",
          line.type === "del" && "text-red"
        )}>
          {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
        </span>
        <span className={cn(
          line.type === "add" && "text-green/80",
          line.type === "del" && "text-red/80",
          line.type === "context" && "text-t2"
        )}>
          {line.content}
        </span>
      </td>
    </tr>
  );
}

function normalizeLegacyPath(path: string): string {
  const winMatch = path.match(/^[A-Za-z]:[/\\].*?[/\\]([^/\\]+[/\\].+)$/);
  if (winMatch) {
    const parts = path.replace(/\\/g, "/").split("/");
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      if (["src", "tests", "test", "lib", "pkg", "cmd", "internal", "scripts", "host"].includes(parts[index] ?? "")) {
        return parts.slice(index).join("/");
      }
    }
    return parts.slice(-3).join("/");
  }
  return path.replace(/\\/g, "/");
}

function createDiffFileId(
  kind: "codex" | "unified",
  oldPath: string,
  newPath: string,
  changeType: string,
  index: number
): string {
  return `${kind}:${changeType}:${oldPath}->${newPath}:${index}`;
}

function scoreCodexFile(file: CodexDiffFile): number {
  return (
    (file.lines.length > 0 ? 100 : 0)
    + (!file.isDeleted ? 20 : 0)
    + (file.isNew ? 5 : 0)
    + file.lines.length
  );
}

function formatUnifiedFileLabel(file: UnifiedDiffFile): string {
  return file.file.type === "rename"
    ? `${file.file.oldPath} -> ${file.file.newPath}`
    : file.displayPath;
}

function formatCodexFileLabel(file: CodexDiffFile): string {
  if (file.isReplacement && file.fromPath !== file.toPath) {
    return `${file.fromPath} -> ${file.toPath}`;
  }
  if (file.isNew) {
    return file.toPath;
  }
  if (file.isDeleted) {
    return file.fromPath;
  }
  if (file.fromPath !== file.toPath) {
    return `${file.fromPath} -> ${file.toPath}`;
  }
  return file.displayPath;
}

function renderUnifiedFileMeta(file: UnifiedDiffFile) {
  if (file.file.type === "rename") {
    return (
      <p className="mt-1 truncate text-[10px] text-t4" title={`${file.file.oldPath} -> ${file.file.newPath}`}>
        {file.file.oldPath} {"->"} {file.file.newPath}
      </p>
    );
  }
  return null;
}

function renderCodexFileMeta(file: CodexDiffFile) {
  if (file.isReplacement && file.fromPath === file.toPath) {
    return (
      <p className="mt-1 truncate text-[10px] text-t4" title={file.displayPath}>
        Replacement captured as one combined diff entry
      </p>
    );
  }
  if (file.fromPath !== file.toPath && file.fromPath !== "/dev/null" && file.toPath !== "/dev/null") {
    return (
      <p className="mt-1 truncate text-[10px] text-t4" title={`${file.fromPath} -> ${file.toPath}`}>
        {file.fromPath} {"->"} {file.toPath}
      </p>
    );
  }
  return null;
}

function DiffBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) {
    return null;
  }

  const segments = 5;
  const addSegs = Math.round((additions / total) * segments);
  const delSegs = segments - addSegs;

  return (
    <div className="flex gap-px">
      {Array.from({ length: addSegs }, (_, index) => (
        <span key={`a${index}`} className="size-[6px] rounded-[1px] bg-green" />
      ))}
      {Array.from({ length: delSegs }, (_, index) => (
        <span key={`d${index}`} className="size-[6px] rounded-[1px] bg-red" />
      ))}
    </div>
  );
}
