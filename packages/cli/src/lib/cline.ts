import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { UsageSummary } from "../interfaces";
import {
  DEFAULT_FILE_PROCESS_CONCURRENCY,
  FILE_PROCESS_CONCURRENCY_ENV,
  type DailyTotalsByDate,
  type DailyTokenTotals,
  type ModelTokenTotals,
  addDailyTokenTotals,
  addModelTokenTotals,
  createUsageSummary,
  getPositiveIntegerEnv,
  getRecentWindowStart,
  listFilesRecursive,
  mergeDailyTotalsByDate,
  mergeModelTotals,
  normalizeModelName,
  readJsonDocument,
  runWithConcurrency,
} from "./utils";

export const CLINE_CONFIG_DIR_ENV = "CLINE_CONFIG_DIR";

const CLINE_EXTENSION_IDS = ["saoudrizwan.claude-dev", "cline.cline"];
const CLINE_FALLBACK_MODEL = "Cline";

interface JsonRecord {
  [key: string]: unknown;
}

interface ClineUsagePayload {
  cacheReads?: unknown;
  cacheWrites?: unknown;
  model?: unknown;
  modelId?: unknown;
  tokensIn?: unknown;
  tokensOut?: unknown;
  totalTokens?: unknown;
}

interface ClineUiMessage {
  say?: unknown;
  text?: unknown;
  ts?: unknown;
}

interface ClineFileProcessingResult {
  totals: DailyTotalsByDate;
  modelTotals: Map<string, ModelTokenTotals>;
  recentModelTotals: Map<string, ModelTokenTotals>;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
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

function getConfiguredClineConfigDirs() {
  const configuredDirs = process.env[CLINE_CONFIG_DIR_ENV]
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");

  if (configuredDirs && configuredDirs.length > 0) {
    return configuredDirs.map((directory) => resolve(directory));
  }

  const home = homedir();

  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA?.trim() || join(home, "AppData", "Roaming");

    return [
      join(appData, "Code", "User"),
      join(appData, "Code - Insiders", "User"),
      join(appData, "VSCodium", "User"),
    ];
  }

  if (process.platform === "darwin") {
    const applicationSupport = join(home, "Library", "Application Support");

    return [
      join(applicationSupport, "Code", "User"),
      join(applicationSupport, "Code - Insiders", "User"),
      join(applicationSupport, "VSCodium", "User"),
    ];
  }

  const xdgConfigHome =
    process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config");

  return [
    join(xdgConfigHome, "Code", "User"),
    join(xdgConfigHome, "Code - Insiders", "User"),
    join(xdgConfigHome, "VSCodium", "User"),
  ];
}

function getClineTaskDirs() {
  const taskDirs: string[] = [];

  for (const configDir of getConfiguredClineConfigDirs()) {
    const normalizedConfigDir = resolve(configDir);
    const configBasename = basename(normalizedConfigDir).toLowerCase();

    if (configBasename === "tasks") {
      taskDirs.push(normalizedConfigDir);
      continue;
    }

    if (CLINE_EXTENSION_IDS.includes(configBasename)) {
      taskDirs.push(join(normalizedConfigDir, "tasks"));
      continue;
    }

    if (configBasename === "globalstorage") {
      for (const extensionId of CLINE_EXTENSION_IDS) {
        taskDirs.push(join(normalizedConfigDir, extensionId, "tasks"));
      }
      continue;
    }

    for (const extensionId of CLINE_EXTENSION_IDS) {
      taskDirs.push(
        join(normalizedConfigDir, "globalStorage", extensionId, "tasks"),
      );
    }
  }

  return [...new Set(taskDirs)];
}

