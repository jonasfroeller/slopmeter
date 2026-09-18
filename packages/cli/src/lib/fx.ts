import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { UsageSummary } from "../interfaces";
import {
  type DailyTotalsByDate,
  type DailyTokenTotals,
  type ModelTokenTotals,
  addDailyTokenTotals,
  addModelTokenTotals,
  createUsageSummary,
  getRecentWindowStart,
  normalizeModelName,
} from "./utils";

const execFileAsync = promisify(execFile);

export const FX_HOME_ENV = "FX_HOME";

const FX_FALLBACK_MODEL = "FX";
const FX_USAGE_FILE_NAME = "usage.jsonl";
const FX_SOURCE_CACHE_MS = 5_000;
const FX_COMMAND_TIMEOUT_MS = 8_000;
const FX_MAX_USAGE_BYTES = 64 * 1024 * 1024;

export interface FxGenerationFact {
  billable_web_search_calls?: unknown;
  cache_read_tokens?: unknown;
  cache_write_tokens?: unknown;
  created_at_ms?: unknown;
  id?: unknown;
  input_tokens?: unknown;
  model?: unknown;
  output_tokens?: unknown;
  reasoning_tokens?: unknown;
  total_cost?: unknown;
}

interface FxUsageSource {
  id: string;
  label: string;
  content: string;
}

interface FxSourceCache {
  expiresAt: number;
  key: string;
  sources: FxUsageSource[];
}

let sourceCache: FxSourceCache | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed === "" ? undefined : trimmed;
}

function asNonNegativeNumber(value: unknown) {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : 0;

  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function decodeCommandOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!Buffer.isBuffer(value)) {
    return "";
  }

  const utf8 = value.toString("utf8");
  const nulCount = [...utf8].filter((character) => character === "\0").length;

  if (nulCount > utf8.length / 10) {
    return value.toString("utf16le");
  }

  return utf8;
}

export function parseWslDistroList(value: unknown): string[] {
  const text = decodeCommandOutput(value)
    .replaceAll("\0", "")
    .replace(/^\uFEFF/, "");
  const names = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const name = line.replace(/^\s*\*\s*/, "").trim();

    if (name === "" || /^name\s+state\s+version$/i.test(name)) {
      continue;
    }

    names.add(name);
  }

  return [...names];
}

function getConfiguredFxHome() {
  const configuredHome = process.env[FX_HOME_ENV]?.trim();

  return configuredHome ? resolve(configuredHome) : undefined;
}

function getFxSourceCacheKey() {
  return `${process.platform}:${getConfiguredFxHome() ?? "<default>"}`;
}

function getNativeFxHome() {
  return getConfiguredFxHome() ?? join(homedir(), ".fx");
}

function parseFxJsonLine(line: string): FxGenerationFact | undefined {
  try {
    const envelope = asRecord(JSON.parse(line));

    if (envelope?.kind !== "generation") {
      return undefined;
    }

    return asRecord(envelope.fact) as FxGenerationFact | undefined;
  } catch {
    return undefined;
  }
}

export function parseFxUsageJsonl(
  content: string,
  sourceId = "fx",
): FxGenerationFact[] {
  const factsById = new Map<string, FxGenerationFact>();

  for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim().replace(/^\uFEFF/, "");

    if (trimmed === "") {
      continue;
    }

    const fact = parseFxJsonLine(trimmed);

    if (!fact) {
      continue;
    }

    const id = asString(fact.id);
    const key = id
      ? `${sourceId}:${id}`
      : `${sourceId}:line-${String(lineIndex)}`;

    // FX may append cumulative updates for the same generation ID. The last
    // observation replaces the earlier one rather than being added to it.
    factsById.set(key, fact);
  }

  return [...factsById.values()];
}

