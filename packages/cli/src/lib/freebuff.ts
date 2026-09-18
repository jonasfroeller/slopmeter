import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

const FREEBUFF_CONFIG_DIR_ENV = "FREEBUFF_CONFIG_DIR";
const FREEBUFF_DATA_DIR_ENV = "FREEBUFF_DATA_DIR";
const FREEBUFF_API_URL_ENV = "FREEBUFF_API_URL";
const DEFAULT_FREEBUFF_API_URL = "http://127.0.0.1:12382";
const FREEBUFF_API_TIMEOUT_MS = 1_500;

export interface FreebuffUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  total_tokens?: unknown;
  model?: unknown;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }

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

function asNonNegativeNumber(value: unknown): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : 0;

  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function getDefaultFreebuffConfigDirs(): string[] {
  const configRoot = join(homedir(), ".config");

  return ["manicode", "manicode-dev", "manicode-staging"].map((suffix) =>
    join(configRoot, suffix),
  );
}

function getFreebuffSupportRoots(): string[] {
  const roots = new Set<string>();
  const home = homedir();

  if (process.env.APPDATA) {
    roots.add(join(process.env.APPDATA, "Freebuff"));
  }

  roots.add(join(home, "AppData", "Roaming", "Freebuff"));
  roots.add(join(home, "Library", "Application Support", "Freebuff"));
  roots.add(
    join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Freebuff"),
  );

  return [...roots];
}

async function getFreebuffApiUrls(): Promise<string[]> {
  const configuredUrls = process.env[FREEBUFF_API_URL_ENV]
    ?.split(",")
    .map((url) => url.trim())
    .filter((url) => url !== "")
    .map((url) => url.replace(/\/$/, ""));

  if (configuredUrls && configuredUrls.length > 0) {
    return [...new Set(configuredUrls)];
  }

  const urls = new Set<string>([DEFAULT_FREEBUFF_API_URL]);

  for (const supportRoot of getFreebuffSupportRoots()) {
    const logPath = join(supportRoot, "logs", "orchestrator-stderr.log");

    try {
      const log = await readFile(logPath, "utf8");

      for (const match of log.matchAll(/listening on (https?:\/\/[^\s]+)/gi)) {
        urls.add(match[1].replace(/\/$/, ""));
      }
    } catch {
      // The Desktop app may not be installed or may not have written its log.
    }
  }

  return [...urls];
}

async function fetchFreebuffJson(
  baseUrl: string,
  path: string,
): Promise<unknown | undefined> {
  try {
    const response = await fetch(new URL(path, `${baseUrl}/`), {
      signal: AbortSignal.timeout(FREEBUFF_API_TIMEOUT_MS),
    });

    if (!response.ok) {
      return undefined;
    }

    return await response.json();
  } catch {
    return undefined;
  }
}

interface FreebuffApiThread {
  baseUrl: string;
  id: string;
  model?: string;
}

