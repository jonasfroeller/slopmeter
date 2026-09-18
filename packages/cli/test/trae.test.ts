import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { isTraeAvailable, loadTraeRows } from "../src/lib/trae";
import { formatLocalDate } from "../src/lib/utils";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/cli.js");

test("isTraeAvailable returns false when no database or key is set", () => {
  const originalDb = process.env.TRAE_DATABASE_PATH;
  const originalKey = process.env.TRAE_SQLCIPHER_KEY;
  const originalConfig = process.env.TRAE_CONFIG_DIR;

  try {
    delete process.env.TRAE_DATABASE_PATH;
    delete process.env.TRAE_SQLCIPHER_KEY;
    process.env.TRAE_CONFIG_DIR = join(
      tmpdir(),
      "non-existent-trae-dir-" + Date.now(),
    );

    assert.equal(isTraeAvailable(), false);
  } finally {
    if (originalDb !== undefined) process.env.TRAE_DATABASE_PATH = originalDb;
    if (originalKey !== undefined) process.env.TRAE_SQLCIPHER_KEY = originalKey;
    if (originalConfig !== undefined)
      process.env.TRAE_CONFIG_DIR = originalConfig;
    else delete process.env.TRAE_CONFIG_DIR;
  }
});

test("loadTraeRows parses chat_turn records from SQLite database", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "slopmeter-trae-test-"));
  const dbPath = join(tempDir, "trae_test.db");

  try {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE chat_turn (
        id INTEGER PRIMARY KEY,
        created_at INTEGER,
        updated_at INTEGER,
        context TEXT
      );
    `);

    const now = new Date();
    const todayMs = now.getTime();
    const yesterdayMs = todayMs - 24 * 60 * 60 * 1000;

    const insert = db.prepare(
      "INSERT INTO chat_turn (created_at, updated_at, context) VALUES (?, ?, ?)",
    );

    insert.run(
      todayMs,
      todayMs,
      JSON.stringify({
        model_name: "claude-3-7-sonnet-20250219",
        token_usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
          total_tokens: 180,
        },
      }),
    );

    insert.run(
      yesterdayMs,
      yesterdayMs,
      JSON.stringify({
        model: "gpt-4o",
        token_usage: {
          input_tokens: 200,
          output_tokens: 80,
          total_tokens: 280,
        },
      }),
    );

    db.close();

    process.env.TRAE_DATABASE_PATH = dbPath;

    const start = new Date(todayMs - 7 * 24 * 60 * 60 * 1000);
    const end = new Date(todayMs + 24 * 60 * 60 * 1000);

    const summary = await loadTraeRows(start, end);

    assert.equal(summary.provider, "trae");
    assert.equal(summary.daily.length, 2);

    const todayStr = formatLocalDate(new Date(todayMs));
    const yesterdayStr = formatLocalDate(new Date(yesterdayMs));

    const todayUsage = summary.daily.find(
      (d) => formatLocalDate(d.date) === todayStr,
    );
    assert.ok(todayUsage);
    assert.equal(todayUsage.input, 120);
    assert.equal(todayUsage.output, 60);
    assert.equal(todayUsage.total, 180);
    assert.equal(todayUsage.breakdown[0]?.name, "claude-3-7-sonnet");

    const yesterdayUsage = summary.daily.find(
      (d) => formatLocalDate(d.date) === yesterdayStr,
    );
    assert.ok(yesterdayUsage);
    assert.equal(yesterdayUsage.input, 200);
    assert.equal(yesterdayUsage.output, 80);
    assert.equal(yesterdayUsage.total, 280);
    assert.equal(yesterdayUsage.breakdown[0]?.name, "gpt-4o");
  } finally {
    delete process.env.TRAE_DATABASE_PATH;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadTraeRows falls back to history_v2 when chat_turn is empty", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "slopmeter-trae-test-"));
  const dbPath = join(tempDir, "trae_v2_test.db");

  try {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE history_v2 (
        id INTEGER PRIMARY KEY,
        created_at INTEGER,
        token_usage TEXT,
        agent_type TEXT
      );
    `);

    const now = new Date();
    const todayMs = now.getTime();

    db.prepare(
      "INSERT INTO history_v2 (created_at, token_usage, agent_type) VALUES (?, ?, ?)",
    ).run(
      todayMs,
      JSON.stringify({
        prompt_tokens: 300,
        completion_tokens: 150,
        total_tokens: 450,
      }),
      "solo_coder",
    );

    db.close();

    process.env.TRAE_DATABASE_PATH = dbPath;

    const start = new Date(todayMs - 7 * 24 * 60 * 60 * 1000);
    const end = new Date(todayMs + 24 * 60 * 60 * 1000);

    const summary = await loadTraeRows(start, end);

    assert.equal(summary.provider, "trae");
    assert.equal(summary.daily.length, 1);
    assert.equal(summary.daily[0]?.total, 450);
    assert.equal(summary.daily[0]?.breakdown[0]?.name, "solo_coder");
  } finally {
    delete process.env.TRAE_DATABASE_PATH;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadTraeRows parses JSON export file", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "slopmeter-trae-test-"));
  const jsonPath = join(tempDir, "sessions.json");

  try {
    const now = new Date();
    const todayMs = now.getTime();

    const sampleSessions = [
      {
        session_id: "s1",
        created_at: todayMs,
        token_usage: {
          prompt_tokens: 50,
          completion_tokens: 25,
          total_tokens: 75,
        },
        agent_type: "builder",
      },
    ];

    await writeFile(jsonPath, JSON.stringify(sampleSessions), "utf8");

    process.env.TRAE_DATABASE_PATH = jsonPath;

    const start = new Date(todayMs - 7 * 24 * 60 * 60 * 1000);
    const end = new Date(todayMs + 24 * 60 * 60 * 1000);

    const summary = await loadTraeRows(start, end);

    assert.equal(summary.provider, "trae");
    assert.equal(summary.daily.length, 1);
    assert.equal(summary.daily[0]?.total, 75);
    assert.equal(summary.daily[0]?.breakdown[0]?.name, "builder");
  } finally {
    delete process.env.TRAE_DATABASE_PATH;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--trae CLI renders JSON and SVG output correctly", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "slopmeter-trae-cli-test-"));
  const dbPath = join(tempDir, "trae_cli.db");
  const jsonOutput = join(tempDir, "out.json");
  const svgOutput = join(tempDir, "out.svg");

  try {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE chat_turn (
        id INTEGER PRIMARY KEY,
        created_at INTEGER,
        updated_at INTEGER,
        context TEXT
      );
    `);

    const now = new Date();
    const todayMs = now.getTime();

    db.prepare(
      "INSERT INTO chat_turn (created_at, updated_at, context) VALUES (?, ?, ?)",
    ).run(
      todayMs,
      todayMs,
      JSON.stringify({
        model_name: "gpt-4o",
        token_usage: {
          prompt_tokens: 400,
          completion_tokens: 200,
          total_tokens: 600,
        },
      }),
    );

    db.close();

    // 1. Test JSON output
    await execFileAsync(
      process.execPath,
      [cliPath, "--trae", "--format", "json", "--output", jsonOutput],
      {
        env: {
          ...process.env,
          TRAE_DATABASE_PATH: dbPath,
        },
      },
    );

    const jsonContent = JSON.parse(await readFile(jsonOutput, "utf8"));
    assert.equal(jsonContent.providers.length, 1);
    assert.equal(jsonContent.providers[0].provider, "trae");
    assert.equal(jsonContent.providers[0].daily.length, 1);
    assert.equal(jsonContent.providers[0].daily[0].total, 600);

    // 2. Test SVG output
    await execFileAsync(
      process.execPath,
      [cliPath, "--trae", "--format", "svg", "--output", svgOutput],
      {
        env: {
          ...process.env,
          TRAE_DATABASE_PATH: dbPath,
        },
      },
    );

    const svgContent = await readFile(svgOutput, "utf8");
    assert.ok(svgContent.includes("Trae"));
    assert.ok(svgContent.includes("<svg"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadTraeRows prioritizes prompt_tokens_total and completion_tokens_total for agent steps", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "slopmeter-trae-test-"));
  const dbPath = join(tempDir, "trae_agent_test.db");

  try {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE chat_turn (
        id INTEGER PRIMARY KEY,
        created_at INTEGER,
        updated_at INTEGER,
        context TEXT
      );
    `);

    const now = new Date();
    const todayMs = now.getTime();

    db.prepare(
      "INSERT INTO chat_turn (created_at, updated_at, context) VALUES (?, ?, ?)",
    ).run(
      todayMs,
      todayMs,
      JSON.stringify({
        model_name: "claude-3-7-sonnet",
        token_usage: {
          prompt_tokens: 100,
          prompt_tokens_total: 10_000,
          completion_tokens: 50,
          completion_tokens_total: 5_000,
          cache_read_input_tokens: 1_000,
          total_tokens: 150,
        },
      }),
    );

    db.close();

    process.env.TRAE_DATABASE_PATH = dbPath;

    const start = new Date(todayMs - 7 * 24 * 60 * 60 * 1000);
    const end = new Date(todayMs + 24 * 60 * 60 * 1000);

    const summary = await loadTraeRows(start, end);

    assert.equal(summary.provider, "trae");
    assert.equal(summary.daily.length, 1);
    assert.equal(summary.daily[0]?.input, 10_000);
    assert.equal(summary.daily[0]?.output, 5_000);
    assert.equal(summary.daily[0]?.total, 15_000);
  } finally {
    delete process.env.TRAE_DATABASE_PATH;
    await rm(tempDir, { recursive: true, force: true });
  }
});

