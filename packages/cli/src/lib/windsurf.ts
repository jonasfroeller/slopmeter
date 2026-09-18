import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { UsageSummary } from "../interfaces";
import {
  type CodeiumConnectionInfo,
  type LanguageServerProcessInfo,
  aggregateCodeiumDebugUsage,
  aggregateCodeiumTrajectoryUsage,
  callLanguageServerRpc,
  chooseWorkingHttpPort,
  collectDebugStepMessages,
  encodeGetUserTrajectoryDebugRequest,
  formatCodeiumModelName,
  getNetstatListeningPortsByPid,
  mergeModelLabelMaps,
  mergeTrajectoryIds,
  parseCsrfTokenFromCommandLine,
  parseGetAllCascadeTrajectoriesResponse,
  parseGetCascadeModelConfigDataResponse,
  parseGetCommandModelConfigsResponse,
  parseUnixLanguageServerProcesses,
  parseWindowsProcessJsonOutput,
} from "./codeium-rpc";
import {
  type DailyTotalsByDate,
  type ModelTokenTotals,
  createUsageSummary,
  getPositiveIntegerEnv,
  getRecentWindowStart,
  listFilesRecursive,
} from "./utils";

const execFileAsync = promisify(execFile);

const WINDSURF_CONFIG_DIR_ENV = "WINDSURF_CONFIG_DIR";
const WINDSURF_CODEIUM_DIR_ENV = "WINDSURF_CODEIUM_DIR";
const WINDSURF_LANGUAGE_SERVER_PATH_ENV = "WINDSURF_LANGUAGE_SERVER_PATH";
const WINDSURF_LOG_PATH_ENV = "WINDSURF_LOG_PATH";
const WINDSURF_LS_PID_ENV = "WINDSURF_LS_PID";
const WINDSURF_LS_HTTP_PORT_ENV = "WINDSURF_LS_HTTP_PORT";
const WINDSURF_LS_CSRF_TOKEN_ENV = "WINDSURF_LS_CSRF_TOKEN";
const WINDSURF_MAX_TRAJECTORIES_ENV = "WINDSURF_MAX_TRAJECTORIES";
const WINDSURF_MAX_STEP_PAGES_ENV = "WINDSURF_MAX_STEP_PAGES";

const DEFAULT_MAX_TRAJECTORIES = 1_000;
const DEFAULT_MAX_STEP_PAGES = 100;
const CONNECTION_CACHE_MS = 10_000;
const HEADLESS_START_TIMEOUT_MS = 6_000;

interface WindsurfLogLaunchRecord {
  pid: number;
  httpPort?: number;
  httpsPort?: number;
}

