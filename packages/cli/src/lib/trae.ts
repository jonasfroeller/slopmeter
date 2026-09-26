import { createDecipheriv } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  loadEnv,
  normalizeModelName,
  readJsonDocument,
} from "./utils";

const TRAE_CONFIG_DIR_ENV = "TRAE_CONFIG_DIR";
const TRAE_DATABASE_PATH_ENV = "TRAE_DATABASE_PATH";
const TRAE_DB_PATH_ENV = "TRAE_DB_PATH";
export const TRAE_SQLCIPHER_KEY_ENV = "TRAE_SQLCIPHER_KEY";
export const FALLBACK_TRAE_SQLCIPHER_KEY =
  "3605f6691095a993f03d5009c918352ef5be31ae31e8f000212b81ff058da773";
export const DEFAULT_TRAE_SQLCIPHER_KEY = FALLBACK_TRAE_SQLCIPHER_KEY;

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8");
const SQLCIPHER_PAGE_SIZE = 4096;
const SQLCIPHER_RESERVE_SIZE = 80;

interface TraeRawTokenUsage {
  prompt_tokens?: number;
  prompt_tokens_total?: number;
  input_tokens?: number;
  completion_tokens?: number;
  completion_tokens_total?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface TraeTurnContext {
  token_usage?: TraeRawTokenUsage | number | string;
  model_name?: string;
  model?: string;
  agent_model?: string;
  agent_type?: string;
  selected_model?: { name?: string };
  selectedModel?: { name?: string };
  persist_user_message_context?: {
    model_info?: {
      display_model_name?: string;
      model_name?: string;
      config_name?: string;
    };
  };
}

interface TraeChatTurnRow {
  session_id?: string;
  created_at?: number | string;
  updated_at?: number | string;
  context?: string | TraeTurnContext;
  agent_type?: string;
}

interface TraeHistoryV2Row {
  session_id?: string;
  created_at?: number | string;
  token_usage?: string | number | TraeRawTokenUsage;
  agent_type?: string;
}

function getTraeKeyCachePath(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");

    return join(appData, "slopmeter", "trae.key");
  }

  const xdgConfig =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");

  return join(xdgConfig, "slopmeter", "trae.key");
}

function getTraeDefaultBaseDirs(): string[] {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");

    return [join(appData, "Trae"), join(appData, "TRAE SOLO")];
  }

  if (process.platform === "darwin") {
    const library = join(homedir(), "Library", "Application Support");

    return [join(library, "Trae"), join(library, "TRAE SOLO")];
  }

  const xdgConfig =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");

  return [join(xdgConfig, "Trae"), join(xdgConfig, "TRAE SOLO")];
}

function getTraeBaseDirs(): string[] {
  const customDirs = process.env[TRAE_CONFIG_DIR_ENV]?.trim();

  if (customDirs) {
    return customDirs
      .split(",")
      .map((dir) => resolve(dir.trim()))
      .filter((dir) => dir !== "");
  }

  return getTraeDefaultBaseDirs();
}


function isSqliteDatabaseFile(filePath: string): boolean {
  let fileDescriptor: number | undefined;

  try {
    fileDescriptor = openSync(filePath, "r");
    const headerBuffer = Buffer.alloc(16);
    const bytesRead = readSync(fileDescriptor, headerBuffer, 0, 16, 0);

    return bytesRead === 16 && headerBuffer.equals(SQLITE_HEADER);
  } catch {
    return false;
  } finally {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }
  }
}

function verifySqlcipherKey(filePath: string, rawKey: Buffer): boolean {
  if (rawKey.length !== 32) {
    return false;
  }

  let fileDescriptor: number | undefined;

  try {
    fileDescriptor = openSync(filePath, "r");
    const pageBuffer = Buffer.alloc(SQLCIPHER_PAGE_SIZE);
    const bytesRead = readSync(
      fileDescriptor,
      pageBuffer,
      0,
      SQLCIPHER_PAGE_SIZE,
      0,
    );

    if (bytesRead < SQLCIPHER_PAGE_SIZE) {
      return false;
    }

    const ivOffset = SQLCIPHER_PAGE_SIZE - SQLCIPHER_RESERVE_SIZE;
    const iv = pageBuffer.subarray(ivOffset, ivOffset + 16);
    const cipherText = pageBuffer.subarray(16, ivOffset);

    const decipher = createDecipheriv("aes-256-cbc", rawKey, iv);

    decipher.setAutoPadding(false);

    const decrypted = Buffer.concat([
      decipher.update(cipherText),
      decipher.final(),
    ]);

    return (
      decrypted[0] === 0x10 &&
      decrypted[1] === 0x00 &&
      decrypted[4] === SQLCIPHER_RESERVE_SIZE
    );
  } catch {
    return false;
  } finally {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }
  }
}

