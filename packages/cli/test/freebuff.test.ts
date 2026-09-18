import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  createFreebuffTokenTotals,
  createFreebuffDesktopTokenTotals,
  isFreebuffAvailable,
  loadFreebuffRows,
  parseFreebuffTimestamp,
} from "../src/lib/freebuff";
import { formatLocalDate } from "../src/lib/utils";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/cli.js");

test("Freebuff token totals include cache fields", () => {
  assert.deepEqual(
    createFreebuffTokenTotals({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    }),
    {
      input: 110,
      output: 25,
      cache: { input: 10, output: 5 },
      total: 135,
    },
  );
});

test("Freebuff Desktop token totals keep cached input inside input", () => {
  assert.deepEqual(
    createFreebuffDesktopTokenTotals({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 10,
      totalTokens: 120,
    }),
    {
      input: 100,
      output: 20,
      cache: { input: 10, output: 0 },
      total: 120,
    },
  );
});

test("Freebuff timestamps restore dashed chat-id times", () => {
  assert.equal(
    parseFreebuffTimestamp("2026-02-18T10-12-13.000Z")?.toISOString(),
    "2026-02-18T10:12:13.000Z",
  );
});

test("loadFreebuffRows reads assistant usage from all supported metadata paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-freebuff-test-"));
  const chatDir = join(
    root,
    "projects",
    "demo-project",
    "chats",
    "2026-02-18T10-00-00.000Z",
  );
  const originalConfigDir = process.env.FREEBUFF_CONFIG_DIR;
  const originalDataDir = process.env.FREEBUFF_DATA_DIR;

  await mkdir(chatDir, { recursive: true });
  await writeFile(
    join(chatDir, "chat-messages.json"),
    JSON.stringify([
      {
        role: "user",
        metadata: { usage: { input_tokens: 9999, output_tokens: 9999 } },
      },
      {
        role: "assistant",
        metadata: {
          usage: {
            model: "model-a-20260101",
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
          },
        },
      },
      {
        role: "assistant",
        metadata: {
          codebuff: {
            usage: {
              model: "model-b",
              input_tokens: 40,
              output_tokens: 10,
            },
          },
        },
      },
      {
        role: "assistant",
        metadata: {
          runState: {
            sessionState: {
              mainAgentState: {
                messageHistory: [
                  {
                    providerOptions: {
                      usage: {
                        model: "model-c",
                        input_tokens: 20,
                        output_tokens: 5,
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ]),
    "utf8",
  );

  process.env.FREEBUFF_CONFIG_DIR = root;
  delete process.env.FREEBUFF_DATA_DIR;

  try {
    assert.equal(await isFreebuffAvailable(), true);

    const summary = await loadFreebuffRows(
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-03-01T00:00:00.000Z"),
    );

    assert.equal(summary.provider, "freebuff");
    assert.equal(summary.daily.length, 1);

    const day = summary.daily[0];
    assert.equal(formatLocalDate(day.date), "2026-02-18");
    assert.equal(day.input, 170);
    assert.equal(day.output, 40);
    assert.equal(day.cache.input, 10);
    assert.equal(day.cache.output, 5);
    assert.equal(day.total, 210);
    assert.deepEqual(
      day.breakdown.map((entry) => [entry.name, entry.tokens.total]),
      [
        ["model-a", 135],
        ["model-b", 50],
        ["model-c", 25],
      ],
    );
  } finally {
    if (originalConfigDir !== undefined) {
      process.env.FREEBUFF_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.FREEBUFF_CONFIG_DIR;
    }

    if (originalDataDir !== undefined) {
      process.env.FREEBUFF_DATA_DIR = originalDataDir;
    } else {
      delete process.env.FREEBUFF_DATA_DIR;
    }

    await rm(root, { recursive: true, force: true });
  }
});

test("loadFreebuffRows falls back to the authenticated Desktop API", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-freebuff-api-test-"));
  const originalConfigDir = process.env.FREEBUFF_CONFIG_DIR;
  const originalDataDir = process.env.FREEBUFF_DATA_DIR;
  const originalApiUrl = process.env.FREEBUFF_API_URL;
  const timestamp = Date.parse("2026-02-18T10:12:13.000Z");
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");

    if (request.url === "/api/projects") {
      response.end(
        JSON.stringify({
          projects: [
            {
              path: root,
              threads: [{ id: "thread-1", model: "desktop-model" }],
            },
          ],
        }),
      );

      return;
    }

    if (request.url === "/api/thread/thread-1") {
      response.end(
        JSON.stringify({
          messages: [
            {
              role: "user",
              ts: timestamp,
              metrics: {
                usage: {
                  inputTokens: 9999,
                  outputTokens: 9999,
                },
              },
            },
            {
              role: "assistant",
              ts: timestamp,
              metrics: {
                usage: {
                  inputTokens: 100,
                  outputTokens: 20,
                  cachedInputTokens: 10,
                  totalTokens: 120,
                },
              },
            },
            {
              role: "assistant",
              ts: timestamp + 1,
              model: "message-model",
              metrics: {
                usage: {
                  inputTokens: 10,
                  outputTokens: 5,
                  totalTokens: 15,
                },
              },
            },
          ],
        }),
      );

      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveServer());
  });

  const address = server.address();

  assert.ok(address && typeof address === "object");

  process.env.FREEBUFF_CONFIG_DIR = root;
  delete process.env.FREEBUFF_DATA_DIR;
  process.env.FREEBUFF_API_URL = `http://127.0.0.1:${address.port}`;

  try {
    assert.equal(await isFreebuffAvailable(), true);

    const summary = await loadFreebuffRows(
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-03-01T00:00:00.000Z"),
    );

    assert.equal(summary.provider, "freebuff");
    assert.equal(summary.daily.length, 1);

    const day = summary.daily[0];
    assert.equal(formatLocalDate(day.date), "2026-02-18");
    assert.equal(day.input, 110);
    assert.equal(day.output, 25);
    assert.equal(day.cache.input, 10);
    assert.equal(day.cache.output, 0);
    assert.equal(day.total, 135);
    assert.deepEqual(
      day.breakdown.map((entry) => [entry.name, entry.tokens.total]),
      [
        ["Mixed", 120],
        ["message-model", 15],
      ],
    );
  } finally {
    if (originalConfigDir !== undefined) {
      process.env.FREEBUFF_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.FREEBUFF_CONFIG_DIR;
    }

    if (originalDataDir !== undefined) {
      process.env.FREEBUFF_DATA_DIR = originalDataDir;
    } else {
      delete process.env.FREEBUFF_DATA_DIR;
    }

    if (originalApiUrl !== undefined) {
      process.env.FREEBUFF_API_URL = originalApiUrl;
    } else {
      delete process.env.FREEBUFF_API_URL;
    }

    await new Promise<void>((resolveServer, reject) => {
      server.close((error) => (error ? reject(error) : resolveServer()));
    });
    await rm(root, { recursive: true, force: true });
  }
});

test("--freebuff CLI renders a JSON export", async () => {
  const root = await mkdtemp(join(tmpdir(), "slopmeter-freebuff-cli-"));
  const chatId = new Date().toISOString().replaceAll(":", "-");
  const chatDir = join(root, "projects", "demo-project", "chats", chatId);
  const outputPath = join(root, "freebuff.json");

  await mkdir(chatDir, { recursive: true });
  await writeFile(
    join(chatDir, "chat-messages.json"),
    JSON.stringify([
      {
        role: "assistant",
        metadata: {
          usage: {
            model: "freebuff-test-model",
            input_tokens: 30,
            output_tokens: 12,
          },
        },
      },
    ]),
    "utf8",
  );

  try {
    await execFileAsync(
      process.execPath,
      [cliPath, "--freebuff", "--format", "json", "--output", outputPath],
      {
        env: {
          ...process.env,
          FREEBUFF_CONFIG_DIR: root,
        },
      },
    );

    const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
      providers: Array<{
        provider: string;
        daily: Array<{ total: number }>;
      }>;
    };

    assert.equal(payload.providers.length, 1);
    assert.equal(payload.providers[0].provider, "freebuff");
    assert.equal(payload.providers[0].daily[0].total, 42);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
