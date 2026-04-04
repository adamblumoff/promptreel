# Promptreel

Promptreel is a Windows-first, local-first causal review layer for Codex-driven software work.

## Workspace

- `apps/daemon`: localhost Fastify API over the Promptreel data spine
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
pnpm dev
pnpm build
pnpm test
pnpm dev:daemon
pnpm dev:web
```

## Cloud Auth (WIP)

- `pl login` opens a browser-based machine-link flow and stores a daemon token in `~/.pl/cloud-auth.json`.
- The hosted web app expects `apps/web/.env.example` values, especially `VITE_CLERK_PUBLISHABLE_KEY`.
- The API expects `apps/daemon/.env.example` values, especially `CLERK_SECRET_KEY`, `PROMPTREEL_WEB_URL`, and `PROMPTREEL_CLOUD_DATABASE_URL`.
- For local development, keep the API on `http://127.0.0.1:4312/api` and the web app on `http://127.0.0.1:4175`.

## Local Dev Loop

- `pnpm dev` runs the daemon and web app together from source.
- `pnpm dev:cli -- repo list` runs the CLI from source without building first.
- Keep `pnpm dev` running in one terminal, then use `pnpm dev:cli -- ...` in another terminal for repo add/import/live checks.
- The daemon automatically watches `~/.codex/sessions` for registered repos, so active and resumed Codex conversations should appear in the Prompt Stream without a manual import loop.
- Check `http://127.0.0.1:4312/api/health` to see watcher status, discovered session files, and open prompt counts.
