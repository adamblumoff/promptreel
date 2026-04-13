import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut, RefreshCw, Search, X } from "lucide-react";
import type {
  WorkspaceSidebarItemViewModel,
} from "./view-models";
import type { PromptSearchItem } from "./types";
import { cn } from "@/lib/utils";

const syncRelativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const searchTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const HELD_ARROW_REPEAT_INTERVAL_MS = 90;

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

function formatSearchTimestamp(timestamp: string): string {
  return searchTimestampFormatter.format(new Date(timestamp));
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
  isRescanning,
  onRescan,
  viewerMode,
  daemonStatus,
  account,
  searchQuery,
  onSearchQueryChange,
  searchResults,
  isSearchLoading,
  onSelectSearchResult,
}: {
  workspaces: WorkspaceSidebarItemViewModel[];
  isWorkspacesLoading: boolean;
  selectedWorkspaceId: string;
  onSelectWorkspace: (id: string) => void;
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
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  searchResults: PromptSearchItem[];
  isSearchLoading: boolean;
  onSelectSearchResult: (result: PromptSearchItem) => void;
}) {
  const [workspaceDropdownOpen, setWorkspaceDropdownOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const [searchInteractionMode, setSearchInteractionMode] = useState<"keyboard" | "pointer">("keyboard");
  const searchRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastArrowNavigationAtRef = useRef(0);
  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId);
  const selectedWorkspaceGenerating = Boolean(
    selectedWorkspace?.isGenerating
    && (viewerMode === "local" || daemonStatus?.syncState === "active")
  );
  const showSearchDropdown = searchOpen && (searchQuery.trim().length > 0 || isSearchLoading);
  const searchShortcutHint = typeof navigator !== "undefined" && /(Mac|iPhone|iPad)/i.test(navigator.platform)
    ? "⌘K"
    : "Ctrl K";

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) {
        setSearchOpen(false);
        setActiveSearchIndex(-1);
        setSearchInteractionMode("keyboard");
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        setWorkspaceDropdownOpen(false);
        setSearchInteractionMode("keyboard");
        setActiveSearchIndex(searchResults.length > 0 ? 0 : -1);
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [searchResults.length]);

  useEffect(() => {
    if (!showSearchDropdown || searchResults.length === 0) {
      setActiveSearchIndex(-1);
      return;
    }
    setActiveSearchIndex((current) => {
      if (current >= 0 && current < searchResults.length) {
        return current;
      }
      return 0;
    });
  }, [searchResults.length, showSearchDropdown]);

  useEffect(() => {
    if (!showSearchDropdown || activeSearchIndex < 0 || searchInteractionMode !== "keyboard") {
      return;
    }
    const nextActive = searchRef.current?.querySelector<HTMLElement>(`[data-search-result-index="${activeSearchIndex}"]`);
    nextActive?.scrollIntoView({ block: "nearest" });
  }, [activeSearchIndex, searchInteractionMode, showSearchDropdown]);

  return (
    <header className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-3 border-b border-brd bg-white/80 px-5 py-3 backdrop-blur-xl md:h-13 md:flex-nowrap">
      <div className="flex min-w-0 items-center gap-4">
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
              setSearchOpen(false);
              setWorkspaceDropdownOpen((open) => !open);
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
      </div>

      <div
        ref={searchRef}
        className="order-3 w-full basis-full md:pointer-events-none md:absolute md:left-1/2 md:top-1/2 md:order-2 md:w-[min(28rem,calc(100%-30rem))] md:-translate-x-1/2 md:-translate-y-1/2"
      >
        <div className="relative md:pointer-events-auto">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-t4" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(event) => {
              onSearchQueryChange(event.target.value);
              setSearchOpen(true);
              setWorkspaceDropdownOpen(false);
              setSearchInteractionMode("keyboard");
              setActiveSearchIndex(0);
            }}
            onFocus={() => {
              setSearchOpen(true);
              setWorkspaceDropdownOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && showSearchDropdown && searchResults.length > 0) {
                event.preventDefault();
                const now = performance.now();
                if (event.repeat && now - lastArrowNavigationAtRef.current < HELD_ARROW_REPEAT_INTERVAL_MS) {
                  return;
                }
                lastArrowNavigationAtRef.current = now;
                setSearchOpen(true);
                setSearchInteractionMode("keyboard");
                setActiveSearchIndex((current) => {
                  if (current < 0) {
                    return 0;
                  }
                  return Math.min(current + 1, searchResults.length - 1);
                });
                return;
              }
              if (event.key === "ArrowUp" && showSearchDropdown && searchResults.length > 0) {
                event.preventDefault();
                const now = performance.now();
                if (event.repeat && now - lastArrowNavigationAtRef.current < HELD_ARROW_REPEAT_INTERVAL_MS) {
                  return;
                }
                lastArrowNavigationAtRef.current = now;
                setSearchOpen(true);
                setSearchInteractionMode("keyboard");
                setActiveSearchIndex((current) => {
                  if (current <= 0) {
                    return 0;
                  }
                  return current - 1;
                });
                return;
              }
              if (event.key === "Home" && showSearchDropdown && searchResults.length > 0) {
                event.preventDefault();
                setSearchInteractionMode("keyboard");
                setActiveSearchIndex(0);
                return;
              }
              if (event.key === "End" && showSearchDropdown && searchResults.length > 0) {
                event.preventDefault();
                setSearchInteractionMode("keyboard");
                setActiveSearchIndex(searchResults.length - 1);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setSearchOpen(false);
                setActiveSearchIndex(-1);
                setSearchInteractionMode("keyboard");
                searchInputRef.current?.blur();
                return;
              }
              if (event.key === "Enter" && showSearchDropdown && searchResults.length > 0) {
                event.preventDefault();
                onSelectSearchResult(searchResults[Math.max(activeSearchIndex, 0)]!);
                setSearchOpen(false);
                setActiveSearchIndex(-1);
                setSearchInteractionMode("keyboard");
              }
            }}
            placeholder="Search prompts..."
            aria-label="Search prompts"
            className="h-10 w-full rounded-full border border-brd bg-white pl-10 pr-18 text-[13px] text-t1 outline-none transition-colors placeholder:text-t4 focus:border-brd-strong focus:ring-2 focus:ring-black/5"
            aria-expanded={showSearchDropdown}
            aria-haspopup="listbox"
          />
          {searchQuery.trim().length > 0 && (
            <button
              type="button"
              onClick={() => {
                onSearchQueryChange("");
                setSearchOpen(false);
                setActiveSearchIndex(-1);
                setSearchInteractionMode("keyboard");
                searchInputRef.current?.focus();
              }}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-full border-0 bg-transparent text-t4 transition-colors hover:text-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/5"
            >
              <X className="size-3.5" strokeWidth={2.2} />
            </button>
          )}
          {searchQuery.trim().length === 0 && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 items-center rounded-md border border-brd bg-gz-1 px-2 py-1 text-[10px] font-medium tracking-[0.04em] text-t4 md:inline-flex"
            >
              {searchShortcutHint}
            </span>
          )}

          {showSearchDropdown && (
            <div className="absolute left-0 top-full z-50 mt-2 w-full overflow-hidden rounded-2xl border border-brd-strong bg-white shadow-xl shadow-black/8">
              <div className="flex items-center justify-between gap-3 border-b border-brd px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-t4">
                  {isSearchLoading ? "Searching" : `${searchResults.length} result${searchResults.length === 1 ? "" : "s"}`}
                </p>
                {searchQuery.trim().length > 0 && !isSearchLoading && (
                  <p className="text-[11px] text-t4">Newest first</p>
                )}
              </div>

              {isSearchLoading ? (
                <div className="px-4 py-5 text-[13px] text-t3">Loading prompt index...</div>
              ) : searchResults.length > 0 ? (
                <div className="max-h-96 overflow-y-auto p-1.5" role="listbox" aria-label="Prompt search results">
                  {searchResults.map((result, index) => (
                    <button
                      key={result.promptId}
                      type="button"
                      data-search-result-index={index}
                      onPointerMove={() => {
                        if (searchInteractionMode === "keyboard" || activeSearchIndex !== index) {
                          setSearchInteractionMode("pointer");
                          setActiveSearchIndex(index);
                        }
                      }}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        onSelectSearchResult(result);
                        setSearchOpen(false);
                        setActiveSearchIndex(-1);
                        setSearchInteractionMode("keyboard");
                      }}
                      className={cn(
                        "w-full rounded-xl border px-3 py-3 text-left transition-[background-color,border-color,color,box-shadow] duration-120 ease-out motion-reduce:transition-none",
                        activeSearchIndex === index
                          ? "border-brd-strong bg-gz-1 text-t1 shadow-[inset_0_0_0_1px_rgba(17,24,39,0.08)]"
                          : "border-transparent bg-transparent hover:border-brd hover:bg-black/[0.025] hover:text-t1"
                      )}
                      role="option"
                      aria-selected={activeSearchIndex === index}
                    >
                      <p className="truncate text-[13px] font-medium text-t1">{result.promptSummary}</p>
                      <p className="mt-1 truncate text-[11px] text-t3">
                        {result.workspaceSlug} · {result.threadTitle} · {formatSearchTimestamp(result.startedAt)}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-5 text-[13px] text-t3">No matching prompts.</div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 md:ml-auto">
        <div className="hidden items-center gap-2 md:flex">
          <div className="group relative">
            <div
              className={cn(
                "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium",
                daemonStatus?.syncState === "error"
                  ? "border-red-200 bg-red-dim text-red"
                  : daemonStatus?.connected
                  ? "border-green/20 bg-green-dim text-green"
                  : "border-brd bg-white text-t2"
              )}
              title={daemonStatus?.detail ?? daemonStatus?.label ?? "Viewer status"}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  daemonStatus?.syncState === "error"
                    ? "bg-red"
                    : daemonStatus?.connected
                    ? "bg-green"
                    : "bg-t4"
                )}
              />
              <span>Status</span>
              {selectedWorkspaceGenerating && (
                <span className="text-[10px] text-current/80">Generating</span>
              )}
            </div>
            <div className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden min-w-[18rem] rounded-xl border border-brd-strong bg-white p-3 text-[11px] text-t2 shadow-xl shadow-black/8 group-hover:block">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <span className="font-medium text-t1">Viewer</span>
                  <span className="text-t4">{viewerMode === "cloud" ? "Cloud mode" : "Local mode"}</span>
                </div>
                {daemonStatus && (
                  <>
                    <div className="flex items-center justify-between gap-4">
                      <span className="font-medium text-t1">Sync status</span>
                      <span className="text-t4">{formatSyncPhaseLabel(daemonStatus.sync.phase)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-t4">Daemon</span>
                      <span className="max-w-[12rem] truncate text-right">{daemonStatus.label}</span>
                    </div>
                    {daemonStatus.detail && (
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-t4">Detail</span>
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
                  </>
                )}
                {!daemonStatus && (
                  <div className="text-t4">Waiting for daemon status...</div>
                )}
                {selectedWorkspaceGenerating && (
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-t4">Current workspace</span>
                    <span className="text-green">Generating</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
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
