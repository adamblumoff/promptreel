import type {
  PromptTranscriptActivity,
  PromptTranscriptEntry,
} from "@promptreel/domain";

function safeJsonParseLocal<T>(input: string | null | undefined, fallback: T): T {
  if (!input) {
    return fallback;
  }
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

function parseResponseItemArguments(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const rawArguments = typeof payload?.arguments === "string" ? payload.arguments : null;
  return safeJsonParseLocal<Record<string, unknown> | null>(rawArguments, null);
}

function parseWebSearchCallAction(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const action = payload?.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return null;
  }
  return action as Record<string, unknown>;
}

function isWebSearchFunctionCall(
  payload: Record<string, unknown>,
  parsedArguments: Record<string, unknown> | null
): boolean {
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (name === "search_query" || name === "web_search") {
    return true;
  }
  return Boolean(
    Array.isArray(parsedArguments?.search_query)
  );
}

function collectWebSearchQueries(
  parsedArguments: Record<string, unknown> | null,
  action: Record<string, unknown> | null = null
): string[] {
  const queryGroups = [
    ...(Array.isArray(parsedArguments?.search_query) ? parsedArguments.search_query : []),
  ];

  const functionQueries = queryGroups
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const query = (item as Record<string, unknown>).q;
      return typeof query === "string" ? query.trim() : null;
    })
    .filter((query): query is string => Boolean(query));

  const webSearchQueries = [
    typeof action?.query === "string" ? action.query.trim() : null,
    ...(Array.isArray(action?.queries) ? action.queries : []).map((value) =>
      typeof value === "string" ? value.trim() : null
    ),
  ].filter((query): query is string => Boolean(query));

  return [...new Set([...functionQueries, ...webSearchQueries])];
}

function summarizeWebSearchQueries(
  parsedArguments: Record<string, unknown> | null,
  action: Record<string, unknown> | null = null
): string {
  const queries = collectWebSearchQueries(parsedArguments, action);
  if (queries.length === 0) {
    return "web search";
  }
  const first = queries[0]!;
  return queries.length === 1 ? first : `${first} +${queries.length - 1}`;
}

function summarizeTranscriptCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function normalizeTranscriptActivityDetail(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const wrappedOutputMatch = trimmed.match(/(?:^|\n)Output:\s*\r?\n([\s\S]*)$/);
  if (trimmed.startsWith("Command:") && wrappedOutputMatch) {
    const outputOnly = wrappedOutputMatch[1]?.trim() ?? "";
    return outputOnly || null;
  }

  return trimmed;
}

function summarizeTranscriptOutput(value: string | null): string | null {
  const trimmed = normalizeTranscriptActivityDetail(value);
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 600 ? `${trimmed.slice(0, 600).trimEnd()}…` : trimmed;
}

function buildTranscriptActivityEntry(input: {
  occurredAt: string;
  activityType: "command" | "tool" | "search";
  label: string;
  summary: string;
  detail?: string | null;
  status?: string | null;
}): PromptTranscriptActivity {
  return {
    kind: "activity",
    occurredAt: input.occurredAt,
    activityType: input.activityType,
    label: input.label,
    summary: input.summary,
    detail: summarizeTranscriptOutput(input.detail ?? null),
    status: input.status ?? null,
  };
}

function isApplyPatchActivity(payload: Record<string, unknown>): boolean {
  return String(payload.name ?? "").trim() === "apply_patch";
}

function summarizeApplyPatchActivity(input: string | null): string {
  const patch = input?.trim() ?? "";
  if (!patch) {
    return "apply patch";
  }

  const files = [
    ...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm),
  ].map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value));

  if (files.length === 0) {
    return "apply patch";
  }

  const primaryFile = files[0]!;
  return files.length === 1
    ? `apply patch ${primaryFile}`
    : `apply patch ${primaryFile} +${files.length - 1}`;
}

function summarizeToolActivity(payload: Record<string, unknown>): string {
  if (isApplyPatchActivity(payload)) {
    return summarizeApplyPatchActivity(typeof payload.input === "string" ? payload.input : null);
  }

  const input = typeof payload.input === "string" ? payload.input.trim() : "";
  return input ? summarizeTranscriptCommand(input) : String(payload.name ?? "tool").trim() || "tool";
}

function normalizeToolActivityDetail(
  payload: Record<string, unknown>,
  output: string | null
): string | null {
  if (isApplyPatchActivity(payload)) {
    const trimmed = output?.trim() ?? "";
    if (!trimmed) {
      return null;
    }
    return /\b(failed|error|verification failed)\b/i.test(trimmed) ? trimmed : null;
  }

  return summarizeTranscriptOutput(output);
}

