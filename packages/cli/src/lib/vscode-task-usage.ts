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

export interface VsCodeTaskUsagePayload {
  cacheReads?: unknown;
  cacheWrites?: unknown;
  model?: unknown;
  modelId?: unknown;
  tokensIn?: unknown;
  tokensOut?: unknown;
  totalTokens?: unknown;
}

export interface VsCodeTaskUsageOptions {
  configDirEnv: string;
  defaultConfigDirs: () => string[];
  extensionIds: string[];
  fallbackModel: string;
  provider: UsageSummary["provider"];
}

interface JsonRecord {
  [key: string]: unknown;
}

interface VsCodeTaskUiMessage {
  say?: unknown;
  text?: unknown;
  ts?: unknown;
}

interface TaskFileProcessingResult {
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

function getConfiguredTaskConfigDirs(options: VsCodeTaskUsageOptions) {
  const configuredDirs = process.env[options.configDirEnv]
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");

  const dirs = configuredDirs?.length
    ? configuredDirs.map((directory) => resolve(directory))
    : options.defaultConfigDirs().map((directory) => resolve(directory));

  return [...new Set(dirs)];
}

function getTaskDirs(options: VsCodeTaskUsageOptions) {
  const taskDirs: string[] = [];

  for (const configDir of getConfiguredTaskConfigDirs(options)) {
    const normalizedConfigDir = resolve(configDir);
    const configBasename = basename(normalizedConfigDir).toLowerCase();

    if (configBasename === "tasks") {
      taskDirs.push(normalizedConfigDir);
      continue;
    }

    if (options.extensionIds.includes(configBasename)) {
      taskDirs.push(join(normalizedConfigDir, "tasks"));
      continue;
    }

    if (configBasename === "globalstorage") {
      for (const extensionId of options.extensionIds) {
        taskDirs.push(join(normalizedConfigDir, extensionId, "tasks"));
      }
      continue;
    }

    for (const extensionId of options.extensionIds) {
      taskDirs.push(
        join(normalizedConfigDir, "globalStorage", extensionId, "tasks"),
      );
    }
  }

  return [...new Set(taskDirs)];
}

export function getDefaultVsCodeUserDataDirs() {
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

export function getDefaultPearAiUserDataDirs() {
  const home = homedir();

  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA?.trim() || join(home, "AppData", "Roaming");

    return [join(appData, "PearAI", "User")];
  }

  if (process.platform === "darwin") {
    return [
      join(home, "Library", "Application Support", "PearAI", "User"),
    ];
  }

  const xdgConfigHome =
    process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config");

  return [join(xdgConfigHome, "PearAI", "User")];
}

export async function getVsCodeTaskUsageFiles(
  options: VsCodeTaskUsageOptions,
) {
  const files: string[] = [];
  const seen = new Set<string>();

  for (const taskDir of getTaskDirs(options)) {
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

export async function isVsCodeTaskUsageAvailable(
  options: VsCodeTaskUsageOptions,
) {
  return (await getVsCodeTaskUsageFiles(options)).length > 0;
}

export function parseVsCodeTaskTimestamp(value: unknown): Date | null {
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

export function createVsCodeTaskTokenTotals(
  usage: VsCodeTaskUsagePayload,
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

function parseTaskUsage(value: unknown): VsCodeTaskUsagePayload | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value)) as
        | VsCodeTaskUsagePayload
        | undefined;
    } catch {
      return undefined;
    }
  }

  return asRecord(value) as VsCodeTaskUsagePayload | undefined;
}

function getTaskModel(
  usage: VsCodeTaskUsagePayload,
  fallbackModel: string,
) {
  return normalizeModelName(
    asString(usage.model) ?? asString(usage.modelId) ?? fallbackModel,
  );
}

function createEmptyTaskFileProcessingResult(): TaskFileProcessingResult {
  return {
    totals: new Map(),
    modelTotals: new Map(),
    recentModelTotals: new Map(),
  };
}

async function processTaskFile(
  filePath: string,
  start: Date,
  end: Date,
  fallbackModel: string,
): Promise<TaskFileProcessingResult> {
  let document: unknown;

  try {
    document = await readJsonDocument<unknown>(filePath);
  } catch {
    return createEmptyTaskFileProcessingResult();
  }

  if (!Array.isArray(document)) {
    return createEmptyTaskFileProcessingResult();
  }

  const result = createEmptyTaskFileProcessingResult();
  const recentStart = getRecentWindowStart(end, 30);

  for (const rawMessage of document) {
    const message = asRecord(rawMessage) as VsCodeTaskUiMessage | undefined;

    if (message?.say !== "api_req_started") {
      continue;
    }

    const usage = parseTaskUsage(message.text);
    const date = parseVsCodeTaskTimestamp(message.ts);

    if (!usage || !date || date < start || date > end) {
      continue;
    }

    const tokenTotals = createVsCodeTaskTokenTotals(usage);

    if (tokenTotals.total <= 0) {
      continue;
    }

    const modelName = getTaskModel(usage, fallbackModel);

    addDailyTokenTotals(result.totals, date, tokenTotals, modelName);
    addModelTokenTotals(result.modelTotals, modelName, tokenTotals);

    if (date >= recentStart) {
      addModelTokenTotals(result.recentModelTotals, modelName, tokenTotals);
    }
  }

  return result;
}

export async function loadVsCodeTaskUsageRows(
  start: Date,
  end: Date,
  options: VsCodeTaskUsageOptions,
): Promise<UsageSummary> {
  const files = await getVsCodeTaskUsageFiles(options);
  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  const fileConcurrency = getPositiveIntegerEnv(
    FILE_PROCESS_CONCURRENCY_ENV,
    DEFAULT_FILE_PROCESS_CONCURRENCY,
  );
  const results = new Array<Awaited<ReturnType<typeof processTaskFile>>>(
    files.length,
  );

  await runWithConcurrency(files, fileConcurrency, async (file, index) => {
    results[index] = await processTaskFile(
      file,
      start,
      end,
      options.fallbackModel,
    );
  });

  for (const result of results) {
    mergeDailyTotalsByDate(totals, result.totals);
    mergeModelTotals(modelTotals, result.modelTotals);
    mergeModelTotals(recentModelTotals, result.recentModelTotals);
  }

  return createUsageSummary(
    options.provider,
    totals,
    modelTotals,
    recentModelTotals,
    end,
  );
}
