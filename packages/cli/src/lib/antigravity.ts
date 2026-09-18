import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import type { UsageSummary } from "../interfaces";
import {
  type CodeiumConnectionInfo,
  aggregateCodeiumDebugUsage,
  aggregateCodeiumTrajectoryUsage,
  callLanguageServerRpc,
  chooseWorkingHttpPort,
  collectDebugStepMessages,
  decodeUtf8,
  encodeGetUserTrajectoryDebugRequest,
  extractStepModelUsagePayloads,
  formatCodeiumModelName,
  getNetstatListeningPortsByPid,
  getProtoBytes,
  getRepeatedProtoBytes,
  mergeModelLabelMaps,
  mergeTrajectoryIds,
  parseCsrfTokenFromCommandLine,
  parseGeneratorMetadataUsage,
  parseGetAllCascadeTrajectoriesResponse,
  parseGetCascadeModelConfigDataResponse,
  parseGetCommandModelConfigsResponse,
  parseModelUsageStats,
  parseProtoFields,
  parseTimestamp,
  parseUnixLanguageServerProcesses,
  parseWindowsProcessJsonOutput,
} from "./codeium-rpc";
import {
  type DailyTotalsByDate,
  type ModelTokenTotals,
  addDailyTokenTotals,
  addModelTokenTotals,
  createUsageSummary,
  getPositiveIntegerEnv,
  getRecentWindowStart,
  listFilesRecursive,
} from "./utils";

const execFileAsync = promisify(execFile);

const ANTIGRAVITY_CONFIG_DIR_ENV = "ANTIGRAVITY_CONFIG_DIR";
const ANTIGRAVITY_CONVERSATIONS_DIR_ENV = "ANTIGRAVITY_CONVERSATIONS_DIR";
const ANTIGRAVITY_LOG_PATH_ENV = "ANTIGRAVITY_LOG_PATH";
const ANTIGRAVITY_LS_PID_ENV = "ANTIGRAVITY_LS_PID";
const ANTIGRAVITY_LS_HTTP_PORT_ENV = "ANTIGRAVITY_LS_HTTP_PORT";
const ANTIGRAVITY_LS_CSRF_TOKEN_ENV = "ANTIGRAVITY_LS_CSRF_TOKEN";
const ANTIGRAVITY_STATE_DB_PATH_ENV = "ANTIGRAVITY_STATE_DB_PATH";
const ANTIGRAVITY_MAX_TRAJECTORIES_ENV = "ANTIGRAVITY_MAX_TRAJECTORIES";
const ANTIGRAVITY_MAX_STEP_PAGES_ENV = "ANTIGRAVITY_MAX_STEP_PAGES";
const ANTIGRAVITY_STATE_DB_RELATIVE_PATH = join(
  "User",
  "globalStorage",
  "state.vscdb",
);
const ANTIGRAVITY_TRAJECTORY_SUMMARY_KEYS = [
  "antigravityUnifiedStateSync.trajectorySummaries",
  "unifiedStateSync.trajectorySummaries",
] as const;

const DEFAULT_MAX_TRAJECTORIES = 1_000;
const DEFAULT_MAX_STEP_PAGES = 100;
const CONNECTION_CACHE_MS = 10_000;

interface AntigravityLogLaunchRecord {
  pid: number;
  httpPort?: number;
  httpsPort?: number;
}