function getCachedTraeKey(): string | undefined {
  const cachePath = getTraeKeyCachePath();

  if (!existsSync(cachePath)) {
    return undefined;
  }

  try {
    const cached = readFileSync(cachePath, "utf8").trim();

    return cached.length === 64 ? cached : undefined;
  } catch {
    return undefined;
  }
}

function saveCachedTraeKey(key: string): void {
  const cachePath = getTraeKeyCachePath();

  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, key, "utf8");
  } catch {
    // Ignore cache write failures
  }
}

export function resolveTraeKey(databasePath?: string): string | null {
  loadEnv();
  const envKey = process.env[TRAE_SQLCIPHER_KEY_ENV]?.trim();

  if (envKey && envKey.length === 64) {
    if (databasePath && existsSync(databasePath)) {
      if (verifySqlcipherKey(databasePath, Buffer.from(envKey, "hex"))) {
        saveCachedTraeKey(envKey);
        return envKey;
      }

      return null;
    }

    return envKey;
  }

  const fallbackCandidates: string[] = [];
  const cachedKey = getCachedTraeKey();

  if (cachedKey) {
    fallbackCandidates.push(cachedKey);
  }
  fallbackCandidates.push(FALLBACK_TRAE_SQLCIPHER_KEY);

  if (databasePath && existsSync(databasePath)) {
    for (const candidate of fallbackCandidates) {
      if (verifySqlcipherKey(databasePath, Buffer.from(candidate, "hex"))) {
        return candidate;
      }
    }

    return null;
  }

  return fallbackCandidates[0] ?? FALLBACK_TRAE_SQLCIPHER_KEY;
}


