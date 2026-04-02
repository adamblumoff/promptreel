import { useState } from "react";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════════════════
   Unified diff parser + renderer
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
};

function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split("\n");
  let current: DiffFile | null = null;
  let oldNum = 0;
  let newNum = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New file header
    if (line.startsWith("diff --git") || line.startsWith("--- a/") && lines[i + 1]?.startsWith("+++ b/")) {
      // skip diff --git line, we'll pick up --- / +++ below
      if (line.startsWith("diff --git")) continue;
    }

    if (line.startsWith("--- ")) {
      const next = lines[i + 1];
      if (next?.startsWith("+++ ")) {
        const fromPath = line.slice(4).replace(/^a\//, "");
        const toPath = next.slice(4).replace(/^b\//, "");
        const displayPath = toPath === "/dev/null" ? fromPath : toPath;
        current = { fromPath, toPath, displayPath, lines: [], additions: 0, deletions: 0 };
        files.push(current);
        i++; // skip +++ line
        continue;
      }
    }

    if (!current) continue;

    // Hunk header
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)/);
    if (hunkMatch) {
      oldNum = parseInt(hunkMatch[1], 10);
      newNum = parseInt(hunkMatch[2], 10);
      current.lines.push({
        type: "hunk",
        content: line,
        oldNum: null,
        newNum: null,
      });
      continue;
    }

    // Diff content lines
    if (line.startsWith("+")) {
      current.lines.push({ type: "add", content: line.slice(1), oldNum: null, newNum: newNum++ });
      current.additions++;
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "del", content: line.slice(1), oldNum: oldNum++, newNum: null });
      current.deletions++;
    } else if (line.startsWith(" ")) {
      current.lines.push({ type: "context", content: line.slice(1), oldNum: oldNum++, newNum: newNum++ });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — skip
    } else if (line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity") || line.startsWith("rename") || line.startsWith("old mode") || line.startsWith("new mode")) {
      // Git metadata lines — skip
    }
  }

  return files;
}

/* ═══════════════════════════════════════════════════════════════════════════
   DiffViewer — renders a full unified diff
   ═══════════════════════════════════════════════════════════════════════════ */

export function DiffViewer({ patch }: { patch: string }) {
  const files = parseDiff(patch);

  if (files.length === 0) {
    return (
      <div className="text-[12px] text-t3 py-3 px-4">
        No parseable diff content.
      </div>
    );
  }

  // Summary counts
  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);

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

/* ─── Per-file collapsible diff ─────────────────────────────────────────── */

function FileDiff({ file, defaultOpen, index }: { file: DiffFile; defaultOpen: boolean; index: number }) {
  const [open, setOpen] = useState(defaultOpen);
  const isNew = file.fromPath === "/dev/null";
  const isDeleted = file.toPath === "/dev/null";

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
          {isNew && <span className="text-[9px] font-semibold uppercase tracking-wider text-green bg-green-dim px-1.5 py-px rounded">new</span>}
          {isDeleted && <span className="text-[9px] font-semibold uppercase tracking-wider text-red bg-red-dim px-1.5 py-px rounded">deleted</span>}
          {file.additions > 0 && <span className="text-[10px] font-mono text-green">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-[10px] font-mono text-red">-{file.deletions}</span>}
          <DiffBar additions={file.additions} deletions={file.deletions} />
        </div>
      </button>

      {/* Diff lines */}
      {open && (
        <div className="overflow-x-auto slidedown">
          <table className="w-full border-collapse text-[11px] leading-[18px] font-mono">
            <tbody>
              {file.lines.map((line, j) => (
                <DiffLineRow key={j} line={line} />
              ))}
            </tbody>
          </table>
        </div>
      )}
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
