export type ViewerMode = "cloud" | "local";

function normalizeViewerMode(value: string | undefined): ViewerMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "local") {
    return "local";
  }
  if (normalized === "cloud") {
    return "cloud";
  }
  return import.meta.env.DEV ? "local" : "cloud";
}

export const VIEWER_MODE: ViewerMode = normalizeViewerMode(import.meta.env.VITE_VIEWER_MODE);
export const IS_CLOUD_VIEWER_MODE = VIEWER_MODE === "cloud";
export const IS_LOCAL_VIEWER_MODE = VIEWER_MODE === "local";
