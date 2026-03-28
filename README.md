# Promptline

Promptline is a Windows-first, local-first causal review layer for Codex-driven software work.

## Workspace

- `apps/daemon`: localhost Fastify API over the Promptline data spine
- `apps/cli`: `pl` command for repo registration, imports, live checks, and prompt queries
- `apps/web`: thin read-only Prompt Stream UI
- `packages/domain`: shared types and causal rules
- `packages/storage`: `~/.pl` storage layout and SQLite persistence
- `packages/codex-adapter`: historical Codex session import and live `codex app-server` ingestion
- `packages/git-integration`: snapshot and diff helpers
- `packages/api-contracts`: request and response contracts for the daemon API
- `packages/test-fixtures`: deterministic fixture data for tests

## Commands

```bash
pnpm install
pnpm build
pnpm test
pnpm dev:daemon
pnpm dev:web
```

