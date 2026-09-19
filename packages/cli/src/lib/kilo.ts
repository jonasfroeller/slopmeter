import type { UsageSummary } from "../interfaces";
import {
  type VsCodeTaskUsagePayload,
  type VsCodeTaskUsageOptions,
  createVsCodeTaskTokenTotals,
  getDefaultVsCodeUserDataDirs,
  getVsCodeTaskUsageFiles,
  isVsCodeTaskUsageAvailable,
  loadVsCodeTaskUsageRows,
  parseVsCodeTaskTimestamp,
} from "./vscode-task-usage";

export const KILO_CONFIG_DIR_ENV = "KILO_CONFIG_DIR";

const KILO_OPTIONS: VsCodeTaskUsageOptions = {
  configDirEnv: KILO_CONFIG_DIR_ENV,
  defaultConfigDirs: getDefaultVsCodeUserDataDirs,
  extensionIds: ["kilocode.kilo-code"],
  fallbackModel: "Kilo Code",
  provider: "kilo",
};

export type KiloUsagePayload = VsCodeTaskUsagePayload;

export function parseKiloTimestamp(value: unknown): Date | null {
  return parseVsCodeTaskTimestamp(value);
}

export function createKiloTokenTotals(usage: KiloUsagePayload) {
  return createVsCodeTaskTokenTotals(usage);
}

export async function getKiloUsageFiles() {
  return getVsCodeTaskUsageFiles(KILO_OPTIONS);
}

export async function isKiloAvailable() {
  return isVsCodeTaskUsageAvailable(KILO_OPTIONS);
}

export async function loadKiloRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  return loadVsCodeTaskUsageRows(start, end, KILO_OPTIONS);
}