const antigravityModelNames = new Map<number, string>([
  [0, "MODEL_UNSPECIFIED"],
  [235, "MODEL_CHAT_20706"],
  [246, "MODEL_GOOGLE_GEMINI_2_5_PRO"],
  [269, "MODEL_CHAT_23310"],
  [281, "MODEL_CLAUDE_4_SONNET"],
  [282, "MODEL_CLAUDE_4_SONNET_THINKING"],
  [290, "MODEL_CLAUDE_4_OPUS"],
  [291, "MODEL_CLAUDE_4_OPUS_THINKING"],
  [312, "MODEL_GOOGLE_GEMINI_2_5_FLASH"],
  [313, "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING"],
  [323, "MODEL_GOOGLE_GEMINI_TRAINING_POLICY"],
  [326, "MODEL_GOOGLE_GEMINI_INTERNAL_BYOM"],
  [327, "MODEL_GOOGLE_GEMINI_FOR_GOOGLE_2_5_PRO"],
  [328, "MODEL_GOOGLE_GEMINI_NEMOSREEF"],
  [329, "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING_TOOLS"],
  [330, "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE"],
  [331, "MODEL_GOOGLE_GEMINI_2_5_PRO_EVAL"],
  [332, "MODEL_GOOGLE_GEMINI_2_5_FLASH_IMAGE_PREVIEW"],
  [333, "MODEL_CLAUDE_4_5_SONNET"],
  [334, "MODEL_CLAUDE_4_5_SONNET_THINKING"],
  [335, "MODEL_GOOGLE_GEMINI_COMPUTER_USE_EXPERIMENTAL"],
  [336, "MODEL_GOOGLE_GEMINI_HORIZONDAWN"],
  [337, "MODEL_GOOGLE_GEMINI_PUREPRISM"],
  [338, "MODEL_GOOGLE_GEMINI_GENTLEISLAND"],
  [339, "MODEL_GOOGLE_GEMINI_RAINSONG"],
  [340, "MODEL_CLAUDE_4_5_HAIKU"],
  [341, "MODEL_CLAUDE_4_5_HAIKU_THINKING"],
  [342, "MODEL_OPENAI_GPT_OSS_120B_MEDIUM"],
  [343, "MODEL_GOOGLE_GEMINI_ORIONFIRE"],
  [344, "MODEL_GOOGLE_GEMINI_INTERNAL_TAB_FLASH_LITE"],
  [345, "MODEL_GOOGLE_GEMINI_INTERNAL_TAB_JUMP_FLASH_LITE"],
  [346, "MODEL_GOOGLE_JARVIS_PROXY"],
  [347, "MODEL_GOOGLE_GEMINI_COSMICFORGE"],
  [348, "MODEL_GOOGLE_GEMINI_RIFTRUNNER"],
  [349, "MODEL_GOOGLE_JARVIS_V4S"],
  [350, "MODEL_GOOGLE_GEMINI_INFINITYJET"],
  [351, "MODEL_GOOGLE_GEMINI_INFINITYBLOOM"],
  [352, "MODEL_GOOGLE_GEMINI_RIFTRUNNER_THINKING_LOW"],
  [353, "MODEL_GOOGLE_GEMINI_RIFTRUNNER_THINKING_HIGH"],
  [1026, "Claude Opus 4.6 (Thinking)"],
  [1035, "Claude Sonnet 4.6 (Thinking)"],
  [1071, "Gemini 3.6 Flash (High)"],
  [1298, "Gemini 3.7 Flash (High)"],
  [1318, "Gemini 3.8 Flash (High)"],
]);
const antigravityModelValues = new Set(antigravityModelNames.keys());

let cachedConnectionInfo: {
  value: CodeiumConnectionInfo | null;
  expiresAt: number;
} | null = null;

function getAntigravityConfigRoots(): string[] {
  const configuredRoot = process.env[ANTIGRAVITY_CONFIG_DIR_ENV]?.trim();

  if (configuredRoot) {
    return [resolve(configuredRoot)];
  }

  const roots: string[] = [];
  const home = homedir();

  if (process.platform === "darwin") {
    const appSupport = join(home, "Library", "Application Support");

    roots.push(
      join(appSupport, "Antigravity IDE"),
      join(appSupport, "Antigravity"),
    );
  } else if (process.platform === "win32") {
    const appData =
      process.env.APPDATA?.trim() || join(home, "AppData", "Roaming");

    roots.push(
      join(appData, "Antigravity IDE"),
      join(appData, "Antigravity"),
    );
  } else {
    const xdgConfigHome =
      process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config");

    roots.push(
      join(xdgConfigHome, "Antigravity IDE"),
      join(xdgConfigHome, "Antigravity"),
      join(home, ".config", "Antigravity IDE"),
      join(home, ".config", "Antigravity"),
    );
  }

  roots.push(
    join(home, ".gemini", "antigravity-ide"),
    join(home, ".gemini", "antigravity"),
  );

  return [...new Set(roots)];
}

