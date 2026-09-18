import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import Database from "better-sqlite3";
import {
  createWarpTokenTotals,
  isWarpAvailable,
  loadWarpRows,
  parseWarpTimestamp,
} from "../src/lib/warp";
import { formatLocalDate } from "../src/lib/utils";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/cli.js");

function createWarpDatabase(path: string) {
  const database = new Database(path);

  database.exec(`
    CREATE TABLE agent_conversations (
      id TEXT PRIMARY KEY,
      conversation_data TEXT,
      last_modified_at TEXT
    );
  `);

  database
    .prepare(
      "INSERT INTO agent_conversations (id, conversation_data, last_modified_at) VALUES (?, ?, ?)",
    )
    .run(
      "conversation-1",
      JSON.stringify({
        conversation_usage_metadata: {
          token_usage: [
            {
              model_id: "claude-4-20260101",
              warp_tokens: 100,
              byok_tokens: 5,
            },
            {
              model_id: "gpt-5",
              warp_tokens: 20,
              byok_tokens: 0,
            },
          ],
        },
      }),
      "2026-01-10T14:49:00.000Z",
    );

  database
    .prepare(
      "INSERT INTO agent_conversations (id, conversation_data, last_modified_at) VALUES (?, ?, ?)",
    )
    .run(
      "conversation-old",
      JSON.stringify({
        conversation_usage_metadata: {
          token_usage: [
            { model_id: "old-model", warp_tokens: 999, byok_tokens: 1 },
          ],
        },
      }),
      "2025-01-10T14:49:00.000Z",
    );

  database.close();
}

test("Warp token totals include Warp and BYOK aggregate usage", () => {
  assert.deepEqual(
    createWarpTokenTotals({ warp_tokens: 100, byok_tokens: 5 }),
    {
      input: 105,
      output: 0,
      cache: { input: 0, output: 0 },
      total: 105,
    },
  );
});

test("Warp timestamps parse SQLite timestamps and epoch values", () => {
  assert.equal(parseWarpTimestamp("2026-01-10 14:49:00")?.getFullYear(), 2026);
  assert.equal(
    parseWarpTimestamp(1_768_056_600)?.toISOString(),
    "2026-01-10T14:50:00.000Z",
  );
});

test("isWarpAvailable returns false for a missing configured database", () => {
  const originalPath = process.env.WARP_DATABASE_PATH;

  process.env.WARP_DATABASE_PATH = join(
    tmpdir(),
    `missing-warp-${Date.now()}.sqlite`,
  );

  try {
    assert.equal(isWarpAvailable(), false);
  } finally {
    if (originalPath === undefined) {
      delete process.env.WARP_DATABASE_PATH;
    } else {
      process.env.WARP_DATABASE_PATH = originalPath;
    }
  }
});

test("loadWarpRows reads aggregate usage by model and ignores old conversations", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-warp-test-"));
  const databasePath = join(root, "warp.sqlite");

  try {
    createWarpDatabase(databasePath);

    process.env.WARP_DATABASE_PATH = databasePath;

    const summary = await loadWarpRows(
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-02-01T00:00:00.000Z"),
    );

    assert.equal(summary.provider, "warp");
    assert.equal(summary.daily.length, 1);

    const day = summary.daily[0];
    assert.ok(day);
    assert.equal(formatLocalDate(day.date), "2026-01-10");
    assert.equal(day.input, 125);
    assert.equal(day.output, 0);
    assert.equal(day.total, 125);
    assert.deepEqual(
      day.breakdown.map((entry) => [entry.name, entry.tokens.total]),
      [
        ["claude-4", 105],
        ["gpt-5", 20],
      ],
    );
  } finally {
    delete process.env.WARP_DATABASE_PATH;
    await rm(root, { recursive: true, force: true });
  }
});

test("--warp CLI renders a JSON export", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-warp-cli-test-"));
  const databasePath = join(root, "warp.sqlite");
  const outputPath = join(root, "warp.json");

  try {
    createWarpDatabase(databasePath);

    const result = await execFileAsync(
      process.execPath,
      [cliPath, "--warp", "--format", "json", "--output", outputPath],
      {
        env: {
          ...process.env,
          WARP_DATABASE_PATH: databasePath,
        },
      },
    );

    assert.match(result.stdout, /Warp available/);

    const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
      providers: Array<{
        provider: string;
        daily: Array<{ total: number }>;
      }>;
    };

    assert.equal(payload.providers.length, 1);
    assert.equal(payload.providers[0]?.provider, "warp");
    assert.equal(payload.providers[0]?.daily[0]?.total, 125);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
