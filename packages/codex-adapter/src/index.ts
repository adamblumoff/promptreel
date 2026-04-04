import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import WebSocket from "ws";
import type {
  ArtifactClassification,
  ArtifactLinkRecord,
  ArtifactRecord,
  CodeDiffResult,
  IngestionStatus,
  LiveDoctorResult,
  PromptMode,
  PromptEventRecord,
  RawEventRecord,
  RepoRegistration,
  WorkspaceSnapshot,
  WorkspaceIngestionStatus
} from "@promptreel/domain";
import {
  choosePrimaryArtifactType,
  createId,
  extractPlan,
  hashValue,
  looksLikeTestCommand,
  nowIso,
  summarizePrompt,
  type GitLinkRecord,
  workspaceGroupId
} from "@promptreel/domain";
import {
  buildCodeDiff,
  buildCodeDiffArtifact,
  captureWorkspaceSnapshot,
  createPlaceholderSnapshot,
  mergeCodeDiffs,
  parseApplyPatchToCodeDiff,
  parseUnifiedDiffToCodeDiff,
  repoRelativePath
} from "@promptreel/git-integration";
import {
  PromptreelStore,
  getFileMtimeMs,
  toEligibleWorkspacePath
} from "@promptreel/storage";

export const LIVE_ACTIVITY_WINDOW_MS = 90_000;
const SESSION_WATCH_DEBOUNCE_MS = 150;
const SESSION_RECOVERY_SWEEP_INTERVAL_MS = 300_000;
const SESSION_META_READ_BYTES = 8_192;

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { message: string };
}

type SessionLine = {
  timestamp: string;
  type: string;
  payload?: Record<string, unknown>;
};

type SessionToolEvent = {
  callId: string;
  kind: "function_call" | "custom_tool_call";
  occurredAt: string;
  name: string;
  status: string | null;
  input: string | null;
  arguments: string | null;
  output: string | null;
};

type SessionAgentMessage = {
  occurredAt: string;
  phase: string | null;
  text: string;
};

type PlanDecisionOption = {
  id: string;
  text: string;
};

type PlanDecisionMetadata = {
  question: string;
  options: PlanDecisionOption[];
  userAnswer: string;
  selectedOptionId: string | null;
  selectedText: string | null;
  selectionMode: "explicit" | "freeform" | "ambiguous";
  askedAt: string;
  answeredAt: string;
  promptEventId: string;
};

type HistoricalRecoveredDiff = {
  diff: CodeDiffResult;
  source: "apply_patch" | "git_diff_output";
  sourceFormat: "codex_apply_patch" | "unified_diff";
};

type SessionMeta = {
  sessionId: string;
  threadId: string | null;
  cwd: string | null;
  normalizedCwd: string | null;
  source: string | null;
};

type WorkspaceImportCount = {
  importedFiles: number;
  importedPrompts: number;
};

export interface ImportCodexSessionsOptions {
  tailOpenPrompt?: boolean;
}

export interface ImportCodexSessionsResult {
  importedFiles: number;
  importedPrompts: number;
  byWorkspace: Record<string, WorkspaceImportCount>;
}

export interface CodexSessionFileMatch {
  filePath: string;
  sessionId: string;
  threadId: string | null;
  cwd: string | null;
  normalizedCwd: string | null;
  source: string | null;
  workspaceId: string;
  mtimeMs: number | null;
  sizeBytes: number;
}

export interface CodexSessionTailerUpdate {
  kind: "ingest";
  at: string;
  workspaceIds: string[];
  threadKeys: string[];
}

type SessionChunkParseResult = {
  lines: SessionLine[];
  trailingText: string;
};

type SessionTailState = {
  lastSizeBytes: number;
  trailingText: string;
  nextPromptIndex: number;
  openPromptIndex: number | null;
  openWindowLines: SessionLine[];
  activePlanDecisions: PlanDecisionMetadata[];
};

function readSessionHead(filePath: string, maxBytes = SESSION_META_READ_BYTES): string {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function parseSessionChunk(text: string): SessionChunkParseResult {
  const lines = text.split(/\r?\n/);
  const parsed: SessionLine[] = [];
  let trailingText = "";
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      parsed.push(JSON.parse(line) as SessionLine);
    } catch (error) {
      if (index === lines.length - 1) {
        trailingText = rawLine;
        break;
      }
      throw error;
    }
  }
  return { lines: parsed, trailingText };
}

function parseSessionLines(text: string): SessionLine[] {
  return parseSessionChunk(text).lines;
}

function findSessionMetaLine(lines: SessionLine[]): SessionLine | null {
  return lines.find((line) => line.type === "session_meta") ?? null;
}

function readSessionMetaFromHead(filePath: string): SessionMeta | null {
  const lines = parseSessionChunk(readSessionHead(filePath)).lines;
  return findSessionMetaLine(lines) ? readSessionMeta(lines) : null;
}

function getSessionFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function discoverCodexSessionFile(filePath: string): CodexSessionFileMatch | null {
  if (!filePath.endsWith(".jsonl") || !existsSync(filePath)) {
    return null;
  }
  const meta = readSessionMetaFromHead(filePath) ?? readSessionMeta(readSessionLines(filePath));
  const workspacePath = meta.normalizedCwd ?? (meta.cwd && isAbsolute(meta.cwd) ? normalize(meta.cwd) : null);
  if (!workspacePath) {
    return null;
  }
  return {
    filePath,
    sessionId: meta.sessionId,
    threadId: meta.threadId,
    cwd: meta.cwd,
    normalizedCwd: meta.normalizedCwd,
    source: meta.source,
    workspaceId: workspaceGroupId(workspacePath),
    mtimeMs: getFileMtimeMs(filePath),
    sizeBytes: getSessionFileSize(filePath)
  };
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}_${hashValue(seed).slice(0, 24)}`;
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const results: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function readSessionLines(filePath: string): SessionLine[] {
  return parseSessionLines(readFileSync(filePath, "utf8"));
}

function readSessionAppend(
  filePath: string,
  startOffset: number,
  trailingText = ""
): { lines: SessionLine[]; trailingText: string; endOffset: number } {
  const fileSize = getSessionFileSize(filePath);
  if (startOffset >= fileSize) {
    return {
      lines: [],
      trailingText,
      endOffset: fileSize,
    };
  }

  const fd = openSync(filePath, "r");
  try {
    const bytesToRead = fileSize - startOffset;
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, startOffset);
    const parsed = parseSessionChunk(`${trailingText}${buffer.toString("utf8", 0, bytesRead)}`);
    return {
      lines: parsed.lines,
      trailingText: parsed.trailingText,
      endOffset: startOffset + bytesRead,
    };
  } finally {
    closeSync(fd);
  }
}

function readSessionMeta(lines: SessionLine[]): SessionMeta {
  const meta = findSessionMetaLine(lines);
  const cwd = typeof meta?.payload?.cwd === "string" ? meta.payload.cwd : null;
  const normalizedCwd = normalizeSessionCwd(cwd);
  return {
    sessionId: typeof meta?.payload?.id === "string" ? meta.payload.id : "",
    threadId:
      typeof meta?.payload?.threadId === "string"
        ? meta.payload.threadId
        : typeof meta?.payload?.thread_id === "string"
          ? meta.payload.thread_id
          : null,
    cwd,
    normalizedCwd,
    source: typeof meta?.payload?.source === "string" ? meta.payload.source : null
  };
}

function normalizeSessionCwd(cwd: string | null): string | null {
  return toEligibleWorkspacePath(cwd);
}

function isUserMessage(line: SessionLine): string | null {
  if (line.type !== "event_msg" || line.payload?.type !== "user_message") {
    return null;
  }
  return String(line.payload.message ?? "");
}

function isAgentMessage(line: SessionLine): string | null {
  if (line.type !== "event_msg" || line.payload?.type !== "agent_message") {
    return null;
  }
  return String(line.payload.message ?? "");
}

function isMirroredUserResponseItem(line: SessionLine): boolean {
  return (
    line.type === "response_item"
    && line.payload?.type === "message"
    && line.payload?.role === "user"
  );
}

function collectSessionAgentMessages(window: SessionLine[]): SessionAgentMessage[] {
  return window.flatMap((line) => {
    const text = isAgentMessage(line)?.trim();
    if (!text) {
      return [];
    }
    return [{
      occurredAt: line.timestamp ?? nowIso(),
      phase: typeof line.payload?.phase === "string" ? line.payload.phase : null,
      text,
    }];
  });
}

function trimHistoricalWindowEndExclusive(
  lines: SessionLine[],
  currentStart: number,
  endExclusive: number
): number {
  if (currentStart < 0 || endExclusive >= lines.length) {
    return endExclusive;
  }

  const boundaryTimestamp = lines[endExclusive]?.timestamp;
  if (!boundaryTimestamp) {
    return endExclusive;
  }

  let trimmedEndExclusive = endExclusive;
  while (trimmedEndExclusive > currentStart) {
    const candidate = lines[trimmedEndExclusive - 1]!;
    if (candidate.timestamp !== boundaryTimestamp) {
      break;
    }
    if (!isMirroredUserResponseItem(candidate)) {
      break;
    }
    trimmedEndExclusive -= 1;
  }

  return trimmedEndExclusive;
}

function trimHistoricalWindowForBoundary(window: SessionLine[], boundaryTimestamp: string | null): SessionLine[] {
  if (!boundaryTimestamp) {
    return window;
  }

  let trimmedLength = window.length;
  while (trimmedLength > 0) {
    const candidate = window[trimmedLength - 1]!;
    if (candidate.timestamp !== boundaryTimestamp) {
      break;
    }
    if (!isMirroredUserResponseItem(candidate)) {
      break;
    }
    trimmedLength -= 1;
  }

  return trimmedLength === window.length ? window : window.slice(0, trimmedLength);
}

function buildHistoricalPromptId(filePath: string, promptIndex: number): string {
  return stableId("prompt", `${filePath}:${promptIndex}`);
}

function extractHistoricalFinalText(window: SessionLine[]): string {
  const messages = collectSessionAgentMessages(window);
  const finalAnswerMessages = messages.filter((message) => message.phase === "final_answer");
  if (finalAnswerMessages.length > 0) {
    return finalAnswerMessages.map((message) => message.text).join("\n\n").trim();
  }

  const unphasedMessages = messages.filter((message) => message.phase === null);
  if (unphasedMessages.length > 0) {
    return unphasedMessages.map((message) => message.text).join("\n\n").trim();
  }

  return "";
}

function extractExplicitPlanText(window: SessionLine[]): string | null {
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const line = window[index]!;
    if (line.type !== "event_msg" || line.payload?.type !== "item_completed") {
      continue;
    }
    const item = line.payload?.item;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const planItem = item as Record<string, unknown>;
    const itemType = typeof planItem.type === "string" ? planItem.type : null;
    const itemText = typeof planItem.text === "string" ? planItem.text.trim() : "";
    if (itemType === "Plan" && itemText) {
      return itemText;
    }
  }

  return null;
}

function looksLikePlanRequest(promptText: string): boolean {
  const normalized = promptText.toLowerCase();
  if (/\b(?:implement|execute|follow)\s+(?:this|the)\s+plan\b/.test(normalized)) {
    return false;
  }

  return (
    /\bplan the\b/.test(normalized)
    || /\b(?:come up with|create|draft|write|make|give|propose|outline|sketch|brainstorm)\b[\s\S]{0,80}\bplan\b/.test(normalized)
    || /\bneed\b[\s\S]{0,40}\bplan\b/.test(normalized)
    || /\bproper\b[\s\S]{0,40}\bmarkdown renderer for plans\b/.test(normalized)
  );
}

function extractEmbeddedPromptPlanText(promptText: string): string | null {
  const match = promptText.match(
    /^\s*(?:please\s+)?(?:implement|follow|execute)\s+this\s+plan:\s*([\s\S]+)$/i
  );
  const planText = match?.[1]?.trim() ?? "";
  return planText ? planText : null;
}

function readHistoricalPromptMode(window: SessionLine[]): PromptMode {
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const line = window[index]!;
    if (line.type !== "turn_context") {
      continue;
    }
    const collaborationMode = line.payload?.collaboration_mode;
    if (!collaborationMode || typeof collaborationMode !== "object" || Array.isArray(collaborationMode)) {
      continue;
    }
    const mode = (collaborationMode as { mode?: unknown }).mode;
    if (mode === "plan") {
      return "plan";
    }
    if (mode === "default") {
      return "default";
    }
  }

  return "default";
}

function buildPlanMarkdownFromSteps(steps: string[]): string {
  return [
    "## Plan",
    "",
    ...steps.map((step, index) => `${index + 1}. ${step}`)
  ].join("\n");
};

type PlanArtifactMetadata = {
  explanation: string | null;
  steps: string[];
  decisions?: PlanDecisionMetadata[];
};

function buildPlanMarkdownFromParsedPlan(plan: ReturnType<typeof extractPlan>): string {
  if (!plan) {
    return "";
  }

  const sections: string[] = [];
  const explanation = plan.explanation?.replace(/\s*##\s+plan\s*$/i, "").trim() ?? "";
  if (explanation) {
    sections.push(explanation);
  }
  if (plan.steps.length > 0) {
    sections.push(buildPlanMarkdownFromSteps(plan.steps));
  }
  return sections.join("\n\n").trim();
}

function hasExplicitPlanSection(finalText: string): boolean {
  return /^\s*##\s+plan\b/im.test(finalText) || /^\s*#\s+.*\bplan\b/im.test(finalText);
}

function hasCommittedPlanLeadIn(finalText: string): boolean {
  const normalized = finalText.slice(0, 400).toLowerCase();
  return (
    /\b(?:here(?:'s| is)|this is|below is|recommended|proposed|draft)\s+(?:the\s+)?plan\b/.test(normalized)
    || /^\s*plan\s*[:\-]/im.test(finalText)
  );
}

function shouldCreateFallbackPlanArtifact(
  promptText: string,
  finalText: string,
  parsedPlan: NonNullable<ReturnType<typeof extractPlan>>
): boolean {
  if (hasExplicitPlanSection(finalText)) {
    return true;
  }

  const explanation = parsedPlan.explanation?.trim() ?? "";
  const explanationWordCount = explanation.split(/\s+/).filter(Boolean).length;
  const hasPlanRequestHint = looksLikePlanRequest(promptText);
  const hasLeadIn = hasCommittedPlanLeadIn(finalText);

  if (parsedPlan.steps.length < 2) {
    return false;
  }

  if (hasLeadIn && explanationWordCount <= 80) {
    return true;
  }

  if (hasPlanRequestHint && explanationWordCount <= 18) {
    return true;
  }

  return false;
}

function extractPlanDecision(
  text: string,
  nextUserPromptText: string | null,
  promptEventId: string,
  askedAt: string,
  answeredAt: string
): { decision: PlanDecisionMetadata; cleanedText: string } | null {
  const userAnswer = nextUserPromptText?.trim() ?? "";
  if (!userAnswer) {
    return null;
  }

  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^\s*##\s+plan\b/i.test(line));
  const preambleEnd = headingIndex >= 0 ? headingIndex : lines.length;
  const preambleLines = lines.slice(0, preambleEnd);
  const optionMatches = preambleLines
    .map((line, index) => {
      const match = line.match(/^\s*(?:[-*]|\d+[.)]|[A-Z][.)])\s+(.+?)\s*$/);
      if (!match) {
        return null;
      }
      return {
        index,
        text: match[1]!.trim(),
      };
    })
    .filter((value): value is { index: number; text: string } => value !== null);

  if (optionMatches.length < 2) {
    return null;
  }

  const firstOptionIndex = optionMatches[0]!.index;
  let questionEndIndex = firstOptionIndex - 1;
  while (questionEndIndex >= 0 && preambleLines[questionEndIndex]!.trim() === "") {
    questionEndIndex -= 1;
  }
  if (questionEndIndex < 0) {
    return null;
  }

  let questionStartIndex = questionEndIndex;
  while (questionStartIndex > 0 && preambleLines[questionStartIndex - 1]!.trim() !== "") {
    questionStartIndex -= 1;
  }

  const question = preambleLines
    .slice(questionStartIndex, questionEndIndex + 1)
    .join("\n")
    .replace(/^\s*#+\s*/gm, "")
    .trim();
  if (
    !question
    || !/[?]$/.test(question)
    && !/\b(which|choose|pick|prefer|want|option|direction)\b/i.test(question)
  ) {
    return null;
  }

  const options = optionMatches.map((option, index) => ({
    id: String(index + 1),
    text: option.text,
  }));
  const selection = selectPlanDecisionOption(options, userAnswer);
  const strippedPreambleText = preambleLines
    .filter((_, index) => {
      if (index >= questionStartIndex && index <= questionEndIndex) {
        return false;
      }
      return !optionMatches.some((option) => option.index === index);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const cleanedText = [strippedPreambleText, lines.slice(preambleEnd).join("\n")]
    .filter((section) => section.trim().length > 0)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    decision: {
      question,
      options,
      userAnswer,
      selectedOptionId: selection.selectedOptionId,
      selectedText: selection.selectedText,
      selectionMode: selection.selectionMode,
      askedAt,
      answeredAt,
      promptEventId,
    },
    cleanedText,
  };
}

function selectPlanDecisionOption(
  options: PlanDecisionOption[],
  userAnswer: string
): Pick<PlanDecisionMetadata, "selectedOptionId" | "selectedText" | "selectionMode"> {
  const normalizedAnswer = userAnswer.toLowerCase().trim();
  const numericMatch = normalizedAnswer.match(/\b(?:option\s+)?(\d+)\b/);
  if (numericMatch) {
    const selected = options.find((option) => option.id === numericMatch[1]);
    if (selected) {
      return {
        selectedOptionId: selected.id,
        selectedText: selected.text,
        selectionMode: "explicit",
      };
    }
  }

  const letterMatch = normalizedAnswer.match(/\b([a-z])(?:[\s.)]|$)/);
  if (letterMatch) {
    const letterIndex = letterMatch[1]!.charCodeAt(0) - 96;
    const selected = options[letterIndex - 1];
    if (selected) {
      return {
        selectedOptionId: selected.id,
        selectedText: selected.text,
        selectionMode: "explicit",
      };
    }
  }

  const normalizedOptions = options.map((option) => ({
    ...option,
    normalized: option.text.toLowerCase(),
  }));
  const directTextMatch = normalizedOptions.find((option) => normalizedAnswer.includes(option.normalized));
  if (directTextMatch) {
    return {
      selectedOptionId: directTextMatch.id,
      selectedText: directTextMatch.text,
      selectionMode: "freeform",
    };
  }

  const tokenizedAnswer = normalizedAnswer.split(/[^a-z0-9]+/).filter(Boolean);
  let bestMatch: { option: PlanDecisionOption; score: number } | null = null;
  for (const option of normalizedOptions) {
    const tokens = option.normalized.split(/[^a-z0-9]+/).filter(Boolean);
    const overlap = tokens.filter((token) => tokenizedAnswer.includes(token)).length;
    if (overlap < 2) {
      continue;
    }
    if (!bestMatch || overlap > bestMatch.score) {
      bestMatch = { option, score: overlap };
    }
  }

  if (bestMatch) {
    return {
      selectedOptionId: bestMatch.option.id,
      selectedText: bestMatch.option.text,
      selectionMode: "freeform",
    };
  }

  return {
    selectedOptionId: null,
    selectedText: null,
    selectionMode: "ambiguous",
  };
}

function buildPlanArtifactContent(
  promptText: string,
  window: SessionLine[],
  finalText: string,
  decisions: PlanDecisionMetadata[] = []
): { blobContent: string; metadata: PlanArtifactMetadata } | null {
  const embeddedPromptPlanText = extractEmbeddedPromptPlanText(promptText);
  if (embeddedPromptPlanText) {
    return {
      blobContent: embeddedPromptPlanText,
      metadata: {
        ...(extractPlan(embeddedPromptPlanText) ?? { explanation: null, steps: [] }),
        ...(decisions.length > 0 ? { decisions } : {}),
      },
    };
  }

  const explicitPlanText = extractExplicitPlanText(window);
  if (explicitPlanText) {
    return {
      blobContent: explicitPlanText,
      metadata: {
        ...(extractPlan(explicitPlanText) ?? { explanation: null, steps: [] }),
        ...(decisions.length > 0 ? { decisions } : {}),
      },
    };
  }

  if (!finalText) {
    return null;
  }

  const parsedPlan = extractPlan(finalText);
  if (!parsedPlan || !shouldCreateFallbackPlanArtifact(promptText, finalText, parsedPlan)) {
    return null;
  }

  return {
    blobContent: buildPlanMarkdownFromParsedPlan(parsedPlan),
    metadata: {
      explanation: parsedPlan.explanation,
      steps: parsedPlan.steps,
      ...(decisions.length > 0 ? { decisions } : {}),
    },
  };
}

function buildLivePlanArtifactContent(
  promptText: string,
  planSteps: string[]
): { blobContent: string; metadata: PlanArtifactMetadata } | null {
  const embeddedPromptPlanText = extractEmbeddedPromptPlanText(promptText);
  if (embeddedPromptPlanText) {
    return {
      blobContent: embeddedPromptPlanText,
      metadata: extractPlan(embeddedPromptPlanText) ?? { explanation: null, steps: [] },
    };
  }

  if (planSteps.length === 0) {
    return null;
  }

  const blobContent = buildPlanMarkdownFromSteps(planSteps);
  return {
    blobContent,
    metadata: {
      explanation: null,
      steps: planSteps,
      decisions: [],
    },
  };
}

function normalizeSessionToolEvents(window: SessionLine[]): SessionToolEvent[] {
  const events = new Map<string, SessionToolEvent>();
  const ordered: SessionToolEvent[] = [];

  const upsert = (
    callId: string,
    partial: Partial<SessionToolEvent> & Pick<SessionToolEvent, "kind" | "occurredAt">
  ): void => {
    const existing = events.get(callId);
    if (!existing) {
      const created: SessionToolEvent = {
        callId,
        kind: partial.kind,
        occurredAt: partial.occurredAt,
        name: partial.name ?? "",
        status: partial.status ?? null,
        input: partial.input ?? null,
        arguments: partial.arguments ?? null,
        output: partial.output ?? null
      };
      events.set(callId, created);
      ordered.push(created);
      return;
    }

    existing.kind = partial.kind ?? existing.kind;
    existing.occurredAt = partial.occurredAt ?? existing.occurredAt;
    if (partial.name !== undefined) {
      existing.name = partial.name;
    }
    if (partial.status !== undefined) {
      existing.status = partial.status;
    }
    if (partial.input !== undefined) {
      existing.input = partial.input;
    }
    if (partial.arguments !== undefined) {
      existing.arguments = partial.arguments;
    }
    if (partial.output !== undefined) {
      existing.output = partial.output;
    }
  };

  for (const line of window) {
    if (line.type !== "response_item") {
      continue;
    }
    const payloadType = String(line.payload?.type ?? "");
    const callId = typeof line.payload?.call_id === "string" ? line.payload.call_id : null;
    if (!callId) {
      continue;
    }

    if (payloadType === "function_call") {
      upsert(callId, {
        kind: "function_call",
        occurredAt: line.timestamp ?? nowIso(),
        name: String(line.payload?.name ?? ""),
        arguments: String(line.payload?.arguments ?? "")
      });
      continue;
    }
    if (payloadType === "function_call_output") {
      upsert(callId, {
        kind: "function_call",
        occurredAt: line.timestamp ?? nowIso(),
        output: String(line.payload?.output ?? "")
      });
      continue;
    }
    if (payloadType === "custom_tool_call") {
      upsert(callId, {
        kind: "custom_tool_call",
        occurredAt: line.timestamp ?? nowIso(),
        name: String(line.payload?.name ?? ""),
        status: typeof line.payload?.status === "string" ? line.payload.status : null,
        input: String(line.payload?.input ?? "")
      });
      continue;
    }
    if (payloadType === "custom_tool_call_output") {
      upsert(callId, {
        kind: "custom_tool_call",
        occurredAt: line.timestamp ?? nowIso(),
        output: String(line.payload?.output ?? "")
      });
    }
  }

  return ordered;
}

function recoverHistoricalCodeDiff(toolEvents: SessionToolEvent[]): HistoricalRecoveredDiff | null {
  const applyPatchDiffs = toolEvents
    .filter((event) => isSuccessfulApplyPatchEvent(event))
    .flatMap((event) => {
      const parsed = parseApplyPatchToCodeDiff(event.input ?? "");
      return parsed ? [parsed] : [];
    });

  if (applyPatchDiffs.length > 0) {
    return {
      diff: mergeCodeDiffs(applyPatchDiffs),
      source: "apply_patch",
      sourceFormat: "codex_apply_patch"
    };
  }

  const gitDiffOutputs = toolEvents
    .filter((event) => isGitDiffCommandEvent(event))
    .flatMap((event) => {
      const parsed = event.output ? parseUnifiedDiffToCodeDiff(event.output) : null;
      return parsed ? [parsed] : [];
    });

  if (gitDiffOutputs.length > 0) {
    return {
      diff: mergeCodeDiffs(gitDiffOutputs),
      source: "git_diff_output",
      sourceFormat: "unified_diff"
    };
  }

  return null;
}

function isSuccessfulApplyPatchEvent(event: SessionToolEvent): boolean {
  return (
    event.kind === "custom_tool_call"
    && event.name === "apply_patch"
    && Boolean(event.input?.trim())
    && (event.status === null || event.status === "completed")
    && !isApplyPatchFailure(event.output)
  );
}

function isApplyPatchFailure(output: string | null): boolean {
  return output?.trimStart().startsWith("apply_patch verification failed") ?? false;
}

function isGitDiffCommandEvent(event: SessionToolEvent): boolean {
  if (event.kind !== "function_call") {
    return false;
  }
  const command = extractCommandText(event);
  return command ? /\bgit\s+diff\b/i.test(command) : false;
}

function extractCommandText(event: SessionToolEvent): string | null {
  const parsedArguments = safeParseJsonRecord(event.arguments);
  if (typeof parsedArguments?.cmd === "string") {
    return parsedArguments.cmd;
  }
  return null;
}

function summarizeToolEvent(event: SessionToolEvent): string {
  const command = extractCommandText(event);
  if (command) {
    return command;
  }
  return `${event.name} ${event.arguments ?? event.input ?? ""}`.trim();
}

function buildCommandArtifactBlobContent(command: string, output: string | null): string {
  const normalizedCommand = command.trim();
  const normalizedOutput = output?.trim() ?? "";
  if (!normalizedOutput) {
    return normalizedCommand;
  }
  return `${normalizedCommand}\n\n${normalizedOutput}`;
}

function classifyCommandExecution(command: string): ArtifactClassification {
  const normalized = command.trim();
  if (looksLikeTestCommand(normalized)) {
    return {
      family: "verification",
      subtype: "verification.test",
      displayLabel: "test",
    };
  }
  if (/\b(?:tsc|typecheck)\b/i.test(normalized)) {
    return {
      family: "verification",
      subtype: "verification.typecheck",
      displayLabel: "typecheck",
    };
  }
  if (/\bgit\s+status\b/i.test(normalized)) {
    return {
      family: "execution",
      subtype: "execution.git_status",
      displayLabel: "git status",
    };
  }
  if (/\b(?:rg|grep|findstr|fd)\b/i.test(normalized)) {
    return {
      family: "execution",
      subtype: "execution.search",
      displayLabel: "search",
    };
  }
  return {
    family: "execution",
    subtype: "execution.command",
    displayLabel: "command",
  };
}

function buildArtifactMetadata(
  classification: ArtifactClassification,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    classification,
    ...extra,
  });
}

function createHistoricalCommandArtifacts(
  store: PromptreelStore,
  workspaceId: string,
  promptId: string,
  promptSeed: string,
  toolEvents: SessionToolEvent[]
): ArtifactRecord[] {
  const commandEvents = toolEvents.filter((event) => {
    if (event.kind !== "function_call") {
      return false;
    }
    const command = extractCommandText(event);
    if (!command?.trim()) {
      return false;
    }
    return !isGitDiffCommandEvent(event);
  });

  return commandEvents.map((event, index) => {
    const command = extractCommandText(event)?.trim() ?? summarizeToolEvent(event);
    const classification = classifyCommandExecution(command);
    return {
      id: stableId("artifact", `${promptSeed}:command:${index}`),
      promptEventId: promptId,
      type: looksLikeTestCommand(command) ? "test_run" : "command_run",
      role: "evidence",
      summary: summarizePrompt(command),
      blobId: store.writeBlob(workspaceId, buildCommandArtifactBlobContent(command, event.output)),
      fileStatsJson: null,
      metadataJson: buildArtifactMetadata(classification, {
        name: event.name,
        command,
        hasOutput: Boolean(event.output?.trim()),
      })
    };
  });
}

function createLiveCommandArtifact(
  store: PromptreelStore,
  workspaceId: string,
  promptEventId: string,
  item: Record<string, unknown>
): ArtifactRecord | null {
  const command = typeof item.command === "string" ? item.command.trim() : "";
  if (!command) {
    return null;
  }
  const classification = classifyCommandExecution(command);
  return {
    id: createId("artifact"),
    promptEventId,
    type: looksLikeTestCommand(command) ? "test_run" : "command_run",
    role: "evidence",
    summary: summarizePrompt(command),
    blobId: store.writeBlob(workspaceId, command),
    fileStatsJson: null,
    metadataJson: buildArtifactMetadata(classification, item)
  };
}

function normalizeRecoveredDiffPaths(diff: CodeDiffResult, repoPath: string | null): CodeDiffResult {
  return {
    ...diff,
    files: diff.files.map((file) => ({
      ...file,
      path: normalizeRecoveredFilePath(file.path, repoPath)
    }))
  };
}

function normalizeRecoveredFilePath(filePath: string, repoPath: string | null): string {
  if (!repoPath || !isAbsolute(filePath)) {
    return filePath.replace(/\\/g, "/");
  }
  const normalizedAbsolutePath = normalize(filePath);
  const normalizedRepoPath = normalize(repoPath);
  if (!normalizedAbsolutePath.toLowerCase().startsWith(normalizedRepoPath.toLowerCase())) {
    return filePath.replace(/\\/g, "/");
  }
  return repoRelativePath(repoPath, normalizedAbsolutePath);
}

function safeParseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function createHistoricalSnapshots(
  store: PromptreelStore,
  workspaceId: string,
  executionPath: string | null,
  seed: string
): WorkspaceSnapshot[] {
  const snapshotPath = executionPath ?? process.cwd();
  const note = JSON.stringify(
    createPlaceholderSnapshot(snapshotPath, "historical import cannot reconstruct exact workspace state"),
    null,
    2
  );
  const baselineBlobId = store.writeBlob(workspaceId, note);
  const endBlobId = store.writeBlob(workspaceId, note);
  return [
    {
      id: stableId("snapshot", `${seed}:baseline`),
      workspaceId,
      capturedAt: nowIso(),
      headSha: null,
      branchName: null,
      dirtyFileHashes: {},
      gitStatusSummary: "historical import placeholder",
      blobId: baselineBlobId
    },
    {
      id: stableId("snapshot", `${seed}:end`),
      workspaceId,
      capturedAt: nowIso(),
      headSha: null,
      branchName: null,
      dirtyFileHashes: {},
      gitStatusSummary: "historical import placeholder",
      blobId: endBlobId
    }
  ];
}

function accumulateWorkspaceResult(
  target: Record<string, WorkspaceImportCount>,
  workspaceId: string,
  addition: WorkspaceImportCount
): void {
  const existing = target[workspaceId] ?? { importedFiles: 0, importedPrompts: 0 };
  target[workspaceId] = {
    importedFiles: existing.importedFiles + addition.importedFiles,
    importedPrompts: existing.importedPrompts + addition.importedPrompts
  };
}

function computeNextActivePlanDecisions(
  filePath: string,
  promptIndex: number,
  promptText: string,
  window: SessionLine[],
  activePlanDecisions: PlanDecisionMetadata[],
  nextUserLine: SessionLine | null
): {
  finalText: string;
  planArtifactContent: { blobContent: string; metadata: PlanArtifactMetadata } | null;
  nextActivePlanDecisions: PlanDecisionMetadata[];
} {
  const promptId = buildHistoricalPromptId(filePath, promptIndex);
  const finalText = extractHistoricalFinalText(window);
  const nextUserPromptText = nextUserLine ? isUserMessage(nextUserLine) ?? null : null;
  const askedAt = window.at(-1)?.timestamp ?? window[0]?.timestamp ?? nowIso();
  const answeredAt = nextUserLine?.timestamp ?? askedAt;
  const extractedPlanDecision = extractPlanDecision(finalText, nextUserPromptText, promptId, askedAt, answeredAt);
  const currentPlanDecision = extractedPlanDecision?.decision ?? null;
  const planSourceText = extractedPlanDecision ? extractedPlanDecision.cleanedText : finalText;
  const candidatePlanDecisions = currentPlanDecision
    ? [...activePlanDecisions, currentPlanDecision]
    : [...activePlanDecisions];
  const planArtifactContent = buildPlanArtifactContent(promptText, window, planSourceText, candidatePlanDecisions);
  return {
    finalText,
    planArtifactContent,
    nextActivePlanDecisions: currentPlanDecision || planArtifactContent ? candidatePlanDecisions : [],
  };
}

function persistHistoricalPromptWindow(
  store: PromptreelStore,
  file: CodexSessionFileMatch,
  workspaceId: string,
  resolvedFolderPath: string,
  window: SessionLine[],
  promptIndex: number,
  activePlanDecisions: PlanDecisionMetadata[],
  nextUserLine: SessionLine | null,
  tailOpenPrompt: boolean
): { imported: boolean; nextActivePlanDecisions: PlanDecisionMetadata[] } {
  const userLine = window.find((line) => isUserMessage(line));
  const promptText = userLine ? isUserMessage(userLine) ?? "" : "";
  if (!promptText) {
    return {
      imported: false,
      nextActivePlanDecisions: activePlanDecisions,
    };
  }

  const promptSeed = `${file.filePath}:${promptIndex}`;
  const promptId = buildHistoricalPromptId(file.filePath, promptIndex);
  const promptMode = readHistoricalPromptMode(window);
  const snapshots = createHistoricalSnapshots(store, workspaceId, resolvedFolderPath, promptSeed);
  const prompt: PromptEventRecord = {
    id: promptId,
    workspaceId,
    executionPath: resolvedFolderPath,
    sessionId: file.sessionId || null,
    threadId: (file.threadId ?? file.sessionId) || null,
    parentPromptEventId: null,
    startedAt: userLine?.timestamp ?? nowIso(),
    endedAt: tailOpenPrompt
      ? null
      : window.at(-1)?.timestamp ?? userLine?.timestamp ?? nowIso(),
    boundaryReason: tailOpenPrompt
      ? null
      : nextUserLine
        ? "next_user_prompt"
        : "import_end",
    status: tailOpenPrompt ? "in_progress" : "imported",
    mode: promptMode,
    promptText,
    promptSummary: summarizePrompt(promptText),
    primaryArtifactId: null,
    baselineSnapshotId: snapshots[0].id,
    endSnapshotId: snapshots[1].id
  };

  const artifacts: ArtifactRecord[] = [];
  const artifactLinks: ArtifactLinkRecord[] = [];
  const toolEvents = normalizeSessionToolEvents(window);
  const {
    finalText,
    planArtifactContent,
    nextActivePlanDecisions,
  } = computeNextActivePlanDecisions(file.filePath, promptIndex, promptText, window, activePlanDecisions, nextUserLine);

  if (finalText) {
    const blobId = store.writeBlob(workspaceId, finalText);
    artifacts.push({
      id: stableId("artifact", `${promptSeed}:final_output`),
      promptEventId: promptId,
      type: "final_output",
      role: "secondary",
      summary: summarizePrompt(finalText),
      blobId,
      fileStatsJson: null,
      metadataJson: buildArtifactMetadata({
        family: "final",
        subtype: "final.answer",
        displayLabel: "answer",
      })
    });
  }

  if (planArtifactContent) {
    const blobId = store.writeBlob(workspaceId, planArtifactContent.blobContent);
    artifacts.push({
      id: stableId("artifact", `${promptSeed}:plan`),
      promptEventId: promptId,
      type: "plan",
      role: "secondary",
      summary:
        planArtifactContent.metadata.steps[0]
        ?? summarizePrompt(planArtifactContent.blobContent.replace(/^#+\s*/m, "")),
      blobId,
      fileStatsJson: null,
      metadataJson: JSON.stringify(planArtifactContent.metadata)
    });
  }

  const recoveredDiff = recoverHistoricalCodeDiff(toolEvents);
  if (recoveredDiff) {
    const normalizedDiff = normalizeRecoveredDiffPaths(recoveredDiff.diff, resolvedFolderPath);
    const diffArtifact = buildCodeDiffArtifact(promptId, normalizedDiff, {
      source: recoveredDiff.source,
      sourceFormat: recoveredDiff.sourceFormat
    });
    diffArtifact.id = stableId("artifact", `${promptSeed}:code_diff`);
    diffArtifact.blobId = store.writeBlob(workspaceId, recoveredDiff.diff.patch);
    artifacts.push(diffArtifact);
  }

  artifacts.push(
    ...createHistoricalCommandArtifacts(store, workspaceId, promptId, promptSeed, toolEvents)
  );

  const primaryType = choosePrimaryArtifactType(Boolean(planArtifactContent), Boolean(recoveredDiff), Boolean(finalText));
  if (primaryType) {
    const primary = artifacts.find((artifact) => artifact.type === primaryType);
    if (primary) {
      prompt.primaryArtifactId = primary.id;
      primary.role = "primary";
    }
  }

  const rawEvents = window.map((line, index) => ({
    record: {
      id: stableId("raw", `${promptSeed}:${index}`),
      workspaceId,
      source: "codex-session" as const,
      sessionId: file.sessionId || null,
      threadId: (file.threadId ?? file.sessionId) || null,
      eventType: `${line.type}:${String(line.payload?.type ?? "none")}`,
      occurredAt: line.timestamp ?? nowIso(),
      ingestPath: file.filePath,
      payloadBlobId: ""
    },
    payload: line
  }));

  store.persistPromptBundle(workspaceId, {
    prompt,
    snapshots,
    artifacts,
    artifactLinks,
    gitLinks: [],
    rawEvents
  });

  return {
    imported: true,
    nextActivePlanDecisions,
  };
}

function buildSessionTailState(
  file: CodexSessionFileMatch,
  lines: SessionLine[],
  trailingText = ""
): SessionTailState {
  let nextPromptIndex = 0;
  let openPromptIndex: number | null = null;
  let openWindowLines: SessionLine[] = [];
  let activePlanDecisions: PlanDecisionMetadata[] = [];

  for (const line of lines) {
    if (isUserMessage(line)) {
      if (openWindowLines.length > 0 && openPromptIndex != null) {
        const trimmedWindow = trimHistoricalWindowForBoundary(openWindowLines, line.timestamp ?? null);
        const promptText = isUserMessage(openWindowLines[0]!) ?? "";
        activePlanDecisions = computeNextActivePlanDecisions(
          file.filePath,
          openPromptIndex,
          promptText,
          trimmedWindow,
          activePlanDecisions,
          line
        ).nextActivePlanDecisions;
      }
      openPromptIndex = nextPromptIndex;
      nextPromptIndex += 1;
      openWindowLines = [line];
      continue;
    }

    if (openWindowLines.length > 0) {
      openWindowLines.push(line);
    }
  }

  return {
    lastSizeBytes: file.sizeBytes,
    trailingText,
    nextPromptIndex,
    openPromptIndex,
    openWindowLines,
    activePlanDecisions,
  };
}

function importSessionDelta(
  store: PromptreelStore,
  file: CodexSessionFileMatch,
  resolvedFolderPath: string,
  state: SessionTailState
): { importedPrompts: number; nextState: SessionTailState } {
  const appended = readSessionAppend(file.filePath, state.lastSizeBytes, state.trailingText);
  if (appended.lines.length === 0) {
    return {
      importedPrompts: 0,
      nextState: {
        ...state,
        lastSizeBytes: appended.endOffset,
        trailingText: appended.trailingText,
      },
    };
  }
  let importedPrompts = 0;
  let nextPromptIndex = state.nextPromptIndex;
  let openPromptIndex = state.openPromptIndex;
  let openWindowLines = [...state.openWindowLines];
  let activePlanDecisions = [...state.activePlanDecisions];

  for (const line of appended.lines) {
    if (isUserMessage(line)) {
      if (openWindowLines.length > 0 && openPromptIndex != null) {
        const trimmedWindow = trimHistoricalWindowForBoundary(openWindowLines, line.timestamp ?? null);
        const persisted = persistHistoricalPromptWindow(
          store,
          file,
          file.workspaceId,
          resolvedFolderPath,
          trimmedWindow,
          openPromptIndex,
          activePlanDecisions,
          line,
          false
        );
        if (persisted.imported) {
          importedPrompts += 1;
        }
        activePlanDecisions = persisted.nextActivePlanDecisions;
      }
      openPromptIndex = nextPromptIndex;
      nextPromptIndex += 1;
      openWindowLines = [line];
      continue;
    }

    if (openWindowLines.length > 0) {
      openWindowLines.push(line);
    }
  }

  if (openWindowLines.length > 0 && openPromptIndex != null) {
    const persisted = persistHistoricalPromptWindow(
      store,
      file,
      file.workspaceId,
      resolvedFolderPath,
      openWindowLines,
      openPromptIndex,
      activePlanDecisions,
      null,
      true
    );
    if (persisted.imported) {
      importedPrompts += 1;
    }
  }

  return {
    importedPrompts,
    nextState: {
      lastSizeBytes: appended.endOffset,
      trailingText: appended.trailingText,
      nextPromptIndex,
      openPromptIndex,
      openWindowLines,
      activePlanDecisions,
    },
  };
}

function importSessionFiles(
  store: PromptreelStore,
  files: CodexSessionFileMatch[],
  options: ImportCodexSessionsOptions = {}
): ImportCodexSessionsResult {
  const totals: ImportCodexSessionsResult = {
    importedFiles: 0,
    importedPrompts: 0,
    byWorkspace: {}
  };

  for (const file of files) {
    const resolvedFolderPath = file.normalizedCwd ?? store.resolveWorkspacePathAlias(file.cwd);
    if (!resolvedFolderPath) {
      continue;
    }
    const workspace = store.ensureWorkspaceGroup(resolvedFolderPath, {
      gitRootPath: resolvedFolderPath,
      gitDir: join(resolvedFolderPath, ".git"),
      source: "auto_discovered"
    });
    const cursorKey = `codex-session:v6:${file.filePath}`;
    const cursor = store.getIngestCursor(workspace.id, cursorKey);
    if (cursor && cursor.cursorValue === String(file.mtimeMs)) {
      continue;
    }

    const lines = readSessionLines(file.filePath);
    let importedPrompts = 0;
    let currentStart = -1;
    let promptIndex = 0;
    let activePlanDecisions: PlanDecisionMetadata[] = [];
    const flushWindow = (endExclusive: number) => {
      if (currentStart < 0) {
        return;
      }
      const effectiveEndExclusive = trimHistoricalWindowEndExclusive(lines, currentStart, endExclusive);
      const window = lines.slice(currentStart, effectiveEndExclusive);
      const nextUserLine = endExclusive < lines.length ? lines[endExclusive]! : null;
      const persisted = persistHistoricalPromptWindow(
        store,
        file,
        workspace.id,
        resolvedFolderPath,
        window,
        promptIndex,
        activePlanDecisions,
        nextUserLine,
        Boolean(options.tailOpenPrompt && endExclusive === lines.length)
      );
      if (persisted.imported) {
        importedPrompts += 1;
        promptIndex += 1;
      }
      activePlanDecisions = persisted.nextActivePlanDecisions;
      currentStart = -1;
    };

    lines.forEach((line, index) => {
      if (isUserMessage(line)) {
        flushWindow(index);
        currentStart = index;
      }
    });
    flushWindow(lines.length);

    store.setIngestCursor(workspace.id, cursorKey, String(file.mtimeMs ?? 0));
    totals.importedFiles += 1;
    totals.importedPrompts += importedPrompts;
    accumulateWorkspaceResult(totals.byWorkspace, workspace.id, {
      importedFiles: 1,
      importedPrompts
    });
  }

  return totals;
}

export function discoverCodexSessionFiles(
  sessionsRoot = join(homedir(), ".codex", "sessions")
): CodexSessionFileMatch[] {
  const files = walkFiles(sessionsRoot).filter((filePath) => filePath.endsWith(".jsonl")).sort();
  return files
    .map((filePath) => discoverCodexSessionFile(filePath))
    .filter((match): match is CodexSessionFileMatch => Boolean(match));
}

export function importCodexSessions(
  store: PromptreelStore,
  sessionsRoot = join(homedir(), ".codex", "sessions"),
  options: ImportCodexSessionsOptions = {}
): ImportCodexSessionsResult {
  const files = discoverCodexSessionFiles(sessionsRoot);
  return importSessionFiles(store, files, options);
}

export function importCodexSessionsForRepo(
  store: PromptreelStore,
  repo: RepoRegistration,
  sessionsRoot = join(homedir(), ".codex", "sessions"),
  options: ImportCodexSessionsOptions = {}
): { importedFiles: number; importedPrompts: number } {
  const files = discoverCodexSessionFiles(sessionsRoot).filter(
    (file) => file.normalizedCwd?.toLowerCase() === normalize(repo.rootPath).toLowerCase()
  );
  const result = importSessionFiles(store, files, options);
  return {
    importedFiles: result.importedFiles,
    importedPrompts: result.importedPrompts
  };
}

export function discoverCodexSessionFilesForRepo(
  repo: RepoRegistration,
  sessionsRoot = join(homedir(), ".codex", "sessions")
): CodexSessionFileMatch[] {
  return discoverCodexSessionFiles(sessionsRoot).filter(
    (file) => file.normalizedCwd?.toLowerCase() === normalize(repo.rootPath).toLowerCase()
  );
}

export class CodexSessionTailer {
  private readonly statusByWorkspace = new Map<string, WorkspaceIngestionStatus>();
  private readonly recentlyUpdatedSessionIdsByWorkspace = new Map<string, Set<string>>();
  private readonly trackedSessionFiles = new Map<string, CodexSessionFileMatch>();
  private readonly sessionTailStates = new Map<string, SessionTailState>();
  private readonly pendingFileTimers = new Map<string, NodeJS.Timeout>();
  private readonly listeners = new Set<(update: CodexSessionTailerUpdate) => void>();
  private watcher: FSWatcher | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private lastScanAt: string | null = null;
  private scanning = false;

  constructor(
    private readonly store: PromptreelStore,
    private readonly sessionsRoot = join(homedir(), ".codex", "sessions"),
    private readonly recoverySweepIntervalMs = SESSION_RECOVERY_SWEEP_INTERVAL_MS
  ) {}

  start(): void {
    if (this.watcher || this.recoveryTimer) {
      return;
    }
    this.rescanAll();
    this.startWatcher();
    if (this.recoverySweepIntervalMs > 0) {
      this.recoveryTimer = setInterval(() => {
        this.rescanAll();
      }, this.recoverySweepIntervalMs);
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    for (const timer of this.pendingFileTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingFileTimers.clear();
    this.sessionTailStates.clear();
  }

  scanNow(): IngestionStatus {
    this.rescanAll();
    return this.getStatus();
  }

  getStatus(): IngestionStatus {
    const workspaces = this.store.listWorkspaces();
    const workspaceStatuses = workspaces.map((workspace) => {
      const existing = this.statusByWorkspace.get(workspace.id);
      if (existing) {
        return existing;
      }
      const threads = this.store.listThreads(workspace.id);
      return {
        workspaceId: workspace.id,
        folderPath: workspace.folderPath,
        mode: "idle" as const,
        threadCount: threads.length,
        openThreadCount: threads.filter((thread) => thread.status === "open").length,
        sessionFileCount: 0,
        recentlyUpdatedSessionCount: 0,
        lastSessionUpdateAt: null,
        lastImportAt: null,
        lastImportResult: null,
        lastError: null
      };
    });

    return {
      watcher: this.watcher || this.recoveryTimer ? "running" : "stopped",
      pollingIntervalMs: 0,
      sessionsRoot: this.sessionsRoot,
      lastScanAt: this.lastScanAt,
      workspaceStatuses,
      repoStatuses: workspaceStatuses.map((status) => ({
        repoId: status.workspaceId,
        mode: status.mode,
        sessionFileCount: status.sessionFileCount,
        recentlyUpdatedSessionCount: status.recentlyUpdatedSessionCount,
        openPromptCount: status.openThreadCount,
        lastSessionUpdateAt: status.lastSessionUpdateAt,
        lastImportAt: status.lastImportAt,
        lastImportResult: status.lastImportResult,
        lastError: status.lastError
      }))
    };
  }

  getRecentlyUpdatedSessionIds(workspaceId: string): Set<string> {
    return new Set(this.recentlyUpdatedSessionIdsByWorkspace.get(workspaceId) ?? []);
  }

  subscribe(listener: (update: CodexSessionTailerUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private startWatcher(): void {
    if (!existsSync(this.sessionsRoot)) {
      return;
    }
    try {
      this.watcher = watch(this.sessionsRoot, { recursive: true }, (_eventType, filename) => {
        if (!filename) {
          this.queueFullRescan();
          return;
        }
        const resolvedPath = normalize(join(this.sessionsRoot, String(filename)));
        if (!resolvedPath.endsWith(".jsonl")) {
          return;
        }
        this.queueFileReconcile(resolvedPath);
      });
      this.watcher.on("error", () => {
        this.queueFullRescan();
      });
    } catch {
      this.watcher = null;
    }
  }

  private queueFullRescan(): void {
    this.queueFileReconcile("__full_rescan__");
  }

  private queueFileReconcile(filePath: string): void {
    const existing = this.pendingFileTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.pendingFileTimers.delete(filePath);
      if (filePath === "__full_rescan__") {
        this.rescanAll();
        return;
      }
      this.reconcileFile(filePath);
    }, SESSION_WATCH_DEBOUNCE_MS);
    this.pendingFileTimers.set(filePath, timer);
  }

  private rescanAll(): void {
    if (this.scanning) {
      return;
    }
    this.scanning = true;
    try {
      const matches = discoverCodexSessionFiles(this.sessionsRoot);
      const nextTrackedFiles = new Map(matches.map((match) => [normalize(match.filePath), match]));
      const changedWorkspaceIds = new Set<string>();
      const changedThreadKeys = new Set<string>();
      for (const match of matches) {
        const normalizedPath = normalize(match.filePath);
        const previous = this.trackedSessionFiles.get(normalizedPath);
        this.trackedSessionFiles.set(normalizedPath, match);
        if (previous && previous.mtimeMs === match.mtimeMs) {
          continue;
        }
        changedWorkspaceIds.add(match.workspaceId);
        if (match.threadId ?? match.sessionId) {
          changedThreadKeys.add(match.threadId ?? match.sessionId ?? "");
        }
        try {
          const result = importSessionFiles(this.store, [match], {
            tailOpenPrompt: true
          });
          this.sessionTailStates.set(normalizedPath, this.buildTailState(match));
          this.statusByWorkspace.set(
            match.workspaceId,
            this.buildWorkspaceStatus(match.workspaceId, {
              lastImportAt: nowIso(),
              lastImportResult: result.byWorkspace[match.workspaceId] ?? { importedFiles: 0, importedPrompts: 0 },
              lastError: null
            })
          );
        } catch (error) {
          this.sessionTailStates.delete(normalizedPath);
          this.statusByWorkspace.set(
            match.workspaceId,
            this.buildWorkspaceStatus(match.workspaceId, {
              lastError: error instanceof Error ? error.message : String(error)
            })
          );
        }
      }
      for (const [filePath, previousMatch] of [...this.trackedSessionFiles.entries()]) {
        if (nextTrackedFiles.has(filePath)) {
          continue;
        }
        this.trackedSessionFiles.delete(filePath);
        this.sessionTailStates.delete(filePath);
        this.statusByWorkspace.set(previousMatch.workspaceId, this.buildWorkspaceStatus(previousMatch.workspaceId));
        changedWorkspaceIds.add(previousMatch.workspaceId);
        if (previousMatch.threadId ?? previousMatch.sessionId) {
          changedThreadKeys.add(previousMatch.threadId ?? previousMatch.sessionId ?? "");
        }
      }
      this.refreshAllWorkspaceStatuses();
      this.lastScanAt = nowIso();
      if (changedWorkspaceIds.size > 0 || changedThreadKeys.size > 0) {
        this.emitUpdate({
          kind: "ingest",
          at: this.lastScanAt ?? nowIso(),
          workspaceIds: [...changedWorkspaceIds],
          threadKeys: [...changedThreadKeys],
        });
      }
    } finally {
      this.scanning = false;
    }
  }

  private reconcileFile(filePath: string): void {
    if (this.scanning) {
      this.queueFileReconcile(filePath);
      return;
    }
    this.scanning = true;
    try {
      const previous = this.trackedSessionFiles.get(filePath) ?? null;
      if (!existsSync(filePath)) {
        if (previous) {
          this.trackedSessionFiles.delete(filePath);
          this.sessionTailStates.delete(filePath);
          this.statusByWorkspace.set(previous.workspaceId, this.buildWorkspaceStatus(previous.workspaceId, {
            lastError: null
          }));
        }
        this.refreshAllWorkspaceStatuses();
        this.lastScanAt = nowIso();
        this.emitUpdate({
          kind: "ingest",
          at: this.lastScanAt ?? nowIso(),
          workspaceIds: previous ? [previous.workspaceId] : [],
          threadKeys: previous ? [previous.threadId ?? previous.sessionId].filter((value): value is string => Boolean(value)) : []
        });
        return;
      }
      const match = discoverCodexSessionFile(filePath);
      if (!match) {
        if (previous) {
          this.trackedSessionFiles.delete(filePath);
          this.sessionTailStates.delete(filePath);
          this.statusByWorkspace.set(previous.workspaceId, this.buildWorkspaceStatus(previous.workspaceId, {
            lastError: null
          }));
          this.refreshAllWorkspaceStatuses();
          this.emitUpdate({
            kind: "ingest",
            at: nowIso(),
            workspaceIds: [previous.workspaceId],
            threadKeys: [previous.threadId ?? previous.sessionId].filter((value): value is string => Boolean(value))
          });
        }
        this.lastScanAt = nowIso();
        return;
      }
      if (previous && previous.mtimeMs === match.mtimeMs) {
        this.lastScanAt = nowIso();
        return;
      }
      this.trackedSessionFiles.set(filePath, match);
      try {
        const deltaResult = this.tryImportDelta(match, previous);
        const result = deltaResult
          ?? importSessionFiles(this.store, [match], {
            tailOpenPrompt: true
          });
        if (!deltaResult) {
          this.sessionTailStates.set(filePath, this.buildTailState(match));
        }
        this.statusByWorkspace.set(
          match.workspaceId,
          this.buildWorkspaceStatus(match.workspaceId, {
            lastImportAt: nowIso(),
            lastImportResult: result.byWorkspace[match.workspaceId] ?? { importedFiles: 0, importedPrompts: 0 },
            lastError: null
          })
        );
      } catch (error) {
        this.sessionTailStates.delete(filePath);
        this.statusByWorkspace.set(
          match.workspaceId,
          this.buildWorkspaceStatus(match.workspaceId, {
            lastError: error instanceof Error ? error.message : String(error)
          })
        );
      }
      if (previous && previous.workspaceId !== match.workspaceId) {
        this.statusByWorkspace.set(previous.workspaceId, this.buildWorkspaceStatus(previous.workspaceId));
      }
      this.refreshAllWorkspaceStatuses();
      this.lastScanAt = nowIso();
      this.emitUpdate({
        kind: "ingest",
        at: this.lastScanAt ?? nowIso(),
        workspaceIds: [...new Set([match.workspaceId, previous?.workspaceId].filter((value): value is string => Boolean(value)))],
        threadKeys: [...new Set([match.threadId ?? match.sessionId, previous?.threadId ?? previous?.sessionId].filter((value): value is string => Boolean(value)))]
      });
    } finally {
      this.scanning = false;
    }
  }

  private refreshAllWorkspaceStatuses(): void {
    const workspaceIds = new Set([
      ...this.store.listWorkspaces().map((workspace) => workspace.id),
      ...this.statusByWorkspace.keys(),
      ...[...this.trackedSessionFiles.values()].map((match) => match.workspaceId)
    ]);
    for (const workspaceId of workspaceIds) {
      this.statusByWorkspace.set(workspaceId, this.buildWorkspaceStatus(workspaceId));
    }
  }

  private emitUpdate(update: CodexSessionTailerUpdate): void {
    for (const listener of this.listeners) {
      listener(update);
    }
  }

  private buildTailState(file: CodexSessionFileMatch): SessionTailState {
    const text = readFileSync(file.filePath, "utf8");
    const parsed = parseSessionChunk(text);
    return buildSessionTailState(file, parsed.lines, parsed.trailingText);
  }

  private tryImportDelta(
    match: CodexSessionFileMatch,
    previous: CodexSessionFileMatch | null
  ): ImportCodexSessionsResult | null {
    if (!previous) {
      return null;
    }
    if (previous.workspaceId !== match.workspaceId || previous.sessionId !== match.sessionId || previous.threadId !== match.threadId) {
      return null;
    }
    if (match.sizeBytes <= previous.sizeBytes) {
      return null;
    }
    const existingState = this.sessionTailStates.get(normalize(match.filePath));
    const resolvedFolderPath = match.normalizedCwd ?? this.store.resolveWorkspacePathAlias(match.cwd);
    if (!existingState || !resolvedFolderPath) {
      return null;
    }
    const delta = importSessionDelta(this.store, match, resolvedFolderPath, existingState);
    this.sessionTailStates.set(normalize(match.filePath), delta.nextState);
    return {
      importedFiles: 1,
      importedPrompts: delta.importedPrompts,
      byWorkspace: {
        [match.workspaceId]: {
          importedFiles: 1,
          importedPrompts: delta.importedPrompts,
        },
      },
    };
  }

  private buildWorkspaceStatus(
    workspaceId: string,
    overrides: Partial<Pick<WorkspaceIngestionStatus, "lastImportAt" | "lastImportResult" | "lastError">> = {}
  ): WorkspaceIngestionStatus {
    const previous = this.statusByWorkspace.get(workspaceId);
    const workspace = this.store.listWorkspaces().find((item) => item.id === workspaceId) ?? null;
    const workspaceMatches = [...this.trackedSessionFiles.values()].filter((match) => match.workspaceId === workspaceId);
    const recentCutoff = Date.now() - LIVE_ACTIVITY_WINDOW_MS;
    const recentlyUpdatedSessionIds = new Set(
      workspaceMatches
        .filter((match) => (match.mtimeMs ?? 0) >= recentCutoff)
        .map((match) => match.sessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId))
    );
    this.recentlyUpdatedSessionIdsByWorkspace.set(workspaceId, recentlyUpdatedSessionIds);
    const lastSessionUpdateAtMs = workspaceMatches.reduce<number | null>((latest, match) => {
      const timestamp = typeof match.mtimeMs === "number" ? match.mtimeMs : null;
      if (timestamp == null) {
        return latest;
      }
      return latest == null || timestamp > latest ? timestamp : latest;
    }, null);
    const threads = workspace ? this.store.listThreads(workspaceId) : [];
    const lastError = overrides.lastError !== undefined ? overrides.lastError : previous?.lastError ?? null;
    return {
      workspaceId,
      folderPath: workspace?.folderPath ?? previous?.folderPath ?? null,
      mode: lastError ? "error" : workspaceMatches.length > 0 ? "watching" : "idle",
      threadCount: threads.length,
      openThreadCount: threads.filter((thread) => thread.status === "open").length,
      sessionFileCount: workspaceMatches.length,
      recentlyUpdatedSessionCount: workspaceMatches.filter((match) => (match.mtimeMs ?? 0) >= recentCutoff).length,
      lastSessionUpdateAt: lastSessionUpdateAtMs ? new Date(lastSessionUpdateAtMs).toISOString() : previous?.lastSessionUpdateAt ?? null,
      lastImportAt: overrides.lastImportAt ?? previous?.lastImportAt ?? null,
      lastImportResult: overrides.lastImportResult ?? previous?.lastImportResult ?? null,
      lastError
    };
  }
}

class CodexAppServerClient {
  private readonly endpoint: string;
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, (value: unknown) => void>();
  private readonly notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  private nextId = 1;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
    this.socket = new WebSocket(endpoint);
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${this.endpoint}`)), 10_000);
      this.socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    this.socket.on("message", (data: WebSocket.RawData) => {
      const message = JSON.parse(String(data)) as JsonRpcResponse & {
        method?: string;
        params?: Record<string, unknown>;
      };
      if (typeof message.id === "number") {
        const resolver = this.pending.get(message.id);
        if (resolver) {
          this.pending.delete(message.id);
          resolver(message.result ?? message.error ?? null);
        }
        return;
      }
      if (message.method) {
        this.notifications.push({
          method: message.method,
          params: (message.params ?? {}) as Record<string, unknown>
        });
      }
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "promptreel",
        title: "Promptreel",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const resultPromise = new Promise<T>((resolve) => {
      this.pending.set(id, (value) => resolve(value as T));
    });
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return resultPromise;
  }

  drainNotifications(): Array<{ method: string; params: Record<string, unknown> }> {
    return this.notifications.splice(0, this.notifications.length);
  }

  close(): void {
    this.socket.close();
  }
}

