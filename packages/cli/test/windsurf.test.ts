import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  decodeWindsurfModelName,
  isWindsurfAvailable,
  loadWindsurfRows,
  parseWindsurfLogLaunchRecords,
  resolveWindsurfModelName,
} from "../src/lib/windsurf";
import {
  concatByteArrays,
  encodeFieldKey,
  encodeStringField,
  encodeVarint,
} from "../src/lib/codeium-rpc";
import { formatLocalDate } from "../src/lib/utils";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/cli.js");

function createMockTimestamp(date: Date): Uint8Array {
  const seconds = Math.floor(date.getTime() / 1000);
  const nanos = (date.getTime() % 1000) * 1_000_000;

  return concatByteArrays([
    encodeFieldKey(1, 0),
    encodeVarint(seconds),
    encodeFieldKey(2, 0),
    encodeVarint(nanos),
  ]);
}

function createMockModelUsagePayload(params: {
  modelValue: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): Uint8Array {
  return concatByteArrays([
    encodeFieldKey(1, 0),
    encodeVarint(params.modelValue),
    encodeFieldKey(2, 0),
    encodeVarint(params.inputTokens),
    encodeFieldKey(3, 0),
    encodeVarint(params.outputTokens),
    encodeFieldKey(4, 0),
    encodeVarint(params.cacheWriteTokens),
    encodeFieldKey(5, 0),
    encodeVarint(params.cacheReadTokens),
  ]);
}

function createMockGeneratorMetadataEntry(params: {
  date: Date;
  modelValue: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): Uint8Array {
  const timestampBytes = createMockTimestamp(params.date);
  const timelineBytes = concatByteArrays([
    encodeFieldKey(4, 2),
    encodeVarint(timestampBytes.length),
    timestampBytes,
  ]);

  const modelUsageBytes = createMockModelUsagePayload(params);

  const rawMetadataBytes = concatByteArrays([
    encodeFieldKey(4, 2),
    encodeVarint(modelUsageBytes.length),
    modelUsageBytes,
    encodeFieldKey(9, 2),
    encodeVarint(timelineBytes.length),
    timelineBytes,
  ]);

  return concatByteArrays([
    encodeFieldKey(1, 2),
    encodeVarint(rawMetadataBytes.length),
    rawMetadataBytes,
  ]);
}

test("isWindsurfAvailable returns false when directory and server do not exist", async () => {
  const originalCodeium = process.env.WINDSURF_CODEIUM_DIR;
  const originalPid = process.env.WINDSURF_LS_PID;
  const originalPort = process.env.WINDSURF_LS_HTTP_PORT;
  const originalToken = process.env.WINDSURF_LS_CSRF_TOKEN;
  const originalBinary = process.env.WINDSURF_LANGUAGE_SERVER_PATH;

  try {
    delete process.env.WINDSURF_LS_PID;
    delete process.env.WINDSURF_LS_HTTP_PORT;
    delete process.env.WINDSURF_LS_CSRF_TOKEN;
    process.env.WINDSURF_LANGUAGE_SERVER_PATH = join(
      tmpdir(),
      `non-existent-binary-${Date.now()}`,
    );
    process.env.WINDSURF_CODEIUM_DIR = join(
      tmpdir(),
      `non-existent-codeium-${Date.now()}`,
    );

    const available = await isWindsurfAvailable();
    assert.equal(available, false);
  } finally {
    if (originalCodeium !== undefined) {
      process.env.WINDSURF_CODEIUM_DIR = originalCodeium;
    } else {
      delete process.env.WINDSURF_CODEIUM_DIR;
    }
    if (originalPid !== undefined) {
      process.env.WINDSURF_LS_PID = originalPid;
    } else {
      delete process.env.WINDSURF_LS_PID;
    }
    if (originalPort !== undefined) {
      process.env.WINDSURF_LS_HTTP_PORT = originalPort;
    } else {
      delete process.env.WINDSURF_LS_HTTP_PORT;
    }
    if (originalToken !== undefined) {
      process.env.WINDSURF_LS_CSRF_TOKEN = originalToken;
    } else {
      delete process.env.WINDSURF_LS_CSRF_TOKEN;
    }
    if (originalBinary !== undefined) {
      process.env.WINDSURF_LANGUAGE_SERVER_PATH = originalBinary;
    } else {
      delete process.env.WINDSURF_LANGUAGE_SERVER_PATH;
    }
  }
});

test("isWindsurfAvailable returns true when cascade directory contains pb files", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "slopmeter-windsurf-test-"));
  const cascadeDir = join(tempDir, "cascade");

  await mkdir(cascadeDir, { recursive: true });
  await writeFile(join(cascadeDir, "test-trajectory.pb"), Buffer.from([0x0a, 0x02]));

  const originalCodeium = process.env.WINDSURF_CODEIUM_DIR;
  process.env.WINDSURF_CODEIUM_DIR = tempDir;

  try {
    const available = await isWindsurfAvailable();
    assert.equal(available, true);
  } finally {
    if (originalCodeium !== undefined) {
      process.env.WINDSURF_CODEIUM_DIR = originalCodeium;
    } else {
      delete process.env.WINDSURF_CODEIUM_DIR;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("decodeWindsurfModelName and resolveWindsurfModelName format model names", () => {
  assert.equal(decodeWindsurfModelName(314), "MODEL_PRIVATE_6");
  assert.equal(resolveWindsurfModelName(314, new Map()), "Private 6");

  assert.equal(decodeWindsurfModelName(377), "MODEL_SWE_1_5_SLOW");
  assert.equal(resolveWindsurfModelName(377, new Map()), "Swe 1.5 Slow");

  assert.equal(decodeWindsurfModelName(260), "MODEL_CHAT_GPT_4_1_MINI_2025_04_14");
  assert.equal(
    resolveWindsurfModelName(260, new Map()),
    "Chat GPT 4.1 Mini 2025.04 14",
  );

  const dynamicLabels = new Map([[314, "Claude 3.5 Sonnet (Thinking)"]]);
  assert.equal(
    resolveWindsurfModelName(314, dynamicLabels),
    "Claude 3.5 Sonnet (Thinking)",
  );
});

test("parseWindsurfLogLaunchRecords parses pid and port from log entries", () => {
  const logContent = `
2026-01-31 02:52:10.004 [info] I0131 02:52:10.004924 17684 main.go:819] Starting language server process with pid 17684
2026-01-31 02:52:10.566 [info] I0131 02:52:10.560370 17684 server.go:369] Language server listening on random port at 36841
`;

  const records = parseWindsurfLogLaunchRecords(logContent);
  assert.equal(records.length, 1);
  assert.equal(records[0].pid, 17684);
  assert.equal(records[0].httpPort, 36841);
});

test("loadWindsurfRows queries Codeium RPC and aggregates usage with model breakdown", async () => {
  const trajectoryId = "test-cascade-uuid-1234";
  const testDate = new Date("2026-02-15T12:00:00.000Z");

  const metadataEntry = createMockGeneratorMetadataEntry({
    date: testDate,
    modelValue: 314,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 500,
    cacheWriteTokens: 50,
  });

  const getAllTrajectoriesResponse = concatByteArrays([
    encodeFieldKey(1, 2),
    encodeVarint(trajectoryId.length + 2),
    encodeStringField(1, trajectoryId),
  ]);

  const getTrajectoryResponse = concatByteArrays([
    encodeFieldKey(3, 0),
    encodeVarint(0),
    encodeFieldKey(4, 0),
    encodeVarint(1),
  ]);

  const getMetadataPageResponse = concatByteArrays([
    encodeFieldKey(1, 2),
    encodeVarint(metadataEntry.length),
    metadataEntry,
  ]);

  const mockServer = createServer((req, res) => {
    const url = req.url ?? "";

    res.setHeader("content-type", "application/proto");

    if (url.endsWith("GetAllCascadeTrajectories")) {
      res.writeHead(200);
      res.end(getAllTrajectoriesResponse);

      return;
    }

    if (url.endsWith("GetCascadeTrajectory")) {
      res.writeHead(200);
      res.end(getTrajectoryResponse);

      return;
    }

    if (url.endsWith("GetCascadeTrajectoryGeneratorMetadata")) {
      res.writeHead(200);
      res.end(getMetadataPageResponse);

      return;
    }

    if (url.endsWith("GetCascadeTrajectorySteps")) {
      res.writeHead(200);
      res.end(new Uint8Array(0));

      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((res) => mockServer.listen(0, "127.0.0.1", () => res()));
  const address = mockServer.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const originalPid = process.env.WINDSURF_LS_PID;
  const originalPort = process.env.WINDSURF_LS_HTTP_PORT;
  const originalToken = process.env.WINDSURF_LS_CSRF_TOKEN;
  const originalCodeium = process.env.WINDSURF_CODEIUM_DIR;

  process.env.WINDSURF_LS_PID = "99999";
  process.env.WINDSURF_LS_HTTP_PORT = String(port);
  process.env.WINDSURF_LS_CSRF_TOKEN = "mock-csrf-token";
  process.env.WINDSURF_CODEIUM_DIR = join(
    tmpdir(),
    `slopmeter-windsurf-rpc-codeium-${Date.now()}`,
  );

  try {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date("2026-03-01T00:00:00.000Z");

    const summary = await loadWindsurfRows(start, end);

    assert.equal(summary.provider, "windsurf");
    assert.equal(summary.daily.length, 1);

    const day = summary.daily[0];
    assert.equal(formatLocalDate(day.date), "2026-02-15");
    // input = inputTokens (1000) + cacheRead (500) + cacheWrite (50) = 1550
    assert.equal(day.input, 1550);
    assert.equal(day.output, 200);
    assert.equal(day.cache.input, 500);
    assert.equal(day.cache.output, 50);
    assert.equal(day.total, 1750);

    assert.equal(day.breakdown.length, 1);
    assert.equal(day.breakdown[0].name, "Private 6");
    assert.equal(day.breakdown[0].tokens.total, 1750);
  } finally {
    if (originalPid !== undefined) {
      process.env.WINDSURF_LS_PID = originalPid;
    } else {
      delete process.env.WINDSURF_LS_PID;
    }
    if (originalPort !== undefined) {
      process.env.WINDSURF_LS_HTTP_PORT = originalPort;
    } else {
      delete process.env.WINDSURF_LS_HTTP_PORT;
    }
    if (originalToken !== undefined) {
      process.env.WINDSURF_LS_CSRF_TOKEN = originalToken;
    } else {
      delete process.env.WINDSURF_LS_CSRF_TOKEN;
    }
    if (originalCodeium !== undefined) {
      process.env.WINDSURF_CODEIUM_DIR = originalCodeium;
    } else {
      delete process.env.WINDSURF_CODEIUM_DIR;
    }
    mockServer.close();
  }
});

test("--windsurf CLI renders JSON and SVG output correctly", async () => {
  const trajectoryId = "test-cascade-cli-uuid";
  const testDate = new Date("2026-02-18T10:00:00.000Z");

  const metadataEntry = createMockGeneratorMetadataEntry({
    date: testDate,
    modelValue: 377,
    inputTokens: 3000,
    outputTokens: 600,
    cacheReadTokens: 1000,
    cacheWriteTokens: 0,
  });

  const getAllTrajectoriesResponse = concatByteArrays([
    encodeFieldKey(1, 2),
    encodeVarint(trajectoryId.length + 2),
    encodeStringField(1, trajectoryId),
  ]);

  const getTrajectoryResponse = concatByteArrays([
    encodeFieldKey(3, 0),
    encodeVarint(0),
    encodeFieldKey(4, 0),
    encodeVarint(1),
  ]);

  const getMetadataPageResponse = concatByteArrays([
    encodeFieldKey(1, 2),
    encodeVarint(metadataEntry.length),
    metadataEntry,
  ]);

  const mockServer = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/proto");

    if (url.endsWith("GetAllCascadeTrajectories")) {
      res.writeHead(200);
      res.end(getAllTrajectoriesResponse);

      return;
    }

    if (url.endsWith("GetCascadeTrajectory")) {
      res.writeHead(200);
      res.end(getTrajectoryResponse);

      return;
    }

    if (url.endsWith("GetCascadeTrajectoryGeneratorMetadata")) {
      res.writeHead(200);
      res.end(getMetadataPageResponse);

      return;
    }

    if (url.endsWith("GetCascadeTrajectorySteps")) {
      res.writeHead(200);
      res.end(new Uint8Array(0));

      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((res) => mockServer.listen(0, "127.0.0.1", () => res()));
  const address = mockServer.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const tempDir = await mkdtemp(join(tmpdir(), "slopmeter-windsurf-cli-test-"));
  const jsonOutput = join(tempDir, "output.json");
  const svgOutput = join(tempDir, "output.svg");

  try {
    await execFileAsync(
      process.execPath,
      [cliPath, "--windsurf", "--format", "json", "--output", jsonOutput],
      {
        env: {
          ...process.env,
          WINDSURF_LS_PID: "99999",
          WINDSURF_LS_HTTP_PORT: String(port),
          WINDSURF_LS_CSRF_TOKEN: "mock-token",
          WINDSURF_CODEIUM_DIR: join(tempDir, "missing-codeium"),
        },
      },
    );

    const jsonContent = JSON.parse(await readFile(jsonOutput, "utf8"));
    assert.equal(jsonContent.providers.length, 1);
    assert.equal(jsonContent.providers[0].provider, "windsurf");
    assert.equal(jsonContent.providers[0].daily.length, 1);
    assert.equal(jsonContent.providers[0].daily[0].date, "2026-02-18");
    assert.equal(jsonContent.providers[0].daily[0].total, 4600);

    await execFileAsync(
      process.execPath,
      [cliPath, "--windsurf", "--format", "svg", "--output", svgOutput],
      {
        env: {
          ...process.env,
          WINDSURF_LS_PID: "99999",
          WINDSURF_LS_HTTP_PORT: String(port),
          WINDSURF_LS_CSRF_TOKEN: "mock-token",
          WINDSURF_CODEIUM_DIR: join(tempDir, "missing-codeium"),
        },
      },
    );

    const svgContent = await readFile(svgOutput, "utf8");
    assert.ok(svgContent.includes("Windsurf"));
    assert.ok(svgContent.includes("<svg"));
  } finally {
    mockServer.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
