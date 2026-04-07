import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchBlob,
  fetchViewerStatus,
  fetchPromptDetail,
  fetchPrompts,
  fetchThreads,
  fetchWorkspaces,
  rescanSessions,
  type LocalViewerEvent,
  subscribeToViewerEvents,
} from "./api";
import { CliLoginPage } from "./auth";
import type {
  PromptDetail,
  PromptListItem,
  ThreadSummary,
  ViewerStatus,
  Workspace,
} from "./types";
import {
  PromptFeed,
  TopBar,
} from "./components";
import {
  buildWorkspaceSidebarItems,
  resolveSelectedThreadId,
  resolveSelectedWorkspaceId,
  sortWorkspacesByActivity,
  toPromptDetailViewModel,
  toPromptRowViewModel,
  toThreadRowViewModel,
  type PromptDetailViewModel,
} from "./view-models";
import {
  getPromptIdsNeedingDetailRefresh,
  mapPromptStatuses,
} from "./prompt-detail-state";

/* ─── Storage helpers ───────────────────────────────────────────────────── */

const KEYS = {
  workspace: "promptreel:selected-workspace-id",
  thread: "promptreel:selected-thread-id",
  transcriptOrder: "promptreel:transcript-order",
} as const;

function stored(key: string): string {
  return (typeof window !== "undefined" && window.localStorage.getItem(key)) || "";
}

function persist(key: string, value: string) {
  if (typeof window !== "undefined") window.localStorage.setItem(key, value);
}

