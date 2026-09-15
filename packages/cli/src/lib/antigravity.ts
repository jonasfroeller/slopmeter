import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import type { UsageSummary } from "../interfaces";
import {
  type DailyTotalsByDate,
  type DailyTokenTotals,
  type ModelTokenTotals,
  addDailyTokenTotals,
  addModelTokenTotals,
  createUsageSummary,
  getPositiveIntegerEnv,
  getRecentWindowStart,
  listFilesRecursive,
} from "./utils";

const execFileAsync = promisify(execFile);
const textDecoder = new TextDecoder();

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
const REQUEST_TIMEOUT_MS = 3_500;
const CONNECTION_CACHE_MS = 10_000;
const STEP_PAGE_SIZE = 20;
const CSRF_HEADER = "x-codeium-csrf-token";
const RPC_CONTENT_TYPE = "application/proto";

type RpcMethod =
  | "GetAllCascadeTrajectories"
  | "GetCascadeModelConfigData"
  | "GetCommandModelConfigs"
  | "GetUserTrajectoryDebug"
  | "GetUserStatus"
  | "GetCascadeTrajectory"
  | "GetCascadeTrajectorySteps"
  | "GetCascadeTrajectoryGeneratorMetadata";

interface ProtoField {
  fieldNumber: number;
  wireType: number;
  value: bigint | Uint8Array;
}

interface AntigravityConnectionInfo {
  pid: number;
  httpPort: number;
  csrfToken: string;
}

interface AntigravityLogLaunchRecord {
  pid: number;
  httpPort?: number;
  httpsPort?: number;
}

interface LanguageServerProcessInfo {
  pid: number;
  commandLine: string;
}

interface ParsedStepUsage {
  date: Date;
  modelName?: string;
  tokenTotals: DailyTokenTotals;
  usageKey: string;
}

interface ParsedModelUsageStats {
  modelName: string;
  tokenTotals: DailyTokenTotals;
  usageIdentifier?: string;
}

interface RawStepMessage {
  rawStep: Uint8Array;
  rawStepKey: string;
}

interface CascadeTrajectoryCounts {
  totalSteps: number;
  totalGeneratorMetadata: number;
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

let cachedConnectionInfo:
  | { value: AntigravityConnectionInfo | null; expiresAt: number }
  | null = null;

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

function parseWindowsProcessJsonOutput(content: string) {
  const trimmed = content.trim();

  if (!trimmed) {
    return [] as LanguageServerProcessInfo[];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const processes: LanguageServerProcessInfo[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }

    const candidate = row as {
      pid?: unknown;
      commandLine?: unknown;
      ProcessId?: unknown;
      CommandLine?: unknown;
    };
    const pidRaw =
      candidate.pid ?? candidate.ProcessId ?? undefined;
    const pid = Number(pidRaw);
    const commandLineRaw = candidate.commandLine ?? candidate.CommandLine;

    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof commandLineRaw !== "string" ||
      commandLineRaw.trim() === ""
    ) {
      continue;
    }

    processes.push({
      pid,
      commandLine: commandLineRaw,
    });
  }

  return processes;
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

function parseUnixLanguageServerProcesses(content: string) {
  const processes: LanguageServerProcessInfo[] = [];

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed === "") {
      continue;
    }

    const match = trimmed.match(/^(\d+)\s+(.*)$/);

    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const commandLine = match[2].trim();

    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      commandLine === "" ||
      !/language_server/i.test(commandLine)
    ) {
      continue;
    }

    processes.push({ pid, commandLine });
  }

  return processes;
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

function parseCsrfTokenFromCommandLine(commandLine: string) {
  const tokenMatch = commandLine.match(
    /(?:^|\s)--csrf[_-]token(?:=|\s+)(?:"([^"]+)"|([^\s]+))/i,
  );
  const rawToken = tokenMatch?.[1] ?? tokenMatch?.[2];

  if (!rawToken) {
    return null;
  }

  const token = rawToken.trim();

  return token === "" ? null : token;
}

function parsePortFromAddress(localAddress: string) {
  const trimmed = localAddress.trim();

  if (trimmed === "") {
    return null;
  }

  if (trimmed.startsWith("[") && trimmed.includes("]:")) {
    const start = trimmed.lastIndexOf("]:");

    if (start === -1) {
      return null;
    }

    const port = Number(trimmed.slice(start + 2));

    return Number.isInteger(port) && port > 0 ? port : null;
  }

  const colonIndex = trimmed.lastIndexOf(":");

  if (colonIndex === -1) {
    return null;
  }

  const port = Number(trimmed.slice(colonIndex + 1));

  return Number.isInteger(port) && port > 0 ? port : null;
}

