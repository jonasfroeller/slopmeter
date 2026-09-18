import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  addDailyTokenTotals,
  addModelTokenTotals,
  type DailyTokenTotals,
  type DailyTotalsByDate,
  type ModelTokenTotals,
} from "./utils";

const execFileAsync = promisify(execFile);
const textDecoder = new TextDecoder();

export const CODEIUM_CSRF_HEADER = "x-codeium-csrf-token";
export const CODEIUM_RPC_CONTENT_TYPE = "application/proto";
export const CODEIUM_REQUEST_TIMEOUT_MS = 3_500;
export const CODEIUM_STEP_PAGE_SIZE = 20;

export type RpcMethod =
  | "GetAllCascadeTrajectories"
  | "GetCascadeModelConfigData"
  | "GetCommandModelConfigs"
  | "GetUserTrajectoryDebug"
  | "GetUserStatus"
  | "GetCascadeTrajectory"
  | "GetCascadeTrajectorySteps"
  | "GetCascadeTrajectoryGeneratorMetadata";

export interface ProtoField {
  fieldNumber: number;
  wireType: number;
  value: bigint | Uint8Array;
}

export interface CodeiumConnectionInfo {
  pid: number;
  httpPort: number;
  csrfToken: string;
}

export interface LanguageServerProcessInfo {
  pid: number;
  commandLine: string;
}

export interface ParsedStepUsage {
  date: Date;
  modelName?: string;
  tokenTotals: DailyTokenTotals;
  usageKey: string;
}

export interface ParsedModelUsageStats {
  modelName: string;
  tokenTotals: DailyTokenTotals;
  usageIdentifier?: string;
}

export interface RawStepMessage {
  rawStep: Uint8Array;
  rawStepKey: string;
}

export interface CascadeTrajectoryCounts {
  totalSteps: number;
  totalGeneratorMetadata: number;
}

export type ModelNameResolver = (
  modelValue: number,
  dynamicModelLabels: ReadonlyMap<number, string>,
) => string;