function getAntigravityConversationDirectories(): string[] {
  const explicitDir = process.env[ANTIGRAVITY_CONVERSATIONS_DIR_ENV]?.trim();
  const dirs: string[] = [];
  const seen = new Set<string>();
  const pushDir = (dirPath: string) => {
    const resolved = resolve(dirPath);

    if (!seen.has(resolved) && existsSync(resolved)) {
      seen.add(resolved);
      dirs.push(resolved);
    }
  };

  if (explicitDir) {
    pushDir(explicitDir);

    return dirs;
  }

  const home = homedir();
  const geminiRoot = join(home, ".gemini");

  pushDir(join(geminiRoot, "antigravity-ide", "conversations"));
  pushDir(join(geminiRoot, "antigravity", "conversations"));
  pushDir(join(geminiRoot, "antigravity-backup", "conversations"));

  for (const root of getAntigravityConfigRoots()) {
    pushDir(join(root, "conversations"));
  }

  return dirs;
}

function getAntigravityLogsRoots(): string[] {
  return getAntigravityConfigRoots().map((root) => join(root, "logs"));
}

function getAntigravityStateDbCandidates(): string[] {
  const explicitDbPath = process.env[ANTIGRAVITY_STATE_DB_PATH_ENV]?.trim();
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (candidatePath: string) => {
    const resolvedCandidate = resolve(candidatePath);

    if (!seen.has(resolvedCandidate)) {
      seen.add(resolvedCandidate);
      candidates.push(resolvedCandidate);
    }

    if (resolvedCandidate.endsWith(".vscdb")) {
      const backupPath = `${resolvedCandidate}.backup`;

      if (!seen.has(backupPath)) {
        seen.add(backupPath);
        candidates.push(backupPath);
      }
    }
  };

  if (explicitDbPath) {
    pushCandidate(explicitDbPath);

    return candidates;
  }

  for (const root of getAntigravityConfigRoots()) {
    pushCandidate(join(root, ANTIGRAVITY_STATE_DB_RELATIVE_PATH));
  }

  return candidates;
}

function normalizeAntigravityDatabaseValue(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();

    return trimmed === "" ? undefined : trimmed;
  }

  if (Buffer.isBuffer(value)) {
    const trimmed = value.toString("utf8").trim();

    return trimmed === "" ? undefined : trimmed;
  }

  return undefined;
}

function readAntigravityTrajectorySummaryValuesFromDatabase(databasePath: string) {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    const query = database.prepare(
      "SELECT value FROM ItemTable WHERE key = ? LIMIT 1",
    );
    const values: string[] = [];

    for (const key of ANTIGRAVITY_TRAJECTORY_SUMMARY_KEYS) {
      const row = query.get(key) as { value?: unknown } | undefined;
      const value = normalizeAntigravityDatabaseValue(row?.value);

      if (value) {
        values.push(value);
      }
    }

    return values;
  } finally {
    database.close();
  }
}

function isSqliteLockedError(error: unknown) {
  return error instanceof Error && /database is locked/i.test(error.message);
}

async function withAntigravityStateSnapshot<T>(
  databasePath: string,
  callback: (snapshotPath: string) => Promise<T>,
) {
  const snapshotDir = await mkdtemp(join(tmpdir(), "slopmeter-antigravity-"));
  const snapshotPath = join(snapshotDir, basename(databasePath));

  await copyFile(databasePath, snapshotPath);

  for (const suffix of ["-shm", "-wal"]) {
    const companionPath = `${databasePath}${suffix}`;

    if (!existsSync(companionPath)) {
      continue;
    }

    await copyFile(companionPath, `${snapshotPath}${suffix}`);
  }

  try {
    return await callback(snapshotPath);
  } finally {
    await rm(snapshotDir, { recursive: true, force: true });
  }
}