function parseNetstatListeningPortsByPid(content: string, pid: number) {
  const ports = new Set<number>();

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || !trimmed.startsWith("TCP")) {
      continue;
    }

    const parts = trimmed.split(/\s+/);

    if (parts.length < 5) {
      continue;
    }

    const parsedPid = Number(parts.at(-1));

    if (!Number.isInteger(parsedPid) || parsedPid !== pid) {
      continue;
    }

    const remoteAddress = parts[2] ?? "";

    if (!remoteAddress.endsWith(":0")) {
      continue;
    }

    const localAddress = parts[1];
    const port = parsePortFromAddress(localAddress);

    if (port !== null) {
      ports.add(port);
    }
  }

  return [...ports];
}

async function getNetstatListeningPortsByPid(pid: number) {
  const output = await tryExec("netstat", ["-ano", "-p", "tcp"]);

  if (!output) {
    return [];
  }

  return parseNetstatListeningPortsByPid(output, pid);
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

function encodeVarint(value: bigint | number) {
  let current = typeof value === "number" ? BigInt(value) : value;

  if (current < 0n) {
    current = 0n;
  }

  const bytes: number[] = [];

  for (;;) {
    const currentByte = Number(current & 0x7fn);

    current >>= 7n;

    if (current === 0n) {
      bytes.push(currentByte);
      break;
    }

    bytes.push(currentByte | 0x80);
  }

  return Uint8Array.from(bytes);
}

function concatByteArrays(chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function encodeFieldKey(fieldNumber: number, wireType: number) {
  return encodeVarint(BigInt((fieldNumber << 3) | wireType));
}

function encodeStringField(fieldNumber: number, value: string) {
  const encodedValue = new TextEncoder().encode(value);

  return concatByteArrays([
    encodeFieldKey(fieldNumber, 2),
    encodeVarint(encodedValue.length),
    encodedValue,
  ]);
}

function encodeUint32Field(fieldNumber: number, value: number) {
  return concatByteArrays([
    encodeFieldKey(fieldNumber, 0),
    encodeVarint(value),
  ]);
}

function encodeGetCascadeTrajectoryRequest(cascadeId: string) {
  return encodeStringField(1, cascadeId);
}

function encodeGetCascadeTrajectoryStepsRequest(cascadeId: string, offset: number) {
  return concatByteArrays([
    encodeStringField(1, cascadeId),
    encodeUint32Field(2, offset),
  ]);
}

function encodeGetCascadeTrajectoryGeneratorMetadataRequest(
  cascadeId: string,
  offset: number,
  includeMessages: boolean,
) {
  return concatByteArrays([
    encodeStringField(1, cascadeId),
    encodeUint32Field(2, offset),
    encodeUint32Field(3, includeMessages ? 1 : 0),
  ]);
}

function readVarint(bytes: Uint8Array, offset: number) {
  let value = 0n;
  let shift = 0n;
  let index = offset;

  while (index < bytes.length) {
    const byte = bytes[index];

    value |= BigInt(byte & 0x7f) << shift;
    index += 1;

    if ((byte & 0x80) === 0) {
      return { value, nextOffset: index };
    }

    shift += 7n;

    if (shift > 70n) {
      return null;
    }
  }

  return null;
}

function parseProtoFields(bytes: Uint8Array) {
  const fields: ProtoField[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);

    if (!key) {
      break;
    }

    offset = key.nextOffset;

    const fieldNumber = Number(key.value >> 3n);
    const wireType = Number(key.value & 0x7n);

    if (fieldNumber <= 0) {
      break;
    }

    if (wireType === 0) {
      const value = readVarint(bytes, offset);

      if (!value) {
        break;
      }

      fields.push({
        fieldNumber,
        wireType,
        value: value.value,
      });
      offset = value.nextOffset;
      continue;
    }

    if (wireType === 2) {
      const lengthResult = readVarint(bytes, offset);

      if (!lengthResult) {
        break;
      }

      const messageLength = Number(lengthResult.value);

      if (
        !Number.isInteger(messageLength) ||
        messageLength < 0 ||
        lengthResult.nextOffset + messageLength > bytes.length
      ) {
        break;
      }

      const start = lengthResult.nextOffset;
      const end = start + messageLength;

      fields.push({
        fieldNumber,
        wireType,
        value: bytes.subarray(start, end),
      });
      offset = end;
      continue;
    }

    if (wireType === 1) {
      const nextOffset = offset + 8;

      if (nextOffset > bytes.length) {
        break;
      }

      offset = nextOffset;
      continue;
    }

    if (wireType === 5) {
      const nextOffset = offset + 4;

      if (nextOffset > bytes.length) {
        break;
      }

      offset = nextOffset;
      continue;
    }

    break;
  }

  return fields;
}

function getProtoVarint(fields: ProtoField[], fieldNumber: number) {
  for (const field of fields) {
    if (field.fieldNumber === fieldNumber && field.wireType === 0) {
      return field.value as bigint;
    }
  }

  return undefined;
}

function getProtoBytes(fields: ProtoField[], fieldNumber: number) {
  for (const field of fields) {
    if (field.fieldNumber === fieldNumber && field.wireType === 2) {
      return field.value as Uint8Array;
    }
  }

  return undefined;
}

function getRepeatedProtoBytes(fields: ProtoField[], fieldNumber: number) {
  const values: Uint8Array[] = [];

  for (const field of fields) {
    if (field.fieldNumber === fieldNumber && field.wireType === 2) {
      values.push(field.value as Uint8Array);
    }
  }

  return values;
}

function protoVarintToNumber(value: bigint | undefined) {
  if (value === undefined) {
    return 0;
  }

  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number.MAX_SAFE_INTEGER;
  }

  return Number(value);
}