export async function getClineUsageFiles() {
  const files: string[] = [];
  const seen = new Set<string>();

  for (const taskDir of getClineTaskDirs()) {
    for (const filePath of await listFilesRecursive(taskDir, ".json")) {
      if (basename(filePath) !== "ui_messages.json") {
        continue;
      }

      const key =
        process.platform === "win32" ? filePath.toLowerCase() : filePath;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      files.push(filePath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

export async function isClineAvailable() {
  return (await getClineUsageFiles()).length > 0;
}

export function parseClineTimestamp(value: unknown): Date | null {
  if (typeof value === "number") {
    const millis = value < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const trimmed = value.trim();
  const numeric = Number(trimmed);

  if (Number.isFinite(numeric)) {
    const millis = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(millis);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(trimmed);

  return Number.isNaN(date.getTime()) ? null : date;
}

export function createClineTokenTotals(
  usage: ClineUsagePayload,
): DailyTokenTotals {
  const cacheRead = asNonNegativeNumber(usage.cacheReads);
  const cacheWrite = asNonNegativeNumber(usage.cacheWrites);
  const input = asNonNegativeNumber(usage.tokensIn) + cacheRead;
  const output = asNonNegativeNumber(usage.tokensOut) + cacheWrite;
  const reportedTotal = asNonNegativeNumber(usage.totalTokens);

  return {
    input,
    output,
    cache: { input: cacheRead, output: cacheWrite },
    total: Math.max(reportedTotal, input + output),
  };
}

function parseClineUsage(value: unknown): ClineUsagePayload | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value)) as ClineUsagePayload | undefined;
    } catch {
      return undefined;
    }
  }

  return asRecord(value) as ClineUsagePayload | undefined;
}

function getClineModel(usage: ClineUsagePayload) {
  return normalizeModelName(
    asString(usage.model) ??
      asString(usage.modelId) ??
      CLINE_FALLBACK_MODEL,
  );
}

function createEmptyClineFileProcessingResult(): ClineFileProcessingResult {
  return {
    totals: new Map(),
    modelTotals: new Map(),
    recentModelTotals: new Map(),
  };
}

async function processClineFile(
  filePath: string,
  start: Date,
  end: Date,
): Promise<ClineFileProcessingResult> {
  let document: unknown;

  try {
    document = await readJsonDocument<unknown>(filePath);
  } catch {
    return createEmptyClineFileProcessingResult();
  }

  if (!Array.isArray(document)) {
    return createEmptyClineFileProcessingResult();
  }

  const result = createEmptyClineFileProcessingResult();
  const recentStart = getRecentWindowStart(end, 30);

  for (const rawMessage of document) {
    const message = asRecord(rawMessage) as ClineUiMessage | undefined;

    if (message?.say !== "api_req_started") {
      continue;
    }

    const usage = parseClineUsage(message.text);
    const date = parseClineTimestamp(message.ts);

    if (!usage || !date || date < start || date > end) {
      continue;
    }

    const tokenTotals = createClineTokenTotals(usage);

    if (tokenTotals.total <= 0) {
      continue;
    }

    const modelName = getClineModel(usage);

    addDailyTokenTotals(result.totals, date, tokenTotals, modelName);
    addModelTokenTotals(result.modelTotals, modelName, tokenTotals);

    if (date >= recentStart) {
      addModelTokenTotals(result.recentModelTotals, modelName, tokenTotals);
    }
  }

  return result;
}

export async function loadClineRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const files = await getClineUsageFiles();
  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  const fileConcurrency = getPositiveIntegerEnv(
    FILE_PROCESS_CONCURRENCY_ENV,
    DEFAULT_FILE_PROCESS_CONCURRENCY,
  );
  const results = new Array<
    Awaited<ReturnType<typeof processClineFile>>
  >(files.length);

  await runWithConcurrency(files, fileConcurrency, async (file, index) => {
    results[index] = await processClineFile(file, start, end);
  });

  for (const result of results) {
    mergeDailyTotalsByDate(totals, result.totals);
    mergeModelTotals(modelTotals, result.modelTotals);
    mergeModelTotals(recentModelTotals, result.recentModelTotals);
  }

  return createUsageSummary(
    "cline",
    totals,
    modelTotals,
    recentModelTotals,
    end,
  );
}
