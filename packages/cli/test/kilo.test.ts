import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createKiloTokenTotals,
  isKiloAvailable,
  loadKiloRows,
  parseKiloTimestamp,
} from "../src/lib/kilo";
import { formatLocalDate } from "../src/lib/utils";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/cli.js");

function kiloMessage(
  timestamp: number | string,
  usage: Record<string, unknown>,
  say = "api_req_started",
) {
  return {
    ts: timestamp,
    type: "say",
    say,
    text: JSON.stringify(usage),
  };
}

async function writeKiloTask(
  root: string,
  messages: unknown[],
  extensionId = "kilocode.kilo-code",
) {
  const filePath = join(
    root,
    "globalStorage",
    extensionId,
    "tasks",
    "task-1",
    "ui_messages.json",
  );

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(messages), "utf8");

  return filePath;
}

test("Kilo token totals preserve input, output, and cache fields", () => {
  assert.deepEqual(
    createKiloTokenTotals({
      cacheReads: 40,
      cacheWrites: 5,
      tokensIn: 100,
      tokensOut: 25,
    }),
    {
      input: 140,
      output: 30,
      cache: { input: 40, output: 5 },
      total: 170,
    },
  );
});

test("Kilo timestamps parse milliseconds, seconds, and ISO strings", () => {
  assert.equal(
    parseKiloTimestamp(1_768_056_600_000)?.toISOString(),
    "2026-01-10T14:50:00.000Z",
  );
  assert.equal(
    parseKiloTimestamp(1_768_056_600)?.toISOString(),
    "2026-01-10T14:50:00.000Z",
  );
  assert.equal(
    parseKiloTimestamp("2026-01-10T14:50:00.000Z")?.toISOString(),
    "2026-01-10T14:50:00.000Z",
  );
  assert.equal(parseKiloTimestamp("not-a-date"), null);
});

test("isKiloAvailable returns false for a missing configured root", async () => {
  const originalConfigDir = process.env.KILO_CONFIG_DIR;

  process.env.KILO_CONFIG_DIR = join(
    tmpdir(),
    `missing-kilo-${Date.now()}`,
  );

  try {
    assert.equal(await isKiloAvailable(), false);
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.KILO_CONFIG_DIR;
    } else {
      process.env.KILO_CONFIG_DIR = originalConfigDir;
    }
  }
});

test("loadKiloRows reads Kilo task telemetry and ignores unrelated messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-kilo-test-"));
  const originalConfigDir = process.env.KILO_CONFIG_DIR;

  try {
    await writeKiloTask(root, [
      kiloMessage("2026-01-10T14:49:00.000Z", {
        cacheReads: 5,
        cacheWrites: 2,
        tokensIn: 100,
        tokensOut: 20,
      }),
      kiloMessage("2026-01-10T15:49:00.000Z", {
        inferenceProvider: "Moonshot AI",
        tokensIn: 40,
        tokensOut: 10,
      }),
      kiloMessage("2025-01-10T15:49:00.000Z", {
        tokensIn: 999,
        tokensOut: 999,
      }),
      kiloMessage(
        "2026-01-10T16:49:00.000Z",
        { tokensIn: 999, tokensOut: 999 },
        "api_req_retry_delayed",
      ),
      { type: "say", say: "text", ts: 1_768_056_600_000, text: "ignored" },
    ]);

    process.env.KILO_CONFIG_DIR = root;

    const summary = await loadKiloRows(
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-02-01T00:00:00.000Z"),
    );

    assert.equal(summary.provider, "kilo");
    assert.equal(summary.daily.length, 1);

    const day = summary.daily[0];
    assert.ok(day);
    assert.equal(formatLocalDate(day.date), "2026-01-10");
    assert.equal(day.input, 145);
    assert.equal(day.output, 32);
    assert.equal(day.cache.input, 5);
    assert.equal(day.cache.output, 2);
    assert.equal(day.total, 177);
    assert.deepEqual(
      day.breakdown.map((entry) => [entry.name, entry.tokens.total]),
      [["Kilo Code", 177]],
    );
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.KILO_CONFIG_DIR;
    } else {
      process.env.KILO_CONFIG_DIR = originalConfigDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("--kilo CLI renders a JSON export", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-kilo-cli-"));
  const outputPath = join(root, "kilo.json");

  try {
    await writeKiloTask(root, [
      kiloMessage("2026-01-10T14:49:00.000Z", {
        tokensIn: 100,
        tokensOut: 20,
      }),
    ]);

    const result = await execFileAsync(
      process.execPath,
      [cliPath, "--kilo", "--format", "json", "--output", outputPath],
      {
        env: {
          ...process.env,
          KILO_CONFIG_DIR: root,
        },
      },
    );

    assert.match(result.stdout, /Kilo Code available/);

    const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
      providers: Array<{
        provider: string;
        daily: Array<{ total: number }>;
      }>;
    };

    assert.equal(payload.providers.length, 1);
    assert.equal(payload.providers[0]?.provider, "kilo");
    assert.equal(payload.providers[0]?.daily[0]?.total, 120);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
