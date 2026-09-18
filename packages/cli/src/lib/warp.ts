import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
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
  parseJsonTextWithLimit,
} from "./utils";

const WARP_DATABASE_PATH_ENV = "WARP_DATABASE_PATH";
const WARP_FALLBACK_MODEL = "Warp";

interface WarpConversationRow {
  conversation_data?: unknown;
  last_modified_at?: unknown;
}

interface WarpTokenUsageEntry {
  model_id?: unknown;
  warp_tokens?: unknown;
  byok_tokens?: unknown;
}

interface JsonRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asWarpTokenUsageEntry(
  value: unknown,
): WarpTokenUsageEntry | undefined {
  const record = asRecord(value);

  return record as WarpTokenUsageEntry | undefined;
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

function getDefaultWarpDatabasePaths() {
  const home = homedir();

  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");

    return [join(localAppData, "warp", "Warp", "data", "warp.sqlite")];
  }

  if (process.platform === "darwin") {
    const applicationSupport = join(home, "Library", "Application Support");

    return [
      join(applicationSupport, "Warp", "Warp", "data", "warp.sqlite"),
      join(applicationSupport, "dev.warp.Warp-Stable", "warp.sqlite"),
    ];
  }

  const xdgDataHome =
    process.env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");

  return [
    join(xdgDataHome, "warp", "Warp", "data", "warp.sqlite"),
    join(home, ".config", "warp", "Warp", "data", "warp.sqlite"),
  ];
}

function getWarpDatabasePath() {
  const configuredPath = process.env[WARP_DATABASE_PATH_ENV]?.trim();

  if (configuredPath) {
    const resolvedPath = resolve(configuredPath);

    return existsSync(resolvedPath) ? resolvedPath : undefined;
  }

  return getDefaultWarpDatabasePaths().find((path) => existsSync(path));
}

export function isWarpAvailable() {
  return getWarpDatabasePath() !== undefined;
}

export function parseWarpTimestamp(value: unknown): Date | null {
  if (typeof value === "number") {
    const millis = value < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const trimmed = value.trim();
  const normalized =
    trimmed.includes(" ") && !trimmed.includes("T")
      ? trimmed.replace(" ", "T")
      : trimmed;
  const date = new Date(normalized);

  return Number.isNaN(date.getTime()) ? null : date;
}

export function createWarpTokenTotals(
  usage: WarpTokenUsageEntry,
): DailyTokenTotals {
  const total =
    asNonNegativeNumber(usage.warp_tokens) +
    asNonNegativeNumber(usage.byok_tokens);

  return {
    // Warp stores a combined token count, not an input/output split. Keep the
    // total exact and follow the existing aggregate-only provider convention.
    input: total,
    output: 0,
    cache: { input: 0, output: 0 },
    total,
  };
}

function getWarpTokenUsageEntries(document: unknown): WarpTokenUsageEntry[] {
  const root = asRecord(document);
  const metadata = asRecord(root?.conversation_usage_metadata);
  const tokenUsage = metadata?.token_usage;

  if (!Array.isArray(tokenUsage)) {
    return [];
  }

  return tokenUsage
    .map(asWarpTokenUsageEntry)
    .filter((entry): entry is WarpTokenUsageEntry => entry !== undefined);
}

function parseWarpConversationData(value: unknown, sourceLabel: string) {
  const content =
    typeof value === "string"
      ? value
      : Buffer.isBuffer(value)
        ? value.toString("utf8")
        : undefined;

  if (content === undefined) {
    return undefined;
  }

  return parseJsonTextWithLimit<unknown>(content, sourceLabel);
}

function loadWarpDatabaseRows(databasePath: string): WarpConversationRow[] {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    return database
      .prepare(
        "SELECT conversation_data, last_modified_at FROM agent_conversations ORDER BY last_modified_at ASC",
      )
      .all() as WarpConversationRow[];
  } finally {
    database.close();
  }
}

function addWarpConversation(
  row: WarpConversationRow,
  databasePath: string,
  start: Date,
  end: Date,
  recentStart: Date,
  totals: DailyTotalsByDate,
  modelTotals: Map<string, ModelTokenTotals>,
  recentModelTotals: Map<string, ModelTokenTotals>,
) {
  const date = parseWarpTimestamp(row.last_modified_at);

  if (!date || date < start || date > end) {
    return;
  }

  const document = parseWarpConversationData(
    row.conversation_data,
    `${databasePath}:agent_conversations`,
  );

  if (document === undefined) {
    return;
  }

  for (const usage of getWarpTokenUsageEntries(document)) {
    const tokenTotals = createWarpTokenTotals(usage);

    if (tokenTotals.total <= 0) {
      continue;
    }

    const modelName = normalizeModelName(
      asString(usage.model_id) ?? WARP_FALLBACK_MODEL,
    );

    addDailyTokenTotals(totals, date, tokenTotals, modelName);
    addModelTokenTotals(modelTotals, modelName, tokenTotals);

    if (date >= recentStart) {
      addModelTokenTotals(recentModelTotals, modelName, tokenTotals);
    }
  }
}

export async function loadWarpRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const databasePath = getWarpDatabasePath();
  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  const recentStart = getRecentWindowStart(end, 30);

  if (!databasePath) {
    return createUsageSummary(
      "warp",
      totals,
      modelTotals,
      recentModelTotals,
      end,
    );
  }

  for (const row of loadWarpDatabaseRows(databasePath)) {
    addWarpConversation(
      row,
      databasePath,
      start,
      end,
      recentStart,
      totals,
      modelTotals,
      recentModelTotals,
    );
  }

  return createUsageSummary(
    "warp",
    totals,
    modelTotals,
    recentModelTotals,
    end,
  );
}