export function encodeVarint(value: bigint | number) {
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

export function concatByteArrays(chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

export function encodeFieldKey(fieldNumber: number, wireType: number) {
  return encodeVarint(BigInt((fieldNumber << 3) | wireType));
}

export function encodeStringField(fieldNumber: number, value: string) {
  const encodedValue = new TextEncoder().encode(value);

  return concatByteArrays([
    encodeFieldKey(fieldNumber, 2),
    encodeVarint(encodedValue.length),
    encodedValue,
  ]);
}

export function encodeUint32Field(fieldNumber: number, value: number) {
  return concatByteArrays([
    encodeFieldKey(fieldNumber, 0),
    encodeVarint(value),
  ]);
}

export function encodeGetCascadeTrajectoryRequest(cascadeId: string) {
  return encodeStringField(1, cascadeId);
}

export function encodeGetCascadeTrajectoryStepsRequest(
  cascadeId: string,
  offset: number,
) {
  return concatByteArrays([
    encodeStringField(1, cascadeId),
    encodeUint32Field(2, offset),
  ]);
}

export function encodeGetCascadeTrajectoryGeneratorMetadataRequest(
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

export function encodeGetUserTrajectoryDebugRequest(
  includeAllTrajectories: boolean,
) {
  return concatByteArrays([
    encodeFieldKey(1, 0),
    encodeVarint(includeAllTrajectories ? 1 : 0),
  ]);
}

export function readVarint(bytes: Uint8Array, offset: number) {
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

export function parseProtoFields(bytes: Uint8Array) {
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

export function getProtoVarint(fields: ProtoField[], fieldNumber: number) {
  for (const field of fields) {
    if (field.fieldNumber === fieldNumber && field.wireType === 0) {
      return field.value as bigint;
    }
  }

  return undefined;
}

export function getProtoBytes(fields: ProtoField[], fieldNumber: number) {
  for (const field of fields) {
    if (field.fieldNumber === fieldNumber && field.wireType === 2) {
      return field.value as Uint8Array;
    }
  }

  return undefined;
}

export function getRepeatedProtoBytes(
  fields: ProtoField[],
  fieldNumber: number,
) {
  const values: Uint8Array[] = [];

  for (const field of fields) {
    if (field.fieldNumber === fieldNumber && field.wireType === 2) {
      values.push(field.value as Uint8Array);
    }
  }

  return values;
}

export function protoVarintToNumber(value: bigint | undefined) {
  if (value === undefined) {
    return 0;
  }

  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number.MAX_SAFE_INTEGER;
  }

  return Number(value);
}

export function decodeUtf8(value: Uint8Array | undefined) {
  if (!value || value.length === 0) {
    return undefined;
  }

  const decoded = textDecoder.decode(value).trim();

  return decoded === "" ? undefined : decoded;
}

export function parseTimestamp(rawTimestamp: Uint8Array | undefined) {
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

export function formatCodeiumModelName(rawName: string) {
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

export function parseModelUsageIdentifier(modelUsageFields: ProtoField[]) {
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

export function parseModelUsageStats(
  rawModelUsage: Uint8Array | undefined,
  dynamicModelLabels: ReadonlyMap<number, string>,
  resolveModelName: ModelNameResolver,
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
    modelName: resolveModelName(modelValue, dynamicModelLabels),
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

export function extractStepModelUsagePayloads(metadataFields: ProtoField[]) {
  const payloads: Uint8Array[] = [];
  const directUsage = getProtoBytes(metadataFields, 9);

  if (directUsage) {
    payloads.push(directUsage);
  }

  for (const usageContainer of getRepeatedProtoBytes(metadataFields, 28)) {
    const usageContainerFields = parseProtoFields(usageContainer);

    for (const modelUsagePayload of getRepeatedProtoBytes(
      usageContainerFields,
      2,
    )) {
      payloads.push(modelUsagePayload);
    }
  }

  return payloads;
}

export function parseStepUsages(
  rawStep: Uint8Array,
  rawStepKey: string,
  dynamicModelLabels: ReadonlyMap<number, string>,
  resolveModelName: ModelNameResolver,
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
    const modelUsage = parseModelUsageStats(
      modelUsagePayload,
      dynamicModelLabels,
      resolveModelName,
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
    usages.push({
      date,
      modelName: modelUsage.modelName,
      tokenTotals: modelUsage.tokenTotals,
      usageKey,
    });
  }

  return usages;
}

export function parseGeneratorMetadataTimestamp(
  rawGeneratorMetadata: Uint8Array,
) {
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

export function parseGeneratorMetadataUsage(
  rawGeneratorMetadataEntry: Uint8Array,
  trajectoryId: string,
  generatorMetadataOffset: number,
  dynamicModelLabels: ReadonlyMap<number, string>,
  resolveModelName: ModelNameResolver,
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
    resolveModelName,
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

export function parseGetAllCascadeTrajectoriesResponse(
  rawResponse: Uint8Array,
) {
  const topFields = parseProtoFields(rawResponse);
  const trajectoryIds: string[] = [];
  const seen = new Set<string>();

  for (const trajectoryField of getRepeatedProtoBytes(topFields, 1)) {
    const trajectoryFields = parseProtoFields(trajectoryField);
    const trajectoryId = decodeUtf8(getProtoBytes(trajectoryFields, 1));

    if (!trajectoryId || seen.has(trajectoryId)) {
      continue;
    }

    seen.add(trajectoryId);
    trajectoryIds.push(trajectoryId);
  }

  return trajectoryIds;
}

export function parseGetCascadeTrajectoryResponse(
  rawResponse: Uint8Array,
): CascadeTrajectoryCounts {
  const topFields = parseProtoFields(rawResponse);
  const directTotalSteps = getProtoVarint(topFields, 3);
  const directTotalGeneratorMetadata = getProtoVarint(topFields, 4);

  // Antigravity and Windsurf currently return the trajectory counts as
  // top-level varints. Keep accepting the nested trajectory shape as a
  // fallback because older language-server builds exposed the entries
  // themselves instead of the count fields.
  if (directTotalSteps !== undefined || directTotalGeneratorMetadata !== undefined) {
    return {
      totalSteps: protoVarintToNumber(directTotalSteps),
      totalGeneratorMetadata: protoVarintToNumber(directTotalGeneratorMetadata),
    };
  }

  const trajectoryBytes = getProtoBytes(topFields, 1);

  if (!trajectoryBytes) {
    return { totalSteps: 0, totalGeneratorMetadata: 0 };
  }

  const trajectoryFields = parseProtoFields(trajectoryBytes);
  const steps = getRepeatedProtoBytes(trajectoryFields, 2);
  const generatorMetadataEntries = getRepeatedProtoBytes(trajectoryFields, 3);

  return {
    totalSteps: steps.length,
    totalGeneratorMetadata: generatorMetadataEntries.length,
  };
}

export function parseGetCascadeTrajectoryStepsResponse(
  rawResponse: Uint8Array,
) {
  const topFields = parseProtoFields(rawResponse);

  return getRepeatedProtoBytes(topFields, 1);
}

export function parseGetCascadeTrajectoryGeneratorMetadataResponse(
  rawResponse: Uint8Array,
) {
  const topFields = parseProtoFields(rawResponse);

  return getRepeatedProtoBytes(topFields, 1);
}

export function collectDebugStepMessages(
  rawResponse: Uint8Array,
): RawStepMessage[] {
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

export function parseModelValueFromModelOrAlias(
  rawModelOrAlias: Uint8Array | undefined,
  preferredModelValues?: ReadonlySet<number>,
) {
  if (!rawModelOrAlias) {
    return null;
  }

  const fields = parseProtoFields(rawModelOrAlias);
  const directModelValue = protoVarintToNumber(getProtoVarint(fields, 1));

  if (
    directModelValue > 0 &&
    (!preferredModelValues || preferredModelValues.has(directModelValue))
  ) {
    return directModelValue;
  }

  const aliasValue = protoVarintToNumber(getProtoVarint(fields, 2));

  if (
    aliasValue > 0 &&
    (!preferredModelValues || preferredModelValues.has(aliasValue))
  ) {
    return aliasValue;
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

    const currentFields = parseProtoFields(current.bytes);

    for (const field of currentFields) {
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
    return directModelValue > 0
      ? directModelValue
      : aliasValue > 0
        ? aliasValue
        : null;
  }

  const preferredCandidate = preferredModelValues
    ? candidates.find((candidate) => preferredModelValues.has(candidate))
    : undefined;

  if (preferredCandidate !== undefined) {
    return preferredCandidate;
  }

  if (directModelValue > 0) {
    return directModelValue;
  }

  if (aliasValue > 0) {
    return aliasValue;
  }

  return candidates[0];
}

export function parseModelValueFromConfigKey(configKey: string | undefined) {
  if (!configKey) {
    return null;
  }

  const trimmed = configKey.trim();
  const directMatch = trimmed.match(/^(\d+)$/);

  if (directMatch) {
    const parsed = Number(directMatch[1]);

    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  const modelPrefixMatch = trimmed.match(/^MODEL_(\d+)$/i);

  if (modelPrefixMatch) {
    const parsed = Number(modelPrefixMatch[1]);

    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  const aliasMatch = trimmed.match(/^MODEL_ALIAS_(\d+)$/i);

  if (aliasMatch) {
    const parsed = Number(aliasMatch[1]);

    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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

export function collectPlainProtoStrings(fields: ProtoField[]) {
  const values: string[] = [];

  for (const field of fields) {
    if (
      field.wireType !== 2 ||
      !(field.value instanceof Uint8Array) ||
      parseProtoFields(field.value).length > 0
    ) {
      continue;
    }

    const decoded = decodeUtf8(field.value);

    const hasControlCharacter = decoded
      ? [...decoded].some((character) => character.charCodeAt(0) < 0x20)
      : false;

    if (decoded && !hasControlCharacter && decoded.length >= 2 && decoded.length <= 120) {
      values.push(decoded);
    }
  }

  return values;
}

export function pickModelLabelCandidate(candidates: string[]) {
  const filtered = candidates
    .map((candidate) => candidate.trim())
    .filter(
      (candidate) =>
        candidate !== "" &&
        !/^MODEL_UNSPECIFIED$/i.test(candidate) &&
        !/^MODEL_ALIAS_UNSPECIFIED$/i.test(candidate) &&
        parseModelValueFromConfigKey(candidate) === null &&
        /[A-Za-z]/.test(candidate) &&
        candidate.length >= 3 &&
        candidate.length <= 120,
    );

  if (filtered.length === 0) {
    return null;
  }

  const titleCased = filtered.find(
    (candidate) =>
      !candidate.startsWith("MODEL_") &&
      !candidate.startsWith("model_") &&
      /[a-z]/.test(candidate),
  );

  if (titleCased) {
    return titleCased;
  }

  const nonPrefixed = filtered.find(
    (candidate) =>
      !candidate.startsWith("MODEL_") && !candidate.startsWith("model_"),
  );

  if (nonPrefixed) {
    return nonPrefixed;
  }

  return filtered[0];
}

export function parseClientModelConfigEntry(
  rawEntry: Uint8Array,
  preferredModelValues?: ReadonlySet<number>,
) {
  const fields = parseProtoFields(rawEntry);
  const configKey = decodeUtf8(getProtoBytes(fields, 1));
  const rawModelConfig = getProtoBytes(fields, 2);

  const modelValueFromConfigKey = parseModelValueFromConfigKey(configKey);
  const modelValueFromModelOrAlias = parseModelValueFromModelOrAlias(
    rawModelConfig,
    preferredModelValues,
  );

  if (rawModelConfig) {
    const configFields = parseProtoFields(rawModelConfig);
    const modelValue =
      parseModelValueFromModelOrAlias(
        getProtoBytes(configFields, 1),
        preferredModelValues,
      ) ??
      parseModelValueFromModelOrAlias(
        getProtoBytes(configFields, 2),
        preferredModelValues,
      ) ??
      modelValueFromModelOrAlias ??
      modelValueFromConfigKey;
    const labelCandidate = pickModelLabelCandidate([
      decodeUtf8(getProtoBytes(configFields, 1)) ?? "",
      decodeUtf8(getProtoBytes(configFields, 2)) ?? "",
      decodeUtf8(getProtoBytes(configFields, 4)) ?? "",
      ...collectPlainProtoStrings(configFields),
    ]);

    if (modelValue && labelCandidate) {
      return {
        modelValue,
        label: formatCodeiumModelName(labelCandidate),
      };
    }
  }

  if (configKey && modelValueFromModelOrAlias) {
    return {
      modelValue: modelValueFromModelOrAlias,
      label: formatCodeiumModelName(configKey),
    };
  }

  const directModelValue = protoVarintToNumber(getProtoVarint(fields, 2));

  if (configKey && directModelValue > 0) {
    return {
      modelValue: directModelValue,
      label: formatCodeiumModelName(configKey),
    };
  }

  return null;
}

export function parseGetCascadeModelConfigDataResponse(
  rawResponse: Uint8Array,
  preferredModelValues?: ReadonlySet<number>,
) {
  const labels = new Map<number, string>();
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
      const parsed = parseClientModelConfigEntry(
        childBytes,
        preferredModelValues,
      );

      if (parsed) {
        labels.set(parsed.modelValue, parsed.label);
      }

      stack.push({ bytes: childBytes, depth: current.depth + 1 });
    }
  }

  return labels;
}

export function parseGetCommandModelConfigsResponse(
  rawResponse: Uint8Array,
  preferredModelValues?: ReadonlySet<number>,
) {
  return parseGetCascadeModelConfigDataResponse(rawResponse, preferredModelValues);
}

export async function callLanguageServerRpc(
  connection: CodeiumConnectionInfo,
  method: RpcMethod,
  body = new Uint8Array(),
) {
  const url = `http://127.0.0.1:${connection.httpPort}/exa.language_server_pb.LanguageServerService/${method}`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CODEIUM_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        [CODEIUM_CSRF_HEADER]: connection.csrfToken,
        "content-type": CODEIUM_RPC_CONTENT_TYPE,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Language server RPC ${method} failed with ${response.status} ${response.statusText}`,
      );
    }

    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export async function isHttpPortUsable(
  pid: number,
  csrfToken: string,
  candidatePort: number,
) {
  const connection = { pid, csrfToken, httpPort: candidatePort };

  for (const method of ["GetUserStatus", "GetAllCascadeTrajectories"] as const) {
    try {
      await callLanguageServerRpc(connection, method);

      return true;
    } catch {
      // Try the next harmless endpoint supported by the server build.
    }
  }

  return false;
}

export async function chooseWorkingHttpPort(
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

export function parseCsrfTokenFromCommandLine(commandLine: string) {
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

export function parsePortFromAddress(localAddress: string) {
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

export function parseNetstatListeningPortsByPid(content: string, pid: number) {
  const ports = new Set<number>();
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "" || !/LISTEN/i.test(trimmed)) {
      continue;
    }

    const tokens = trimmed.split(/\s+/);

    if (tokens.length < 4) {
      continue;
    }

    const pidToken = tokens.at(-1);

    if (pidToken !== String(pid)) {
      continue;
    }

    const localAddress = tokens[1];
    const port = parsePortFromAddress(localAddress);

    if (port) {
      ports.add(port);
    }
  }

  return [...ports];
}

export async function getNetstatListeningPortsByPid(pid: number) {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 8_000,
    });

    return parseNetstatListeningPortsByPid(stdout, pid);
  } catch {
    return [];
  }
}

export function parseWindowsProcessJsonOutput(content: string) {
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
    const pidRaw = candidate.pid ?? candidate.ProcessId ?? undefined;
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

export function parseUnixLanguageServerProcesses(content: string) {
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

export function mergeTrajectoryIds(...sources: string[][]) {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    for (const trajectoryId of source) {
      const trimmed = trajectoryId.trim();

      if (trimmed === "" || seen.has(trimmed)) {
        continue;
      }

      seen.add(trimmed);
      merged.push(trimmed);
    }
  }

  return merged;
}

export function mergeModelLabelMaps(...maps: ReadonlyMap<number, string>[]) {
  const merged = new Map<number, string>();

  for (const map of maps) {
    for (const [modelValue, label] of map.entries()) {
      if (!merged.has(modelValue) && label.trim() !== "") {
        merged.set(modelValue, label.trim());
      }
    }
  }

  return merged;
}

export async function aggregateCodeiumTrajectoryUsage(
  connection: CodeiumConnectionInfo,
  trajectoryId: string,
  start: Date,
  end: Date,
  recentStart: Date,
  totals: DailyTotalsByDate,
  modelTotals: Map<string, ModelTokenTotals>,
  recentModelTotals: Map<string, ModelTokenTotals>,
  dynamicModelLabels: ReadonlyMap<number, string>,
  resolveModelName: ModelNameResolver,
  seenUsageKeys: Set<string>,
  maxStepPages: number,
) {
  let totalSteps = 0;
  let totalGeneratorMetadata = 0;

  try {
    const countsResponse = await callLanguageServerRpc(
      connection,
      "GetCascadeTrajectory",
      encodeGetCascadeTrajectoryRequest(trajectoryId),
    );
    const counts = parseGetCascadeTrajectoryResponse(countsResponse);

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
    const offset = pageIndex * CODEIUM_STEP_PAGE_SIZE;
    let stepMessages: Uint8Array[];

    try {
      const response = await callLanguageServerRpc(
        connection,
        "GetCascadeTrajectorySteps",
        encodeGetCascadeTrajectoryStepsRequest(trajectoryId, offset),
      );

      stepMessages = parseGetCascadeTrajectoryStepsResponse(response);
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
        resolveModelName,
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
          Math.ceil(totalGeneratorMetadata / CODEIUM_STEP_PAGE_SIZE),
        )
      : maxStepPages;

  for (
    let generatorPageIndex = 0;
    generatorPageIndex < maxGeneratorMetadataPages;
    generatorPageIndex += 1
  ) {
    const offset = generatorPageIndex * CODEIUM_STEP_PAGE_SIZE;
    let generatorMetadataEntries: Uint8Array[];

    try {
      const response = await callLanguageServerRpc(
        connection,
        "GetCascadeTrajectoryGeneratorMetadata",
        encodeGetCascadeTrajectoryGeneratorMetadataRequest(
          trajectoryId,
          offset,
          true,
        ),
      );

      generatorMetadataEntries =
        parseGetCascadeTrajectoryGeneratorMetadataResponse(response);
    } catch {
      break;
    }

    if (generatorMetadataEntries.length === 0) {
      break;
    }

    for (const [
      entryIndex,
      rawGeneratorMetadataEntry,
    ] of generatorMetadataEntries.entries()) {
      const parsedUsage = parseGeneratorMetadataUsage(
        rawGeneratorMetadataEntry,
        trajectoryId,
        offset + entryIndex,
        dynamicModelLabels,
        resolveModelName,
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

    if (generatorMetadataEntries.length < CODEIUM_STEP_PAGE_SIZE) {
      break;
    }
  }
}

export function aggregateCodeiumDebugUsage(
  stepMessages: RawStepMessage[],
  start: Date,
  end: Date,
  recentStart: Date,
  totals: DailyTotalsByDate,
  modelTotals: Map<string, ModelTokenTotals>,
  recentModelTotals: Map<string, ModelTokenTotals>,
  dynamicModelLabels: ReadonlyMap<number, string>,
  resolveModelName: ModelNameResolver,
  seenUsageKeys: Set<string>,
) {
  for (const stepMessage of stepMessages) {
    for (const parsedUsage of parseStepUsages(
      stepMessage.rawStep,
      stepMessage.rawStepKey,
      dynamicModelLabels,
      resolveModelName,
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