function decodeUtf8(value: Uint8Array | undefined) {
  if (!value || value.length === 0) {
    return undefined;
  }

  const decoded = textDecoder.decode(value).trim();

  return decoded === "" ? undefined : decoded;
}

function parseTimestamp(rawTimestamp: Uint8Array | undefined) {
  if (!rawTimestamp) {
    return null;
  }

  const timestampFields = parseProtoFields(rawTimestamp);
  const seconds = protoVarintToNumber(getProtoVarint(timestampFields, 1));
  const nanos = protoVarintToNumber(getProtoVarint(timestampFields, 2));
  const nanosComponent = Math.max(0, Math.min(999_999_999, nanos));
  const epochMillis = seconds * 1_000 + Math.floor(nanosComponent / 1_000_000);
  const parsed = new Date(epochMillis);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function decodeAntigravityModelName(modelValue: number) {
  const knownName = antigravityModelNames.get(modelValue);

  if (knownName) {
    return knownName;
  }

  if (modelValue >= 1000 && modelValue <= 2000) {
    return `MODEL_PLACEHOLDER_M${modelValue - 1000}`;
  }

  return `MODEL_${modelValue}`;
}

function formatAntigravityModelName(rawName: string) {
  const trimmed = rawName.trim();
  const placeholderMatch = trimmed.match(/^MODEL_PLACEHOLDER_M(\d+)$/);

  if (placeholderMatch) {
    return `Unknown model (M${placeholderMatch[1]})`;
  }

  if (!trimmed.startsWith("MODEL_")) {
    return trimmed;
  }

  const rawTokens = trimmed
    .slice("MODEL_".length)
    .split("_")
    .filter((token) => token !== "");
  const formattedTokens: string[] = [];

  for (let index = 0; index < rawTokens.length; index += 1) {
    const token = rawTokens[index];
    const nextToken = rawTokens[index + 1];

    if (
      index + 1 < rawTokens.length &&
      /^\d+$/.test(token) &&
      /^\d+$/.test(nextToken)
    ) {
      formattedTokens.push(`${token}.${nextToken}`);
      index += 1;
      continue;
    }

    if (
      /^(GPT|OSS|BYOM|API|UI|ID|URL|CPU|GPU|LLM|V\d+[A-Z0-9]*)$/.test(token)
    ) {
      formattedTokens.push(token);
      continue;
    }

    if (/^\d+[A-Z]+$/.test(token)) {
      formattedTokens.push(token);
      continue;
    }

    formattedTokens.push(
      token.charAt(0).toUpperCase() + token.slice(1).toLowerCase(),
    );
  }

  return formattedTokens.join(" ");
}

function resolveAntigravityModelName(
  modelValue: number,
  dynamicModelLabels: ReadonlyMap<number, string>,
) {
  const dynamicLabel = dynamicModelLabels.get(modelValue)?.trim();

  if (dynamicLabel) {
    return formatAntigravityModelName(dynamicLabel);
  }

  return formatAntigravityModelName(decodeAntigravityModelName(modelValue));
}

function parseModelUsageIdentifier(modelUsageFields: ProtoField[]) {
  const messageId = decodeUtf8(getProtoBytes(modelUsageFields, 7));
  const responseId = decodeUtf8(getProtoBytes(modelUsageFields, 11));
  const providerAssignedMessageId = decodeUtf8(
    getProtoBytes(modelUsageFields, 12),
  );
  const parts: string[] = [];

  if (messageId) {
    parts.push(`m:${messageId}`);
  }

  if (responseId) {
    parts.push(`r:${responseId}`);
  }

  if (providerAssignedMessageId) {
    parts.push(`p:${providerAssignedMessageId}`);
  }

  return parts.length > 0 ? parts.join("|") : undefined;
}

function parseModelUsageStats(
  rawModelUsage: Uint8Array | undefined,
  dynamicModelLabels: ReadonlyMap<number, string>,
): ParsedModelUsageStats | null {
  if (!rawModelUsage) {
    return null;
  }

  const modelUsageFields = parseProtoFields(rawModelUsage);
  const modelValue = protoVarintToNumber(getProtoVarint(modelUsageFields, 1));
  const inputTokens = protoVarintToNumber(getProtoVarint(modelUsageFields, 2));
  const outputTokens = protoVarintToNumber(getProtoVarint(modelUsageFields, 3));
  const cacheWriteTokens = protoVarintToNumber(
    getProtoVarint(modelUsageFields, 4),
  );
  const cacheReadTokens = protoVarintToNumber(
    getProtoVarint(modelUsageFields, 5),
  );
  const thinkingOutputTokens = protoVarintToNumber(
    getProtoVarint(modelUsageFields, 9),
  );
  const responseOutputTokens = protoVarintToNumber(
    getProtoVarint(modelUsageFields, 10),
  );
  const resolvedOutput =
    responseOutputTokens + thinkingOutputTokens > 0
      ? responseOutputTokens + thinkingOutputTokens
      : outputTokens;
  const input = inputTokens + cacheReadTokens + cacheWriteTokens;
  const total = input + resolvedOutput;

  if (total <= 0) {
    return null;
  }

  return {
    modelName: resolveAntigravityModelName(modelValue, dynamicModelLabels),
    tokenTotals: {
      input,
      output: resolvedOutput,
      cache: {
        input: cacheReadTokens,
        output: cacheWriteTokens,
      },
      total,
    } satisfies DailyTokenTotals,
    usageIdentifier: parseModelUsageIdentifier(modelUsageFields),
  };
}

function extractStepModelUsagePayloads(metadataFields: ProtoField[]) {
  const payloads: Uint8Array[] = [];
  const directUsage = getProtoBytes(metadataFields, 9);

  if (directUsage) {
    payloads.push(directUsage);
  }

  for (const usageContainer of getRepeatedProtoBytes(metadataFields, 28)) {
    const usageContainerFields = parseProtoFields(usageContainer);

    for (const modelUsagePayload of getRepeatedProtoBytes(usageContainerFields, 2)) {
      payloads.push(modelUsagePayload);
    }
  }

  return payloads;
}

function parseStepUsages(
  rawStep: Uint8Array,
  rawStepKey: string,
  dynamicModelLabels: ReadonlyMap<number, string>,
): ParsedStepUsage[] {
  const stepFields = parseProtoFields(rawStep);
  const metadata = getProtoBytes(stepFields, 5);

  if (!metadata) {
    return [];
  }

  const metadataFields = parseProtoFields(metadata);
  const date =
    parseTimestamp(getProtoBytes(metadataFields, 1)) ??
    parseTimestamp(getProtoBytes(metadataFields, 6)) ??
    parseTimestamp(getProtoBytes(metadataFields, 8));

  if (!date) {
    return [];
  }

  const modelUsagePayloads = extractStepModelUsagePayloads(metadataFields);
  const usages: ParsedStepUsage[] = [];
  const seenUsageKeys = new Set<string>();

  for (const [index, modelUsagePayload] of modelUsagePayloads.entries()) {
    const modelUsage = parseModelUsageStats(modelUsagePayload, dynamicModelLabels);

    if (!modelUsage) {
      continue;
    }

    const usageKey = modelUsage.usageIdentifier ?? `raw:${rawStepKey}:${index}`;

    if (seenUsageKeys.has(usageKey)) {
      continue;
    }

    seenUsageKeys.add(usageKey);
    usages.push({
      date,
      modelName: modelUsage.modelName,
      tokenTotals: modelUsage.tokenTotals,
      usageKey,
    });
  }

  return usages;
}

function parseModelValueFromModelOrAlias(rawModelOrAlias: Uint8Array | undefined) {
  if (!rawModelOrAlias) {
    return null;
  }

  const stack: Array<{ bytes: Uint8Array; depth: number }> = [
    { bytes: rawModelOrAlias, depth: 0 },
  ];
  const candidates: number[] = [];

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current || current.depth > 3) {
      continue;
    }

    const fields = parseProtoFields(current.bytes);

    for (const field of fields) {
      if (field.wireType === 0) {
        const value = protoVarintToNumber(field.value as bigint);

        if (value >= 100 && value <= 5_000) {
          candidates.push(value);
        }
      } else if (field.wireType === 2) {
        stack.push({
          bytes: field.value as Uint8Array,
          depth: current.depth + 1,
        });
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const preferredKnown = candidates.find((candidate) =>
    antigravityModelNames.has(candidate),
  );

  if (preferredKnown) {
    return preferredKnown;
  }

  const preferredPlaceholder = candidates.find(
    (candidate) => candidate >= 1_000 && candidate <= 1_500,
  );

  return preferredPlaceholder ?? candidates[0];
}

function parseModelValueFromConfigKey(configKey: string | undefined) {
  if (!configKey) {
    return null;
  }

  const trimmed = configKey.trim();

  if (trimmed === "") {
    return null;
  }

  const numericMatch = trimmed.match(/^(\d+)$/);

  if (numericMatch) {
    const numericValue = Number(numericMatch[1]);

    return Number.isInteger(numericValue) && numericValue > 0
      ? numericValue
      : null;
  }

  const placeholderMatch = trimmed.match(
    /^(?:MODEL_PLACEHOLDER_M|M)(\d+)$/i,
  );

  if (!placeholderMatch) {
    return null;
  }

  const placeholderIndex = Number(placeholderMatch[1]);

  return Number.isInteger(placeholderIndex) && placeholderIndex >= 0
    ? 1_000 + placeholderIndex
    : null;
}

function collectPlainProtoStrings(fields: ProtoField[]) {
  const strings: string[] = [];

  for (const field of fields) {
    if (field.wireType !== 2 || !(field.value instanceof Uint8Array)) {
      continue;
    }

    const rawBytes = field.value;

    if (parseProtoFields(rawBytes).length > 0) {
      continue;
    }

    const decoded = decodeUtf8(rawBytes);

    if (decoded) {
      strings.push(decoded);
    }
  }

  return strings;
}

function pickModelLabelCandidate(candidates: string[]) {
  for (const candidate of candidates) {
    if (parseModelValueFromConfigKey(candidate) !== null) {
      continue;
    }

    if (!/[A-Za-z]/.test(candidate)) {
      continue;
    }

    if (candidate.length < 3 || candidate.length > 120) {
      continue;
    }

    return candidate;
  }

  return undefined;
}

function parseClientModelConfigEntry(rawEntry: Uint8Array) {
  const entryFields = parseProtoFields(rawEntry);
  const keyOrLabel = decodeUtf8(getProtoBytes(entryFields, 1));
  const nestedConfig = getProtoBytes(entryFields, 2);
  const modelFromKey = parseModelValueFromConfigKey(keyOrLabel);

  const modelValueFromAlias = parseModelValueFromModelOrAlias(
    getProtoBytes(entryFields, 2),
  );

  if (nestedConfig) {
    const nestedFields = parseProtoFields(nestedConfig);
    const nestedLabel =
      decodeUtf8(getProtoBytes(nestedFields, 1)) ??
      pickModelLabelCandidate(collectPlainProtoStrings(nestedFields));
    const nestedModelValue =
      parseModelValueFromModelOrAlias(getProtoBytes(nestedFields, 2)) ??
      parseModelValueFromModelOrAlias(nestedConfig) ??
      modelFromKey;

    if (nestedLabel && nestedModelValue !== null) {
      return { modelValue: nestedModelValue, label: nestedLabel };
    }
  }

  if (keyOrLabel) {
    if (modelValueFromAlias !== null) {
      return { modelValue: modelValueFromAlias, label: keyOrLabel };
    }

    const directModelValue = protoVarintToNumber(getProtoVarint(entryFields, 2));

    if (directModelValue > 0) {
      return { modelValue: directModelValue, label: keyOrLabel };
    }
  }

  return null;
}

function parseGetCascadeModelConfigDataResponse(rawResponse: Uint8Array) {
  const labelsByModel = new Map<number, string>();
  const stack: Array<{ bytes: Uint8Array; depth: number }> = [
    { bytes: rawResponse, depth: 0 },
  ];

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current || current.depth > 6) {
      continue;
    }

    const fields = parseProtoFields(current.bytes);

    for (const field of fields) {
      if (field.wireType !== 2) {
        continue;
      }

      const childBytes = field.value as Uint8Array;
      const entry = parseClientModelConfigEntry(childBytes);

      if (entry) {
        labelsByModel.set(entry.modelValue, entry.label);
      }

      stack.push({ bytes: childBytes, depth: current.depth + 1 });
    }
  }

  return labelsByModel;
}

