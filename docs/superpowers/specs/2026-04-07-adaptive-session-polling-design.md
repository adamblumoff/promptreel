# Adaptive Session Polling Design

## Goal

Reduce daemon wakeups from the live Codex session tailer without hurting the user-visible freshness of Promptreel updates. The acceptable delay for active streaming updates is 2-3 seconds.

## Current Behavior

- The tailer watches `~/.codex/sessions` JSONL files with directory and per-file watchers.
- It also polls "active" session files every 500ms.
- A file is considered active when it has an open prompt in memory or was modified within the live activity window.
- The polling loop compares `mtime` and file size, then queues a reconcile if either changed.

## Problem

The 500ms poll loop is conservative and reliable, but it wakes up frequently even when a session file is still considered active yet has gone quiet. Earlier attempts that changed watcher registration behavior were reverted, so this change should avoid altering watcher lifecycle logic.

## Approaches Considered

### 1. Adaptive polling with existing watchers preserved

Keep the existing watcher model and reduce only the polling frequency for quiet files.

Pros:
- Lowest-risk change
- Preserves the current detection model
- Meets the 2-3 second freshness target

Cons:
- Polling still exists
- Requires a small amount of per-file timing state

### 2. Fixed slower polling for all active files

Replace the 500ms interval with a single slower value like 2s or 3s.

Pros:
- Very small patch

Cons:
- Slower than necessary during genuinely active streaming
- No distinction between hot and quiet files

### 3. Remove most active polling and rely on watchers

Lean primarily on filesystem events and the recovery sweep.

Pros:
- Lowest wakeup rate

Cons:
- Highest risk on Windows append-heavy JSONL writes
- Too similar to previous churn-reduction attempts that were reverted

## Chosen Design

Use adaptive polling while keeping all existing watcher logic unchanged.

### Polling tiers

- Hot: 500ms while a tracked session has an open prompt or has changed very recently
- Warm: 1s after a short quiet period
- Quiet-live: 2-3s while still inside the live activity window but no longer changing rapidly

The implementation should compute the effective poll cadence per file inside the existing timer loop rather than creating new timers per file.

## Data Flow

1. The existing timer continues to run at a lightweight base cadence.
2. For each tracked active session file, the tailer decides whether that file is due for another stat check based on:
   - open prompt state
   - last observed file change time
   - current live activity status
3. If a file is not due yet, it is skipped for that tick.
4. If a stat check detects a new size or `mtime`, the file is reconciled immediately and its "recently changed" timestamp is refreshed.

## Non-Goals

- No watcher registration changes
- No removal of the recovery sweep
- No changes to hosted viewer refresh behavior in this slice

## Error Handling

- Preserve current behavior for missing files and stat failures
- Keep reconcile queueing behavior unchanged
- Fall back to the next polling opportunity if a stat call races with file changes

## Testing

- Keep the existing watcher tests passing
- Add unit coverage for the adaptive cadence decision logic
- Add or extend a test to prove hot files stay fast and quiet live files back off

## Success Criteria

- Live updates still appear within 2-3 seconds during active Codex streaming
- No change to watcher lifecycle behavior
- Fewer unnecessary stat checks for quiet-but-still-live session files
