export type NormalizedPlanDocument = {
  markdown: string;
  sourceKind: "json_plan" | "markdown" | "plain_text" | "trace_fallback";
};

type ParsedPlanJson = {
  explanation?: unknown;
  steps?: unknown;
};

export function normalizePlanDocument(
  raw: string | null | undefined,
  fallbackSteps: string[] = []
): NormalizedPlanDocument | null {
  const trimmed = raw?.trim() ?? "";

  if (trimmed) {
    const parsedJson = tryParsePlanJson(trimmed);
    if (parsedJson) {
      return {
        markdown: planJsonToMarkdown(parsedJson),
        sourceKind: "json_plan",
      };
    }

    return {
      markdown: trimmed,
      sourceKind: looksLikeMarkdown(trimmed) ? "markdown" : "plain_text",
    };
  }

  if (fallbackSteps.length > 0) {
    return {
      markdown: `## Plan\n${stepsToMarkdown(fallbackSteps)}`,
      sourceKind: "trace_fallback",
    };
  }

  return null;
}

export function isWebHref(href: string | null | undefined): boolean {
  return typeof href === "string" && /^https?:\/\//i.test(href);
}

function tryParsePlanJson(raw: string): ParsedPlanJson | null {
  if (!raw.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as ParsedPlanJson;
    const hasExplanation = typeof parsed.explanation === "string" && parsed.explanation.trim().length > 0;
    const hasSteps = Array.isArray(parsed.steps) && parsed.steps.some((step) => typeof step === "string" && step.trim().length > 0);
    if (!hasExplanation && !hasSteps) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function planJsonToMarkdown(plan: ParsedPlanJson): string {
  const sections: string[] = [];

  if (typeof plan.explanation === "string" && plan.explanation.trim()) {
    sections.push(plan.explanation.trim());
  }

  const steps = Array.isArray(plan.steps)
    ? plan.steps.filter((step): step is string => typeof step === "string" && step.trim().length > 0)
    : [];

  if (steps.length > 0) {
    sections.push(`## Plan\n${stepsToMarkdown(steps)}`);
  }

  return sections.join("\n\n").trim();
}

function stepsToMarkdown(steps: string[]): string {
  return steps
    .map((step, index) => `${index + 1}. ${step.trim()}`)
    .join("\n");
}

function looksLikeMarkdown(raw: string): boolean {
  return [
    /^#{1,6}\s/m,
    /^>\s/m,
    /^([-*]|\d+\.)\s/m,
    /```/,
    /\[.+\]\(.+\)/,
    /^\|.+\|$/m,
    /^---$/m,
  ].some((pattern) => pattern.test(raw));
}