function parseStateTrajectoryIds(rawEncodedSummaries: string[]) {
  const trajectoryIds: string[] = [];
  const seenTrajectoryIds = new Set<string>();

  for (const encodedSummary of rawEncodedSummaries) {
    if (!encodedSummary) {
      continue;
    }

    let rawSummary: Uint8Array;

    try {
      rawSummary = new Uint8Array(Buffer.from(encodedSummary, "base64"));
    } catch {
      continue;
    }

    if (rawSummary.length === 0) {
      continue;
    }

    const summaryFields = parseProtoFields(rawSummary);
    const mapEntries = getRepeatedProtoBytes(summaryFields, 1);

    for (const mapEntry of mapEntries) {
      const mapEntryFields = parseProtoFields(mapEntry);
      const trajectoryId = decodeUtf8(getProtoBytes(mapEntryFields, 1));

      if (!trajectoryId || seenTrajectoryIds.has(trajectoryId)) {
        continue;
      }

      seenTrajectoryIds.add(trajectoryId);
      trajectoryIds.push(trajectoryId);
    }
  }

  return trajectoryIds;
}

async function getStateTrajectoryIds() {
  const candidates = getAntigravityStateDbCandidates();
  const allSummaries: string[] = [];

  for (const databasePath of candidates) {
    if (!existsSync(databasePath)) {
      continue;
    }

    const readValues = (path: string) =>
      readAntigravityTrajectorySummaryValuesFromDatabase(path);
    let rawEncodedSummaries: string[];

    try {
      rawEncodedSummaries = readValues(databasePath);
    } catch (error) {
      if (!isSqliteLockedError(error)) {
        continue;
      }

      try {
        rawEncodedSummaries = await withAntigravityStateSnapshot(
          databasePath,
          async (snapshotPath) => readValues(snapshotPath),
        );
      } catch {
        continue;
      }
    }

    allSummaries.push(...rawEncodedSummaries);
  }

  return parseStateTrajectoryIds(allSummaries);
}

function getExplicitLogPath() {
  const explicitLogPath = process.env[ANTIGRAVITY_LOG_PATH_ENV]?.trim();

  if (!explicitLogPath) {
    return null;
  }

  return resolve(explicitLogPath);
}

function parseAntigravityLogLaunchRecords(
  content: string,
): AntigravityLogLaunchRecord[] {
  const records: AntigravityLogLaunchRecord[] = [];
  const lines = content.split(/\r?\n/);

  const ensureRecord = (pid: number) => {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].pid === pid) {
        return records[index];
      }
    }

    const record: AntigravityLogLaunchRecord = { pid };

    records.push(record);

    return record;
  };

  for (const line of lines) {
    const startMatch = line.match(
      /Starting language server process with pid (\d+)/i,
    );

    if (startMatch) {
      records.push({ pid: Number(startMatch[1]) });
      continue;
    }

    const httpsMatch = line.match(
      /(\d+)\s+server\.go:\d+\]\s+Language server listening on random port at (\d+) for HTTPS/i,
    );

    if (httpsMatch) {
      const record = ensureRecord(Number(httpsMatch[1]));

      record.httpsPort = Number(httpsMatch[2]);
      continue;
    }

    const httpMatch = line.match(
      /(\d+)\s+server\.go:\d+\]\s+Language server listening on random port at (\d+) for HTTP/i,
    );

    if (httpMatch) {
      const record = ensureRecord(Number(httpMatch[1]));

      record.httpPort = Number(httpMatch[2]);
    }
  }

  return records;
}

async function getRecentAntigravityLogFiles() {
  const explicitLogPath = getExplicitLogPath();

  if (explicitLogPath) {
    return existsSync(explicitLogPath) ? [explicitLogPath] : [];
  }

  const logFiles: string[] = [];

  for (const logsRoot of getAntigravityLogsRoots()) {
    if (!existsSync(logsRoot)) {
      continue;
    }

    const files = await listFilesRecursive(logsRoot, ".log");

    for (const filePath of files) {
      if (basename(filePath).toLowerCase() === "antigravity.log") {
        logFiles.push(filePath);
      }
    }
  }

  return logFiles.sort((left, right) => right.localeCompare(left));
}