function cacheKey(workspaceId: string, threadId: string) {
  return `${workspaceId}::${threadId}`;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

async function warmDiffViewer() {
  await import("./diff-viewer");
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function formatLastSeenLabel(timestamp: string | null): string | null {
  if (!timestamp) {
    return null;
  }
  const deltaMinutes = Math.round((Date.parse(timestamp) - Date.now()) / 60_000);
  return `seen ${relativeTimeFormatter.format(deltaMinutes, "minute")}`;
}

function toThreadRevision(thread: ThreadSummary | null): string {
  if (!thread) {
    return "";
  }
  return [
    thread.lastActivityAt,
    thread.promptCount,
    thread.openPromptCount,
    thread.status,
    thread.lastPromptSummary,
  ].join("|");
}

/* ─── App ───────────────────────────────────────────────────────────────── */

type AppProps = {
  viewerMode?: "local" | "cloud";
  account?: {
    label: string;
    sublabel: string | null;
    avatarUrl: string | null;
    canSignOut: boolean;
    onSignOut?: () => void;
  } | null;
};

export function App({ viewerMode = "local", account = null }: AppProps) {
  const isCliLoginRoute = typeof window !== "undefined" && window.location.pathname.startsWith("/cli-login");
  if (isCliLoginRoute) {
    return <CliLoginPage />;
  }

  /* state */
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(() => stored(KEYS.workspace));
  const [threadsByWs, setThreadsByWs] = useState<Record<string, ThreadSummary[]>>({});
  const [selectedThreadId, setSelectedThreadId] = useState(() => stored(KEYS.thread));
  const [promptsByKey, setPromptsByKey] = useState<Record<string, PromptListItem[]>>({});
  const [expandedPromptId, setExpandedPromptId] = useState<string | null>(null);
  const [detailsById, setDetailsById] = useState<Record<string, PromptDetail>>({});
  const [detailLoadingById, setDetailLoadingById] = useState<Record<string, boolean>>({});
  const [detailErrorById, setDetailErrorById] = useState<Record<string, string | null>>({});
  const [isRescanning, setIsRescanning] = useState(false);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [promptOrder, setPromptOrder] = useState<"desc" | "asc">("desc");
  const [transcriptOrder, setTranscriptOrder] = useState<"desc" | "asc">(
    () => (stored(KEYS.transcriptOrder) as "desc" | "asc") || "asc"
  );
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden
  );

  const [blobCache, setBlobCache] = useState<Record<string, string>>({});
  const [blobLoadingById, setBlobLoadingById] = useState<Record<string, boolean>>({});
  const [viewerStatus, setViewerStatus] = useState<ViewerStatus | null>(null);
  const [viewerRefreshTick, setViewerRefreshTick] = useState(0);
  const [viewerRefreshEvent, setViewerRefreshEvent] = useState<LocalViewerEvent | null>(null);
  const detailControllers = useRef<Record<string, AbortController | undefined>>({});
  const previousPromptStatusesRef = useRef<Partial<Record<string, PromptListItem["status"]>>>({});
  const promptRevisionsRef = useRef<Record<string, string>>({});
  const localThreadRefreshRef = useRef<Record<string, number>>({});
  const localPromptRefreshRef = useRef<Record<string, number>>({});
  const localDetailRefreshRef = useRef<Record<string, number>>({});
  const hostedPromptRefreshRef = useRef<Record<string, number>>({});
  const hostedDetailRefreshRef = useRef<Record<string, number>>({});
  const isHostedViewer = viewerMode === "cloud";
  const hostedRefreshTick = isHostedViewer ? viewerRefreshTick : 0;

  /* visibility */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const h = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  }, []);

  /* persist selections */
  useEffect(() => persist(KEYS.workspace, selectedWorkspaceId), [selectedWorkspaceId]);
  useEffect(() => persist(KEYS.thread, selectedThreadId), [selectedThreadId]);
  useEffect(() => persist(KEYS.transcriptOrder, transcriptOrder), [transcriptOrder]);

  useEffect(() => {
    return subscribeToViewerEvents((event) => {
      startTransition(() => {
        setViewerRefreshEvent(event);
        setViewerRefreshTick((current) => current + 1);
      });
    });
  }, [isHostedViewer]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    let live = true;
    let ctrl: AbortController | null = null;
    const go = async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const nextStatus = await fetchViewerStatus({ signal: ctrl.signal });
        if (!live) {
          return;
        }
        setViewerStatus(nextStatus);
      } catch (error) {
        if (!live || isAbort(error)) {
          return;
        }
      }
    };

    void go();
    return () => {
      live = false;
      ctrl?.abort();
    };
  }, [isHostedViewer, viewerRefreshTick, visible]);

  /* ── fetch workspaces ─────────────────────────────────────────────────── */

  useEffect(() => {
    if (!visible) return;
    let live = true;
    let ctrl: AbortController | null = null;

    const go = async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      setWorkspacesLoading(true);
      try {
        const data = sortWorkspacesByActivity(await fetchWorkspaces({ signal: ctrl.signal }));
        if (!live) return;
        startTransition(() => {
          setWorkspaces(data);
          setSelectedWorkspaceId((c) => resolveSelectedWorkspaceId(data, c));
        });
      } catch (e) { if (!live || isAbort(e)) return; }
      finally {
        if (live) setWorkspacesLoading(false);
      }
    };

    void go();
    return () => { live = false; ctrl?.abort(); };
  }, [hostedRefreshTick, isHostedViewer, viewerRefreshTick, visible]);

  /* ── fetch threads ────────────────────────────────────────────────────── */

  const cachedThreads = selectedWorkspaceId ? threadsByWs[selectedWorkspaceId] : undefined;
  const localEventTouchesSelectedWorkspace = Boolean(
    !isHostedViewer
    && selectedWorkspaceId
    && viewerRefreshEvent?.kind === "ingest"
    && viewerRefreshEvent.workspaceIds?.includes(selectedWorkspaceId)
  );

  useEffect(() => {
    if (!selectedWorkspaceId || !visible) return;
    let live = true;
    let ctrl: AbortController | null = null;
    const hasCached = Boolean(cachedThreads);

    const go = async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      if (!hasCached) setThreadsLoading(true);
      try {
        const d = await fetchThreads(selectedWorkspaceId, { signal: ctrl.signal });
        if (!live) return;
        startTransition(() => {
          setThreadsByWs((c) => ({ ...c, [selectedWorkspaceId]: d }));
          setSelectedThreadId((c) => resolveSelectedThreadId(d, c));
        });
      } catch (e) { if (!live || isAbort(e)) return; }
      finally { if (live) setThreadsLoading(false); }
    };

    if (isHostedViewer) {
      void go();
      return () => { live = false; ctrl?.abort(); };
    }

    const previousTick = localThreadRefreshRef.current[selectedWorkspaceId] ?? -1;
    const shouldRefresh = !hasCached || (previousTick !== viewerRefreshTick && localEventTouchesSelectedWorkspace);
    if (shouldRefresh) {
      localThreadRefreshRef.current[selectedWorkspaceId] = viewerRefreshTick;
      void go();
    }
    return () => { live = false; ctrl?.abort(); };
  }, [hostedRefreshTick, isHostedViewer, localEventTouchesSelectedWorkspace, viewerRefreshTick, visible, selectedWorkspaceId]);

  /* ── fetch prompts ────────────────────────────────────────────────────── */

  const threads = selectedWorkspaceId ? (threadsByWs[selectedWorkspaceId] ?? []) : [];
  const selThread = threads.find((t) => t.id === selectedThreadId) ?? null;
  const selThreadKey = selThread?.threadId ?? selThread?.sessionId ?? "";
  const selThreadRevision = toThreadRevision(selThread);
  const localEventTouchesSelectedThread = Boolean(
    !isHostedViewer
    && selThreadKey
    && viewerRefreshEvent?.kind === "ingest"
    && (
      viewerRefreshEvent.threadKeys?.includes(selThreadKey)
      || viewerRefreshEvent.workspaceIds?.includes(selectedWorkspaceId)
    )
  );
  const pKey = selectedWorkspaceId && selectedThreadId
    ? cacheKey(selectedWorkspaceId, selectedThreadId)
    : "";
  const cachedPrompts = pKey ? promptsByKey[pKey] : undefined;

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedThreadId || !selThreadKey || !visible) return;
    let live = true;
    let ctrl: AbortController | null = null;
    const ck = cacheKey(selectedWorkspaceId, selectedThreadId);
    const hasCached = Boolean(cachedPrompts?.length);

    const go = async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      if (!hasCached) setPromptsLoading(true);
      try {
        const d = await fetchPrompts(selectedWorkspaceId, selThreadKey, { signal: ctrl.signal });
        if (!live) return;
        startTransition(() => {
          setPromptsByKey((c) => ({ ...c, [ck]: d }));
          setExpandedPromptId((c) => {
            if (!c) return c;
            return d.some((p) => p.id === c) ? c : null;
          });
        });
      } catch (e) { if (!live || isAbort(e)) return; }
      finally { if (live) setPromptsLoading(false); }
    };

    const previousRevision = promptRevisionsRef.current[ck];
    const previousLocalTick = localPromptRefreshRef.current[ck] ?? -1;
    const previousHostedRefreshTick = hostedPromptRefreshRef.current[ck] ?? -1;
    const shouldRefresh = !hasCached
      || previousRevision !== selThreadRevision
      || (isHostedViewer
        ? previousHostedRefreshTick !== hostedRefreshTick
        : previousLocalTick !== viewerRefreshTick && localEventTouchesSelectedThread);
    if (shouldRefresh) {
      promptRevisionsRef.current[ck] = selThreadRevision;
      if (isHostedViewer) {
        hostedPromptRefreshRef.current[ck] = hostedRefreshTick;
      } else {
        localPromptRefreshRef.current[ck] = viewerRefreshTick;
      }
      void go();
    }
    return () => {
      live = false;
      ctrl?.abort();
    };
  }, [cachedPrompts, hostedRefreshTick, isHostedViewer, localEventTouchesSelectedThread, viewerRefreshTick, visible, selThreadRevision, selectedThreadId, selThreadKey, selectedWorkspaceId]);

  const prompts = pKey ? (promptsByKey[pKey] ?? []) : [];

  useEffect(() => {
    previousPromptStatusesRef.current = {};
    if (!pKey) {
      promptRevisionsRef.current = {};
      localPromptRefreshRef.current = {};
      hostedPromptRefreshRef.current = {};
    }
  }, [pKey]);

  /* ── load prompt detail ───────────────────────────────────────────────── */

  async function loadDetail(wsId: string, pid: string, force = false) {
    if (!force && detailsById[pid]) return;
    detailControllers.current[pid]?.abort();
    const ctrl = new AbortController();
    detailControllers.current[pid] = ctrl;

    setDetailLoadingById((c) => ({ ...c, [pid]: true }));
    setDetailErrorById((c) => ({ ...c, [pid]: null }));

    try {
      const d = await fetchPromptDetail(wsId, pid, { signal: ctrl.signal });
      setDetailsById((c) => ({ ...c, [pid]: d }));
    } catch (e) {
      if (!isAbort(e)) setDetailErrorById((c) => ({ ...c, [pid]: "Prompt detail is unavailable right now." }));
    } finally {
      setDetailLoadingById((c) => ({ ...c, [pid]: false }));
      if (detailControllers.current[pid] === ctrl) delete detailControllers.current[pid];
    }
  }

  async function loadBlob(wsId: string, blobId: string) {
    if (blobCache[blobId] || blobLoadingById[blobId]) return;
    setBlobLoadingById((c) => ({ ...c, [blobId]: true }));
    try {
      const content = await fetchBlob(wsId, blobId);
      setBlobCache((c) => ({ ...c, [blobId]: content }));
    } catch (e) {
      console.warn(`[loadBlob] Failed to fetch blob ${blobId}:`, e);
    } finally {
      setBlobLoadingById((c) => ({ ...c, [blobId]: false }));
    }
  }

  useEffect(() => {
    if (!selectedWorkspaceId || !expandedPromptId || !visible) return;
    const ep = prompts.find((p) => p.id === expandedPromptId);
    if (!ep) { setExpandedPromptId(null); return; }
    if (!detailsById[expandedPromptId]) void loadDetail(selectedWorkspaceId, expandedPromptId);
    if (isHostedViewer) {
      const previousHostedRefreshTick = hostedDetailRefreshRef.current[expandedPromptId] ?? -1;
      if (detailsById[expandedPromptId] && previousHostedRefreshTick !== hostedRefreshTick) {
        hostedDetailRefreshRef.current[expandedPromptId] = hostedRefreshTick;
        void loadDetail(selectedWorkspaceId, expandedPromptId, true);
      }
      return;
    }
    const previousTick = localDetailRefreshRef.current[expandedPromptId] ?? -1;
    if (previousTick !== viewerRefreshTick && detailsById[expandedPromptId] && localEventTouchesSelectedThread) {
      localDetailRefreshRef.current[expandedPromptId] = viewerRefreshTick;
      void loadDetail(selectedWorkspaceId, expandedPromptId, true);
    }
  }, [detailsById, expandedPromptId, hostedRefreshTick, isHostedViewer, localEventTouchesSelectedThread, viewerRefreshTick, prompts, selectedWorkspaceId, visible]);

  useEffect(() => {
    if (!selectedWorkspaceId || !expandedPromptId) return;

    const detail = detailsById[expandedPromptId];
    if (!detail) return;

    const diffBlobIds = detail.artifacts
      .filter((artifact) => artifact.type === "code_diff" && artifact.blobId)
      .map((artifact) => artifact.blobId!);

    if (diffBlobIds.length === 0) return;

    void warmDiffViewer();
    for (const blobId of diffBlobIds) {
      void loadBlob(selectedWorkspaceId, blobId);
    }
  }, [blobLoadingById, blobCache, detailsById, expandedPromptId, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId || prompts.length === 0) {
      previousPromptStatusesRef.current = {};
      return;
    }

    const promptIdsThatNeedRefresh = getPromptIdsNeedingDetailRefresh(
      prompts,
      previousPromptStatusesRef.current,
      detailsById
    );

    previousPromptStatusesRef.current = mapPromptStatuses(prompts);

    for (const promptId of promptIdsThatNeedRefresh) {
      void loadDetail(selectedWorkspaceId, promptId, true);
    }
  }, [detailsById, prompts, selectedWorkspaceId]);

  useEffect(() => {
    return () => { for (const c of Object.values(detailControllers.current)) c?.abort(); };
  }, []);

  /* ── derived view models ──────────────────────────────────────────────── */

  const wsSidebarItems = buildWorkspaceSidebarItems(workspaces, selectedWorkspaceId);
  const threadRows = useMemo(
    () =>
      [...threads]
        .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))
        .map(toThreadRowViewModel),
    [threads]
  );
  const selThreadRow = threadRows.find((t) => t.id === selectedThreadId) ?? null;

  const promptRows = useMemo(
    () =>
      [...prompts.map(toPromptRowViewModel)]
        .sort((left, right) =>
          promptOrder === "desc"
            ? right.startedAt.localeCompare(left.startedAt)
            : left.startedAt.localeCompare(right.startedAt)
        ),
    [promptOrder, prompts]
  );

  const promptDetails = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(detailsById).map(([id, p]) => [id, toPromptDetailViewModel(p)])
      ) as Record<string, PromptDetailViewModel>,
    [detailsById]
  );

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (promptRows.length === 0) {
      if (expandedPromptId) {
        setExpandedPromptId(null);
      }
      return;
    }
    if (expandedPromptId && promptRows.some((row) => row.id === expandedPromptId)) {
      return;
    }
    const nextPromptId = promptRows[0]!.id;
    setExpandedPromptId(nextPromptId);
    if (!detailsById[nextPromptId]) {
      void loadDetail(selectedWorkspaceId, nextPromptId);
    }
  }, [selectedWorkspaceId, promptRows, expandedPromptId, detailsById]);

  /* ── handlers ─────────────────────────────────────────────────────────── */

  const handleSelectWorkspace = (id: string) => {
    const next = threadsByWs[id] ?? [];
      startTransition(() => {
        setSelectedWorkspaceId(id);
        setSelectedThreadId(resolveSelectedThreadId(next, ""));
        setExpandedPromptId(null);
      });
  };

  const handleSelectThread = (id: string) => {
    startTransition(() => {
      setSelectedThreadId(id);
      setExpandedPromptId(null);
    });
  };

  const handleTogglePrompt = (id: string) => {
    if (!selectedWorkspaceId) return;
    if (expandedPromptId === id) { setExpandedPromptId(null); return; }
    setExpandedPromptId(id);
    void loadDetail(selectedWorkspaceId, id);
  };

  const handleRescan = async () => {
    setIsRescanning(true);
    try {
      const ctrl = new AbortController();
      await rescanSessions({ signal: ctrl.signal });
      const ws = sortWorkspacesByActivity(await fetchWorkspaces({ signal: ctrl.signal }));
      startTransition(() => {
        setWorkspaces(ws);
        setSelectedWorkspaceId((c) => resolveSelectedWorkspaceId(ws, c));
      });
    } finally {
      setIsRescanning(false);
    }
  };

  const handleTogglePromptOrder = () => {
    startTransition(() => {
      setPromptOrder((current) => (current === "desc" ? "asc" : "desc"));
    });
  };

  const handleToggleTranscriptOrder = () => {
    startTransition(() => {
      setTranscriptOrder((current) => (current === "desc" ? "asc" : "desc"));
    });
  };

  const handleLoadBlob = (blobId: string) => {
    if (!selectedWorkspaceId) {
      return;
    }

    void loadBlob(selectedWorkspaceId, blobId);
  };

  /* ── render ───────────────────────────────────────────────────────────── */

  return (
    <div className="min-h-dvh bg-white">
      <TopBar
        workspaces={wsSidebarItems}
        isWorkspacesLoading={workspacesLoading}
        selectedWorkspaceId={selectedWorkspaceId}
        onSelectWorkspace={handleSelectWorkspace}
        threads={threadRows}
        selectedThreadId={selectedThreadId}
        onSelectThread={handleSelectThread}
        isThreadsLoading={threadsLoading}
        isRescanning={isRescanning}
        onRescan={() => void handleRescan()}
        viewerMode={viewerMode}
        daemonStatus={viewerStatus ? {
          connected: viewerStatus.daemon.connected,
          label: viewerStatus.daemon.label,
          detail: viewerStatus.daemon.detail,
          syncState: viewerStatus.daemon.syncState,
          lastSeenLabel: formatLastSeenLabel(viewerStatus.daemon.lastSeenAt),
          sync: viewerStatus.daemon.sync,
        } : null}
        account={account}
      />

      <main className="w-full px-5 py-6">
        <PromptFeed
          rows={promptRows}
          details={promptDetails}
          loadingById={detailLoadingById}
          errorById={detailErrorById}
          expandedId={expandedPromptId}
          onToggle={handleTogglePrompt}
          promptOrder={promptOrder}
          onTogglePromptOrder={handleTogglePromptOrder}
          transcriptOrder={transcriptOrder}
          onToggleTranscriptOrder={handleToggleTranscriptOrder}
          isLoading={promptsLoading}
          isInitializing={workspacesLoading || threadsLoading || promptsLoading}
          onLoadBlob={handleLoadBlob}
          blobCache={blobCache}
          blobLoadingById={blobLoadingById}
        />
      </main>
    </div>
  );
}
