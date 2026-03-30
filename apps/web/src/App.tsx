import { useEffect, useState } from "react";
import {
  fetchHealth,
  fetchPromptDetail,
  fetchPrompts,
  fetchRepos
} from "./api";
import type { Health, PromptDetail, PromptListItem, Repo } from "./types";
import {
  AppShell,
  ContextRail,
  MainColumn,
  ProjectSidebar
} from "./components";
import {
  buildProjectSidebarItems,
  getSelectedProject,
  getSelectedRepoStatus,
  resolveSelectedProjectId,
  sortProjectsAlphabetically,
  toPromptRowViewModel,
  type PromptDetailViewModel
} from "./view-models";
import { toPromptDetailViewModel } from "./view-models";

const SELECTED_PROJECT_STORAGE_KEY = "promptline:selected-project-id";
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

export function App() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(() =>
    readStoredValue(SELECTED_PROJECT_STORAGE_KEY)
  );
  const [prompts, setPrompts] = useState<PromptListItem[]>([]);
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

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, selectedProjectId);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(sidebarCollapsed));
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    let cancelled = false;

    const refreshRepos = async () => {
      try {
        const data = sortProjectsAlphabetically(await fetchRepos());
        if (cancelled) {
          return;
        }
        setRepos(data);
        setSelectedProjectId((current) => resolveSelectedProjectId(data, current));
      } catch {
        if (!cancelled) {
          setRepos([]);
          setSelectedProjectId("");
        }
      }
    };

    void refreshRepos();
    const interval = window.setInterval(() => {
      void refreshRepos();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const refreshHealth = async () => {
      try {
        const data = await fetchHealth();
        if (!cancelled) {
          setHealth(data);
        }
      } catch {
        if (!cancelled) {
          setHealth(null);
        }
      }
    };

    void refreshHealth();
    const interval = window.setInterval(() => {
      void refreshHealth();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setPrompts([]);
      setExpandedPromptId(null);
      return;
    }

    let cancelled = false;

    const refreshPrompts = async () => {
      try {
        const data = await fetchPrompts(selectedProjectId);
        if (cancelled) {
          return;
        }
        setPrompts(data);
        setExpandedPromptId((current) => {
          if (!current) {
            return current;
          }
          return data.some((prompt) => prompt.id === current) ? current : null;
        });
      } catch {
        if (!cancelled) {
          setPrompts([]);
          setExpandedPromptId(null);
        }
      }
    };

    void refreshPrompts();
    const interval = window.setInterval(() => {
      void refreshPrompts();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedProjectId]);

  async function loadPromptDetail(projectId: string, promptId: string, force = false): Promise<void> {
    if (!force && promptDetailsById[promptId]) {
      return;
    }

    setDetailLoadingById((current) => ({
      ...current,
      [promptId]: true
    }));
    setDetailErrorById((current) => ({
      ...current,
      [promptId]: null
    }));

    try {
      const detail = await fetchPromptDetail(projectId, promptId);
      setPromptDetailsById((current) => ({
        ...current,
        [promptId]: detail
      }));
    } catch {
      setDetailErrorById((current) => ({
        ...current,
        [promptId]: "Prompt detail is unavailable right now."
      }));
    } finally {
      setDetailLoadingById((current) => ({
        ...current,
        [promptId]: false
      }));
    }
  }

  useEffect(() => {
    if (!selectedProjectId || !expandedPromptId) {
      return;
    }

    const expandedPrompt = prompts.find((prompt) => prompt.id === expandedPromptId);
    if (!expandedPrompt) {
      setExpandedPromptId(null);
      return;
    }

    if (!promptDetailsById[expandedPromptId]) {
      void loadPromptDetail(selectedProjectId, expandedPromptId);
    }

    if (expandedPrompt.status !== "in_progress") {
      return;
    }

    const interval = window.setInterval(() => {
      void loadPromptDetail(selectedProjectId, expandedPromptId, true);
    }, 3000);

    return () => {
      window.clearInterval(interval);
    };
  }, [expandedPromptId, promptDetailsById, prompts, selectedProjectId]);

  const selectedProject = getSelectedProject(repos, selectedProjectId);
  const selectedProjectStatus = getSelectedRepoStatus(health, selectedProjectId);
  const projectSidebarItems = buildProjectSidebarItems(repos, health, selectedProjectId);
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

  const promptDetails = Object.fromEntries(
    Object.entries(promptDetailsById).map(([promptId, prompt]) => [promptId, toPromptDetailViewModel(prompt)])
  ) as Record<string, PromptDetailViewModel>;

  const handleSelectProject = (projectId: string) => {
    setSelectedProjectId(projectId);
    setExpandedPromptId(null);
    setSidebarDrawerOpen(false);
  };

  const handleTogglePrompt = (promptId: string) => {
    if (!selectedProjectId) {
      return;
    }

    if (expandedPromptId === promptId) {
      setExpandedPromptId(null);
      return;
    }

    setExpandedPromptId(promptId);
    void loadPromptDetail(selectedProjectId, promptId);
  };

  return (
    <AppShell
      sidebar={
        <ProjectSidebar
          projects={projectSidebarItems}
          selectedProjectId={selectedProjectId}
          onSelectProject={handleSelectProject}
          health={health}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((current) => !current)}
          isDrawerOpen={sidebarDrawerOpen}
          onCloseDrawer={() => setSidebarDrawerOpen(false)}
        />
      }
      main={
        <MainColumn
          selectedProject={selectedProject}
          selectedProjectStatus={selectedProjectStatus}
          promptRows={promptRows}
          expandedPromptId={expandedPromptId}
          promptDetails={promptDetails}
          detailLoadingById={detailLoadingById}
          detailErrorById={detailErrorById}
          filter={filter}
          onFilterChange={setFilter}
          onTogglePrompt={handleTogglePrompt}
          onOpenSidebarDrawer={() => setSidebarDrawerOpen(true)}
        />
      }
      contextRail={<ContextRail selectedRepoStatus={selectedProjectStatus} />}
    />
  );
}