async function getLatestAntigravityLaunchRecord() {
  const logFiles = await getRecentAntigravityLogFiles();

  for (const logFile of logFiles) {
    let content: string;

    try {
      content = await readFile(logFile, "utf8");
    } catch {
      continue;
    }

    const records = parseAntigravityLogLaunchRecords(content);
    const record =
      [...records]
        .reverse()
        .find((candidate) => candidate.httpPort || candidate.httpsPort) ?? null;

    if (record) {
      return record;
    }
  }

  return null;
}

async function tryExec(command: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 8_000,
    });

    return stdout;
  } catch {
    return null;
  }
}

async function getWindowsLanguageServerProcesses() {
  const cimCommand = [
    "-NoProfile",
    "-Command",
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
      "$rows=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.Name -like 'language_server*' -or $_.CommandLine -like '*language_server*' } | " +
      "Select-Object @{Name='pid';Expression={$_.ProcessId}}, @{Name='commandLine';Expression={$_.CommandLine}}; " +
      "$rows | ConvertTo-Json -Compress",
  ];
  const wmiCommand = [
    "-NoProfile",
    "-Command",
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
      "$rows=Get-WmiObject Win32_Process -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.Name -like 'language_server*' -or $_.CommandLine -like '*language_server*' } | " +
      "Select-Object @{Name='pid';Expression={$_.ProcessId}}, @{Name='commandLine';Expression={$_.CommandLine}}; " +
      "$rows | ConvertTo-Json -Compress",
  ];

  const outputs = [
    await tryExec("powershell.exe", cimCommand),
    await tryExec("powershell.exe", wmiCommand),
  ];

  for (const output of outputs) {
    if (!output) {
      continue;
    }

    const parsed = parseWindowsProcessJsonOutput(output);

    if (parsed.length > 0) {
      return parsed;
    }
  }

  return [];
}

async function getUnixLanguageServerProcesses() {
  const output = await tryExec("ps", ["-ax", "-o", "pid=,command="]);

  if (!output) {
    return [];
  }

  return parseUnixLanguageServerProcesses(output);
}

async function getLanguageServerProcesses() {
  const processes =
    process.platform === "win32"
      ? await getWindowsLanguageServerProcesses()
      : await getUnixLanguageServerProcesses();

  return processes.filter(
    (processInfo) =>
      /language_server/i.test(processInfo.commandLine) &&
      /antigravity|codeium|gemini/i.test(processInfo.commandLine),
  );
}