const windsurfModelNames = new Map<number, string>([
  [0, "MODEL_UNSPECIFIED"],
  [20, "MODEL_EMBED_6591"],
  [30, "MODEL_CHAT_GPT_4"],
  [37, "MODEL_CHAT_GPT_4_1106_PREVIEW"],
  [61, "MODEL_GOOGLE_GEMINI_1_0_PRO"],
  [62, "MODEL_GOOGLE_GEMINI_1_5_PRO"],
  [63, "MODEL_CLAUDE_3_OPUS_20240229"],
  [64, "MODEL_CLAUDE_3_SONNET_20240229"],
  [71, "MODEL_CHAT_GPT_4O_2024_05_13"],
  [80, "MODEL_CLAUDE_3_5_SONNET_20240620"],
  [109, "MODEL_CHAT_GPT_4O_2024_08_06"],
  [113, "MODEL_CHAT_GPT_4O_MINI_2024_07_18"],
  [166, "MODEL_CLAUDE_3_5_SONNET_20241022"],
  [171, "MODEL_CLAUDE_3_5_HAIKU_20241022"],
  [172, "MODEL_CLAUDE_3_HAIKU_20240307"],
  [183, "MODEL_GOOGLE_GEMINI_EXP_1206"],
  [184, "MODEL_GOOGLE_GEMINI_2_0_FLASH"],
  [219, "MODEL_PRIVATE_1"],
  [220, "MODEL_PRIVATE_2"],
  [221, "MODEL_PRIVATE_3"],
  [222, "MODEL_PRIVATE_4"],
  [223, "MODEL_PRIVATE_5"],
  [226, "MODEL_CLAUDE_3_7_SONNET_20250219"],
  [227, "MODEL_CLAUDE_3_7_SONNET_20250219_THINKING"],
  [228, "MODEL_CHAT_GPT_4_5"],
  [246, "MODEL_GOOGLE_GEMINI_2_5_PRO"],
  [259, "MODEL_CHAT_GPT_4_1_2025_04_14"],
  [260, "MODEL_CHAT_GPT_4_1_MINI_2025_04_14"],
  [261, "MODEL_CHAT_GPT_4_1_NANO_2025_04_14"],
  [272, "MODEL_GOOGLE_GEMINI_2_5_FLASH_PREVIEW_04_17"],
  [275, "MODEL_GOOGLE_GEMINI_2_5_FLASH_PREVIEW_05_20"],
  [276, "MODEL_GOOGLE_GEMINI_2_5_FLASH_PREVIEW_05_20_THINKING"],
  [277, "MODEL_CLAUDE_4_OPUS_BYOK"],
  [278, "MODEL_CLAUDE_4_OPUS_THINKING_BYOK"],
  [279, "MODEL_CLAUDE_4_SONNET_BYOK"],
  [280, "MODEL_CLAUDE_4_SONNET_THINKING_BYOK"],
  [281, "MODEL_CLAUDE_4_SONNET"],
  [282, "MODEL_CLAUDE_4_SONNET_THINKING"],
  [284, "MODEL_CLAUDE_3_5_SONNET_BYOK"],
  [285, "MODEL_CLAUDE_3_7_SONNET_BYOK"],
  [286, "MODEL_CLAUDE_3_7_SONNET_THINKING_BYOK"],
  [290, "MODEL_CLAUDE_4_OPUS"],
  [291, "MODEL_CLAUDE_4_OPUS_THINKING"],
  [292, "MODEL_CLAUDE_4_SONNET_DATABRICKS"],
  [293, "MODEL_CLAUDE_4_SONNET_THINKING_DATABRICKS"],
  [312, "MODEL_GOOGLE_GEMINI_2_5_FLASH"],
  [313, "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING"],
  [314, "MODEL_PRIVATE_6"],
  [315, "MODEL_PRIVATE_7"],
  [316, "MODEL_PRIVATE_8"],
  [317, "MODEL_PRIVATE_9"],
  [318, "MODEL_PRIVATE_10"],
  [319, "MODEL_CLAUDE_3_7_SONNET_OPEN_ROUTER_BYOK"],
  [320, "MODEL_CLAUDE_3_7_SONNET_THINKING_OPEN_ROUTER_BYOK"],
  [321, "MODEL_CLAUDE_4_SONNET_OPEN_ROUTER_BYOK"],
  [322, "MODEL_CLAUDE_4_SONNET_THINKING_OPEN_ROUTER_BYOK"],
  [326, "MODEL_GPT_OSS_120B"],
  [328, "MODEL_CLAUDE_4_1_OPUS"],
  [329, "MODEL_CLAUDE_4_1_OPUS_THINKING"],
  [337, "MODEL_GPT_5_NANO"],
  [338, "MODEL_CHAT_GPT_5_MINIMAL"],
  [339, "MODEL_CHAT_GPT_5_LOW"],
  [340, "MODEL_CHAT_GPT_5"],
  [341, "MODEL_CHAT_GPT_5_HIGH"],
  [343, "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE"],
  [346, "MODEL_CHAT_GPT_5_CODEX"],
  [347, "MODEL_PRIVATE_11"],
  [348, "MODEL_PRIVATE_12"],
  [349, "MODEL_PRIVATE_13"],
  [350, "MODEL_PRIVATE_14"],
  [351, "MODEL_PRIVATE_15"],
  [353, "MODEL_CLAUDE_4_5_SONNET"],
  [354, "MODEL_CLAUDE_4_5_SONNET_THINKING"],
  [359, "MODEL_SWE_1_5"],
  [361, "MODEL_SWE_1_5_REDIRECT"],
  [363, "MODEL_PRIVATE_16"],
  [364, "MODEL_PRIVATE_17"],
  [369, "MODEL_SWE_1_5_THINKING"],
  [370, "MODEL_CLAUDE_4_5_SONNET_1M"],
  [371, "MODEL_CLAUDE_4_5_SONNET_THINKING_1M"],
  [377, "MODEL_SWE_1_5_SLOW"],
  [378, "MODEL_GOOGLE_GEMINI_3_0_PRO_LOW"],
  [379, "MODEL_GOOGLE_GEMINI_3_0_PRO_HIGH"],
  [385, "MODEL_GPT_5_1_CODEX_MINI_LOW"],
  [386, "MODEL_GPT_5_1_CODEX_MINI_MEDIUM"],
  [387, "MODEL_GPT_5_1_CODEX_MINI_HIGH"],
  [388, "MODEL_GPT_5_1_CODEX_LOW"],
  [389, "MODEL_GPT_5_1_CODEX_MEDIUM"],
  [390, "MODEL_GPT_5_1_CODEX_HIGH"],
  [391, "MODEL_CLAUDE_4_5_OPUS"],
  [392, "MODEL_CLAUDE_4_5_OPUS_THINKING"],
  [395, "MODEL_GPT_5_1_CODEX_MAX_LOW"],
  [396, "MODEL_GPT_5_1_CODEX_MAX_MEDIUM"],
  [397, "MODEL_GPT_5_1_CODEX_MAX_HIGH"],
  [411, "MODEL_GOOGLE_GEMINI_3_0_PRO_MINIMAL"],
  [412, "MODEL_GOOGLE_GEMINI_3_0_PRO_MEDIUM"],
  [413, "MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL"],
  [414, "MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW"],
  [415, "MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM"],
  [416, "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH"],
  [420, "MODEL_SWE_1_6"],
  [421, "MODEL_SWE_1_6_FAST"],
]);

