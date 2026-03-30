import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchHealth,
  fetchPromptDetail,
  fetchPrompts,
  fetchThreads,
  fetchWorkspaces,
  rescanSessions
} from "./api";
import type {
  Health,
  PromptDetail,
  PromptListItem,
  ThreadSummary,
  Workspace
} from "./types";
import {
  AppShell,
  MainColumn,
  WorkspaceSidebar
} from "./components";
import type { ContentTab } from "./components";
import {
  buildWorkspaceSidebarItems,
  getSelectedWorkspace,
  getSelectedWorkspaceStatus,
  resolveSelectedThreadId,
  resolveSelectedWorkspaceId,
  sortWorkspacesByActivity,
  toPromptDetailViewModel,
  toPromptRowViewModel,
  toThreadRowViewModel,
  type PromptDetailViewModel
} from "./view-models";

const SELECTED_WORKSPACE_STORAGE_KEY = "promptline:selected-workspace-id";
const SELECTED_THREAD_STORAGE_KEY = "promptline:selected-thread-id";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "promptline:sidebar-collapsed";

function readStoredValue(key: string): string {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(key) ?? "";
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = window.localStorage.getItem(key);
  return value === null ? fallback : value === "true";
}

function createThreadCacheKey(workspaceId: string, threadId: string): string {
  return `${workspaceId}::${threadId}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(() =>
    readStoredValue(SELECTED_WORKSPACE_STORAGE_KEY)
  );
  const [threadsByWorkspaceId, setThreadsByWorkspaceId] = useState<Record<string, ThreadSummary[]>>({});
  const [selectedThreadId, setSelectedThreadId] = useState(() =>
    readStoredValue(SELECTED_THREAD_STORAGE_KEY)
  );
  const [promptsByThreadKey, setPromptsByThreadKey] = useState<Record<string, PromptListItem[]>>({});
  const [health, setHealth] = useState<Health | null>(null);
  const [filter, setFilter] = useState<"all" | "open" | "imported">("all");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readStoredBoolean(SIDEBAR_COLLAPSED_STORAGE_KEY, false)
  );
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  const [expandedPromptId, setExpandedPromptId] = useState<string | null>(null);
  const [promptDetailsById, setPromptDetailsById] = useState<Record<string, PromptDetail>>({});
  const [detailLoadingById, setDetailLoadingById] = useState<Record<string, boolean>>({});
  const [detailErrorById, setDetailErrorById] = useState<Record<string, string | null>>({});
  const [isRescanning, setIsRescanning] = useState(false);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<ContentTab>("threads");
  const [isDocumentVisible, setIsDocumentVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden
  );

  const detailControllersRef = useRef<Record<string, AbortController | undefined>>({});

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const handleVisibilityChange = () => {
      setIsDocumentVisible(!document.hidden);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SELECTED_WORKSPACE_STORAGE_KEY, selectedWorkspaceId);
    }
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SELECTED_THREAD_STORAGE_KEY, selectedThreadId);
    }
  }, [selectedThreadId]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(sidebarCollapsed));
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!isDocumentVisible) {
      return;
    }

    let active = true;
    let controller: AbortController | null = null;

    const refreshWorkspaces = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const data = sortWorkspacesByActivity(await fetchWorkspaces({ signal: controller.signal }));
        if (!active) {
          return;
        }
        startTransition(() => {
          setWorkspaces(data);
          setSelectedWorkspaceId((current) => resolveSelectedWorkspaceId(data, current));
        });
      } catch (error) {
        if (!active || isAbortError(error)) {
          return;
        }
      }
    };

    void refreshWorkspaces();
    const interval = window.setInterval(() => {
      void refreshWorkspaces();
    }, 10_000);

    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [isDocumentVisible]);

  useEffect(() => {
    if (!selectedWorkspaceId || !isDocumentVisible) {
      return;
    }

    let active = true;
    let controller: AbortController | null = null;

    const refreshHealth = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const data = await fetchHealth({ signal: controller.signal });
        if (!active) {
          return;
        }
        setHealth(data);
      } catch (error) {
        if (!active || isAbortError(error)) {
          return;
        }
        setHealth(null);
      }
    };

    void refreshHealth();
    const interval = window.setInterval(() => {
      void refreshHealth();
    }, 15_000);

    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [isDocumentVisible, selectedWorkspaceId]);

  const cachedThreads = selectedWorkspaceId ? threadsByWorkspaceId[selectedWorkspaceId] : undefined;

  useEffect(() => {
    if (!selectedWorkspaceId || !isDocumentVisible) {
      return;
    }

    let active = true;
    let controller: AbortController | null = null;
    const hasCachedThreads = Boolean(cachedThreads);

    const refreshThreads = async () => {
      controller?.abort();
      controller = new AbortController();
      if (!hasCachedThreads) {
        setThreadsLoading(true);
      }

      try {
        const data = await fetchThreads(selectedWorkspaceId, { signal: controller.signal });
        if (!active) {
          return;
        }
        startTransition(() => {
          setThreadsByWorkspaceId((current) => ({
            ...current,
            [selectedWorkspaceId]: data
          }));
          setSelectedThreadId((current) => resolveSelectedThreadId(data, current));
        });
      } catch (error) {
        if (!active || isAbortError(error)) {
          return;
        }
      } finally {
        if (active) {
          setThreadsLoading(false);
        }
      }
    };

    void refreshThreads();
    const interval = window.setInterval(() => {
      void refreshThreads();
    }, 5_000);

    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [cachedThreads, isDocumentVisible, selectedWorkspaceId]);

  const threads = selectedWorkspaceId ? (threadsByWorkspaceId[selectedWorkspaceId] ?? []) : [];
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const selectedThreadKey = selectedThread?.threadId ?? selectedThread?.sessionId ?? "";
  const promptCacheKey =
    selectedWorkspaceId && selectedThreadId
      ? createThreadCacheKey(selectedWorkspaceId, selectedThreadId)
      : "";
  const cachedPrompts = promptCacheKey ? promptsByThreadKey[promptCacheKey] : undefined;

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedThreadId || !selectedThreadKey || !isDocumentVisible) {
      return;
    }

    let active = true;
    let controller: AbortController | null = null;
    const cacheKey = createThreadCacheKey(selectedWorkspaceId, selectedThreadId);
    const hasCachedPrompts = Boolean(cachedPrompts);
    const refreshInterval = selectedThread?.openPromptCount ? 2_000 : 5_000;

    const refreshPrompts = async () => {
      controller?.abort();
      controller = new AbortController();
      if (!hasCachedPrompts) {
        setPromptsLoading(true);
      }

      try {
        const data = await fetchPrompts(selectedWorkspaceId, selectedThreadKey, {
          signal: controller.signal
        });
        if (!active) {
          return;
        }
        startTransition(() => {
          setPromptsByThreadKey((current) => ({
            ...current,
            [cacheKey]: data
          }));
          setExpandedPromptId((current) => {
            if (!current) {
              return current;
            }
            return data.some((prompt) => prompt.id === current) ? current : null;
          });
        });
      } catch (error) {
        if (!active || isAbortError(error)) {
          return;
        }
      } finally {
        if (active) {
          setPromptsLoading(false);
        }
      }
    };

    void refreshPrompts();
    const interval = window.setInterval(() => {
      void refreshPrompts();
    }, refreshInterval);

    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [
    cachedPrompts,
    isDocumentVisible,
    selectedThread?.openPromptCount,
    selectedThreadId,
    selectedThreadKey,
    selectedWorkspaceId
  ]);

  const prompts = promptCacheKey ? (promptsByThreadKey[promptCacheKey] ?? []) : [];

  async function loadPromptDetail(workspaceId: string, promptId: string, force = false): Promise<void> {
    if (!force && promptDetailsById[promptId]) {
      return;
    }

    detailControllersRef.current[promptId]?.abort();
    const controller = new AbortController();
    detailControllersRef.current[promptId] = controller;

    setDetailLoadingById((current) => ({
      ...current,
      [promptId]: true
    }));
    setDetailErrorById((current) => ({
      ...current,
      [promptId]: null
    }));

    try {
      const detail = await fetchPromptDetail(workspaceId, promptId, {
        signal: controller.signal
      });
      setPromptDetailsById((current) => ({
        ...current,
        [promptId]: detail
      }));
    } catch (error) {
      if (!isAbortError(error)) {
        setDetailErrorById((current) => ({
          ...current,
          [promptId]: "Prompt detail is unavailable right now."
        }));
      }
    } finally {
      setDetailLoadingById((current) => ({
        ...current,
        [promptId]: false
      }));
      if (detailControllersRef.current[promptId] === controller) {
        delete detailControllersRef.current[promptId];
      }
    }
  }

  useEffect(() => {
    if (!selectedWorkspaceId || !expandedPromptId || !isDocumentVisible) {
      return;
    }

    const expandedPrompt = prompts.find((prompt) => prompt.id === expandedPromptId);
    if (!expandedPrompt) {
      setExpandedPromptId(null);
      return;
    }

    if (!promptDetailsById[expandedPromptId]) {
      void loadPromptDetail(selectedWorkspaceId, expandedPromptId);
    }

    if (expandedPrompt.status !== "in_progress") {
      return;
    }

    const interval = window.setInterval(() => {
      void loadPromptDetail(selectedWorkspaceId, expandedPromptId, true);
    }, 2_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [expandedPromptId, isDocumentVisible, promptDetailsById, prompts, selectedWorkspaceId]);

  useEffect(() => {
    return () => {
      for (const controller of Object.values(detailControllersRef.current)) {
        controller?.abort();
      }
    };
  }, []);

  const selectedWorkspace = getSelectedWorkspace(workspaces, selectedWorkspaceId);
  const selectedWorkspaceStatus = getSelectedWorkspaceStatus(selectedWorkspace, health, selectedWorkspaceId);
  const workspaceSidebarItems = buildWorkspaceSidebarItems(workspaces, selectedWorkspaceId);
  const threadRows = threads.map(toThreadRowViewModel);
  const promptRows = prompts
    .filter((prompt) => {
      if (filter === "open") {
        return prompt.status === "in_progress";
      }
      if (filter === "imported") {
        return prompt.status !== "in_progress";
      }
      return true;
    })
    .map(toPromptRowViewModel);

  const promptDetails = useMemo(() => (
    Object.fromEntries(
      Object.entries(promptDetailsById).map(([promptId, prompt]) => [promptId, toPromptDetailViewModel(prompt)])
    ) as Record<string, PromptDetailViewModel>
  ), [promptDetailsById]);

  const handleSelectWorkspace = (workspaceId: string) => {
    const nextThreads = threadsByWorkspaceId[workspaceId] ?? [];
    startTransition(() => {
      setSelectedWorkspaceId(workspaceId);
      setSelectedThreadId(resolveSelectedThreadId(nextThreads, ""));
      setExpandedPromptId(null);
      setActiveTab("threads");
    });
    setSidebarDrawerOpen(false);
  };

  const handleSelectThread = (threadId: string) => {
    startTransition(() => {
      setSelectedThreadId(threadId);
      setExpandedPromptId(null);
    });
  };

  const handleTogglePrompt = (promptId: string) => {
    if (!selectedWorkspaceId) {
      return;
    }

    if (expandedPromptId === promptId) {
      setExpandedPromptId(null);
      return;
    }

    setExpandedPromptId(promptId);
    void loadPromptDetail(selectedWorkspaceId, promptId);
  };

  const handleRescan = async () => {
    setIsRescanning(true);
    try {
      const controller = new AbortController();
      const ingestion = await rescanSessions({ signal: controller.signal });
      setHealth((current) => current ? { ...current, ingestion } : current);
      const refreshed = sortWorkspacesByActivity(await fetchWorkspaces({ signal: controller.signal }));
      startTransition(() => {
        setWorkspaces(refreshed);
        setSelectedWorkspaceId((current) => resolveSelectedWorkspaceId(refreshed, current));
      });
    } finally {
      setIsRescanning(false);
    }
  };

  return (
    <AppShell
      isSidebarCollapsed={sidebarCollapsed}
      onOpenSidebarDrawer={() => setSidebarDrawerOpen(true)}
      sidebar={
        <WorkspaceSidebar
          workspaces={workspaceSidebarItems}
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectWorkspace={handleSelectWorkspace}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((current) => !current)}
          isDrawerOpen={sidebarDrawerOpen}
          onCloseDrawer={() => setSidebarDrawerOpen(false)}
          isRescanning={isRescanning}
          onRescan={() => {
            void handleRescan();
          }}
        />
      }
      main={
        <MainColumn
          selectedWorkspace={selectedWorkspace}
          selectedWorkspaceStatus={selectedWorkspaceStatus}
          threadRows={threadRows}
          selectedThreadId={selectedThreadId}
          onSelectThread={handleSelectThread}
          promptRows={promptRows}
          expandedPromptId={expandedPromptId}
          promptDetails={promptDetails}
          detailLoadingById={detailLoadingById}
          detailErrorById={detailErrorById}
          filter={filter}
          onFilterChange={setFilter}
          onTogglePrompt={handleTogglePrompt}
          onOpenSidebarDrawer={() => setSidebarDrawerOpen(true)}
          isThreadsLoading={threadsLoading}
          isPromptsLoading={promptsLoading}
          activeTab={activeTab}
          onTabChange={setActiveTab}
        />
      }
    />
  );
}
