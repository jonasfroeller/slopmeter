import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createOllamaTokenTotals,
  isOllamaAvailable,
  loadOllamaRows,
  parseOllamaLog,
  parseOllamaTimestamp,
} from "../src/lib/ollama";
import { formatLocalDate } from "../src/lib/utils";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/cli.js");

function ollamaLog(model = "registry.ollama.ai/library/qwen3.5:9b") {
  return [
    `time=2026-01-10T14:48:00.000+01:00 level=INFO source=images.go:373 msg="template selection" model=${model} selected=renderer_parser`,
    "slot print_timing: id  0 | task 0 | prompt eval time = 100.00 ms /   100 tokens ( 1.00 ms per token, 100.00 tokens per second)",
    "slot print_timing: id  0 | task 0 |        eval time = 200.00 ms /    25 tokens ( 8.00 ms per token, 25.00 tokens per second)",
    "slot print_timing: id  0 | task 0 |       total time = 300.00 ms /   125 tokens",
    '[GIN] 2026/01/10 - 14:49:00 | 200 | 300ms | 127.0.0.1 | POST     "/api/chat"',
    "slot print_timing: id  0 | task 1 | prompt eval time = 100.00 ms /    40 tokens ( 2.50 ms per token, 40.00 tokens per second)",
    "slot print_timing: id  0 | task 1 |        eval time = 200.00 ms /    10 tokens (20.00 ms per token, 10.00 tokens per second)",
    "slot print_timing: id  0 | task 1 |       total time = 300.00 ms /    50 tokens",
    '[GIN] 2026/01/10 - 15:49:00 | 400 | 300ms | 127.0.0.1 | POST     "/api/chat"',
    "slot print_timing: id  0 | task 2 | prompt eval time = 100.00 ms /    30 tokens ( 3.33 ms per token, 30.00 tokens per second)",
    "slot print_timing: id  0 | task 2 |        eval time = 200.00 ms /     5 tokens (40.00 ms per token, 5.00 tokens per second)",
    "slot print_timing: id  0 | task 2 |       total time = 300.00 ms /    35 tokens",
    '[GIN] 2026/01/10 - 16:49:00 | 200 | 300ms | 127.0.0.1 | POST     "/api/generate"',
  ].join("\n");
}

test("Ollama token totals preserve prompt and generated tokens", () => {
  assert.deepEqual(
    createOllamaTokenTotals({ promptTokens: 100, outputTokens: 25 }),
    {
      input: 100,
      output: 25,
      cache: { input: 0, output: 0 },
      total: 125,
    },
  );
});

test("Ollama timestamps parse GIN, ISO, and epoch values", () => {
  assert.equal(
    parseOllamaTimestamp("2026/01/10 - 14:49:00")?.getFullYear(),
    2026,
  );
  assert.equal(
    parseOllamaTimestamp("2026-01-10T14:50:00.000Z")?.toISOString(),
    "2026-01-10T14:50:00.000Z",
  );
  assert.equal(
    parseOllamaTimestamp(1_768_056_600)?.toISOString(),
    "2026-01-10T14:50:00.000Z",
  );
});

test("parseOllamaLog keeps successful chat/generate timings and model names", () => {
  const records = parseOllamaLog(ollamaLog());

  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => [
      record.model,
      record.promptTokens,
      record.outputTokens,
    ]),
    [
      ["qwen3.5:9b", 100, 25],
      ["qwen3.5:9b", 30, 5],
    ],
  );
});

test("isOllamaAvailable returns false for a missing configured log root", async () => {
  const originalLogDir = process.env.OLLAMA_LOG_DIR;

  process.env.OLLAMA_LOG_DIR = join(
    tmpdir(),
    `missing-ollama-${Date.now()}`,
  );

  try {
    assert.equal(await isOllamaAvailable(), false);
  } finally {
    if (originalLogDir === undefined) {
      delete process.env.OLLAMA_LOG_DIR;
    } else {
      process.env.OLLAMA_LOG_DIR = originalLogDir;
    }
  }
});

test("loadOllamaRows reads rotated server logs and ignores failed requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-ollama-test-"));
  const logPath = join(root, "server.log");
  const originalLogDir = process.env.OLLAMA_LOG_DIR;

  try {
    await writeFile(logPath, ollamaLog(), "utf8");
    process.env.OLLAMA_LOG_DIR = root;

    const summary = await loadOllamaRows(
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-02-01T00:00:00.000Z"),
    );

    assert.equal(summary.provider, "ollama");
    assert.equal(summary.daily.length, 1);

    const day = summary.daily[0];
    assert.ok(day);
    assert.equal(formatLocalDate(day.date), "2026-01-10");
    assert.equal(day.input, 130);
    assert.equal(day.output, 30);
    assert.equal(day.total, 160);
    assert.deepEqual(
      day.breakdown.map((entry) => [entry.name, entry.tokens.total]),
      [["qwen3.5:9b", 160]],
    );
  } finally {
    if (originalLogDir === undefined) {
      delete process.env.OLLAMA_LOG_DIR;
    } else {
      process.env.OLLAMA_LOG_DIR = originalLogDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("--ollama CLI renders a JSON export", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-ollama-cli-"));
  const logPath = join(root, "server-1.log");
  const outputPath = join(root, "ollama.json");

  try {
    await mkdir(root, { recursive: true });
    await writeFile(logPath, ollamaLog(), "utf8");

    const result = await execFileAsync(
      process.execPath,
      [cliPath, "--ollama", "--format", "json", "--output", outputPath],
      {
        env: {
          ...process.env,
          OLLAMA_LOG_DIR: root,
        },
      },
    );

    assert.match(result.stdout, /Ollama available/);

    const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
      providers: Array<{
        provider: string;
        daily: Array<{ total: number }>;
      }>;
    };

    assert.equal(payload.providers.length, 1);
    assert.equal(payload.providers[0]?.provider, "ollama");
    assert.equal(payload.providers[0]?.daily[0]?.total, 160);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
