import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@promptline/domain": resolve("packages/domain/src/index.ts"),
      "@promptline/storage": resolve("packages/storage/src/index.ts"),
      "@promptline/codex-adapter": resolve("packages/codex-adapter/src/index.ts"),
      "@promptline/git-integration": resolve("packages/git-integration/src/index.ts"),
      "@promptline/api-contracts": resolve("packages/api-contracts/src/index.ts"),
      "@promptline/test-fixtures": resolve("packages/test-fixtures/src/index.ts")
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node"
  }
});