export function parseFxTimestamp(value: unknown): Date | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;

  if (Number.isFinite(numeric)) {
    const millis = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(millis);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

export function createFxTokenTotals(fact: FxGenerationFact): DailyTokenTotals {
  const input = asNonNegativeNumber(fact.input_tokens);
  const output = asNonNegativeNumber(fact.output_tokens);

  return {
    input,
    output,
    cache: {
      input: asNonNegativeNumber(fact.cache_read_tokens),
      output: asNonNegativeNumber(fact.cache_write_tokens),
    },
    total: input + output,
  };
}

async function readNativeFxUsage(): Promise<string | null> {
  const usagePath = join(getNativeFxHome(), FX_USAGE_FILE_NAME);

  if (!existsSync(usagePath)) {
    return null;
  }

  try {
    const content = await readFile(usagePath);

    if (content.byteLength > FX_MAX_USAGE_BYTES) {
      return null;
    }

    return content.toString("utf8");
  } catch {
    return null;
  }
}

async function getWslDistros(): Promise<string[]> {
  if (process.platform !== "win32" || getConfiguredFxHome()) {
    return [];
  }

  try {
    const { stdout } = await execFileAsync("wsl.exe", ["--list", "--quiet"], {
      encoding: "buffer",
      maxBuffer: 1 * 1024 * 1024,
      timeout: FX_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });

    return parseWslDistroList(stdout);
  } catch {
    return [];
  }
}

async function readWslFxUsage(distro: string): Promise<string | null> {
  const command =
    'if [ -f "$HOME/.fx/usage.jsonl" ]; then cat "$HOME/.fx/usage.jsonl"; fi';

  try {
    const { stdout } = await execFileAsync(
      "wsl.exe",
      ["--distribution", distro, "--exec", "sh", "-lc", command],
      {
        encoding: "buffer",
        maxBuffer: FX_MAX_USAGE_BYTES,
        timeout: FX_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    const content = decodeCommandOutput(stdout);

    return content === "" ? null : content;
  } catch {
    return null;
  }
}

async function collectFxUsageSources(): Promise<FxUsageSource[]> {
  const key = getFxSourceCacheKey();
  const now = Date.now();

  if (sourceCache?.key === key && sourceCache.expiresAt > now) {
    return sourceCache.sources;
  }

  const sources: FxUsageSource[] = [];
  const nativeContent = await readNativeFxUsage();

  if (nativeContent) {
    sources.push({
      id: `native:${getNativeFxHome()}`,
      label: "FX",
      content: nativeContent,
    });
  }

  for (const distro of await getWslDistros()) {
    const content = await readWslFxUsage(distro);

    if (!content) {
      continue;
    }

    sources.push({
      id: `wsl:${distro}`,
      label: `FX (${distro})`,
      content,
    });
  }

  sourceCache = {
    expiresAt: now + FX_SOURCE_CACHE_MS,
    key,
    sources,
  };

  return sources;
}

export function clearFxSourceCache() {
  sourceCache = undefined;
}

export async function isFxAvailable() {
  return (await collectFxUsageSources()).length > 0;
}

function getFxModel(fact: FxGenerationFact) {
  return normalizeModelName(asString(fact.model) ?? FX_FALLBACK_MODEL);
}

export async function loadFxRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  const recentStart = getRecentWindowStart(end, 30);

  for (const source of await collectFxUsageSources()) {
    for (const fact of parseFxUsageJsonl(source.content, source.id)) {
      const date = parseFxTimestamp(fact.created_at_ms);

      if (!date || date < start || date > end) {
        continue;
      }

      const tokenTotals = createFxTokenTotals(fact);

      if (tokenTotals.total <= 0) {
        continue;
      }

      const modelName = getFxModel(fact);

      addDailyTokenTotals(totals, date, tokenTotals, modelName);
      addModelTokenTotals(modelTotals, modelName, tokenTotals);

      if (date >= recentStart) {
        addModelTokenTotals(recentModelTotals, modelName, tokenTotals);
      }
    }
  }

  return createUsageSummary("fx", totals, modelTotals, recentModelTotals, end);
}
