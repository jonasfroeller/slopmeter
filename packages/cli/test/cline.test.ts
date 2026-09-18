import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createClineTokenTotals,
  isClineAvailable,
  loadClineRows,
  parseClineTimestamp,
} from "../src/lib/cline";
import { formatLocalDate } from "../src/lib/utils";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/cli.js");

function clineMessage(
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

async function writeClineTask(
  root: string,
  messages: unknown[],
  extensionId = "saoudrizwan.claude-dev",
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

test("Cline token totals preserve input, output, and cache fields", () => {
  assert.deepEqual(
    createClineTokenTotals({
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

test("Cline timestamps parse milliseconds, seconds, and ISO strings", () => {
  assert.equal(
    parseClineTimestamp(1_768_056_600_000)?.toISOString(),
    "2026-01-10T14:50:00.000Z",
  );
  assert.equal(
    parseClineTimestamp(1_768_056_600)?.toISOString(),
    "2026-01-10T14:50:00.000Z",
  );
  assert.equal(
    parseClineTimestamp("2026-01-10T14:50:00.000Z")?.toISOString(),
    "2026-01-10T14:50:00.000Z",
  );
  assert.equal(parseClineTimestamp("not-a-date"), null);
});

test("isClineAvailable returns false for a missing configured root", async () => {
  const originalConfigDir = process.env.CLINE_CONFIG_DIR;

  process.env.CLINE_CONFIG_DIR = join(
    tmpdir(),
    `missing-cline-${Date.now()}`,
  );

  try {
    assert.equal(await isClineAvailable(), false);
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.CLINE_CONFIG_DIR;
    } else {
      process.env.CLINE_CONFIG_DIR = originalConfigDir;
    }
  }
});

test("loadClineRows reads task request usage and ignores old or unrelated messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-cline-test-"));
  const originalConfigDir = process.env.CLINE_CONFIG_DIR;

  try {
    await writeClineTask(root, [
      clineMessage("2026-01-10T14:49:00.000Z", {
        cacheReads: 5,
        cacheWrites: 2,
        tokensIn: 100,
        tokensOut: 20,
      }),
      clineMessage("2026-01-10T15:49:00.000Z", {
        model: "claude-sonnet-4-20260101",
        tokensIn: 40,
        tokensOut: 10,
      }),
      clineMessage("2025-01-10T15:49:00.000Z", {
        tokensIn: 999,
        tokensOut: 999,
      }),
      clineMessage("2026-01-10T16:49:00.000Z", {
        tokensIn: 999,
        tokensOut: 999,
      }, "api_req_retried"),
      clineMessage("2026-01-10T17:49:00.000Z", {
        tokensIn: 0,
        tokensOut: 0,
      }),
      { type: "say", say: "text", ts: 1_768_056_600_000, text: "ignored" },
    ]);

    process.env.CLINE_CONFIG_DIR = root;

    const summary = await loadClineRows(
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-02-01T00:00:00.000Z"),
    );

    assert.equal(summary.provider, "cline");
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
      [
        ["Cline", 127],
        ["claude-sonnet-4", 50],
      ],
    );
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.CLINE_CONFIG_DIR;
    } else {
      process.env.CLINE_CONFIG_DIR = originalConfigDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("--cline CLI renders a JSON export", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-cline-cli-"));
  const outputPath = join(root, "cline.json");

  try {
    await writeClineTask(root, [
      clineMessage("2026-01-10T14:49:00.000Z", {
        tokensIn: 100,
        tokensOut: 20,
      }),
    ]);

    const result = await execFileAsync(
      process.execPath,
      [cliPath, "--cline", "--format", "json", "--output", outputPath],
      {
        env: {
          ...process.env,
          CLINE_CONFIG_DIR: root,
        },
      },
    );

    assert.match(result.stdout, /Cline available/);

    const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
      providers: Array<{
        provider: string;
        daily: Array<{ total: number }>;
      }>;
    };

    assert.equal(payload.providers.length, 1);
    assert.equal(payload.providers[0]?.provider, "cline");
    assert.equal(payload.providers[0]?.daily[0]?.total, 120);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