function parseGetCommandModelConfigsResponse(rawResponse: Uint8Array) {
  return parseGetCascadeModelConfigDataResponse(rawResponse);
}

function parseGetAllCascadeTrajectoriesResponse(rawResponse: Uint8Array) {
  const ids: string[] = [];
  const seen = new Set<string>();
  const responseFields = parseProtoFields(rawResponse);
  const mapEntries = getRepeatedProtoBytes(responseFields, 1);

  for (const mapEntry of mapEntries) {
    const mapEntryFields = parseProtoFields(mapEntry);
    const cascadeId = decodeUtf8(getProtoBytes(mapEntryFields, 1));

    if (!cascadeId || seen.has(cascadeId)) {
      continue;
    }

    seen.add(cascadeId);
    ids.push(cascadeId);
  }

  return ids;
}

function parseGetCascadeTrajectoryResponse(rawResponse: Uint8Array) {
  const responseFields = parseProtoFields(rawResponse);

  return {
    totalSteps: protoVarintToNumber(getProtoVarint(responseFields, 3)),
    totalGeneratorMetadata: protoVarintToNumber(
      getProtoVarint(responseFields, 4),
    ),
  } satisfies CascadeTrajectoryCounts;
}

function parseGetCascadeTrajectoryStepsResponse(rawResponse: Uint8Array) {
  const responseFields = parseProtoFields(rawResponse);

  return getRepeatedProtoBytes(responseFields, 1);
}

