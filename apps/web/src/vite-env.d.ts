/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  readonly VITE_VIEWER_MODE?: "cloud" | "local";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
