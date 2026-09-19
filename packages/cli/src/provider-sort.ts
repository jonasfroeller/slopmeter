import type { UsageSummary } from "./interfaces";
import { heatmapThemes } from "./graph";

export type ProviderSortBy = "name" | "tokens";
export type ProviderSortDirection = "asc" | "desc";

export interface ProviderSortOptions {
  by: ProviderSortBy;
  direction: ProviderSortDirection;
}

function getProviderName(summary: UsageSummary) {
  return heatmapThemes[summary.provider].title;
}

export function getProviderTokenTotal(summary: UsageSummary) {
  return summary.daily.reduce((total, row) => total + row.total, 0);
}

function compareNumbers(left: number, right: number) {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

const providerNameCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export function compareProviderSummaries(
  left: UsageSummary,
  right: UsageSummary,
  { by, direction }: ProviderSortOptions,
) {
  const directionMultiplier = direction === "asc" ? 1 : -1;
  const primaryComparison =
    by === "name"
      ? providerNameCollator.compare(
          getProviderName(left),
          getProviderName(right),
        )
      : compareNumbers(
          getProviderTokenTotal(left),
          getProviderTokenTotal(right),
        );

  if (primaryComparison !== 0) {
    return primaryComparison * directionMultiplier;
  }

  // Keep ties deterministic without reversing the alphabetical tie-breaker.
  return providerNameCollator.compare(
    getProviderName(left),
    getProviderName(right),
  );
}

export function sortProviderSummaries(
  summaries: UsageSummary[],
  options: ProviderSortOptions,
) {
  return [...summaries].sort((left, right) =>
    compareProviderSummaries(left, right, options),
  );
}