function parseGetCascadeTrajectoryGeneratorMetadataResponse(
  rawResponse: Uint8Array,
) {
  const responseFields = parseProtoFields(rawResponse);

  return getRepeatedProtoBytes(responseFields, 1);
}

function encodeGetUserTrajectoryDebugRequest(includeAllTrajectories: boolean) {
  return encodeUint32Field(1, includeAllTrajectories ? 1 : 0);
}

function collectDebugStepMessages(rawResponse: Uint8Array) {
  const foundSteps: RawStepMessage[] = [];
  const seenMessages = new Set<string>();
  const stack: Array<{ bytes: Uint8Array; depth: number }> = [
    { bytes: rawResponse, depth: 0 },
  ];

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current || current.depth > 8) {
      continue;
    }

    const fields = parseProtoFields(current.bytes);

    if (fields.length === 0) {
      continue;
    }

    for (const field of fields) {
      if (field.wireType !== 2) {
        continue;
      }

      const child = field.value as Uint8Array;

      if (child.length === 0) {
        continue;
      }

      const childFields = parseProtoFields(child);

      if (childFields.length === 0) {
        continue;
      }

      const rawStepKey = Buffer.from(child).toString("base64");

      if (seenMessages.has(rawStepKey)) {
        continue;
      }

      seenMessages.add(rawStepKey);

      if (getProtoBytes(childFields, 5)) {
        foundSteps.push({ rawStep: child, rawStepKey });
      }

      stack.push({ bytes: child, depth: current.depth + 1 });
    }
  }

  return foundSteps;
}

