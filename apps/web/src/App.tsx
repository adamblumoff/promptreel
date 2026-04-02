import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchBlob,
  fetchPromptDetail,
  fetchPrompts,
  fetchThreads,
  fetchWorkspaces,
  rescanSessions,
} from "./api";
import type {
  PromptDetail,
  PromptListItem,
  ThreadSummary,
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
  workspace: "promptline:selected-workspace-id",
  thread: "promptline:selected-thread-id",
  transcriptOrder: "promptline:transcript-order",
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

const WORKSPACE_POLL_MS = 20_000;
const ACTIVE_THREADS_POLL_MS = 5_000;
const IDLE_THREADS_POLL_MS = 12_000;
const ACTIVE_PROMPTS_POLL_MS = 2_000;
const IDLE_PROMPTS_POLL_MS = 10_000;
const ACTIVE_DETAIL_POLL_MS = 3_000;

/* ─── App ───────────────────────────────────────────────────────────────── */

export function App() {
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
  const detailControllers = useRef<Record<string, AbortController | undefined>>({});
  const previousPromptStatusesRef = useRef<Partial<Record<string, PromptListItem["status"]>>>({});

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
    const id = setInterval(() => void go(), WORKSPACE_POLL_MS);
    return () => { live = false; ctrl?.abort(); clearInterval(id); };
  }, [visible]);

  /* ── fetch threads ────────────────────────────────────────────────────── */

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  const cachedThreads = selectedWorkspaceId ? threadsByWs[selectedWorkspaceId] : undefined;

  useEffect(() => {
    if (!selectedWorkspaceId || !visible) return;
    let live = true;
    let ctrl: AbortController | null = null;
    const hasCached = Boolean(cachedThreads);
    const interval = selectedWorkspace?.isGenerating ? ACTIVE_THREADS_POLL_MS : IDLE_THREADS_POLL_MS;

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

    void go();
    const id = setInterval(() => void go(), interval);
    return () => { live = false; ctrl?.abort(); clearInterval(id); };
  }, [cachedThreads, selectedWorkspace?.isGenerating, visible, selectedWorkspaceId]);

  /* ── fetch prompts ────────────────────────────────────────────────────── */

  const threads = selectedWorkspaceId ? (threadsByWs[selectedWorkspaceId] ?? []) : [];
  const selThread = threads.find((t) => t.id === selectedThreadId) ?? null;
  const selThreadKey = selThread?.threadId ?? selThread?.sessionId ?? "";
  const pKey = selectedWorkspaceId && selectedThreadId
    ? cacheKey(selectedWorkspaceId, selectedThreadId)
    : "";
  const cachedPrompts = pKey ? promptsByKey[pKey] : undefined;

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedThreadId || !selThreadKey || !visible) return;
    let live = true;
    let ctrl: AbortController | null = null;
    const ck = cacheKey(selectedWorkspaceId, selectedThreadId);
    const hasCached = Boolean(cachedPrompts);
    const interval = selThread?.openPromptCount ? ACTIVE_PROMPTS_POLL_MS : IDLE_PROMPTS_POLL_MS;

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

    void go();
    const id = setInterval(() => void go(), interval);
    return () => { live = false; ctrl?.abort(); clearInterval(id); };
  }, [cachedPrompts, visible, selThread?.openPromptCount, selectedThreadId, selThreadKey, selectedWorkspaceId]);

  const prompts = pKey ? (promptsByKey[pKey] ?? []) : [];

  useEffect(() => {
    previousPromptStatusesRef.current = {};
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
    if (ep.status !== "in_progress") return;

    const id = setInterval(() => void loadDetail(selectedWorkspaceId, expandedPromptId, true), ACTIVE_DETAIL_POLL_MS);
    return () => clearInterval(id);
  }, [expandedPromptId, visible, detailsById, prompts, selectedWorkspaceId]);

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
