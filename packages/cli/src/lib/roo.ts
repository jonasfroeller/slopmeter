import type { UsageSummary } from "../interfaces";
import {
  type VsCodeTaskUsagePayload,
  type VsCodeTaskUsageOptions,
  createVsCodeTaskTokenTotals,
  getDefaultPearAiUserDataDirs,
  getDefaultVsCodeUserDataDirs,
  getVsCodeTaskUsageFiles,
  isVsCodeTaskUsageAvailable,
  loadVsCodeTaskUsageRows,
  parseVsCodeTaskTimestamp,
} from "./vscode-task-usage";

export const ROO_CONFIG_DIR_ENV = "ROO_CONFIG_DIR";

const ROO_OPTIONS: VsCodeTaskUsageOptions = {
  configDirEnv: ROO_CONFIG_DIR_ENV,
  defaultConfigDirs: () => [
    ...getDefaultVsCodeUserDataDirs(),
    ...getDefaultPearAiUserDataDirs(),
  ],
  extensionIds: [
    "rooveterinaryinc.roo-cline",
    "pearai.pearai-roo-cline",
  ],
  fallbackModel: "Roo Code",
  provider: "roo",
};

export type RooUsagePayload = VsCodeTaskUsagePayload;

export function parseRooTimestamp(value: unknown): Date | null {
  return parseVsCodeTaskTimestamp(value);
}

export function createRooTokenTotals(usage: RooUsagePayload) {
  return createVsCodeTaskTokenTotals(usage);
}

export async function getRooUsageFiles() {
  return getVsCodeTaskUsageFiles(ROO_OPTIONS);
}

export async function isRooAvailable() {
  return isVsCodeTaskUsageAvailable(ROO_OPTIONS);
}

export async function loadRooRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  return loadVsCodeTaskUsageRows(start, end, ROO_OPTIONS);
}