async function getFreebuffApiThreads(): Promise<FreebuffApiThread[]> {
  const threads: FreebuffApiThread[] = [];

  for (const baseUrl of await getFreebuffApiUrls()) {
    const document = asRecord(
      await fetchFreebuffJson(baseUrl, "/api/projects"),
    );
    const projects = document?.projects;

    if (!Array.isArray(projects)) {
      continue;
    }

    for (const rawProject of projects) {
      const project = asRecord(rawProject);

      if (!project || !Array.isArray(project.threads)) {
        continue;
      }

      for (const rawThread of project.threads) {
        const thread = asRecord(rawThread);
        const id = asString(thread?.id);

        if (!id) {
          continue;
        }

        threads.push({
          baseUrl,
          id,
          model: asString(thread?.model),
        });
      }
    }
  }

  const seen = new Set<string>();

  return threads.filter((thread) => {
    const key = `${thread.baseUrl}/${thread.id}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

export function getFreebuffConfigDirs(): string[] {
  const configuredDir =
    process.env[FREEBUFF_CONFIG_DIR_ENV]?.trim() ||
    process.env[FREEBUFF_DATA_DIR_ENV]?.trim();

  if (configuredDir) {
    return [
      ...new Set(
        configuredDir
          .split(",")
          .map((dir) => dir.trim())
          .filter((dir) => dir !== "")
          .map((dir) => resolve(dir)),
      ),
    ];
  }

  return getDefaultFreebuffConfigDirs();
}

async function getFreebuffMessageFiles(): Promise<string[]> {
  const files: string[] = [];

  for (const configDir of getFreebuffConfigDirs()) {
    const projectsDir = join(configDir, "projects");

    if (!existsSync(projectsDir)) {
      continue;
    }

    const candidates = await listFilesRecursive(projectsDir, ".json");

    files.push(
      ...candidates.filter(
        (filePath) => basename(filePath) === "chat-messages.json",
      ),
    );
  }

  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

export async function isFreebuffAvailable(): Promise<boolean> {
  if ((await getFreebuffMessageFiles()).length > 0) {
    return true;
  }

  return (await getFreebuffApiThreads()).length > 0;
}

function restoreFreebuffChatIdTimestamp(value: string): string {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?)(Z|[+-]\d{2}-\d{2})?$/,
  );

  if (!match) {
    return value;
  }

  const timezone = (match[5] || "").replace(/^([+-]\d{2})-(\d{2})$/, "$1:$2");

  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}${timezone}`;
}

export function parseFreebuffTimestamp(value: unknown): Date | null {
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

  const date = new Date(restoreFreebuffChatIdTimestamp(trimmed));

  return Number.isNaN(date.getTime()) ? null : date;
}

export function createFreebuffTokenTotals(
  usage: FreebuffUsage,
): DailyTokenTotals {
  const cacheRead = asNonNegativeNumber(usage.cache_read_input_tokens);
  const cacheCreation = asNonNegativeNumber(usage.cache_creation_input_tokens);
  const input = asNonNegativeNumber(usage.input_tokens) + cacheRead;
  const output = asNonNegativeNumber(usage.output_tokens) + cacheCreation;
  const reportedTotal = asNonNegativeNumber(usage.total_tokens);

  return {
    input,
    output,
    cache: { input: cacheRead, output: cacheCreation },
    total: Math.max(reportedTotal, input + output),
  };
}

export function createFreebuffDesktopTokenTotals(
  usage: JsonRecord,
): DailyTokenTotals {
  const input = asNonNegativeNumber(usage.inputTokens);
  const output = asNonNegativeNumber(usage.outputTokens);
  const cacheRead = asNonNegativeNumber(usage.cachedInputTokens);
  const reportedTotal = asNonNegativeNumber(usage.totalTokens);

  return {
    input,
    output,
    cache: { input: cacheRead, output: 0 },
    total: Math.max(reportedTotal, input + output),
  };
}

function getUsageEntries(message: JsonRecord): JsonRecord[] {
  const metadata = asRecord(message.metadata);
  const metadataUsage = asRecord(metadata?.usage);

  if (metadataUsage) {
    return [metadataUsage];
  }

  const codebuffUsage = asRecord(asRecord(metadata?.codebuff)?.usage);

  if (codebuffUsage) {
    return [codebuffUsage];
  }

  const runState = asRecord(metadata?.runState);
  const sessionState = asRecord(runState?.sessionState);
  const mainAgentState = asRecord(sessionState?.mainAgentState);
  const messageHistory = mainAgentState?.messageHistory;

  if (Array.isArray(messageHistory)) {
    const historyUsages: JsonRecord[] = [];

    for (const historyEntry of messageHistory) {
      const providerOptions = asRecord(asRecord(historyEntry)?.providerOptions);
      const usage = asRecord(providerOptions?.usage);

      if (usage) {
        historyUsages.push(usage);
      }
    }

    if (historyUsages.length > 0) {
      return historyUsages;
    }
  }

  const messageUsage = asRecord(message.usage);

  return messageUsage ? [messageUsage] : [];
}

function getMessageDate(message: JsonRecord, filePath: string): Date | null {
  const metadata = asRecord(message.metadata);
  const timestamp =
    parseFreebuffTimestamp(metadata?.timestamp) ??
    parseFreebuffTimestamp(message.timestamp) ??
    parseFreebuffTimestamp(message.createdAt) ??
    parseFreebuffTimestamp(message.created_at);

  if (timestamp) {
    return timestamp;
  }

  return parseFreebuffTimestamp(basename(dirname(filePath)));
}

function getMessages(document: unknown): unknown[] {
  if (Array.isArray(document)) {
    return document;
  }

  const record = asRecord(document);

  return Array.isArray(record?.messages) ? record.messages : [];
}

function addFreebuffUsage(
  totals: DailyTotalsByDate,
  modelTotals: Map<string, ModelTokenTotals>,
  recentModelTotals: Map<string, ModelTokenTotals>,
  date: Date,
  recentStart: Date,
  usage: FreebuffUsage,
  message: JsonRecord,
) {
  const tokenTotals = createFreebuffTokenTotals(usage);
  const modelName = asString(usage.model) ?? asString(message.model);

  addFreebuffTokenTotals(
    totals,
    modelTotals,
    recentModelTotals,
    date,
    recentStart,
    tokenTotals,
    modelName,
  );
}

function addFreebuffTokenTotals(
  totals: DailyTotalsByDate,
  modelTotals: Map<string, ModelTokenTotals>,
  recentModelTotals: Map<string, ModelTokenTotals>,
  date: Date,
  recentStart: Date,
  tokenTotals: DailyTokenTotals,
  modelName?: string,
) {

  if (tokenTotals.total <= 0) {
    return;
  }

  const normalizedModelName = modelName
    ? normalizeModelName(modelName)
    : undefined;

  addDailyTokenTotals(totals, date, tokenTotals, normalizedModelName);

  if (!normalizedModelName) {
    return;
  }

  addModelTokenTotals(modelTotals, normalizedModelName, tokenTotals);

  if (date >= recentStart) {
    addModelTokenTotals(recentModelTotals, normalizedModelName, tokenTotals);
  }
}

async function processFreebuffApiThread(
  thread: FreebuffApiThread,
  start: Date,
  end: Date,
): Promise<{
  totals: DailyTotalsByDate;
  modelTotals: Map<string, ModelTokenTotals>;
  recentModelTotals: Map<string, ModelTokenTotals>;
}> {
  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  const recentStart = getRecentWindowStart(end, 30);
  const document = asRecord(
    await fetchFreebuffJson(
      thread.baseUrl,
      `/api/thread/${encodeURIComponent(thread.id)}`,
    ),
  );

  if (!document || !Array.isArray(document.messages)) {
    return { totals, modelTotals, recentModelTotals };
  }

  for (const rawMessage of document.messages) {
    const message = asRecord(rawMessage);
    const metrics = asRecord(message?.metrics);
    const usage = asRecord(metrics?.usage);

    if (!message || message.role !== "assistant" || !usage) {
      continue;
    }

    const date = parseFreebuffTimestamp(message.ts);

    if (!date || date < start || date > end) {
      continue;
    }

    const modelName =
      asString(usage.model) ?? asString(message.model) ?? thread.model;

    addFreebuffTokenTotals(
      totals,
      modelTotals,
      recentModelTotals,
      date,
      recentStart,
      createFreebuffDesktopTokenTotals(usage),
      modelName,
    );
  }

  return { totals, modelTotals, recentModelTotals };
}

async function processFreebuffFile(
  filePath: string,
  start: Date,
  end: Date,
): Promise<{
  totals: DailyTotalsByDate;
  modelTotals: Map<string, ModelTokenTotals>;
  recentModelTotals: Map<string, ModelTokenTotals>;
}> {
  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  const recentStart = getRecentWindowStart(end, 30);
  let document: unknown;

  try {
    document = await readJsonDocument<unknown>(filePath, {
      oversizedErrorMessage: ({ filePath, maxBytes, envVarName }) =>
        `Freebuff chat messages exceed ${maxBytes} bytes in ${filePath}. Increase ${envVarName} to process this file.`,
    });
  } catch {
    return { totals, modelTotals, recentModelTotals };
  }

  for (const rawMessage of getMessages(document)) {
    const message = asRecord(rawMessage);

    if (!message || message.role !== "assistant") {
      continue;
    }

    const date = getMessageDate(message, filePath);

    if (!date || date < start || date > end) {
      continue;
    }

    for (const usage of getUsageEntries(message)) {
      addFreebuffUsage(
        totals,
        modelTotals,
        recentModelTotals,
        date,
        recentStart,
        usage,
        message,
      );
    }
  }

  return { totals, modelTotals, recentModelTotals };
}

export async function loadFreebuffRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const files = await getFreebuffMessageFiles();
  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  const fileConcurrency = getPositiveIntegerEnv(
    FILE_PROCESS_CONCURRENCY_ENV,
    DEFAULT_FILE_PROCESS_CONCURRENCY,
  );
  const results = new Array<Awaited<ReturnType<typeof processFreebuffFile>>>(
    files.length,
  );

  await runWithConcurrency(files, fileConcurrency, async (file, index) => {
    results[index] = await processFreebuffFile(file, start, end);
  });

  for (const result of results) {
    mergeDailyTotalsByDate(totals, result.totals);
    mergeModelTotals(modelTotals, result.modelTotals);
    mergeModelTotals(recentModelTotals, result.recentModelTotals);
  }

  if (files.length === 0) {
    const apiThreads = await getFreebuffApiThreads();
    const apiResults = new Array<
      Awaited<ReturnType<typeof processFreebuffApiThread>>
    >(apiThreads.length);

    await runWithConcurrency(
      apiThreads,
      fileConcurrency,
      async (thread, index) => {
        apiResults[index] = await processFreebuffApiThread(thread, start, end);
      },
    );

    for (const result of apiResults) {
      mergeDailyTotalsByDate(totals, result.totals);
      mergeModelTotals(modelTotals, result.modelTotals);
      mergeModelTotals(recentModelTotals, result.recentModelTotals);
    }
  }

  return createUsageSummary(
    "freebuff",
    totals,
    modelTotals,
    recentModelTotals,
    end,
  );
}
