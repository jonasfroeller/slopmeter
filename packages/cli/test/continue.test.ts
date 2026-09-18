import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createContinueTokenTotals,
  isContinueAvailable,
  loadContinueRows,
  parseContinueTimestamp,
} from "../src/lib/continue";
import { formatLocalDate } from "../src/lib/utils";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/cli.js");

async function writeContinueTelemetry(
  root: string,
  version: string,
  records: unknown[],
) {
  const directory = join(root, "dev_data", version);
  const filePath = join(directory, "tokensGenerated.jsonl");

  await mkdir(directory, { recursive: true });
  await writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );

  return filePath;
}

test("Continue token totals preserve prompt and generated tokens", () => {
  assert.deepEqual(
    createContinueTokenTotals({ promptTokens: 100, generatedTokens: 25 }),
    {
      input: 100,
      output: 25,
      cache: { input: 0, output: 0 },
      total: 125,
    },
  );
});

test("Continue timestamps parse ISO strings and epoch values", () => {
  assert.equal(
    parseContinueTimestamp("2026-01-10T14:49:00.000Z")?.toISOString(),
    "2026-01-10T14:49:00.000Z",
  );
  assert.equal(
    parseContinueTimestamp(1_768_056_600)?.toISOString(),
    "2026-01-10T14:50:00.000Z",
  );
  assert.equal(parseContinueTimestamp("not-a-date"), null);
});

test("isContinueAvailable returns false for a missing configured root", async () => {
  const originalPath = process.env.CONTINUE_CONFIG_DIR;

  process.env.CONTINUE_CONFIG_DIR = join(
    tmpdir(),
    `missing-continue-${Date.now()}`,
  );

  try {
    assert.equal(await isContinueAvailable(), false);
  } finally {
    if (originalPath === undefined) {
      delete process.env.CONTINUE_CONFIG_DIR;
    } else {
      process.env.CONTINUE_CONFIG_DIR = originalPath;
    }
  }
});

test("loadContinueRows reads timestamped telemetry by model and ignores old records", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-continue-test-"));
  const originalPath = process.env.CONTINUE_CONFIG_DIR;

  try {
    await writeContinueTelemetry(root, "0.2.0", [
      {
        generatedTokens: 20,
        model: "gpt-5-20260101",
        promptTokens: 100,
        provider: "openai",
        timestamp: "2026-01-10T14:49:00.000Z",
      },
      {
        generatedTokens: 10,
        model: "claude-sonnet-4-20250514",
        promptTokens: 40,
        timestamp: "2026-01-10T15:49:00.000Z",
      },
      {
        generatedTokens: 999,
        model: "old-model",
        promptTokens: 999,
        timestamp: "2025-01-10T15:49:00.000Z",
      },
    ]);

    process.env.CONTINUE_CONFIG_DIR = root;

    const summary = await loadContinueRows(
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-02-01T00:00:00.000Z"),
    );

    assert.equal(summary.provider, "continue");
    assert.equal(summary.daily.length, 1);

    const day = summary.daily[0];
    assert.ok(day);
    assert.equal(formatLocalDate(day.date), "2026-01-10");
    assert.equal(day.input, 140);
    assert.equal(day.output, 30);
    assert.equal(day.total, 170);
    assert.deepEqual(
      day.breakdown.map((entry) => [entry.name, entry.tokens.total]),
      [
        ["gpt-5", 120],
        ["claude-sonnet-4", 50],
      ],
    );
  } finally {
    if (originalPath === undefined) {
      delete process.env.CONTINUE_CONFIG_DIR;
    } else {
      process.env.CONTINUE_CONFIG_DIR = originalPath;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("loadContinueRows uses file modification date for untimestamped telemetry", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "slopmeter-continue-fallback-test-"),
  );
  const originalPath = process.env.CONTINUE_CONFIG_DIR;
  const fallbackDate = new Date("2026-01-09T12:00:00.000Z");

  try {
    const filePath = await writeContinueTelemetry(root, "0.1.0", [
      {
        generatedTokens: 35,
        model: "legacy-model",
        promptTokens: 65,
      },
    ]);
    await utimes(filePath, fallbackDate, fallbackDate);
    process.env.CONTINUE_CONFIG_DIR = root;

    const summary = await loadContinueRows(
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-31T00:00:00.000Z"),
    );

    assert.equal(summary.daily.length, 1);
    assert.equal(
      formatLocalDate(summary.daily[0]!.date),
      formatLocalDate(fallbackDate),
    );
    assert.equal(summary.daily[0]!.total, 100);
  } finally {
    if (originalPath === undefined) {
      delete process.env.CONTINUE_CONFIG_DIR;
    } else {
      process.env.CONTINUE_CONFIG_DIR = originalPath;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("--continue CLI renders a JSON export", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-continue-cli-test-"));
  const outputPath = join(root, "continue.json");

  try {
    await writeContinueTelemetry(root, "0.2.0", [
      {
        generatedTokens: 20,
        model: "gpt-5-20260101",
        promptTokens: 100,
        timestamp: "2026-01-10T14:49:00.000Z",
      },
    ]);

    const result = await execFileAsync(
      process.execPath,
      [cliPath, "--continue", "--format", "json", "--output", outputPath],
      {
        env: {
          ...process.env,
          CONTINUE_CONFIG_DIR: root,
        },
      },
    );

    assert.match(result.stdout, /Continue available/);

    const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
      providers: Array<{
        provider: string;
        daily: Array<{ total: number }>;
      }>;
    };

    assert.equal(payload.providers.length, 1);
    assert.equal(payload.providers[0]?.provider, "continue");
    assert.equal(payload.providers[0]?.daily[0]?.total, 120);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