async function callLanguageServerRpc(
  connection: AntigravityConnectionInfo,
  method: RpcMethod,
  body = new Uint8Array(),
) {
  const url = `http://127.0.0.1:${connection.httpPort}/exa.language_server_pb.LanguageServerService/${method}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        [CSRF_HEADER]: connection.csrfToken,
        "content-type": RPC_CONTENT_TYPE,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Antigravity RPC ${method} failed with ${response.status} ${response.statusText}`,
      );
    }

    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

async function isHttpPortUsable(
  pid: number,
  csrfToken: string,
  candidatePort: number,
) {
  try {
    await callLanguageServerRpc(
      { pid, csrfToken, httpPort: candidatePort },
      "GetUserStatus",
    );

    return true;
  } catch {
    return false;
  }
}

async function chooseWorkingHttpPort(
  pid: number,
  csrfToken: string,
  candidatePorts: number[],
) {
  const uniqueCandidatePorts = [...new Set(candidatePorts)].filter(
    (candidate) => Number.isInteger(candidate) && candidate > 0,
  );

  for (const candidatePort of uniqueCandidatePorts) {
    if (await isHttpPortUsable(pid, csrfToken, candidatePort)) {
      return candidatePort;
    }
  }

  return null;
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
    } satisfies AntigravityConnectionInfo;
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

  for (const netstatPort of await getNetstatListeningPortsByPid(processInfo.pid)) {
    candidatePorts.push(netstatPort);
  }

  const httpPort = await chooseWorkingHttpPort(
    processInfo.pid,
    csrfToken,
    candidatePorts,
  );

  if (!httpPort) {
    return null;
  }

  return {
    pid: processInfo.pid,
    csrfToken,
    httpPort,
  } satisfies AntigravityConnectionInfo;
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

