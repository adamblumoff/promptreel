import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════════════════
   Unified diff parser + renderer
   Supports both standard unified diff and Codex patch format
   ═══════════════════════════════════════════════════════════════════════════ */

type DiffLineType = "header" | "hunk" | "add" | "del" | "context";

type DiffLine = {
  type: DiffLineType;
  content: string;
  oldNum: number | null;
  newNum: number | null;
};

type DiffFile = {
  fromPath: string;
  toPath: string;
  displayPath: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
};

/* ─── Codex patch format parser ────────────────────────────────────────── */

function parseCodexPatch(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split("\n");
  let current: DiffFile | null = null;
  let lineNum = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line === "*** Begin Patch" || line === "*** End Patch") {
      current = null;
      continue;
    }

    const addMatch = line.match(/^\*\*\* Add File:\s*(.+)/);
    if (addMatch) {
      const path = normalizePath(addMatch[1].trim());
      current = { fromPath: "/dev/null", toPath: path, displayPath: path, lines: [], additions: 0, deletions: 0, isNew: true, isDeleted: false };
      files.push(current);
      lineNum = 0;
      continue;
    }

    const deleteMatch = line.match(/^\*\*\* Delete File:\s*(.+)/);
    if (deleteMatch) {
      const path = normalizePath(deleteMatch[1].trim());
      // If the next line is an Add File for the same path, this is a replace — skip the delete-only entry
      const nextLine = lines[i + 1];
      if (nextLine) {
        const nextAdd = nextLine.match(/^\*\*\* Add File:\s*(.+)/);
        if (nextAdd && normalizePath(nextAdd[1].trim()) === path) {
          continue; // skip, the Add File will create the entry
        }
      }
      current = { fromPath: path, toPath: "/dev/null", displayPath: path, lines: [], additions: 0, deletions: 0, isNew: false, isDeleted: true };
      files.push(current);
      lineNum = 0;
      continue;
    }

    const updateMatch = line.match(/^\*\*\* Update File:\s*(.+)/);
    if (updateMatch) {
      const path = normalizePath(updateMatch[1].trim());
      current = { fromPath: path, toPath: path, displayPath: path, lines: [], additions: 0, deletions: 0, isNew: false, isDeleted: false };
      files.push(current);
      lineNum = 0;
      continue;
    }

    if (!current) continue;

    // Codex @@ is a section separator (no line numbers)
    if (line === "@@") {
      current.lines.push({ type: "hunk", content: "@@", oldNum: null, newNum: null });
      continue;
    }

    if (line.startsWith("+")) {
      lineNum++;
      current.lines.push({ type: "add", content: line.slice(1), oldNum: null, newNum: lineNum });
      current.additions++;
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "del", content: line.slice(1), oldNum: lineNum, newNum: null });
      current.deletions++;
    } else if (line.startsWith(" ")) {
      lineNum++;
      current.lines.push({ type: "context", content: line.slice(1), oldNum: lineNum, newNum: lineNum });
    }
  }

  // Merge files with the same displayPath (Codex emits Delete+Add pairs for rewrites)
  return mergeFiles(files);
}

function mergeFiles(files: DiffFile[]): DiffFile[] {
  const merged = new Map<string, DiffFile>();
  for (const file of files) {
    const existing = merged.get(file.displayPath);
    if (existing) {
      existing.lines.push(...file.lines);
      existing.additions += file.additions;
      existing.deletions += file.deletions;
      if (file.isNew) existing.isNew = false; // Delete+Add = update
      if (file.isDeleted) existing.isDeleted = false;
    } else {
      merged.set(file.displayPath, { ...file });
    }
  }
  return [...merged.values()];
}

function normalizePath(p: string): string {
  // Strip absolute Windows paths to relative
  const winMatch = p.match(/^[A-Za-z]:[/\\].*?[/\\]([^/\\]+[/\\].+)$/);
  if (winMatch) {
    // Try to find a reasonable relative path — take from the last recognizable root
    const parts = p.replace(/\\/g, "/").split("/");
    // Find common project roots like src/, tests/, etc.
    for (let i = parts.length - 1; i >= 0; i--) {
      if (["src", "tests", "test", "lib", "pkg", "cmd", "internal", "scripts", "host"].includes(parts[i])) {
        return parts.slice(i).join("/");
      }
    }
    // Fallback: last 3 segments
    return parts.slice(-3).join("/");
  }
  return p.replace(/\\/g, "/");
}