function parsePidEnvVar() {
  const rawPid = process.env[ANTIGRAVITY_LS_PID_ENV]?.trim();

  if (!rawPid) {
    return null;
  }

  const pid = Number(rawPid);

  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function parseHttpPortEnvVar() {
  const rawPort = process.env[ANTIGRAVITY_LS_HTTP_PORT_ENV]?.trim();

  if (!rawPort) {
    return null;
  }

  const port = Number(rawPort);

  return Number.isInteger(port) && port > 0 ? port : null;
}

function decodeAntigravityModelName(modelValue: number) {
  const configuredName = antigravityModelNames.get(modelValue);

  if (configuredName) {
    return configuredName;
  }

  if (modelValue >= 1_000 && modelValue <= 2_000) {
    return `MODEL_PLACEHOLDER_M${modelValue - 1_000}`;
  }

  return `MODEL_${modelValue}`;
}

function resolveAntigravityModelName(
  modelValue: number,
  dynamicModelLabels: ReadonlyMap<number, string>,
) {
  const dynamicLabel = dynamicModelLabels.get(modelValue)?.trim();

  if (dynamicLabel) {
    return formatCodeiumModelName(dynamicLabel);
  }

  return formatCodeiumModelName(decodeAntigravityModelName(modelValue));
}

async function discoverAntigravityConnectionInfo() {
  const envCsrfToken = process.env[ANTIGRAVITY_LS_CSRF_TOKEN_ENV]?.trim() || null;
  const envHttpPort = parseHttpPortEnvVar();
  const envPid = parsePidEnvVar();

  if (envCsrfToken && envHttpPort && envPid) {
    return {
      pid: envPid,
      csrfToken: envCsrfToken,
      httpPort: envHttpPort,
    } satisfies CodeiumConnectionInfo;
  }

  const [launchRecord, processes] = await Promise.all([
    getLatestAntigravityLaunchRecord(),
    getLanguageServerProcesses(),
  ]);
  const targetPid = envPid ?? launchRecord?.pid ?? null;
  const processInfo =
    (targetPid
      ? processes.find((candidate) => candidate.pid === targetPid)
      : null) ??
    processes.find(
      (candidate) => parseCsrfTokenFromCommandLine(candidate.commandLine) !== null,
    ) ??
    null;

  if (!processInfo) {
    return null;
  }

  const csrfToken = envCsrfToken ?? parseCsrfTokenFromCommandLine(processInfo.commandLine);

  if (!csrfToken) {
    return null;
  }

  const candidatePorts: number[] = [];

  if (envHttpPort) {
    candidatePorts.push(envHttpPort);
  }

  if (launchRecord?.pid === processInfo.pid) {
    if (launchRecord.httpPort) {
      candidatePorts.push(launchRecord.httpPort);
    }

    if (launchRecord.httpsPort) {
      candidatePorts.push(launchRecord.httpsPort);
    }
  }

  const netstatPorts = await getNetstatListeningPortsByPid(processInfo.pid);

  for (const port of netstatPorts) {
    candidatePorts.push(port);
  }

  const workingHttpPort = await chooseWorkingHttpPort(
    processInfo.pid,
    csrfToken,
    candidatePorts,
  );

  if (!workingHttpPort) {
    return null;
  }

  return {
    pid: processInfo.pid,
    csrfToken,
    httpPort: workingHttpPort,
  } satisfies CodeiumConnectionInfo;
}

async function getAntigravityConnectionInfo() {
  const now = Date.now();

  if (cachedConnectionInfo && cachedConnectionInfo.expiresAt > now) {
    return cachedConnectionInfo.value;
  }

  const value = await discoverAntigravityConnectionInfo();

  cachedConnectionInfo = {
    value,
    expiresAt: now + CONNECTION_CACHE_MS,
  };

  return value;
}

async function getCascadeIds(connection: CodeiumConnectionInfo) {
  const response = await callLanguageServerRpc(
    connection,
    "GetAllCascadeTrajectories",
  );

  return parseGetAllCascadeTrajectoriesResponse(response);
}

async function getCascadeModelLabels(connection: CodeiumConnectionInfo) {
  const response = await callLanguageServerRpc(
    connection,
    "GetCascadeModelConfigData",
  );

  return parseGetCascadeModelConfigDataResponse(response, antigravityModelValues);
}

async function getCommandModelLabels(connection: CodeiumConnectionInfo) {
  const response = await callLanguageServerRpc(
    connection,
    "GetCommandModelConfigs",
  );

  return parseGetCommandModelConfigsResponse(response, antigravityModelValues);
}

async function getDebugStepMessages(connection: CodeiumConnectionInfo) {
  const response = await callLanguageServerRpc(
    connection,
    "GetUserTrajectoryDebug",
    encodeGetUserTrajectoryDebugRequest(true),
  );

  return collectDebugStepMessages(response);
}

function readConversationDbRows(databasePath: string): {
  genRows: Array<{ idx: number; data: Buffer }>;
  stepRows: Array<{ idx: number; metadata: Buffer | null }>;
} {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    const hasGenMetadata = Boolean(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata' LIMIT 1",
        )
        .get(),
    );
    const hasSteps = Boolean(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps' LIMIT 1",
        )
        .get(),
    );

    const genRows = hasGenMetadata
      ? (database
          .prepare("SELECT idx, data FROM gen_metadata")
          .all() as Array<{ idx: number; data: Buffer }>)
      : [];
    const stepRows = hasSteps
      ? (database
          .prepare(
            "SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL",
          )
          .all() as Array<{ idx: number; metadata: Buffer | null }>)
      : [];

    return { genRows, stepRows };
  } finally {
    database.close();
  }
}