async function getCascadeIds(connection: AntigravityConnectionInfo) {
  const response = await callLanguageServerRpc(
    connection,
    "GetAllCascadeTrajectories",
  );

  return parseGetAllCascadeTrajectoriesResponse(response);
}

function mergeTrajectoryIds(...sources: string[][]) {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    for (const rawId of source) {
      const trajectoryId = rawId.trim();

      if (trajectoryId === "" || seen.has(trajectoryId)) {
        continue;
      }

      seen.add(trajectoryId);
      merged.push(trajectoryId);
    }
  }

  return merged;
}

async function getCascadeModelLabels(connection: AntigravityConnectionInfo) {
  const response = await callLanguageServerRpc(
    connection,
    "GetCascadeModelConfigData",
  );

  return parseGetCascadeModelConfigDataResponse(response);
}

async function getCommandModelLabels(connection: AntigravityConnectionInfo) {
  const response = await callLanguageServerRpc(
    connection,
    "GetCommandModelConfigs",
  );

  return parseGetCommandModelConfigsResponse(response);
}

async function getDebugStepMessages(connection: AntigravityConnectionInfo) {
  const response = await callLanguageServerRpc(
    connection,
    "GetUserTrajectoryDebug",
    encodeGetUserTrajectoryDebugRequest(true),
  );

  return collectDebugStepMessages(response);
}

function mergeModelLabelMaps(...maps: ReadonlyMap<number, string>[]) {
  const merged = new Map<number, string>();

  for (const modelMap of maps) {
    for (const [modelValue, label] of modelMap) {
      if (!label || label.trim() === "") {
        continue;
      }

      merged.set(modelValue, label);
    }
  }

  return merged;
}

async function getTrajectoryCounts(
  connection: AntigravityConnectionInfo,
  trajectoryId: string,
) {
  const response = await callLanguageServerRpc(
    connection,
    "GetCascadeTrajectory",
    encodeGetCascadeTrajectoryRequest(trajectoryId),
  );

  return parseGetCascadeTrajectoryResponse(response);
}

async function getTrajectoryStepPage(
  connection: AntigravityConnectionInfo,
  trajectoryId: string,
  offset: number,
) {
  const response = await callLanguageServerRpc(
    connection,
    "GetCascadeTrajectorySteps",
    encodeGetCascadeTrajectoryStepsRequest(trajectoryId, offset),
  );

  return parseGetCascadeTrajectoryStepsResponse(response);
}

async function getTrajectoryGeneratorMetadataPage(
  connection: AntigravityConnectionInfo,
  trajectoryId: string,
  offset: number,
) {
  const response = await callLanguageServerRpc(
    connection,
    "GetCascadeTrajectoryGeneratorMetadata",
    encodeGetCascadeTrajectoryGeneratorMetadataRequest(trajectoryId, offset, true),
  );

  return parseGetCascadeTrajectoryGeneratorMetadataResponse(response);
}

function parseGeneratorMetadataTimestamp(rawGeneratorMetadata: Uint8Array) {
  const generatorMetadataFields = parseProtoFields(rawGeneratorMetadata);
  const rawTimeline = getProtoBytes(generatorMetadataFields, 9);

  if (!rawTimeline) {
    return null;
  }

  const timelineFields = parseProtoFields(rawTimeline);

  return (
    parseTimestamp(getProtoBytes(timelineFields, 4)) ??
    parseTimestamp(getProtoBytes(timelineFields, 1))
  );
}

function parseGeneratorMetadataUsage(
  rawGeneratorMetadataEntry: Uint8Array,
  trajectoryId: string,
  generatorMetadataOffset: number,
  dynamicModelLabels: ReadonlyMap<number, string>,
): ParsedStepUsage | null {
  const entryFields = parseProtoFields(rawGeneratorMetadataEntry);
  const rawGeneratorMetadata =
    getProtoBytes(entryFields, 1) ?? rawGeneratorMetadataEntry;
  const date = parseGeneratorMetadataTimestamp(rawGeneratorMetadata);

  if (!date) {
    return null;
  }

  const generatorMetadataFields = parseProtoFields(rawGeneratorMetadata);
  const modelUsage = parseModelUsageStats(
    getProtoBytes(generatorMetadataFields, 4),
    dynamicModelLabels,
  );

  if (!modelUsage) {
    return null;
  }

  return {
    date,
    modelName: modelUsage.modelName,
    tokenTotals: modelUsage.tokenTotals,
    usageKey:
      modelUsage.usageIdentifier ??
      `generator:${trajectoryId}:${generatorMetadataOffset}`,
  };
}