let cachedConnectionInfo: {
  cacheKey: string;
  value: CodeiumConnectionInfo | null;
  expiresAt: number;
} | null = null;

function getConnectionCacheKey() {
  return [
    WINDSURF_CONFIG_DIR_ENV,
    WINDSURF_CODEIUM_DIR_ENV,
    WINDSURF_LOG_PATH_ENV,
    WINDSURF_LS_PID_ENV,
    WINDSURF_LS_HTTP_PORT_ENV,
    WINDSURF_LS_CSRF_TOKEN_ENV,
  ]
    .map((name) => `${name}=${process.env[name] ?? ""}`)
    .join("\u0000");
}

export function getWindsurfCodeiumDir(): string {
  const configuredDir = process.env[WINDSURF_CODEIUM_DIR_ENV]?.trim();

  if (configuredDir) {
    return resolve(configuredDir);
  }

  return join(homedir(), ".codeium", "windsurf");
}

export function getWindsurfCascadeDir(): string {
  return join(getWindsurfCodeiumDir(), "cascade");
}

export function getWindsurfConfigRoots(): string[] {
  const configuredRoot = process.env[WINDSURF_CONFIG_DIR_ENV]?.trim();

  if (configuredRoot) {
    return [resolve(configuredRoot)];
  }

  const roots: string[] = [];
  const home = homedir();

  if (process.platform === "darwin") {
    const appSupport = join(home, "Library", "Application Support");

    roots.push(join(appSupport, "Windsurf"));
  } else if (process.platform === "win32") {
    const appData =
      process.env.APPDATA?.trim() || join(home, "AppData", "Roaming");

    roots.push(join(appData, "Windsurf"));
  } else {
    const xdgConfigHome =
      process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config");

    roots.push(join(xdgConfigHome, "Windsurf"), join(home, ".config", "Windsurf"));
  }

  return [...new Set(roots)];
}

