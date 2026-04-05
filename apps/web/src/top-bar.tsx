import { useState } from "react";
import { ChevronDown, LogOut, RefreshCw } from "lucide-react";
import type {
  ThreadRowViewModel,
  WorkspaceSidebarItemViewModel,
} from "./view-models";
import { cn } from "@/lib/utils";

const syncRelativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function formatRelativeTimestamp(timestamp: string | null): string | null {
  if (!timestamp) {
    return null;
  }
  const deltaMinutes = Math.round((Date.parse(timestamp) - Date.now()) / 60_000);
  return syncRelativeTimeFormatter.format(deltaMinutes, "minute");
}

function formatSyncPhaseLabel(phase: "idle" | "pending" | "syncing" | "retrying" | "error" | "unavailable") {
  switch (phase) {
    case "pending":
      return "Pending";
    case "syncing":
      return "Syncing";
    case "retrying":
      return "Retrying";
    case "error":
      return "Error";
    case "unavailable":
      return "Unavailable";
    default:
      return "Idle";
  }
}

function PromptreelMark({ className }: { className?: string }) {
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
  viewerMode,
  daemonStatus,
  account,
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
  viewerMode: "local" | "cloud";
  daemonStatus: {
    connected: boolean;
    label: string;
    detail: string | null;
    syncState: "active" | "idle" | "error" | "disconnected";
    lastSeenLabel: string | null;
    sync: {
      phase: "idle" | "pending" | "syncing" | "retrying" | "error" | "unavailable";
      pendingDirtyWorkspaceCount: number;
      summary: string | null;
      lastSuccessfulSyncAt: string | null;
      lastSuccessfulSyncStats: {
        workspaceCount: number;
        promptCount: number;
        blobCount: number;
      } | null;
      nextScheduledSyncAt: string | null;
      lastErrorMessage: string | null;
    };
  } | null;
  account: {
    label: string;
    sublabel: string | null;
    avatarUrl: string | null;
    canSignOut: boolean;
    onSignOut?: () => void;
  } | null;
}) {
  const [workspaceDropdownOpen, setWorkspaceDropdownOpen] = useState(false);
  const [threadDropdownOpen, setThreadDropdownOpen] = useState(false);
  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId);
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const showGeneratingBadge = Boolean(
    selectedWorkspace?.isGenerating
    && (viewerMode === "local" || daemonStatus?.syncState === "active")
  );

  return (
    <header className="sticky top-0 z-50 h-13 flex items-center justify-between px-5 bg-white/80 backdrop-blur-xl border-b border-brd">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="size-7 shrink-0">
            <PromptreelMark className="size-7" />
          </div>
          <span className="text-sm font-semibold text-t1 tracking-tight">Promptreel</span>
        </div>

        <div className="w-px h-5 bg-brd" />

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

      <div className="flex items-center gap-3">
        <div className="hidden items-center gap-2 md:flex">
          <span className="inline-flex items-center rounded-full border border-brd bg-white px-2.5 py-1 text-[11px] font-medium text-t2">
            {viewerMode === "cloud" ? "Cloud mode" : "Local mode"}
          </span>
          {daemonStatus && (
            <div className="group relative">
              <div
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px]",
                  daemonStatus.syncState === "error"
                    ? "border-red-200 bg-red-dim text-red"
                    : daemonStatus.connected
                    ? "border-green/20 bg-green-dim text-green"
                    : "border-brd bg-white text-t3"
                )}
                title={daemonStatus.detail ?? daemonStatus.label}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    daemonStatus.syncState === "error"
                      ? "bg-red"
                      : daemonStatus.connected
                      ? "bg-green"
                      : "bg-t4"
                  )}
                />
                <span>{daemonStatus.label}</span>
                {daemonStatus.sync.summary && (
                  <span className="text-t4">· {daemonStatus.sync.summary}</span>
                )}
              </div>
              <div className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden min-w-[18rem] rounded-xl border border-brd-strong bg-white p-3 text-[11px] text-t2 shadow-xl shadow-black/8 group-hover:block">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-medium text-t1">Sync status</span>
                    <span className="text-t4">{formatSyncPhaseLabel(daemonStatus.sync.phase)}</span>
                  </div>
                  {daemonStatus.detail && (
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-t4">Daemon</span>
                      <span className="max-w-[12rem] truncate text-right">{daemonStatus.detail}</span>
                    </div>
                  )}
                  {daemonStatus.lastSeenLabel && (
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-t4">Last seen</span>
                      <span>{daemonStatus.lastSeenLabel}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-t4">Pending workspaces</span>
                    <span>{daemonStatus.sync.pendingDirtyWorkspaceCount}</span>
                  </div>
                  {daemonStatus.sync.lastSuccessfulSyncAt && (
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-t4">Last success</span>
                      <span>{formatRelativeTimestamp(daemonStatus.sync.lastSuccessfulSyncAt)}</span>
                    </div>
                  )}
                  {daemonStatus.sync.lastSuccessfulSyncStats && (
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-t4">Last payload</span>
                      <span>
                        {daemonStatus.sync.lastSuccessfulSyncStats.promptCount} prompt{daemonStatus.sync.lastSuccessfulSyncStats.promptCount === 1 ? "" : "s"}
                        {" · "}
                        {daemonStatus.sync.lastSuccessfulSyncStats.blobCount} blob{daemonStatus.sync.lastSuccessfulSyncStats.blobCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  )}
                  {daemonStatus.sync.nextScheduledSyncAt && (
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-t4">
                        {daemonStatus.sync.phase === "retrying" ? "Next retry" : "Next sync"}
                      </span>
                      <span>{formatRelativeTimestamp(daemonStatus.sync.nextScheduledSyncAt)}</span>
                    </div>
                  )}
                  {daemonStatus.sync.lastErrorMessage && (
                    <div className="border-t border-brd pt-2 text-red">
                      {daemonStatus.sync.lastErrorMessage}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
        {showGeneratingBadge && (
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
        {account && (
          <div className="flex items-center gap-2 rounded-full border border-brd bg-white pl-1.5 pr-1.5 py-1">
            <div className="flex items-center gap-2 min-w-0">
              {account.avatarUrl ? (
                <img
                  src={account.avatarUrl}
                  alt=""
                  className="size-6 rounded-full object-cover"
                />
              ) : (
                <span className="inline-flex size-6 items-center justify-center rounded-full bg-gz-2 text-[11px] font-semibold text-t2">
                  {account.label.slice(0, 1).toUpperCase()}
                </span>
              )}
              <div className="hidden min-w-0 md:block">
                <p className="max-w-[160px] truncate text-[12px] font-medium text-t1">{account.label}</p>
                {account.sublabel && (
                  <p className="max-w-[180px] truncate text-[10px] text-t4">{account.sublabel}</p>
                )}
              </div>
            </div>
            {account.canSignOut && account.onSignOut && (
              <button
                type="button"
                onClick={account.onSignOut}
                aria-label="sign out"
                className="inline-flex size-7 items-center justify-center rounded-full border-0 bg-transparent text-t3 transition-colors hover:bg-gz-1 hover:text-t1 pressable"
              >
                <LogOut className="size-3.5" strokeWidth={1.6} />
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