/* ─── Standard unified diff parser ─────────────────────────────────────── */

function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split("\n");
  let current: DiffFile | null = null;
  let oldNum = 0;
  let newNum = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git")) continue;

    if (line.startsWith("--- ")) {
      const next = lines[i + 1];
      if (next?.startsWith("+++ ")) {
        const fromPath = line.slice(4).replace(/^a\//, "");
        const toPath = next.slice(4).replace(/^b\//, "");
        const displayPath = toPath === "/dev/null" ? fromPath : toPath;
        current = {
          fromPath, toPath, displayPath, lines: [], additions: 0, deletions: 0,
          isNew: fromPath === "/dev/null", isDeleted: toPath === "/dev/null"
        };
        files.push(current);
        i++;
        continue;
      }
    }

    if (!current) continue;

    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)/);
    if (hunkMatch) {
      oldNum = parseInt(hunkMatch[1], 10);
      newNum = parseInt(hunkMatch[2], 10);
      current.lines.push({ type: "hunk", content: line, oldNum: null, newNum: null });
      continue;
    }

    if (line.startsWith("+")) {
      current.lines.push({ type: "add", content: line.slice(1), oldNum: null, newNum: newNum++ });
      current.additions++;
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "del", content: line.slice(1), oldNum: oldNum++, newNum: null });
      current.deletions++;
    } else if (line.startsWith(" ")) {
      current.lines.push({ type: "context", content: line.slice(1), oldNum: oldNum++, newNum: newNum++ });
    } else if (line.startsWith("\\") || line.startsWith("index ") || line.startsWith("new file") ||
               line.startsWith("deleted file") || line.startsWith("similarity") || line.startsWith("rename") ||
               line.startsWith("old mode") || line.startsWith("new mode")) {
      // skip metadata
    }
  }

  return files;
}

/* ─── Auto-detect and parse ────────────────────────────────────────────── */

function parseDiff(raw: string): DiffFile[] {
  if (raw.includes("*** Begin Patch") || raw.includes("*** Add File:") || raw.includes("*** Update File:")) {
    return parseCodexPatch(raw);
  }
  return parseUnifiedDiff(raw);
}

/* ═══════════════════════════════════════════════════════════════════════════
   DiffViewer — renders a full diff
   ═══════════════════════════════════════════════════════════════════════════ */

export function DiffViewer({
  patch,
  mode = "stacked"
}: {
  patch: string;
  mode?: "stacked" | "focused";
}) {
  const files = parseDiff(patch);

  if (files.length === 0) {
    return (
      <div className="text-[12px] text-t3 py-3 px-4">
        No parseable diff content.
      </div>
    );
  }

  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);

  if (mode === "focused") {
    return <FocusedDiffViewer files={files} totalAdd={totalAdd} totalDel={totalDel} />;
  }

  return (
    <div className="flex flex-col gap-3 slidein">
      {/* Summary bar */}
      <div className="flex items-center gap-3 text-[11px]">
        <span className="text-t2 font-medium">{files.length} file{files.length !== 1 ? "s" : ""} changed</span>
        {totalAdd > 0 && <span className="text-green font-mono">+{totalAdd}</span>}
        {totalDel > 0 && <span className="text-red font-mono">-{totalDel}</span>}
        <DiffBar additions={totalAdd} deletions={totalDel} />
      </div>

      {/* File diffs */}
      {files.map((file, i) => (
        <FileDiff key={`${file.displayPath}-${i}`} file={file} defaultOpen={files.length <= 3} index={i} />
      ))}
    </div>
  );
}