export function getWindsurfLogsRoots(): string[] {
  return getWindsurfConfigRoots().map((root) => join(root, "logs"));
}

function getExplicitLogPath(): string | null {
  const explicit = process.env[WINDSURF_LOG_PATH_ENV]?.trim();

  return explicit ? resolve(explicit) : null;
}

export function parseWindsurfLogLaunchRecords(
  content: string,
): WindsurfLogLaunchRecord[] {
  const records: WindsurfLogLaunchRecord[] = [];
  const lines = content.split(/\r?\n/);

  const ensureRecord = (pid: number) => {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].pid === pid) {
        return records[index];
      }
    }

    const record: WindsurfLogLaunchRecord = { pid };

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

    const portMatch = line.match(
      /(\d+)\s+server\.go:\d+\]\s+Language server listening on random port at (\d+)/i,
    );

    if (portMatch) {
      const record = ensureRecord(Number(portMatch[1]));

      record.httpPort = Number(portMatch[2]);
    }
  }

  return records;
}

export async function getRecentWindsurfLogFiles(): Promise<string[]> {
  const explicitLog = getExplicitLogPath();

  if (explicitLog) {
    return existsSync(explicitLog) ? [explicitLog] : [];
  }

  const logFiles: string[] = [];

  for (const logsRoot of getWindsurfLogsRoots()) {
    if (!existsSync(logsRoot)) {
      continue;
    }

    const files = await listFilesRecursive(logsRoot, ".log");

    for (const filePath of files) {
      if (basename(filePath).toLowerCase() === "windsurf.log") {
        logFiles.push(filePath);
      }
    }
  }

  return logFiles.sort((left, right) => right.localeCompare(left));
}

