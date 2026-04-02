import type { PromptDetail, PromptListItem, PromptStatus } from "./types";

export function mapPromptStatuses(
  prompts: PromptListItem[]
): Record<string, PromptStatus> {
  return Object.fromEntries(
    prompts.map((prompt) => [prompt.id, prompt.status])
  ) as Record<string, PromptStatus>;
}

export function getPromptIdsNeedingDetailRefresh(
  prompts: PromptListItem[],
  previousStatuses: Partial<Record<string, PromptStatus>>,
  cachedDetails: Partial<Record<string, Pick<PromptDetail, "status" | "endedAt">>>
): string[] {
  return prompts
    .filter(
      (prompt) => {
        const cachedDetail = cachedDetails[prompt.id];
        if (!cachedDetail) return false;

        const justClosed =
          previousStatuses[prompt.id] === "in_progress" &&
          prompt.status !== "in_progress";
        const staleClosedDetail =
          prompt.status !== "in_progress" &&
          (cachedDetail.status === "in_progress" || cachedDetail.endedAt == null);

        return justClosed || staleClosedDetail;
      }
    )
    .map((prompt) => prompt.id);
}