export function buildCompletedActivityEntry(
  occurredAt: string,
  payload: Record<string, unknown> | undefined
): PromptTranscriptActivity | null {
  const item = payload?.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const itemRecord = item as Record<string, unknown>;
  if (itemRecord.type !== "commandExecution") {
    return null;
  }

  const command = typeof itemRecord.command === "string" ? itemRecord.command.trim() : "";
  if (!command) {
    return null;
  }

  return buildTranscriptActivityEntry({
    occurredAt,
    activityType: "command",
    label: "command",
    summary: summarizeTranscriptCommand(command),
    detail: typeof itemRecord.output === "string" ? itemRecord.output : null,
    status: typeof itemRecord.status === "string" ? itemRecord.status : null,
  });
}

export function upsertResponseItemActivity(
  activityEntries: Map<string, PromptTranscriptActivity>,
  transcript: PromptTranscriptEntry[],
  occurredAt: string,
  payload: Record<string, unknown> | undefined
): PromptTranscriptActivity | null {
  const payloadType = typeof payload?.type === "string" ? payload.type : null;
  if (!payloadType) {
    return null;
  }
  const safePayload: Record<string, unknown> = payload ?? {};

  if (payloadType === "web_search_call") {
    const action = parseWebSearchCallAction(safePayload);
    if (action?.type !== "search") {
      return null;
    }
    const entry = buildTranscriptActivityEntry({
      occurredAt,
      activityType: "search",
      label: "web search",
      summary: summarizeWebSearchQueries(null, action),
      detail: null,
      status: typeof safePayload.status === "string" ? safePayload.status : null,
    });
    transcript.push(entry);
    return entry;
  }

  const callId = typeof payload?.call_id === "string" ? payload.call_id : null;
  if (!callId) {
    return null;
  }

  if (payloadType === "function_call") {
    const parsedArguments = parseResponseItemArguments(safePayload);
    if (isWebSearchFunctionCall(safePayload, parsedArguments)) {
      const entry = buildTranscriptActivityEntry({
        occurredAt,
        activityType: "search",
        label: "web search",
        summary: summarizeWebSearchQueries(parsedArguments),
        detail: null,
        status: null,
      });
      activityEntries.set(callId, entry);
      transcript.push(entry);
      return entry;
    }
    const command = typeof parsedArguments?.cmd === "string" ? parsedArguments.cmd.trim() : "";
    const entry = buildTranscriptActivityEntry({
      occurredAt,
      activityType: "command",
      label: "command",
      summary: command || String(safePayload.name ?? "function call").trim(),
      detail: null,
      status: null,
    });
    activityEntries.set(callId, entry);
    transcript.push(entry);
    return entry;
  }

  if (payloadType === "function_call_output") {
    const entry = activityEntries.get(callId);
    if (!entry) {
      return null;
    }
    entry.detail = summarizeTranscriptOutput(typeof safePayload.output === "string" ? safePayload.output : null);
    return entry;
  }

  if (payloadType === "custom_tool_call") {
    const entry = buildTranscriptActivityEntry({
      occurredAt,
      activityType: "tool",
      label: String(safePayload.name ?? "tool").trim() || "tool",
      summary: summarizeToolActivity(safePayload),
      detail: null,
      status: typeof safePayload.status === "string" ? safePayload.status : null,
    });
    activityEntries.set(callId, entry);
    transcript.push(entry);
    return entry;
  }

  if (payloadType === "custom_tool_call_output") {
    const entry = activityEntries.get(callId);
    if (!entry) {
      return null;
    }
    entry.detail = normalizeToolActivityDetail(
      safePayload,
      typeof safePayload.output === "string" ? safePayload.output : null
    );
    return entry;
  }

  return null;
}

export function buildAppServerActivityEntry(
  occurredAt: string,
  payload: { method?: unknown; params?: Record<string, unknown> }
): PromptTranscriptActivity | null {
  if (payload.method !== "item/completed") {
    return null;
  }
  const item = payload.params?.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const itemRecord = item as Record<string, unknown>;
  if (itemRecord.type !== "commandExecution") {
    return null;
  }
  const command = typeof itemRecord.command === "string" ? itemRecord.command.trim() : "";
  if (!command) {
    return null;
  }
  return buildTranscriptActivityEntry({
    occurredAt,
    activityType: "command",
    label: "command",
    summary: summarizeTranscriptCommand(command),
    detail: typeof itemRecord.output === "string" ? itemRecord.output : null,
    status: typeof itemRecord.status === "string" ? itemRecord.status : null,
  });
}