async function getConversationDbRows(databasePath: string) {
  try {
    return readConversationDbRows(databasePath);
  } catch (error) {
    if (!isSqliteLockedError(error)) {
      return null;
    }

    try {
      return await withAntigravityStateSnapshot(databasePath, async (snapshotPath) =>
        readConversationDbRows(snapshotPath),
      );
    } catch {
      return null;
    }
  }
}

async function aggregateConversationDbUsage(
  databasePath: string,
  trajectoryId: string,
  start: Date,
  end: Date,
  recentStart: Date,
  totals: DailyTotalsByDate,
  modelTotals: Map<string, ModelTokenTotals>,
  recentModelTotals: Map<string, ModelTokenTotals>,
  dynamicModelLabels: ReadonlyMap<number, string>,
  seenUsageKeys: Set<string>,
): Promise<boolean> {
  const data = await getConversationDbRows(databasePath);

  if (!data) {
    return false;
  }

  for (const row of data.genRows) {
    const parsedUsage = parseGeneratorMetadataUsage(
      new Uint8Array(row.data),
      trajectoryId,
      row.idx,
      dynamicModelLabels,
      resolveAntigravityModelName,
    );

    if (!parsedUsage || seenUsageKeys.has(parsedUsage.usageKey)) {
      continue;
    }

    seenUsageKeys.add(parsedUsage.usageKey);

    if (parsedUsage.date < start || parsedUsage.date > end) {
      continue;
    }

    addDailyTokenTotals(
      totals,
      parsedUsage.date,
      parsedUsage.tokenTotals,
      parsedUsage.modelName,
    );

    if (!parsedUsage.modelName) {
      continue;
    }

    addModelTokenTotals(
      modelTotals,
      parsedUsage.modelName,
      parsedUsage.tokenTotals,
    );

    if (parsedUsage.date >= recentStart) {
      addModelTokenTotals(
        recentModelTotals,
        parsedUsage.modelName,
        parsedUsage.tokenTotals,
      );
    }
  }

  for (const row of data.stepRows) {
    if (!row.metadata) {
      continue;
    }

    const rawStepKey = `${trajectoryId}:step:${row.idx}`;
    const metadataFields = parseProtoFields(new Uint8Array(row.metadata));
    const date =
      parseTimestamp(getProtoBytes(metadataFields, 1)) ??
      parseTimestamp(getProtoBytes(metadataFields, 6)) ??
      parseTimestamp(getProtoBytes(metadataFields, 8));

    if (!date) {
      continue;
    }

    const modelUsagePayloads = extractStepModelUsagePayloads(metadataFields);

    for (const [index, modelUsagePayload] of modelUsagePayloads.entries()) {
      const modelUsage = parseModelUsageStats(
        modelUsagePayload,
        dynamicModelLabels,
        resolveAntigravityModelName,
      );

      if (!modelUsage) {
        continue;
      }

      const usageKey =
        modelUsage.usageIdentifier ?? `raw:${rawStepKey}:${index}`;

      if (seenUsageKeys.has(usageKey)) {
        continue;
      }

      seenUsageKeys.add(usageKey);

      if (date < start || date > end) {
        continue;
      }

      addDailyTokenTotals(
        totals,
        date,
        modelUsage.tokenTotals,
        modelUsage.modelName,
      );

      if (!modelUsage.modelName) {
        continue;
      }

      addModelTokenTotals(
        modelTotals,
        modelUsage.modelName,
        modelUsage.tokenTotals,
      );

      if (date >= recentStart) {
        addModelTokenTotals(
          recentModelTotals,
          modelUsage.modelName,
          modelUsage.tokenTotals,
        );
      }
    }
  }

  return true;
}

export async function isAntigravityAvailable() {
  const connection = await getAntigravityConnectionInfo();

  if (connection) {
    return true;
  }

  for (const dir of getAntigravityConversationDirectories()) {
    if (existsSync(dir)) {
      try {
        const files = await readdir(dir);

        if (files.some((f) => f.endsWith(".db") || f.endsWith(".pb"))) {
          return true;
        }
      } catch {
        continue;
      }
    }
  }

  for (const candidate of getAntigravityStateDbCandidates()) {
    if (existsSync(candidate)) {
      return true;
    }
  }

  return false;
}

