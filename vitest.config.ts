import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve("apps/web/src"),
      "@promptreel/domain": resolve("packages/domain/src/index.ts"),
      "@promptreel/storage": resolve("packages/storage/src/index.ts"),
      "@promptreel/codex-adapter": resolve("packages/codex-adapter/src/index.ts"),
      "@promptreel/git-integration": resolve("packages/git-integration/src/index.ts"),
      "@promptreel/api-contracts": resolve("packages/api-contracts/src/index.ts"),
      "@promptreel/test-fixtures": resolve("packages/test-fixtures/src/index.ts")
    }
  },
  test: {
    include: ["packages/**/*.test.{ts,tsx}", "apps/**/*.test.{ts,tsx}"],
    environment: "node"
  }
});