function parseTraeTimestamp(value: unknown): Date | null {
  if (typeof value === "number") {
    const millis = value < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === "string") {
    const numeric = Number(value);

    if (!Number.isNaN(numeric) && value.trim() !== "") {
      const millis = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
      const date = new Date(millis);

      return Number.isNaN(date.getTime()) ? null : date;
    }

    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function extractTraeTokens(
  usage?: TraeRawTokenUsage | number | string,
): DailyTokenTotals | null {
  if (!usage) {
    return null;
  }

  if (typeof usage === "number") {
    if (usage <= 0) {
      return null;
    }

    return {
      input: usage,
      output: 0,
      cache: { input: 0, output: 0 },
      total: usage,
    };
  }

  if (typeof usage === "string") {
    const numeric = Number(usage);

    if (!Number.isNaN(numeric) && usage.trim() !== "") {
      if (numeric <= 0) {
        return null;
      }

      return {
        input: numeric,
        output: 0,
        cache: { input: 0, output: 0 },
        total: numeric,
      };
    }

    try {
      const parsed = JSON.parse(usage) as TraeRawTokenUsage;

      return extractTraeTokens(parsed);
    } catch {
      return null;
    }
  }

  const prompt =
    usage.prompt_tokens_total && usage.prompt_tokens_total > 0
      ? usage.prompt_tokens_total
      : (usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completion =
    usage.completion_tokens_total && usage.completion_tokens_total > 0
      ? usage.completion_tokens_total
      : (usage.completion_tokens ?? usage.output_tokens ?? 0);
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;

  const promptIncludesCache =
    cacheRead > 0 &&
    prompt >= cacheRead &&
    (usage.total_tokens === undefined ||
      prompt + completion >= usage.total_tokens);
  const input = promptIncludesCache ? prompt : prompt + cacheRead;
  const output = completion + cacheCreation;
  const total = Math.max(usage.total_tokens ?? 0, input + output);

  if (total === 0 && input === 0 && output === 0) {
    return null;
  }

  return {
    input,
    output,
    cache: {
      input: cacheRead,
      output: cacheCreation,
    },
    total,
  };
}

function extractTraeModel(
  context?: TraeTurnContext,
  fallback = "trae",
): string {
  if (!context) {
    return normalizeModelName(fallback);
  }

  const modelInfo = context.persist_user_message_context?.model_info;
  const displayModel = modelInfo?.display_model_name?.trim();
  const validDisplay =
    displayModel && displayModel !== "-" ? displayModel : undefined;

  const rawModel =
    validDisplay ||
    modelInfo?.model_name ||
    modelInfo?.config_name ||
    context.model_name ||
    context.model ||
    context.agent_model ||
    context.selected_model?.name ||
    context.selectedModel?.name ||
    context.agent_type ||
    fallback;

  return normalizeModelName(rawModel);
}

function decryptSqlcipherDatabase(
  encryptedPath: string,
  outputPath: string,
  rawHexKey: string,
): boolean {
  try {
    const rawKey = Buffer.from(rawHexKey, "hex");

    if (rawKey.length !== 32) {
      return false;
    }

    let inDescriptor: number | undefined;
    let outDescriptor: number | undefined;

    try {
      inDescriptor = openSync(encryptedPath, "r");
      const stat = fstatSync(inDescriptor);

      if (stat.size < SQLCIPHER_PAGE_SIZE) {
        return false;
      }

      const totalPages = Math.floor(stat.size / SQLCIPHER_PAGE_SIZE);

      outDescriptor = openSync(outputPath, "w");

      const chunkPages = 512;
      const inBuffer = Buffer.alloc(SQLCIPHER_PAGE_SIZE * chunkPages);
      const outBuffer = Buffer.alloc(SQLCIPHER_PAGE_SIZE * chunkPages);
      const ivOffsetInPage = SQLCIPHER_PAGE_SIZE - SQLCIPHER_RESERVE_SIZE;

      let page = 1;

      while (page <= totalPages) {
        const pagesInChunk = Math.min(chunkPages, totalPages - page + 1);
        const bytesToRead = pagesInChunk * SQLCIPHER_PAGE_SIZE;
        const readOffset = (page - 1) * SQLCIPHER_PAGE_SIZE;

        const bytesRead = readSync(
          inDescriptor,
          inBuffer,
          0,
          bytesToRead,
          readOffset,
        );

        if (bytesRead < bytesToRead) {
          return false;
        }

        outBuffer.fill(0, 0, bytesToRead);

        for (let p = 0; p < pagesInChunk; p++) {
          const currentPageNum = page + p;
          const pageStart = p * SQLCIPHER_PAGE_SIZE;
          const iv = inBuffer.subarray(
            pageStart + ivOffsetInPage,
            pageStart + ivOffsetInPage + 16,
          );
          const dataStart = currentPageNum === 1 ? 16 : 0;
          const cipherText = inBuffer.subarray(
            pageStart + dataStart,
            pageStart + ivOffsetInPage,
          );

          const decipher = createDecipheriv("aes-256-cbc", rawKey, iv);

          decipher.setAutoPadding(false);

          const decrypted = Buffer.concat([
            decipher.update(cipherText),
            decipher.final(),
          ]);

          if (currentPageNum === 1) {
            SQLITE_HEADER.copy(outBuffer, pageStart);
            decrypted.copy(outBuffer, pageStart + 16);
          } else {
            decrypted.copy(outBuffer, pageStart);
          }
        }

        writeSync(outDescriptor, outBuffer, 0, bytesToRead, readOffset);
        page += pagesInChunk;
      }

      return true;
    } finally {
      if (inDescriptor !== undefined) {
        closeSync(inDescriptor);
      }

      if (outDescriptor !== undefined) {
        closeSync(outDescriptor);
      }
    }
  } catch {
    return false;
  }
}

async function withTraeDatabaseSnapshot<T>(
  databasePath: string,
  callback: (snapshotPath: string) => Promise<T>,
): Promise<T> {
  if (isSqliteDatabaseFile(databasePath)) {
    return await callback(databasePath);
  }

  const siblingDecrypted = join(
    resolve(databasePath, ".."),
    "database_decrypted.db",
  );

  if (existsSync(siblingDecrypted) && isSqliteDatabaseFile(siblingDecrypted)) {
    return await callback(siblingDecrypted);
  }

  const hexKey = resolveTraeKey(databasePath);

  if (!hexKey || hexKey.length !== 64) {
    throw new Error(
      `Trae database found at ${databasePath} is SQLCipher-encrypted. ` +
        `Set TRAE_DATABASE_PATH to a decrypted database or set TRAE_SQLCIPHER_KEY to decrypt.`,
    );
  }

  const snapshotDir = await mkdtemp(join(tmpdir(), "slopmeter-trae-"));
  const snapshotPath = join(snapshotDir, "trae.db");

  const decrypted = decryptSqlcipherDatabase(
    databasePath,
    snapshotPath,
    hexKey,
  );

  if (!decrypted) {
    await rm(snapshotDir, { recursive: true, force: true });
    throw new Error(
      `Failed to decrypt Trae SQLCipher database at ${databasePath} with the provided key.`,
    );
  }

  try {
    return await callback(snapshotPath);
  } finally {
    await rm(snapshotDir, { recursive: true, force: true });
  }
}

async function processTraeJsonExport(
  filePath: string,
  start: Date,
  end: Date,
  totals: DailyTotalsByDate = new Map(),
  modelTotals: Map<string, ModelTokenTotals> = new Map(),
  recentModelTotals: Map<string, ModelTokenTotals> = new Map(),
): Promise<{
  totals: DailyTotalsByDate;
  modelTotals: Map<string, ModelTokenTotals>;
  recentModelTotals: Map<string, ModelTokenTotals>;
}> {
  const recentStart = getRecentWindowStart(end, 30);

  const data = await readJsonDocument<unknown>(filePath);

  const items: unknown[] = Array.isArray(data)
    ? data
    : typeof data === "object" &&
        data !== null &&
        "list" in data &&
        Array.isArray((data as { list: unknown[] }).list)
      ? (data as { list: unknown[] }).list
      : [];

  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }

    const entry = item as Record<string, unknown>;
    const date = parseTraeTimestamp(entry.created_at ?? entry.updated_at);

    if (!date || date < start || date > end) {
      continue;
    }

    const tokenUsage =
      extractTraeTokens(entry.token_usage as TraeRawTokenUsage | undefined) ??
      extractTraeTokens(
        (entry.context as TraeTurnContext | undefined)?.token_usage,
      );

    if (!tokenUsage) {
      continue;
    }

    const modelName = extractTraeModel(
      entry.context as TraeTurnContext | undefined,
      typeof entry.agent_type === "string" ? entry.agent_type : "trae",
    );

    addDailyTokenTotals(totals, date, tokenUsage, modelName);
    addModelTokenTotals(modelTotals, modelName, tokenUsage);

    if (date >= recentStart) {
      addModelTokenTotals(recentModelTotals, modelName, tokenUsage);
    }
  }

  return { totals, modelTotals, recentModelTotals };
}

function getTraeDataSources(): string[] {
  const explicitPath =
    process.env[TRAE_DATABASE_PATH_ENV]?.trim() ||
    process.env[TRAE_DB_PATH_ENV]?.trim();

  if (explicitPath) {
    return existsSync(explicitPath) ? [resolve(explicitPath)] : [];
  }

  const sources: string[] = [];

  for (const baseDir of getTraeBaseDirs()) {
    if (!existsSync(baseDir)) {
      continue;
    }

    const priorityCandidates = [
      join(baseDir, "ModularData", "ai-agent", "database_decrypted.db"),
      join(baseDir, "ModularData", "ai-agent", "database.sqlite"),
      join(baseDir, "chat_export", "sessions.json"),
      join(baseDir, "ModularData", "ai-agent", "database.db"),
      join(baseDir, "ModularData", "ai-chat", "database.db"),
    ];

    for (const candidate of priorityCandidates) {
      if (!existsSync(candidate)) {
        continue;
      }

      if (
        candidate.endsWith(".json") ||
        isSqliteDatabaseFile(candidate) ||
        resolveTraeKey(candidate)
      ) {
        sources.push(candidate);
        break;
      }
    }
  }

  return sources;
}

export function isTraeAvailable(): boolean {
  return getTraeDataSources().length > 0;
}

function processTraeSqliteDatabase(
  databasePath: string,
  start: Date,
  end: Date,
  totals: DailyTotalsByDate = new Map(),
  modelTotals: Map<string, ModelTokenTotals> = new Map(),
  recentModelTotals: Map<string, ModelTokenTotals> = new Map(),
): {
  totals: DailyTotalsByDate;
  modelTotals: Map<string, ModelTokenTotals>;
  recentModelTotals: Map<string, ModelTokenTotals>;
} {
  const recentStart = getRecentWindowStart(end, 30);

  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const tableNames = new Set(tables.map((t) => t.name));

    const seenSessionIds = new Set<string>();

    if (tableNames.has("chat_turn")) {
      const turnCols = database
        .prepare("PRAGMA table_info(chat_turn)")
        .all() as { name: string }[];
      const turnColNames = new Set(turnCols.map((c) => c.name));
      const hasAgentType = turnColNames.has("agent_type");
      const hasUpdatedAt = turnColNames.has("updated_at");
      const hasSessionId = turnColNames.has("session_id");

      const selectCols = [
        ...(hasSessionId ? ["session_id"] : []),
        "created_at",
        ...(hasUpdatedAt ? ["updated_at"] : []),
        "context",
        ...(hasAgentType ? ["agent_type"] : []),
      ].join(", ");

      const query = database.prepare(
        `SELECT ${selectCols} FROM chat_turn WHERE context IS NOT NULL`,
      );
      const rows = query.all() as TraeChatTurnRow[];

      for (const row of rows) {
        const date = parseTraeTimestamp(row.created_at ?? row.updated_at);

        if (!date || date < start || date > end) {
          continue;
        }

        let context: TraeTurnContext | undefined;

        if (typeof row.context === "string") {
          try {
            context = JSON.parse(row.context) as TraeTurnContext;
          } catch {
            context = undefined;
          }
        } else if (row.context) {
          context = row.context;
        }

        const tokenTotals = extractTraeTokens(context?.token_usage);

        if (!tokenTotals) {
          continue;
        }

        if (row.session_id) {
          seenSessionIds.add(row.session_id);
        }

        const modelName = extractTraeModel(context, row.agent_type || "trae");

        addDailyTokenTotals(totals, date, tokenTotals, modelName);
        addModelTokenTotals(modelTotals, modelName, tokenTotals);

        if (date >= recentStart) {
          addModelTokenTotals(recentModelTotals, modelName, tokenTotals);
        }
      }
    }

    if (tableNames.has("history_v2")) {
      const histCols = database
        .prepare("PRAGMA table_info(history_v2)")
        .all() as { name: string }[];
      const histColNames = new Set(histCols.map((c) => c.name));
      const hasAgentType = histColNames.has("agent_type");
      const hasSessionId = histColNames.has("session_id");

      const selectCols = [
        ...(hasSessionId ? ["session_id"] : []),
        "created_at",
        "token_usage",
        ...(hasAgentType ? ["agent_type"] : []),
      ].join(", ");

      const query = database.prepare(
        `SELECT ${selectCols} FROM history_v2 WHERE token_usage IS NOT NULL`,
      );
      const rows = query.all() as TraeHistoryV2Row[];

      for (const row of rows) {
        if (row.session_id && seenSessionIds.has(row.session_id)) {
          continue;
        }

        const date = parseTraeTimestamp(row.created_at);

        if (!date || date < start || date > end) {
          continue;
        }

        const tokenTotals = extractTraeTokens(row.token_usage);

        if (!tokenTotals) {
          continue;
        }

        const modelName = normalizeModelName(row.agent_type || "trae");

        addDailyTokenTotals(totals, date, tokenTotals, modelName);
        addModelTokenTotals(modelTotals, modelName, tokenTotals);

        if (date >= recentStart) {
          addModelTokenTotals(recentModelTotals, modelName, tokenTotals);
        }
      }
    }

    return { totals, modelTotals, recentModelTotals };
  } finally {
    database.close();
  }
}

export async function loadTraeRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const sources = getTraeDataSources();

  if (sources.length === 0) {
    throw new Error(
      `No Trae data source found. Set TRAE_DATABASE_PATH to a decrypted database or JSON export.`,
    );
  }

  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();

  for (const source of sources) {
    if (source.endsWith(".json")) {
      await processTraeJsonExport(
        source,
        start,
        end,
        totals,
        modelTotals,
        recentModelTotals,
      );
    } else {
      await withTraeDatabaseSnapshot(source, async (snapshotPath) =>
        processTraeSqliteDatabase(
          snapshotPath,
          start,
          end,
          totals,
          modelTotals,
          recentModelTotals,
        ),
      );
    }
  }

  return createUsageSummary(
    "trae",
    totals,
    modelTotals,
    recentModelTotals,
    end,
  );
}
