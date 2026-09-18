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

export const CLINE_CONFIG_DIR_ENV = "CLINE_CONFIG_DIR";

const CLINE_OPTIONS: VsCodeTaskUsageOptions = {
  configDirEnv: CLINE_CONFIG_DIR_ENV,
  defaultConfigDirs: getDefaultVsCodeUserDataDirs,
  extensionIds: ["saoudrizwan.claude-dev", "cline.cline"],
  fallbackModel: "Cline",
  provider: "cline",
};

export type ClineUsagePayload = VsCodeTaskUsagePayload;

export function parseClineTimestamp(value: unknown): Date | null {
  return parseVsCodeTaskTimestamp(value);
}

export function createClineTokenTotals(usage: ClineUsagePayload) {
  return createVsCodeTaskTokenTotals(usage);
}

export async function getClineUsageFiles() {
  return getVsCodeTaskUsageFiles(CLINE_OPTIONS);
}

export async function isClineAvailable() {
  return isVsCodeTaskUsageAvailable(CLINE_OPTIONS);
}

export async function loadClineRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  return loadVsCodeTaskUsageRows(start, end, CLINE_OPTIONS);
}