export async function getLatestWindsurfLaunchRecord(): Promise<WindsurfLogLaunchRecord | null> {
  const logFiles = await getRecentWindsurfLogFiles();

  for (const logFile of logFiles) {
    let content: string;

    try {
      content = await readFile(logFile, "utf8");
    } catch {
      continue;
    }

    const records = parseWindsurfLogLaunchRecords(content);
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

async function getWindowsLanguageServerProcesses(): Promise<LanguageServerProcessInfo[]> {
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

async function getUnixLanguageServerProcesses(): Promise<LanguageServerProcessInfo[]> {
  const output = await tryExec("ps", ["-ax", "-o", "pid=,command="]);

  if (!output) {
    return [];
  }

  return parseUnixLanguageServerProcesses(output);
}

export async function getWindsurfLanguageServerProcesses(): Promise<LanguageServerProcessInfo[]> {
  const processes =
    process.platform === "win32"
      ? await getWindowsLanguageServerProcesses()
      : await getUnixLanguageServerProcesses();

  return processes.filter(
    (processInfo) =>
      /language_server/i.test(processInfo.commandLine) &&
      /windsurf/i.test(processInfo.commandLine),
  );
}

function parsePidEnvVar(): number | null {
  const rawPid = process.env[WINDSURF_LS_PID_ENV]?.trim();

  if (!rawPid) {
    return null;
  }

  const pid = Number(rawPid);

  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function parseHttpPortEnvVar(): number | null {
  const rawPort = process.env[WINDSURF_LS_HTTP_PORT_ENV]?.trim();

  if (!rawPort) {
    return null;
  }

  const port = Number(rawPort);

  return Number.isInteger(port) && port > 0 ? port : null;
}

export function decodeWindsurfModelName(modelValue: number): string {
  const configuredName = windsurfModelNames.get(modelValue);

  if (configuredName) {
    return configuredName;
  }

  if (modelValue >= 1_000 && modelValue <= 2_000) {
    return `MODEL_PLACEHOLDER_M${modelValue - 1_000}`;
  }

  return `MODEL_${modelValue}`;
}

export function resolveWindsurfModelName(
  modelValue: number,
  dynamicModelLabels: ReadonlyMap<number, string>,
): string {
  const dynamicLabel = dynamicModelLabels.get(modelValue)?.trim();

  if (dynamicLabel) {
    return formatCodeiumModelName(dynamicLabel);
  }

  return formatCodeiumModelName(decodeWindsurfModelName(modelValue));
}

export async function discoverWindsurfConnectionInfo(): Promise<CodeiumConnectionInfo | null> {
  const envCsrfToken = process.env[WINDSURF_LS_CSRF_TOKEN_ENV]?.trim() || null;
  const envHttpPort = parseHttpPortEnvVar();
  const envPid = parsePidEnvVar();

  if (envCsrfToken && envHttpPort && envPid) {
    return {
      pid: envPid,
      csrfToken: envCsrfToken,
      httpPort: envHttpPort,
    };
  }

  const [launchRecord, processes] = await Promise.all([
    getLatestWindsurfLaunchRecord(),
    getWindsurfLanguageServerProcesses(),
  ]);
  const targetPid = envPid ?? launchRecord?.pid ?? null;
  const processInfo =
    (targetPid
      ? processes.find((candidate) => candidate.pid === targetPid)
      : null) ??
    processes.find(
      (candidate) =>
        parseCsrfTokenFromCommandLine(candidate.commandLine) !== null,
    ) ??
    null;

  if (!processInfo) {
    return null;
  }

  const csrfToken =
    envCsrfToken ?? parseCsrfTokenFromCommandLine(processInfo.commandLine);

  if (!csrfToken) {
    return null;
  }

  const candidatePorts: number[] = [];

  if (envHttpPort) {
    candidatePorts.push(envHttpPort);
  }

  if (launchRecord?.pid === processInfo.pid && launchRecord.httpPort) {
    candidatePorts.push(launchRecord.httpPort);
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
  };
}

export async function getWindsurfConnectionInfo(): Promise<CodeiumConnectionInfo | null> {
  const now = Date.now();
  const cacheKey = getConnectionCacheKey();

  if (
    cachedConnectionInfo &&
    cachedConnectionInfo.cacheKey === cacheKey &&
    cachedConnectionInfo.expiresAt > now
  ) {
    return cachedConnectionInfo.value;
  }

  const value = await discoverWindsurfConnectionInfo();

  cachedConnectionInfo = {
    cacheKey,
    value,
    expiresAt: now + CONNECTION_CACHE_MS,
  };

  return value;
}

async function findLanguageServerOnPath(): Promise<string | null> {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const executableNames =
    process.platform === "win32"
      ? ["language_server_windows_x64.exe", "language_server.exe", "language_server"]
      : [
          "language_server_macos_arm",
          "language_server_macos_x64",
          "language_server_linux_x64",
          "language_server",
        ];

  for (const executableName of executableNames) {
    const output = await tryExec(command, [executableName]);

    if (!output) {
      continue;
    }

    for (const line of output.split(/\r?\n/)) {
      const candidate = line.trim().replace(/^"|"$/g, "");

      if (candidate && existsSync(candidate)) {
        return resolve(candidate);
      }
    }
  }

  return null;
}

export async function findWindsurfLanguageServerBinary(): Promise<string | null> {
  const explicitPath = process.env[WINDSURF_LANGUAGE_SERVER_PATH_ENV]?.trim();

  if (explicitPath && existsSync(explicitPath)) {
    return resolve(explicitPath);
  }

  const pathBinary = await findLanguageServerOnPath();

  if (pathBinary) {
    return pathBinary;
  }

  if (process.platform === "win32") {
    const registryInstallLocations: string[] = [];

    for (const rootKey of [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ]) {
      const output = await tryExec("reg.exe", [
        "query",
        rootKey,
        "/f",
        "Windsurf",
        "/s",
      ]);

      if (!output) {
        continue;
      }

      for (const line of output.split(/\r?\n/)) {
        const match = line.match(
          /^\s*(?:InstallLocation|Inno Setup: App Path)\s+REG_SZ\s+(.*)$/i,
        );

        if (match?.[1]) {
          const rawDir = match[1].trim();

          if (rawDir && !registryInstallLocations.includes(rawDir)) {
            registryInstallLocations.push(rawDir);
          }
        }
      }
    }

    const candidateInstallDirs = [
      ...registryInstallLocations,
      join(process.env.LOCALAPPDATA ?? "", "Programs", "Windsurf"),
      "C:\\Program Files\\Windsurf",
      "C:\\Program Files (x86)\\Windsurf",
      "A:\\Windsurf",
      "D:\\Windsurf",
    ];

    for (const installDir of candidateInstallDirs) {
      const binaryPath = join(
        installDir,
        "resources",
        "app",
        "extensions",
        "windsurf",
        "bin",
        "language_server_windows_x64.exe",
      );

      if (existsSync(binaryPath)) {
        return binaryPath;
      }
    }
  } else if (process.platform === "darwin") {
    const macCandidates = [
      "/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_arm",
      "/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_x64",
      join(
        homedir(),
        "Applications",
        "Windsurf.app",
        "Contents",
        "Resources",
        "app",
        "extensions",
        "windsurf",
        "bin",
        "language_server_macos_arm",
      ),
      join(
        homedir(),
        "Applications",
        "Windsurf.app",
        "Contents",
        "Resources",
        "app",
        "extensions",
        "windsurf",
        "bin",
        "language_server_macos_x64",
      ),
    ];

    for (const candidate of macCandidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } else {
    const linuxCandidates = [
      "/usr/share/windsurf/resources/app/extensions/windsurf/bin/language_server_linux_x64",
      "/usr/lib/windsurf/resources/app/extensions/windsurf/bin/language_server_linux_x64",
      join(
        homedir(),
        ".local",
        "share",
        "windsurf",
        "resources",
        "app",
        "extensions",
        "windsurf",
        "bin",
        "language_server_linux_x64",
      ),
    ];

    for (const candidate of linuxCandidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export async function withHeadlessWindsurfServer<T>(
  callback: (connection: CodeiumConnectionInfo) => Promise<T>,
): Promise<T | null> {
  const binaryPath = await findWindsurfLanguageServerBinary();

  if (!binaryPath) {
    return null;
  }

  const codeiumDir = getWindsurfCodeiumDir();

  if (!existsSync(codeiumDir)) {
    return null;
  }

  const csrfToken = randomUUID();
  const child = spawn(binaryPath, [
    "--random_port",
    "--codeium_dir",
    codeiumDir,
    "--csrf_token",
    csrfToken,
  ]);

  return new Promise<T | null>((resolvePromise) => {
    let resolved = false;
    let listeningPort: number | null = null;

    const cleanup = () => {
      try {
        child.kill();
      } catch {
        // ignore errors during process teardown
      }
    };

    const timeoutRef: {
      current: NodeJS.Timeout | undefined;
    } = { current: undefined };
    const finish = (value: T | null) => {
      if (resolved) {
        return;
      }

      resolved = true;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      cleanup();
      resolvePromise(value);
    };

    timeoutRef.current = setTimeout(() => {
      finish(null);
    }, HEADLESS_START_TIMEOUT_MS);

    child.stderr.on("data", (data: Buffer) => {
      if (resolved || listeningPort !== null) {
        return;
      }

      const text = data.toString("utf8");
      const portMatch = text.match(
        /Language server listening on random port at (\d+)/i,
      );

      if (portMatch) {
        listeningPort = Number(portMatch[1]);
        const connection: CodeiumConnectionInfo = {
          pid: child.pid ?? 0,
          csrfToken,
          httpPort: listeningPort,
        };

        void callback(connection)
          .then((result) => finish(result))
          .catch(() => finish(null));
      }
    });

    child.on("error", () => {
      finish(null);
    });

    child.on("exit", () => {
      finish(null);
    });
  });
}

export async function isWindsurfAvailable(): Promise<boolean> {
  const connection = await getWindsurfConnectionInfo();

  if (connection) {
    return true;
  }

  const cascadeDir = getWindsurfCascadeDir();

  if (existsSync(cascadeDir)) {
    try {
      const files = await readdir(cascadeDir);

      if (files.some((f) => f.endsWith(".pb"))) {
        return true;
      }
    } catch {
      // directory read failure indicates unavailable
    }
  }

  return false;
}

async function queryWindsurfUsage(
  connection: CodeiumConnectionInfo,
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  const recentStart = getRecentWindowStart(end, 30);
  const maxTrajectories = getPositiveIntegerEnv(
    WINDSURF_MAX_TRAJECTORIES_ENV,
    DEFAULT_MAX_TRAJECTORIES,
  );
  const maxStepPages = getPositiveIntegerEnv(
    WINDSURF_MAX_STEP_PAGES_ENV,
    DEFAULT_MAX_STEP_PAGES,
  );
  const seenUsageKeys = new Set<string>();
  let dynamicModelLabels = new Map<number, string>();

  try {
    dynamicModelLabels = mergeModelLabelMaps(
      dynamicModelLabels,
      await parseGetCascadeModelConfigDataResponse(
        await callLanguageServerRpc(connection, "GetCascadeModelConfigData"),
      ),
    );
  } catch {
    // continue with fallback model names
  }

  try {
    dynamicModelLabels = mergeModelLabelMaps(
      dynamicModelLabels,
      await parseGetCommandModelConfigsResponse(
        await callLanguageServerRpc(connection, "GetCommandModelConfigs"),
      ),
    );
  } catch {
    // continue with fallback model names
  }

  try {
    const debugStepMessages = collectDebugStepMessages(
      await callLanguageServerRpc(
        connection,
        "GetUserTrajectoryDebug",
        encodeGetUserTrajectoryDebugRequest(true),
      ),
    );

    aggregateCodeiumDebugUsage(
      debugStepMessages,
      start,
      end,
      recentStart,
      totals,
      modelTotals,
      recentModelTotals,
      dynamicModelLabels,
      resolveWindsurfModelName,
      seenUsageKeys,
    );
  } catch {
    // optional debug endpoint
  }

  let rpcCascadeIds: string[] = [];

  try {
    rpcCascadeIds = parseGetAllCascadeTrajectoriesResponse(
      await callLanguageServerRpc(connection, "GetAllCascadeTrajectories"),
    );
  } catch {
    // continue with local file ids
  }

  const cascadeDir = getWindsurfCascadeDir();
  const fileTrajectoryIds: string[] = [];

  if (existsSync(cascadeDir)) {
    try {
      const files = await readdir(cascadeDir);

      for (const file of files) {
        if (file.endsWith(".pb")) {
          fileTrajectoryIds.push(basename(file, ".pb"));
        }
      }
    } catch {
      // directory read failure
    }
  }

  const candidateTrajectoryIds = mergeTrajectoryIds(
    rpcCascadeIds,
    fileTrajectoryIds,
  );

  for (const trajectoryId of candidateTrajectoryIds.slice(
    0,
    maxTrajectories,
  )) {
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
      resolveWindsurfModelName,
      seenUsageKeys,
      maxStepPages,
    );
  }

  return createUsageSummary(
    "windsurf",
    totals,
    modelTotals,
    recentModelTotals,
    end,
  );
}

export async function loadWindsurfRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const activeConnection = await getWindsurfConnectionInfo();

  if (activeConnection) {
    return queryWindsurfUsage(activeConnection, start, end);
  }

  const headlessResult = await withHeadlessWindsurfServer((connection) =>
    queryWindsurfUsage(connection, start, end),
  );

  if (headlessResult) {
    return headlessResult;
  }

  return createUsageSummary(
    "windsurf",
    new Map(),
    new Map(),
    new Map(),
    end,
  );
}
