import type { PromptSearchItem } from "./types";

export function normalizePromptSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function filterPromptSearchItems(
  items: PromptSearchItem[],
  query: string,
  limit = 20
): PromptSearchItem[] {
  const normalizedQuery = normalizePromptSearchText(query);
  if (!normalizedQuery) {
    return [];
  }

  return items
    .filter((item) => normalizePromptSearchText(item.promptSummary).includes(normalizedQuery))
    .slice(0, limit);
}