export async function runLiveDoctor(
  store: PromptreelStore,
  repo: RepoRegistration
): Promise<LiveDoctorResult> {
  const port = 43123;
  const endpoint = `ws://127.0.0.1:${port}`;
  const child = spawn("codex", ["app-server", "--listen", endpoint], {
    stdio: "ignore",
    windowsHide: true
  });

  try {
    await waitForSocket(endpoint);
    const client = new CodexAppServerClient(endpoint);
    await client.connect();
    await client.initialize();
    const threadResponse = (await client.request<{ thread: { id: string } }>("thread/start", {
      cwd: repo.rootPath,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      ephemeral: true
    })) ?? { thread: { id: null } };
    const threadId = threadResponse.thread.id;
    const baselineSnapshot = store.createSnapshot(repo.id, captureWorkspaceSnapshot(repo.rootPath));

    await client.request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: "Run `git status -sb`, then reply with exactly `promptreel live ok`.",
          text_elements: []
        }
      ]
    });

    const startedAt = nowIso();
    let turnId: string | null = null;
    let finalText = "";
    let latestDiff = "";
    let planSteps: string[] = [];
    let promptMode: PromptMode = "default";
    let completed = false;
    let notificationCount = 0;
    const rawEvents: Array<{ record: RawEventRecord; payload: unknown }> = [];
    const commandArtifacts: ArtifactRecord[] = [];

    while (!completed) {
      const notifications = client.drainNotifications();
      for (const notification of notifications) {
        notificationCount += 1;
        rawEvents.push({
          record: {
            id: createId("raw"),
            workspaceId: repo.id,
            source: "codex-app-server",
            sessionId: null,
            threadId,
            eventType: notification.method,
            occurredAt: nowIso(),
            ingestPath: endpoint,
            payloadBlobId: ""
          },
          payload: notification
        });

        if (notification.method === "turn/started") {
          turnId = String((notification.params.turn as { id: string }).id);
        } else if (notification.method === "item/agentMessage/delta") {
          finalText += String(notification.params.delta ?? "");
        } else if (notification.method === "turn/plan/updated") {
          promptMode = "plan";
          planSteps = Array.isArray(notification.params.plan)
            ? notification.params.plan.map((step) => String((step as { step: string }).step))
            : [];
        } else if (notification.method === "turn/diff/updated") {
          latestDiff = String(notification.params.diff ?? "");
        } else if (notification.method === "item/completed") {
          const item = notification.params.item as Record<string, unknown> | undefined;
          if (item?.type === "commandExecution") {
            const artifact = createLiveCommandArtifact(store, repo.id, "", item);
            if (artifact) {
              commandArtifacts.push(artifact);
            }
          }
        } else if (notification.method === "turn/completed") {
          completed = true;
          const completedTurn = notification.params.turn as { id: string };
          turnId = completedTurn.id;
        }
      }
      if (!completed) {
        await delay(200);
      }
    }

    const endSnapshot = store.createSnapshot(repo.id, captureWorkspaceSnapshot(repo.rootPath));
    const promptEventId = createId("prompt");
    const prompt: PromptEventRecord = {
      id: promptEventId,
      workspaceId: repo.id,
      executionPath: repo.rootPath,
      sessionId: null,
      threadId,
      parentPromptEventId: null,
      startedAt,
      endedAt: nowIso(),
      boundaryReason: "turn_completed",
      status: "completed",
      mode: promptMode,
      promptText: "Run `git status -sb`, then reply with exactly `promptreel live ok`.",
      promptSummary: "Live Codex app-server doctor turn",
      primaryArtifactId: null,
      baselineSnapshotId: baselineSnapshot.id,
      endSnapshotId: endSnapshot.id
    };

    const artifacts: ArtifactRecord[] = [];
    const artifactLinks: ArtifactLinkRecord[] = [];
    const gitLinks: GitLinkRecord[] = [];

    if (finalText.trim()) {
      artifacts.push({
        id: createId("artifact"),
        promptEventId,
        type: "final_output",
        role: "secondary",
        summary: summarizePrompt(finalText),
        blobId: store.writeBlob(repo.id, finalText.trim()),
        fileStatsJson: null,
        metadataJson: buildArtifactMetadata({
          family: "final",
          subtype: "final.answer",
          displayLabel: "answer",
        })
      });
    }

    const livePlanArtifactContent = buildLivePlanArtifactContent(prompt.promptText, planSteps);
    if (livePlanArtifactContent) {
      artifacts.push({
        id: createId("artifact"),
        promptEventId,
        type: "plan",
        role: "secondary",
        summary:
          livePlanArtifactContent.metadata.steps[0]
          ?? summarizePrompt(livePlanArtifactContent.blobContent.replace(/^#+\s*/m, "")),
        blobId: store.writeBlob(repo.id, livePlanArtifactContent.blobContent),
        fileStatsJson: null,
        metadataJson: JSON.stringify(livePlanArtifactContent.metadata)
      });
    }

    const localDiff = buildCodeDiff(
      JSON.parse(store.readBlob(repo.id, baselineSnapshot.blobId)) as ReturnType<typeof captureWorkspaceSnapshot>,
      JSON.parse(store.readBlob(repo.id, endSnapshot.blobId)) as ReturnType<typeof captureWorkspaceSnapshot>
    );
    const chosenDiff = latestDiff.trim()
      ? {
          patch: latestDiff,
          files: [],
          patchIdentity: hashValue(latestDiff)
        }
      : localDiff;
    if (chosenDiff) {
      const diffArtifact = buildCodeDiffArtifact(promptEventId, chosenDiff, {
        source: latestDiff.trim() ? "app_server_diff" : "snapshot_diff",
        sourceFormat: "unified_diff"
      });
      diffArtifact.blobId = store.writeBlob(repo.id, chosenDiff.patch);
      artifacts.push(diffArtifact);
      gitLinks.push({
        id: createId("gitlink"),
        promptEventId,
        commitSha: endSnapshot.headSha,
        patchIdentity: chosenDiff.patchIdentity,
        survivalState: endSnapshot.headSha && endSnapshot.headSha !== baselineSnapshot.headSha ? "survived" : "uncommitted",
        matchedAt: nowIso()
      });
    }

    for (const artifact of commandArtifacts) {
      artifact.promptEventId = promptEventId;
      artifacts.push(artifact);
    }

    const primaryType = choosePrimaryArtifactType(Boolean(livePlanArtifactContent), Boolean(chosenDiff), Boolean(finalText.trim()));
    if (primaryType) {
      const primary = artifacts.find((artifact) => artifact.type === primaryType);
      if (primary) {
        primary.role = "primary";
        prompt.primaryArtifactId = primary.id;
      }
    }

    store.persistPromptBundle(repo.id, {
      prompt,
      snapshots: [baselineSnapshot, endSnapshot],
      artifacts,
      artifactLinks,
      gitLinks,
      rawEvents
    });
    client.close();

    return {
      ok: true,
      endpoint,
      threadId,
      turnId,
      notificationCount,
      promptEventId,
      message: "Live Codex app-server capture succeeded."
    };
  } catch (error) {
    return {
      ok: false,
      endpoint,
      threadId: null,
      turnId: null,
      notificationCount: 0,
      promptEventId: null,
      message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    child.kill();
  }
}

async function waitForSocket(endpoint: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(endpoint);
        const cleanup = () => {
          socket.removeAllListeners();
          socket.close();
        };
        socket.once("open", () => {
          cleanup();
          resolve();
        });
        socket.once("error", (error: Error) => {
          cleanup();
          reject(error);
        });
      });
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Timed out waiting for Codex app-server on ${endpoint}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
