import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { UsageSummary } from "../interfaces";
import {
  type DailyTotalsByDate,
  type DailyTokenTotals,
  type ModelTokenTotals,
  addDailyTokenTotals,
  addModelTokenTotals,
  createUsageSummary,
  getRecentWindowStart,
  listFilesRecursive,
  normalizeModelName,
  readJsonLines,
} from "./utils";

export const CONTINUE_CONFIG_DIR_ENV = "CONTINUE_CONFIG_DIR";

const CONTINUE_FALLBACK_MODEL = "Continue";

export interface ContinueTokenRecord {
  generatedTokens?: unknown;
  model?: unknown;
  promptTokens?: unknown;
  provider?: unknown;
  timestamp?: unknown;
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

function getContinueConfigDir() {
  const configuredPath = process.env[CONTINUE_CONFIG_DIR_ENV]?.trim();

  return configuredPath
    ? resolve(configuredPath)
    : join(homedir(), ".continue");
}

function getContinueDevDataDir() {
  return join(getContinueConfigDir(), "dev_data");
}

export async function getContinueTokenFiles() {
  const files = await listFilesRecursive(getContinueDevDataDir(), ".jsonl");

  return files.filter(
    (filePath) => basename(filePath) === "tokensGenerated.jsonl",
  );
}

export async function isContinueAvailable() {
  return (await getContinueTokenFiles()).length > 0;
}

export function parseContinueTimestamp(value: unknown): Date | null {
  if (typeof value === "number") {
    const millis = value < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const date = new Date(value.trim());

  return Number.isNaN(date.getTime()) ? null : date;
}

export function createContinueTokenTotals(
  record: ContinueTokenRecord,
): DailyTokenTotals {
  const input = asNonNegativeNumber(record.promptTokens);
  const output = asNonNegativeNumber(record.generatedTokens);

  return {
    input,
    output,
    cache: { input: 0, output: 0 },
    total: input + output,
  };
}

function getContinueModel(record: ContinueTokenRecord) {
  return normalizeModelName(
    asString(record.model) ??
      asString(record.provider) ??
      CONTINUE_FALLBACK_MODEL,
  );
}

async function getFileModificationDate(filePath: string) {
  try {
    return (await stat(filePath)).mtime;
  } catch {
    return null;
  }
}

export async function loadContinueRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  const recentStart = getRecentWindowStart(end, 30);

  for (const filePath of await getContinueTokenFiles()) {
    // Continue 0.1 telemetry has no timestamp. The file date is the least
    // surprising fallback, and keeps those recorded tokens from disappearing.
    const fallbackDate = await getFileModificationDate(filePath);

    for await (const record of readJsonLines<ContinueTokenRecord>(filePath)) {
      const date = parseContinueTimestamp(record.timestamp) ?? fallbackDate;

      if (!date || date < start || date > end) {
        continue;
      }

      const tokenTotals = createContinueTokenTotals(record);

      if (tokenTotals.total <= 0) {
        continue;
      }

      const modelName = getContinueModel(record);

      addDailyTokenTotals(totals, date, tokenTotals, modelName);
      addModelTokenTotals(modelTotals, modelName, tokenTotals);

      if (date >= recentStart) {
        addModelTokenTotals(recentModelTotals, modelName, tokenTotals);
      }
    }
  }

  return createUsageSummary(
    "continue",
    totals,
    modelTotals,
    recentModelTotals,
    end,
  );
}
