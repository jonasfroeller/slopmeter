import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
  mergeDailyTotalsByDate,
  mergeModelTotals,
  normalizeModelName,
  readJsonDocument,
  readJsonLines,
  runWithConcurrency,
} from "./utils";

const GROK_HOME_ENV = "GROK_HOME";
const GROK_CONFIG_DIR_ENV = "GROK_CONFIG_DIR";

export interface GrokTokenMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  modelCalls?: number;
  costUsdTicks?: number;
}

export interface GrokTurn {
  turnNumber?: number;
  endedAt?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  modelCalls?: number;
  costUsdTicks?: number;
  primaryModelId?: string;
  modelUsage?: Record<string, GrokTokenMetrics>;
}

export interface GrokSessionUsageDocument {
  sessionId?: string;
  updatedAt?: string;
  session?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cacheCreationTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    primaryModelId?: string;
    modelUsage?: Record<string, GrokTokenMetrics>;
  };
  turns?: GrokTurn[];
}

export interface GrokUpdateLine {
  timestamp?: number;
  method?: string;
  params?: {
    sessionId?: string;
    update?: {
      sessionUpdate?: string;
      prompt_id?: string;
      stop_reason?: string;
      usage?: GrokTokenMetrics & {
        modelUsage?: Record<string, GrokTokenMetrics>;
      };
    };
    _meta?: {
      agentTimestampMs?: number;
      eventId?: string;
    };
  };
}

export function getGrokBaseDir(): string {
  const envDir =
    process.env[GROK_HOME_ENV]?.trim() ||
    process.env[GROK_CONFIG_DIR_ENV]?.trim();

  if (envDir) {
    return resolve(envDir);
  }

  return join(homedir(), ".grok");
}

export function isGrokAvailable(): boolean {
  return existsSync(join(getGrokBaseDir(), "sessions"));
}

export function createGrokTokenTotals(metrics: GrokTokenMetrics): DailyTokenTotals {
  const rawInput = metrics.inputTokens ?? 0;
  const rawOutput = metrics.outputTokens ?? 0;
  const cacheRead = metrics.cachedReadTokens ?? 0;
  const cacheCreation = metrics.cacheCreationTokens ?? 0;
  const reportedTotal = metrics.totalTokens ?? 0;

  const inputIncludesCache =
    cacheRead > 0 &&
    rawInput >= cacheRead &&
    (reportedTotal <= 0 || rawInput + rawOutput >= reportedTotal);

  const input = inputIncludesCache ? rawInput : rawInput + cacheRead;
  const output = rawOutput + cacheCreation;
  const total =
    reportedTotal > 0
      ? Math.max(reportedTotal, input + output)
      : input + output;
  const reportedCostTicks = metrics.costUsdTicks ?? 0;
  const reportedCostUsd =
    Number.isFinite(reportedCostTicks) && reportedCostTicks > 0
      ? reportedCostTicks / 10_000_000_000
      : 0;
  const tokenTotals: DailyTokenTotals = {
    input,
    output,
    cache: {
      input: cacheRead,
      output: cacheCreation,
    },
    total,
  };

  if (reportedCostUsd > 0) {
    tokenTotals.reportedCost = {
      amountUsd: reportedCostUsd,
      tokens: {
        input,
        output,
        cache: { input: cacheRead, output: cacheCreation },
      },
    };
  }

  return tokenTotals;
}

export async function getGrokSessionDirs(): Promise<string[]> {
  const sessionsBase = join(getGrokBaseDir(), "sessions");

  if (!existsSync(sessionsBase)) {
    return [];
  }

  const sessionDirs: string[] = [];
  const stack = [sessionsBase];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;

    try {
      entries = await readdir(current, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }

    let isSessionDir = false;

    for (const entry of entries) {
      if (
        entry.isFile() &&
        (entry.name === "usage.json" || entry.name === "updates.jsonl")
      ) {
        isSessionDir = true;
        break;
      }
    }

    if (isSessionDir) {
      sessionDirs.push(current);
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(join(current, entry.name));
      }
    }
  }

  return sessionDirs;
}

interface ProcessSessionResult {
  totals: DailyTotalsByDate;
  modelTotals: Map<string, ModelTokenTotals>;
  recentModelTotals: Map<string, ModelTokenTotals>;
}

function addMetricsToTotals(
  totals: DailyTotalsByDate,
  modelTotals: Map<string, ModelTokenTotals>,
  recentModelTotals: Map<string, ModelTokenTotals>,
  date: Date,
  recentStart: Date,
  modelUsage: Record<string, GrokTokenMetrics> | undefined,
  fallbackModelId: string | undefined,
  fallbackMetrics: GrokTokenMetrics,
) {
  if (modelUsage && Object.keys(modelUsage).length > 0) {
    for (const [rawModelId, metrics] of Object.entries(modelUsage)) {
      const tokenTotals = createGrokTokenTotals(metrics);

      if (tokenTotals.total <= 0) {
        continue;
      }

      const modelName = normalizeModelName(rawModelId);

      addDailyTokenTotals(totals, date, tokenTotals, modelName);
      addModelTokenTotals(modelTotals, modelName, tokenTotals);

      if (date >= recentStart) {
        addModelTokenTotals(recentModelTotals, modelName, tokenTotals);
      }
    }

    return;
  }

  const tokenTotals = createGrokTokenTotals(fallbackMetrics);

  if (tokenTotals.total <= 0) {
    return;
  }

  const modelName = fallbackModelId ? normalizeModelName(fallbackModelId) : undefined;

  addDailyTokenTotals(totals, date, tokenTotals, modelName);

  if (!modelName) {
    return;
  }

  addModelTokenTotals(modelTotals, modelName, tokenTotals);

  if (date >= recentStart) {
    addModelTokenTotals(recentModelTotals, modelName, tokenTotals);
  }
}

