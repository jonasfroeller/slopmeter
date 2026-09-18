import type { UsageSummary } from "./interfaces";
import { isAntigravityAvailable, loadAntigravityRows } from "./lib/antigravity";
import { isAmpAvailable, loadAmpRows } from "./lib/amp";
import { isClaudeAvailable, loadClaudeRows } from "./lib/claude-code";
import { isClineAvailable, loadClineRows } from "./lib/cline";
import { isCodexAvailable, loadCodexRows } from "./lib/codex";
import { isContinueAvailable, loadContinueRows } from "./lib/continue";
import { isCursorAvailable, loadCursorRows } from "./lib/cursor";
import { isFreebuffAvailable, loadFreebuffRows } from "./lib/freebuff";
import { isFxAvailable, loadFxRows } from "./lib/fx";
import { isGeminiAvailable, loadGeminiRows } from "./lib/gemini";
import {
  defaultProviderIds,
  providerIds,
  providerStatusLabel,
  type ProviderId,
} from "./lib/interfaces";
import { isOpenCodeAvailable, loadOpenCodeRows } from "./lib/open-code";
import { isPiAvailable, loadPiRows } from "./lib/pi";
import { isRooAvailable, loadRooRows } from "./lib/roo";
import { isTraeAvailable, loadTraeRows } from "./lib/trae";
import { isGrokAvailable, loadGrokRows } from "./lib/grok";
import { isWindsurfAvailable, loadWindsurfRows } from "./lib/windsurf";
import { isWarpAvailable, loadWarpRows } from "./lib/warp";
import { hasUsage, mergeUsageSummaries } from "./lib/utils";

export { defaultProviderIds, providerIds, providerStatusLabel, type ProviderId };

interface AggregateUsageOptions {
  start: Date;
  end: Date;
  requestedProviders?: ProviderId[];
}

export interface AggregateUsageResult {
  rowsByProvider: Record<ProviderId, UsageSummary | null>;
  warnings: string[];
}

export type ProviderAvailability = Record<ProviderId, boolean>;

function createEmptyProviderAvailability(): ProviderAvailability {
  return {
    antigravity: false,
    amp: false,
    claude: false,
    cline: false,
    codex: false,
    continue: false,
    cursor: false,
    fx: false,
    freebuff: false,
    gemini: false,
    grok: false,
    opencode: false,
    pi: false,
    roo: false,
    trae: false,
    windsurf: false,
    warp: false,
  };
}

export async function isProviderAvailable(provider: ProviderId): Promise<boolean> {
  switch (provider) {
    case "antigravity":
      return isAntigravityAvailable();
    case "amp":
      return isAmpAvailable();
    case "claude":
      return isClaudeAvailable();
    case "cline":
      return isClineAvailable();
    case "codex":
      return isCodexAvailable();
    case "continue":
      return isContinueAvailable();
    case "cursor":
      return isCursorAvailable();
    case "fx":
      return isFxAvailable();
    case "freebuff":
      return isFreebuffAvailable();
    case "gemini":
      return isGeminiAvailable();
    case "grok":
      return isGrokAvailable();
    case "opencode":
      return isOpenCodeAvailable();
    case "pi":
      return isPiAvailable();
    case "roo":
      return isRooAvailable();
    case "trae":
      return isTraeAvailable();
    case "windsurf":
      return isWindsurfAvailable();
    case "warp":
      return isWarpAvailable();
    default: {
      const exhaustiveCheck: never = provider;

      throw new Error(`Unhandled provider: ${String(exhaustiveCheck)}`);
    }
  }
}

export async function getProviderAvailability(
  providers: ProviderId[] = providerIds,
): Promise<ProviderAvailability> {
  const availability = createEmptyProviderAvailability();

  for (const provider of providers) {
    availability[provider] = await isProviderAvailable(provider);
  }

  return availability;
}

export function mergeProviderUsage(
  rowsByProvider: Record<ProviderId, UsageSummary | null>,
  end: Date,
): UsageSummary | null {
  const summaries = providerIds
    .map((provider) => rowsByProvider[provider])
    .filter((summary): summary is UsageSummary => summary !== null);

  if (summaries.length === 0) {
    return null;
  }

  return mergeUsageSummaries("all", summaries, end);
}

export async function aggregateUsage({
  start,
  end,
  requestedProviders,
}: AggregateUsageOptions): Promise<AggregateUsageResult> {
  const providersToLoad = requestedProviders?.length
    ? requestedProviders
    : providerIds;
  const rowsByProvider: Record<ProviderId, UsageSummary | null> = {
    antigravity: null,
    amp: null,
    claude: null,
    cline: null,
    codex: null,
    continue: null,
    cursor: null,
    fx: null,
    freebuff: null,
    gemini: null,
    grok: null,
    opencode: null,
    pi: null,
    roo: null,
    trae: null,
    windsurf: null,
    warp: null,
  };
  const warnings: string[] = [];

  for (const provider of providersToLoad) {
    let summary: UsageSummary;

    switch (provider) {
      case "antigravity":
        summary = await loadAntigravityRows(start, end);
        break;
      case "amp":
        summary = await loadAmpRows(start, end);
        break;
      case "claude":
        summary = await loadClaudeRows(start, end);
        break;
      case "cline":
        summary = await loadClineRows(start, end);
        break;
      case "codex":
        summary = await loadCodexRows(start, end, warnings);
        break;
      case "continue":
        summary = await loadContinueRows(start, end);
        break;
      case "cursor":
        summary = await loadCursorRows(start, end);
        break;
      case "fx":
        summary = await loadFxRows(start, end);
        break;
      case "freebuff":
        summary = await loadFreebuffRows(start, end);
        break;
      case "gemini":
        summary = await loadGeminiRows(start, end);
        break;
      case "grok":
        summary = await loadGrokRows(start, end);
        break;
      case "opencode":
        summary = await loadOpenCodeRows(start, end);
        break;
      case "pi":
        summary = await loadPiRows(start, end);
        break;
      case "roo":
        summary = await loadRooRows(start, end);
        break;
      case "trae":
        summary = await loadTraeRows(start, end);
        break;
      case "windsurf":
        summary = await loadWindsurfRows(start, end);
        break;
      case "warp":
        summary = await loadWarpRows(start, end);
        break;
      default: {
        const exhaustiveCheck: never = provider;

        throw new Error(`Unhandled provider: ${String(exhaustiveCheck)}`);
      }
    }

    rowsByProvider[provider] = hasUsage(summary) ? summary : null;
  }

  return { rowsByProvider, warnings };
}