function FocusedDiffViewer({
  files,
  totalAdd,
  totalDel
}: {
  files: DiffFile[];
  totalAdd: number;
  totalDel: number;
}) {
  const [activePath, setActivePath] = useState(files[0]?.displayPath ?? "");

  useEffect(() => {
    if (!files.some((file) => file.displayPath === activePath)) {
      setActivePath(files[0]?.displayPath ?? "");
    }
  }, [activePath, files]);

  const activeFile = files.find((file) => file.displayPath === activePath) ?? files[0];
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
              const isActive = file.displayPath === activeFile.displayPath;
              return (
                <button
                  key={file.displayPath}
                  type="button"
                  onClick={() => setActivePath(file.displayPath)}
                  className={cn(
                    "w-full rounded-lg border px-2.5 py-2 text-left transition-colors",
                    isActive
                      ? "border-brd-strong bg-gz-1"
                      : "border-transparent bg-transparent hover:bg-gz-1"
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <code className="min-w-0 flex-1 truncate text-[11px] font-mono text-t2">
                      {file.displayPath}
                    </code>
                    {file.isNew && (
                      <span className="text-[9px] font-semibold uppercase tracking-wider text-green bg-green-dim px-1.5 py-px rounded">
                        new
                      </span>
                    )}
                    {file.isDeleted && (
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
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-brd bg-white">
            <code className="min-w-0 flex-1 truncate text-[11px] font-mono font-medium text-t1">
              {activeFile.displayPath}
            </code>
            {activeFile.additions > 0 && <span className="text-[10px] font-mono text-green">+{activeFile.additions}</span>}
            {activeFile.deletions > 0 && <span className="text-[10px] font-mono text-red">-{activeFile.deletions}</span>}
          </div>
          <DiffTable file={activeFile} maxHeightClass="max-h-[560px]" />
        </div>
      </div>
    </div>
  );
}

/* ─── Per-file collapsible diff ─────────────────────────────────────────── */

function FileDiff({ file, defaultOpen, index }: { file: DiffFile; defaultOpen: boolean; index: number }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      style={{ animationDelay: `${index * 40}ms` }}
      className="rounded-lg border border-brd overflow-hidden cardenter"
    >
      {/* File header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
          {file.isNew && <span className="text-[9px] font-semibold uppercase tracking-wider text-green bg-green-dim px-1.5 py-px rounded">new</span>}
          {file.isDeleted && <span className="text-[9px] font-semibold uppercase tracking-wider text-red bg-red-dim px-1.5 py-px rounded">deleted</span>}
          {file.additions > 0 && <span className="text-[10px] font-mono text-green">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-[10px] font-mono text-red">-{file.deletions}</span>}
          <DiffBar additions={file.additions} deletions={file.deletions} />
        </div>
      </button>

      {/* Diff lines */}
      {open && (
        <DiffTable file={file} maxHeightClass="" className="slidedown" />
      )}
    </div>
  );
}

function DiffTable({
  file,
  maxHeightClass,
  className
}: {
  file: DiffFile;
  maxHeightClass: string;
  className?: string;
}) {
  return (
    <div className={cn("overflow-x-auto", maxHeightClass, className)}>
      <table className="w-full border-collapse text-[11px] leading-[18px] font-mono">
        <tbody>
          {file.lines.map((line, index) => (
            <DiffLineRow key={index} line={line} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Single diff line ──────────────────────────────────────────────────── */

function DiffLineRow({ line }: { line: DiffLine }) {
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
      {/* Line numbers */}
      <td className="w-[1px] whitespace-nowrap text-right select-none px-2 py-0 text-t4 border-r border-brd align-top">
        {line.oldNum ?? ""}
      </td>
      <td className="w-[1px] whitespace-nowrap text-right select-none px-2 py-0 text-t4 border-r border-brd align-top">
        {line.newNum ?? ""}
      </td>

      {/* Content */}
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

/* ─── Mini diff bar (5-segment addition/deletion visualization) ─────────── */

function DiffBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) return null;

  const segments = 5;
  const addSegs = Math.round((additions / total) * segments);
  const delSegs = segments - addSegs;

  return (
    <div className="flex gap-px">
      {Array.from({ length: addSegs }, (_, i) => (
        <span key={`a${i}`} className="size-[6px] rounded-[1px] bg-green" />
      ))}
      {Array.from({ length: delSegs }, (_, i) => (
        <span key={`d${i}`} className="size-[6px] rounded-[1px] bg-red" />
      ))}
    </div>
  );
}
