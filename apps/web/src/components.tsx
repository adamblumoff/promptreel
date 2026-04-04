import type { ThreadRowViewModel, WorkspaceSidebarItemViewModel, WorkspaceStatusViewModel } from "./view-models";
import type { Workspace } from "./types";
import { cn } from "@/lib/utils";
export { PromptFeed } from "./prompt-feed";
export { TopBar } from "./top-bar";

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
