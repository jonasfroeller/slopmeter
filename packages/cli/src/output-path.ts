import type { ProviderId } from "./lib/interfaces";

export type OutputFormat = "png" | "svg" | "json";

export interface ProviderSelectionValues {
  all: boolean;
  antigravity: boolean;
  amp: boolean;
  claude: boolean;
  codex: boolean;
  cursor: boolean;
  gemini: boolean;
  opencode: boolean;
  pi: boolean;
  trae: boolean;
  grok: boolean;
}

const outputProviderIds: ProviderId[] = [
  "antigravity",
  "amp",
  "claude",
  "codex",
  "cursor",
  "gemini",
  "opencode",
  "pi",
  "trae",
  "grok",
];


export function getRequestedProvidersForOutput(
  values: ProviderSelectionValues,
) {
  return outputProviderIds.filter((provider) => values[provider]);
}

export function getDefaultOutputSuffix(values: ProviderSelectionValues) {
  if (values.all) {
    return "_all";
  }

  const requestedProviders = getRequestedProvidersForOutput(values);

  if (requestedProviders.length === 0) {
    return "";
  }

  return `_${requestedProviders.join("_")}`;
}

export function formatFileTimestamp(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const mins = String(date.getMinutes()).padStart(2, "0");
  const secs = String(date.getSeconds()).padStart(2, "0");

  return `${y}-${m}-${d}_${hours}-${mins}-${secs}`;
}

export function getDefaultOutputPath(
  values: ProviderSelectionValues,
  format: OutputFormat,
  timestamp?: Date | null,
) {
  const timeSuffix =
    timestamp === null
      ? ""
      : `_${formatFileTimestamp(timestamp ?? new Date())}`;

  return `./heatmap-last-year${getDefaultOutputSuffix(values)}${timeSuffix}.${format}`;
}
