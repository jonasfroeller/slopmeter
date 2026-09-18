import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { UsageSummary } from "../interfaces";
import {
  type DailyTokenTotals,
  type DailyTotalsByDate,
  type ModelTokenTotals,
  addDailyTokenTotals,
  addModelTokenTotals,
  createUsageSummary,
  getRecentWindowStart,
  normalizeModelName,
} from "./utils";

export const OLLAMA_LOG_DIR_ENV = "OLLAMA_LOG_DIR";

const OLLAMA_FALLBACK_MODEL = "Ollama";
const OLLAMA_LOG_FILE_PATTERN = /^server(?:-\d+)?\.log$/i;
const OLLAMA_MAX_LOG_BYTES = 128 * 1024 * 1024;

export interface OllamaTimingRecord {
  timestamp: Date;
  model: string;
  promptTokens: number;
  outputTokens: number;
}

interface OllamaPartialTiming {
  model: string;
  promptTokens: number;
  outputTokens: number;
}

interface OllamaRequestLog {
  date: string;
  time: string;
  status: number;
  route: string;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed === "" ? undefined : trimmed;
}

function asNonNegativeInteger(value: unknown) {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : 0;

  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0;
}

function normalizeOllamaModelName(value: unknown) {
  const model = asString(value);

  if (!model) {
    return OLLAMA_FALLBACK_MODEL;
  }

  return normalizeModelName(
    model
      .replace(/^registry\.ollama\.ai\//, "")
      .replace(/^library\//, ""),
  );
}

export function parseOllamaTimestamp(value: unknown): Date | null {
  if (value instanceof Date) {
    const copy = new Date(value);

    return Number.isNaN(copy.getTime()) ? null : copy;
  }

  if (typeof value === "number") {
    const millis = value < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const trimmed = value.trim();
  const ginTimestamp = trimmed.match(
    /^(\d{4})\/(\d{2})\/(\d{2})\s+-\s+(\d{2}:\d{2}:\d{2})$/,
  );
  const normalized = ginTimestamp
    ? `${ginTimestamp[1]}-${ginTimestamp[2]}-${ginTimestamp[3]}T${ginTimestamp[4]}`
    : trimmed;
  const date = new Date(normalized);

  return Number.isNaN(date.getTime()) ? null : date;
}

export function createOllamaTokenTotals(
  usage: Pick<OllamaTimingRecord, "promptTokens" | "outputTokens">,
): DailyTokenTotals {
  const input = asNonNegativeInteger(usage.promptTokens);
  const output = asNonNegativeInteger(usage.outputTokens);

  return {
    input,
    output,
    cache: { input: 0, output: 0 },
    total: input + output,
  };
}

function parseOllamaModelLine(line: string) {
  const match = line.match(
    /msg="template selection"\s+model=(?:"([^"]+)"|(\S+))/,
  );

  return match ? normalizeOllamaModelName(match[1] || match[2]) : undefined;
}

function parseOllamaTimingTask(line: string) {
  const match = line.match(
    /slot print_timing:\s+id\s+\d+\s+\|\s+task\s+(-?\d+)\s+\|/,
  );

  return match ? Number(match[1]) : undefined;
}

function parseOllamaRequestLog(line: string): OllamaRequestLog | undefined {
  const match = line.match(
    /\[GIN\]\s+(\d{4}\/\d{2}\/\d{2})\s+-\s+(\d{2}:\d{2}:\d{2})\s+\|\s*(\d{3})\s+\|.*?\|\s+POST\s+["'](\/api\/[^"']+)["']/,
  );

  if (!match) {
    return undefined;
  }

  return {
    date: match[1],
    time: match[2],
    status: Number(match[3]),
    route: match[4],
  };
}

export function parseOllamaLog(content: string): OllamaTimingRecord[] {
  const partialByTask = new Map<number, OllamaPartialTiming>();
  const completedTimings: OllamaPartialTiming[] = [];
  const records: OllamaTimingRecord[] = [];
  let currentModel = OLLAMA_FALLBACK_MODEL;

  for (const line of content.split(/\r?\n/)) {
    const model = parseOllamaModelLine(line);

    if (model) {
      currentModel = model;
    }

    const task = parseOllamaTimingTask(line);

    if (task !== undefined) {
      const promptMatch = line.match(
        /\|\s+prompt eval time\s*=.*?\/\s*(\d+)\s+tokens/,
      );

      if (promptMatch) {
        partialByTask.set(task, {
          model: currentModel,
          promptTokens: Number(promptMatch[1]),
          outputTokens: 0,
        });
      }

      const outputMatch = line.match(/\|\s+eval time\s*=.*?\/\s*(\d+)\s+tokens/);
      const partial = partialByTask.get(task);

      if (outputMatch && partial) {
        partial.outputTokens = Number(outputMatch[1]);
      }

      if (/\|\s+total time\s*=/.test(line) && partial) {
        completedTimings.push(partial);
        partialByTask.delete(task);
      }
    }

    const request = parseOllamaRequestLog(line);

    if (!request || completedTimings.length === 0) {
      continue;
    }

    const timing = completedTimings.shift()!;
    const timestamp = parseOllamaTimestamp(`${request.date} - ${request.time}`);

    if (
      !timestamp ||
      request.status < 200 ||
      request.status >= 300 ||
      !/^\/api\/(?:chat|generate)$/.test(request.route)
    ) {
      continue;
    }

    records.push({
      timestamp,
      model: timing.model,
      promptTokens: timing.promptTokens,
      outputTokens: timing.outputTokens,
    });
  }

  return records;
}

function getDefaultOllamaLogDirs() {
  const home = homedir();

  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");

    return [join(localAppData, "Ollama")];
  }

  if (process.platform === "darwin") {
    return [
      join(home, "Library", "Logs", "Ollama"),
      join(home, ".ollama", "logs"),
    ];
  }

  const xdgStateHome =
    process.env.XDG_STATE_HOME?.trim() || join(home, ".local", "state");

  return [
    join(home, ".ollama", "logs"),
    join(xdgStateHome, "ollama"),
    "/var/log/ollama",
  ];
}

async function getOllamaLogFilesFromRoot(root: string) {
  try {
    const rootInfo = await stat(root);

    if (rootInfo.isFile()) {
      return OLLAMA_LOG_FILE_PATTERN.test(basename(root)) ? [root] : [];
    }

    if (!rootInfo.isDirectory()) {
      return [];
    }

    const entries = await readdir(root, { withFileTypes: true });

    return entries
      .filter(
        (entry) => entry.isFile() && OLLAMA_LOG_FILE_PATTERN.test(entry.name),
      )
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

export async function getOllamaUsageFiles() {
  const configuredRoot = process.env[OLLAMA_LOG_DIR_ENV]?.trim();
  const roots = configuredRoot
    ? [resolve(configuredRoot)]
    : getDefaultOllamaLogDirs();
  const files = new Set<string>();

  for (const root of roots) {
    for (const file of await getOllamaLogFilesFromRoot(root)) {
      files.add(file);
    }
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

export async function isOllamaAvailable() {
  return (await getOllamaUsageFiles()).length > 0;
}

async function readOllamaLogFile(filePath: string) {
  try {
    const fileInfo = await stat(filePath);

    if (!fileInfo.isFile() || fileInfo.size > OLLAMA_MAX_LOG_BYTES) {
      return "";
    }

    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function loadOllamaRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  const recentStart = getRecentWindowStart(end, 30);

  for (const filePath of await getOllamaUsageFiles()) {
    const content = await readOllamaLogFile(filePath);

    for (const record of parseOllamaLog(content)) {
      if (record.timestamp < start || record.timestamp > end) {
        continue;
      }

      const tokenTotals = createOllamaTokenTotals(record);

      if (tokenTotals.total <= 0) {
        continue;
      }

      addDailyTokenTotals(
        totals,
        record.timestamp,
        tokenTotals,
        record.model,
      );
      addModelTokenTotals(modelTotals, record.model, tokenTotals);

      if (record.timestamp >= recentStart) {
        addModelTokenTotals(recentModelTotals, record.model, tokenTotals);
      }
    }
  }

  return createUsageSummary(
    "ollama",
    totals,
    modelTotals,
    recentModelTotals,
    end,
  );
}
