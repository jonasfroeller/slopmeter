import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  clearFxSourceCache,
  createFxTokenTotals,
  isFxAvailable,
  loadFxRows,
  parseFxTimestamp,
  parseFxUsageJsonl,
  parseWslDistroList,
} from "../src/lib/fx";
import { formatLocalDate } from "../src/lib/utils";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/cli.js");

async function writeFxUsage(root: string, records: unknown[]) {
  await mkdir(root, { recursive: true });
  const filePath = join(root, "usage.jsonl");

  await writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );

  return filePath;
}

function generation(
  id: string,
  createdAtMs: number,
  inputTokens: number,
  outputTokens: number,
  model = "zai/glm-5.2",
) {
  return {
    fact: {
      cache_read_tokens: Math.floor(inputTokens / 2),
      cache_write_tokens: 10,
      created_at_ms: createdAtMs,
      id,
      input_tokens: inputTokens,
      model,
      output_tokens: outputTokens,
      reasoning_tokens: 0,
    },
    kind: "generation",
    schema_version: 1,
  };
}

test("parseWslDistroList handles WSL UTF-16 output and duplicate names", () => {
  const output = Buffer.from(
    "\uFEFFDebian\r\n* Ubuntu-22.04\r\nDebian\r\n",
    "utf16le",
  );

  assert.deepEqual(parseWslDistroList(output), ["Debian", "Ubuntu-22.04"]);
});

test("FX token totals preserve cache fields and input/output totals", () => {
  assert.deepEqual(
    createFxTokenTotals({
      cache_read_tokens: 800,
      cache_write_tokens: 25,
      input_tokens: 1_000,
      output_tokens: 50,
    }),
    {
      input: 1_000,
      output: 50,
      cache: { input: 800, output: 25 },
      total: 1_050,
    },
  );
});

test("FX token totals preserve reported provider costs", () => {
  const totals = createFxTokenTotals({
    cache_read_tokens: 800,
    cache_write_tokens: 25,
    input_tokens: 1_000,
    output_tokens: 50,
    total_cost: 0.42,
  });

  assert.equal(totals.reportedCost?.amountUsd, 0.42);
  assert.deepEqual(totals.reportedCost?.tokens, {
    input: 1_000,
    output: 50,
    cache: { input: 800, output: 25 },
  });
});

test("FX timestamps parse millisecond and second epochs", () => {
  assert.equal(
    parseFxTimestamp(1_768_056_600_000)?.toISOString(),
    "2026-01-10T14:50:00.000Z",
  );
  assert.equal(
    parseFxTimestamp(1_768_056_600)?.toISOString(),
    "2026-01-10T14:50:00.000Z",
  );
});

test("parseFxUsageJsonl replaces repeated cumulative generation facts", () => {
  const records = parseFxUsageJsonl(
    [
      generation("generation-1", 1_768_056_000_000, 100, 10),
      generation("generation-1", 1_768_056_001_000, 120, 12),
      generation("generation-2", 1_768_142_400_000, 20, 5, "other-model"),
      { kind: "incident", occurred_at_ms: 1_768_056_000_000 },
      "not json",
    ]
      .map((record) =>
        typeof record === "string" ? record : JSON.stringify(record),
      )
      .join("\n"),
    "wsl:Debian",
  );

  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => [
      record.id,
      record.input_tokens,
      record.output_tokens,
    ]),
    [
      ["generation-1", 120, 12],
      ["generation-2", 20, 5],
    ],
  );
});

test("isFxAvailable returns false for a missing explicit FX home", async () => {
  const originalHome = process.env.FX_HOME;

  process.env.FX_HOME = join(tmpdir(), `missing-fx-${Date.now()}`);
  clearFxSourceCache();

  try {
    assert.equal(await isFxAvailable(), false);
  } finally {
    if (originalHome === undefined) {
      delete process.env.FX_HOME;
    } else {
      process.env.FX_HOME = originalHome;
    }
    clearFxSourceCache();
  }
});

test("loadFxRows reads native FX usage by model and ignores old facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-fx-test-"));
  const originalHome = process.env.FX_HOME;

  try {
    await writeFxUsage(root, [
      generation("generation-1", 1_768_142_400_000, 100, 20),
      generation("generation-2", 1_768_228_800_000, 40, 10, "other-model"),
      generation("old-generation", 1_735_603_200_000, 999, 999),
    ]);

    process.env.FX_HOME = root;
    clearFxSourceCache();

    const summary = await loadFxRows(
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-02-01T00:00:00.000Z"),
    );

    assert.equal(summary.provider, "fx");
    assert.equal(summary.daily.length, 2);
    assert.equal(summary.daily[0]!.input, 100);
    assert.equal(summary.daily[0]!.output, 20);
    assert.equal(summary.daily[0]!.total, 120);
    assert.equal(formatLocalDate(summary.daily[1]!.date), "2026-01-12");
    assert.deepEqual(
      summary.daily.flatMap((day) =>
        day.breakdown.map((entry) => [entry.name, entry.tokens.total]),
      ),
      [
        ["zai/glm-5.2", 120],
        ["other-model", 50],
      ],
    );
  } finally {
    if (originalHome === undefined) {
      delete process.env.FX_HOME;
    } else {
      process.env.FX_HOME = originalHome;
    }
    clearFxSourceCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("--fx CLI renders a JSON export from an explicit FX home", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-fx-cli-test-"));
  const outputPath = join(root, "fx.json");

  try {
    await writeFxUsage(root, [
      generation("generation-1", 1_768_142_400_000, 100, 20),
    ]);

    const result = await execFileAsync(
      process.execPath,
      [cliPath, "--fx", "--format", "json", "--output", outputPath],
      {
        env: {
          ...process.env,
          FX_HOME: root,
        },
      },
    );

    assert.match(result.stdout, /Vercel FX available/);

    const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
      providers: Array<{
        provider: string;
        daily: Array<{ total: number }>;
      }>;
    };

    assert.equal(payload.providers.length, 1);
    assert.equal(payload.providers[0]?.provider, "fx");
    assert.equal(payload.providers[0]?.daily[0]?.total, 120);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