async function aggregateTrajectoryUsage(
  connection: AntigravityConnectionInfo,
  trajectoryId: string,
  start: Date,
  end: Date,
  recentStart: Date,
  totals: DailyTotalsByDate,
  modelTotals: Map<string, ModelTokenTotals>,
  recentModelTotals: Map<string, ModelTokenTotals>,
  dynamicModelLabels: ReadonlyMap<number, string>,
  seenUsageKeys: Set<string>,
  maxStepPages: number,
) {
  let totalSteps = 0;
  let totalGeneratorMetadata = 0;

  try {
    const counts = await getTrajectoryCounts(connection, trajectoryId);

    totalSteps = counts.totalSteps;
    totalGeneratorMetadata = counts.totalGeneratorMetadata;
  } catch {
    return;
  }

  if (totalSteps <= 0 && totalGeneratorMetadata <= 0) {
    return;
  }

  const seenRawSteps = new Set<string>();

  for (let pageIndex = 0; pageIndex < maxStepPages; pageIndex += 1) {
    const offset = pageIndex * STEP_PAGE_SIZE;
    let stepMessages: Uint8Array[];

    try {
      stepMessages = await getTrajectoryStepPage(connection, trajectoryId, offset);
    } catch {
      break;
    }

    if (stepMessages.length === 0) {
      break;
    }

    let addedRawSteps = 0;

    for (const rawStep of stepMessages) {
      const stepKey = Buffer.from(rawStep).toString("base64");

      if (seenRawSteps.has(stepKey)) {
        continue;
      }

      seenRawSteps.add(stepKey);
      addedRawSteps += 1;

      for (const parsedUsage of parseStepUsages(
        rawStep,
        stepKey,
        dynamicModelLabels,
      )) {
        if (seenUsageKeys.has(parsedUsage.usageKey)) {
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
    }

    if (totalSteps > 0 && seenRawSteps.size >= totalSteps) {
      break;
    }

    if (addedRawSteps === 0 && pageIndex > 0) {
      break;
    }
  }

  const maxGeneratorMetadataPages =
    totalGeneratorMetadata > 0
      ? Math.min(
          maxStepPages,
          Math.ceil(totalGeneratorMetadata / STEP_PAGE_SIZE),
        )
      : maxStepPages;

  for (
    let generatorPageIndex = 0;
    generatorPageIndex < maxGeneratorMetadataPages;
    generatorPageIndex += 1
  ) {
    const offset = generatorPageIndex * STEP_PAGE_SIZE;
    let generatorMetadataEntries: Uint8Array[];

    try {
      generatorMetadataEntries = await getTrajectoryGeneratorMetadataPage(
        connection,
        trajectoryId,
        offset,
      );
    } catch {
      break;
    }

    if (generatorMetadataEntries.length === 0) {
      break;
    }

    for (const [entryIndex, rawGeneratorMetadataEntry] of generatorMetadataEntries.entries()) {
      const parsedUsage = parseGeneratorMetadataUsage(
        rawGeneratorMetadataEntry,
        trajectoryId,
        offset + entryIndex,
        dynamicModelLabels,
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

    if (
      totalGeneratorMetadata > 0 &&
      offset + generatorMetadataEntries.length >= totalGeneratorMetadata
    ) {
      break;
    }

    if (generatorMetadataEntries.length < STEP_PAGE_SIZE) {
      break;
    }
  }
}

function aggregateDebugUsage(
  stepMessages: RawStepMessage[],
  start: Date,
  end: Date,
  recentStart: Date,
  totals: DailyTotalsByDate,
  modelTotals: Map<string, ModelTokenTotals>,
  recentModelTotals: Map<string, ModelTokenTotals>,
  dynamicModelLabels: ReadonlyMap<number, string>,
  seenUsageKeys: Set<string>,
) {
  for (const stepMessage of stepMessages) {
    for (const parsedUsage of parseStepUsages(
      stepMessage.rawStep,
      stepMessage.rawStepKey,
      dynamicModelLabels,
    )) {
      if (seenUsageKeys.has(parsedUsage.usageKey)) {
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
  }
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

  if (connection !== null) {
    return true;
  }

  for (const dir of getAntigravityConversationDirectories()) {
    if (existsSync(dir)) {
      try {
        const entries = readdirSync(dir);

        if (
          entries.some(
            (entry) => entry.endsWith(".db") || entry.endsWith(".pb"),
          )
        ) {
          return true;
        }
      } catch {
        // ignore filesystem read errors
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

      aggregateDebugUsage(
        debugStepMessages,
        start,
        end,
        recentStart,
        totals,
        modelTotals,
        recentModelTotals,
        dynamicModelLabels,
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
      await aggregateTrajectoryUsage(
        connection,
        trajectoryId,
        start,
        end,
        recentStart,
        totals,
        modelTotals,
        recentModelTotals,
        dynamicModelLabels,
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
