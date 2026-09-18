import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createRooTokenTotals,
  isRooAvailable,
  loadRooRows,
  parseRooTimestamp,
} from "../src/lib/roo";
import { formatLocalDate } from "../src/lib/utils";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/cli.js");

function rooMessage(
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

async function writeRooTask(
  root: string,
  extensionId: string,
  taskId: string,
  messages: unknown[],
) {
  const filePath = join(
    root,
    "globalStorage",
    extensionId,
    "tasks",
    taskId,
    "ui_messages.json",
  );

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(messages), "utf8");
}

test("Roo Code token totals preserve input, output, and cache fields", () => {
  assert.deepEqual(
    createRooTokenTotals({
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

test("Roo Code timestamps parse milliseconds, seconds, and ISO strings", () => {
  assert.equal(
    parseRooTimestamp(1_768_056_600_000)?.toISOString(),
    "2026-01-10T14:50:00.000Z",
  );
  assert.equal(
    parseRooTimestamp(1_768_056_600)?.toISOString(),
    "2026-01-10T14:50:00.000Z",
  );
  assert.equal(
    parseRooTimestamp("2026-01-10T14:50:00.000Z")?.toISOString(),
    "2026-01-10T14:50:00.000Z",
  );
});

test("isRooAvailable returns false for a missing configured root", async () => {
  const originalConfigDir = process.env.ROO_CONFIG_DIR;

  process.env.ROO_CONFIG_DIR = join(
    tmpdir(),
    `missing-roo-${Date.now()}`,
  );

  try {
    assert.equal(await isRooAvailable(), false);
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.ROO_CONFIG_DIR;
    } else {
      process.env.ROO_CONFIG_DIR = originalConfigDir;
    }
  }
});

test("loadRooRows reads standalone and PearAI task telemetry", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-roo-test-"));
  const originalConfigDir = process.env.ROO_CONFIG_DIR;

  try {
    await writeRooTask(root, "rooveterinaryinc.roo-cline", "standalone", [
      rooMessage("2026-01-10T14:49:00.000Z", {
        cacheReads: 5,
        cacheWrites: 2,
        tokensIn: 100,
        tokensOut: 20,
      }),
    ]);
    await writeRooTask(root, "pearai.pearai-roo-cline", "pearai", [
      rooMessage("2026-01-10T15:49:00.000Z", {
        tokensIn: 40,
        tokensOut: 10,
      }),
      rooMessage(
        "2026-01-10T16:49:00.000Z",
        { tokensIn: 999, tokensOut: 999 },
        "api_req_retried",
      ),
    ]);

    process.env.ROO_CONFIG_DIR = root;

    const summary = await loadRooRows(
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-02-01T00:00:00.000Z"),
    );

    assert.equal(summary.provider, "roo");
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
      [["Roo Code", 177]],
    );
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.ROO_CONFIG_DIR;
    } else {
      process.env.ROO_CONFIG_DIR = originalConfigDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("--roo CLI renders a JSON export", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-roo-cli-"));
  const outputPath = join(root, "roo.json");

  try {
    await writeRooTask(root, "pearai.pearai-roo-cline", "task-1", [
      rooMessage("2026-01-10T14:49:00.000Z", {
        tokensIn: 100,
        tokensOut: 20,
      }),
    ]);

    const result = await execFileAsync(
      process.execPath,
      [cliPath, "--roo", "--format", "json", "--output", outputPath],
      {
        env: {
          ...process.env,
          ROO_CONFIG_DIR: root,
        },
      },
    );

    assert.match(result.stdout, /Roo Code available/);

    const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
      providers: Array<{
        provider: string;
        daily: Array<{ total: number }>;
      }>;
    };

    assert.equal(payload.providers.length, 1);
    assert.equal(payload.providers[0]?.provider, "roo");
    assert.equal(payload.providers[0]?.daily[0]?.total, 120);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