async function processUsageJson(
  filePath: string,
  start: Date,
  end: Date,
  recentStart: Date,
): Promise<ProcessSessionResult | null> {
  let doc: GrokSessionUsageDocument;

  try {
    doc = await readJsonDocument<GrokSessionUsageDocument>(filePath, {
      oversizedErrorMessage: ({ filePath, maxBytes, envVarName }) =>
        `Grok session JSON document exceeds ${maxBytes} bytes in ${filePath}. Increase ${envVarName} to process this file.`,
    });
  } catch {
    return null;
  }

  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();

  if (Array.isArray(doc.turns) && doc.turns.length > 0) {
    for (const turn of doc.turns) {
      if (!turn.endedAt) {
        continue;
      }

      const date = new Date(turn.endedAt);

      if (Number.isNaN(date.getTime()) || date < start || date > end) {
        continue;
      }

      addMetricsToTotals(
        totals,
        modelTotals,
        recentModelTotals,
        date,
        recentStart,
        turn.modelUsage,
        turn.primaryModelId,
        turn,
      );
    }

    return { totals, modelTotals, recentModelTotals };
  }

  if (doc.session && doc.updatedAt) {
    const date = new Date(doc.updatedAt);

    if (!Number.isNaN(date.getTime()) && date >= start && date <= end) {
      addMetricsToTotals(
        totals,
        modelTotals,
        recentModelTotals,
        date,
        recentStart,
        doc.session.modelUsage,
        doc.session.primaryModelId,
        doc.session,
      );
    }
  }

  return { totals, modelTotals, recentModelTotals };
}

async function processUpdatesJsonl(
  filePath: string,
  start: Date,
  end: Date,
  recentStart: Date,
): Promise<ProcessSessionResult | null> {
  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  const seenTurns = new Set<string>();

  try {
    for await (const line of readJsonLines<GrokUpdateLine>(filePath)) {
      const update = line.params?.update;

      if (update?.sessionUpdate !== "turn_completed" || !update.usage) {
        continue;
      }

      const turnKey =
        update.prompt_id ||
        line.params?._meta?.eventId ||
        `${line.params?.sessionId ?? ""}-${line.timestamp ?? ""}`;

      if (seenTurns.has(turnKey)) {
        continue;
      }

      seenTurns.add(turnKey);

      const timestampMs =
        line.params?._meta?.agentTimestampMs ??
        (line.timestamp ? line.timestamp * 1000 : null);

      if (!timestampMs) {
        continue;
      }

      const date = new Date(timestampMs);

      if (Number.isNaN(date.getTime()) || date < start || date > end) {
        continue;
      }

      addMetricsToTotals(
        totals,
        modelTotals,
        recentModelTotals,
        date,
        recentStart,
        update.usage.modelUsage,
        undefined,
        update.usage,
      );
    }
  } catch {
    return null;
  }

  return { totals, modelTotals, recentModelTotals };
}

async function processGrokSession(
  sessionDir: string,
  start: Date,
  end: Date,
  recentStart: Date,
): Promise<ProcessSessionResult | null> {
  const usageJsonPath = join(sessionDir, "usage.json");

  if (existsSync(usageJsonPath)) {
    const result = await processUsageJson(usageJsonPath, start, end, recentStart);

    if (result && result.totals.size > 0) {
      return result;
    }
  }

  const updatesJsonlPath = join(sessionDir, "updates.jsonl");

  if (existsSync(updatesJsonlPath)) {
    return processUpdatesJsonl(updatesJsonlPath, start, end, recentStart);
  }

  return null;
}

export async function loadGrokRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const sessionDirs = await getGrokSessionDirs();
  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  const recentStart = getRecentWindowStart(end, 30);
  const fileConcurrency = getPositiveIntegerEnv(
    FILE_PROCESS_CONCURRENCY_ENV,
    DEFAULT_FILE_PROCESS_CONCURRENCY,
  );

  const results = new Array<ProcessSessionResult | null>(sessionDirs.length);

  await runWithConcurrency(sessionDirs, fileConcurrency, async (dir, index) => {
    results[index] = await processGrokSession(dir, start, end, recentStart);
  });

  for (const result of results) {
    if (!result) {
      continue;
    }

    mergeDailyTotalsByDate(totals, result.totals);
    mergeModelTotals(modelTotals, result.modelTotals);
    mergeModelTotals(recentModelTotals, result.recentModelTotals);
  }

  return createUsageSummary(
    "grok",
    totals,
    modelTotals,
    recentModelTotals,
    end,
  );
}