export async function loadAntigravityRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const connection = await getAntigravityConnectionInfo();
  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  const recentStart = getRecentWindowStart(end, 30);
  const maxTrajectories = getPositiveIntegerEnv(
    ANTIGRAVITY_MAX_TRAJECTORIES_ENV,
    DEFAULT_MAX_TRAJECTORIES,
  );
  const maxStepPages = getPositiveIntegerEnv(
    ANTIGRAVITY_MAX_STEP_PAGES_ENV,
    DEFAULT_MAX_STEP_PAGES,
  );
  const seenUsageKeys = new Set<string>();
  let dynamicModelLabels = new Map<number, string>();

  if (connection) {
    try {
      dynamicModelLabels = mergeModelLabelMaps(
        dynamicModelLabels,
        await getCascadeModelLabels(connection),
      );
    } catch {
      // continue with static model names when model config data is unavailable
    }

    try {
      dynamicModelLabels = mergeModelLabelMaps(
        dynamicModelLabels,
        await getCommandModelLabels(connection),
      );
    } catch {
      // continue with static model names when model config data is unavailable
    }

    try {
      const debugStepMessages = await getDebugStepMessages(connection);

      aggregateCodeiumDebugUsage(
        debugStepMessages,
        start,
        end,
        recentStart,
        totals,
        modelTotals,
        recentModelTotals,
        dynamicModelLabels,
        resolveAntigravityModelName,
        seenUsageKeys,
      );
    } catch {
      // debug endpoint is optional; trajectory paging remains primary source.
    }
  }

  const processedTrajectoryIds = new Set<string>();
  const conversationDirs = getAntigravityConversationDirectories();
  const pbTrajectoryIds = new Set<string>();

  for (const dir of conversationDirs) {
    let files: string[];

    try {
      files = await readdir(dir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (file.endsWith(".db")) {
        const trajectoryId = basename(file, ".db");

        if (processedTrajectoryIds.has(trajectoryId)) {
          continue;
        }

        const fullPath = join(dir, file);
        const loaded = await aggregateConversationDbUsage(
          fullPath,
          trajectoryId,
          start,
          end,
          recentStart,
          totals,
          modelTotals,
          recentModelTotals,
          dynamicModelLabels,
          seenUsageKeys,
        );

        if (loaded) {
          processedTrajectoryIds.add(trajectoryId);
        }
      } else if (file.endsWith(".pb")) {
        pbTrajectoryIds.add(basename(file, ".pb"));
      }
    }
  }

  let rpcCascadeIds: string[] = [];
  let stateCascadeIds: string[] = [];

  if (connection) {
    try {
      rpcCascadeIds = await getCascadeIds(connection);
    } catch {
      // continue: unified state cache can still provide trajectory IDs
    }
  }

  try {
    stateCascadeIds = await getStateTrajectoryIds();
  } catch {
    // continue: RPC IDs can still provide trajectory coverage
  }

  const allCandidateIds = mergeTrajectoryIds(
    rpcCascadeIds,
    stateCascadeIds,
    [...pbTrajectoryIds],
  );

  const remainingTrajectoryIds = allCandidateIds.filter(
    (id) => !processedTrajectoryIds.has(id),
  );

  if (connection && remainingTrajectoryIds.length > 0) {
    for (const trajectoryId of remainingTrajectoryIds.slice(0, maxTrajectories)) {
      await aggregateCodeiumTrajectoryUsage(
        connection,
        trajectoryId,
        start,
        end,
        recentStart,
        totals,
        modelTotals,
        recentModelTotals,
        dynamicModelLabels,
        resolveAntigravityModelName,
        seenUsageKeys,
        maxStepPages,
      );
    }
  }

  return createUsageSummary(
    "antigravity",
    totals,
    modelTotals,
    recentModelTotals,
    end,
  );
}
