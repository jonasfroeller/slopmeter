import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  createGrokTokenTotals,
  isGrokAvailable,
  loadGrokRows,
} from "../src/lib/grok";
import { formatLocalDate } from "../src/lib/utils";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/cli.js");

test("isGrokAvailable returns false when session directory does not exist", () => {
  const originalHome = process.env.GROK_HOME;
  const originalConfig = process.env.GROK_CONFIG_DIR;

  try {
    delete process.env.GROK_CONFIG_DIR;
    process.env.GROK_HOME = join(
      tmpdir(),
      `non-existent-grok-dir-${Date.now()}`,
    );

    assert.equal(isGrokAvailable(), false);
  } finally {
    if (originalHome !== undefined) {
      process.env.GROK_HOME = originalHome;
    } else {
      delete process.env.GROK_HOME;
    }

    if (originalConfig !== undefined) {
      process.env.GROK_CONFIG_DIR = originalConfig;
    } else {
      delete process.env.GROK_CONFIG_DIR;
    }
  }
});

test("createGrokTokenTotals handles cache inclusion and totals correctly", () => {
  const overlapping = createGrokTokenTotals({
    inputTokens: 2000,
    outputTokens: 500,
    cachedReadTokens: 1500,
    totalTokens: 2500,
  });

  assert.equal(overlapping.input, 2000);
  assert.equal(overlapping.output, 500);
  assert.equal(overlapping.cache.input, 1500);
  assert.equal(overlapping.total, 2500);

  const nonOverlapping = createGrokTokenTotals({
    inputTokens: 2000,
    outputTokens: 500,
    cachedReadTokens: 1500,
    totalTokens: 4000,
  });

  assert.equal(nonOverlapping.input, 3500);
  assert.equal(nonOverlapping.output, 500);
  assert.equal(nonOverlapping.cache.input, 1500);
  assert.equal(nonOverlapping.total, 4000);
});

test("loadGrokRows parses multi-turn usage.json records with model breakdown", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "slopmeter-grok-test-"));
  const sessionsDir = join(tempDir, "sessions", "test-project", "session-1");

  await mkdir(sessionsDir, { recursive: true });

  const originalHome = process.env.GROK_HOME;
  process.env.GROK_HOME = tempDir;

  try {
    const usageDoc = {
      sessionId: "session-1",
      updatedAt: "2026-09-15T12:00:00.000Z",
      turns: [
        {
          turnNumber: 1,
          endedAt: "2026-09-15T10:00:00.000Z",
          inputTokens: 10000,
          outputTokens: 500,
          cachedReadTokens: 8000,
          totalTokens: 10500,
          modelUsage: {
            "grok-4.6-build": {
              inputTokens: 10000,
              outputTokens: 500,
              cachedReadTokens: 8000,
              totalTokens: 10500,
            },
          },
        },
        {
          turnNumber: 2,
          endedAt: "2026-09-16T15:30:00.000Z",
          inputTokens: 20000,
          outputTokens: 1000,
          cachedReadTokens: 16000,
          totalTokens: 21000,
          modelUsage: {
            "grok-4.6-build": {
              inputTokens: 20000,
              outputTokens: 1000,
              cachedReadTokens: 16000,
              totalTokens: 21000,
            },
          },
        },
      ],
    };

    await writeFile(
      join(sessionsDir, "usage.json"),
      JSON.stringify(usageDoc, null, 2),
      "utf8",
    );

    const start = new Date("2026-09-01T00:00:00.000Z");
    const end = new Date("2026-09-30T23:59:59.999Z");

    const summary = await loadGrokRows(start, end);

    assert.equal(summary.provider, "grok");
    assert.equal(summary.daily.length, 2);

    const day1 = summary.daily.find(
      (d) => formatLocalDate(d.date) === "2026-09-15",
    );
    assert.ok(day1);
    assert.equal(day1.input, 10000);
    assert.equal(day1.output, 500);
    assert.equal(day1.cache.input, 8000);
    assert.equal(day1.total, 10500);
    assert.equal(day1.breakdown[0].name, "grok-4.6-build");

    const day2 = summary.daily.find(
      (d) => formatLocalDate(d.date) === "2026-09-16",
    );
    assert.ok(day2);
    assert.equal(day2.input, 20000);
    assert.equal(day2.output, 1000);
    assert.equal(day2.total, 21000);

    assert.equal(summary.insights?.streaks.longest, 2);
    assert.equal(summary.insights?.mostUsedModel?.name, "grok-4.6-build");
  } finally {
    if (originalHome !== undefined) {
      process.env.GROK_HOME = originalHome;
    } else {
      delete process.env.GROK_HOME;
    }

    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadGrokRows falls back to updates.jsonl when usage.json is missing", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "slopmeter-grok-fallback-"));
  const sessionsDir = join(tempDir, "sessions", "test-project", "session-2");

  await mkdir(sessionsDir, { recursive: true });

  const originalHome = process.env.GROK_HOME;
  process.env.GROK_HOME = tempDir;

  try {
    const lines = [
      JSON.stringify({
        timestamp: 1789473600,
        method: "_x.ai/session/update",
        params: {
          sessionId: "session-2",
          update: {
            sessionUpdate: "turn_completed",
            prompt_id: "prompt-1",
            usage: {
              inputTokens: 5000,
              outputTokens: 200,
              cachedReadTokens: 3000,
              totalTokens: 5200,
              modelUsage: {
                "grok-4.6-build": {
                  inputTokens: 5000,
                  outputTokens: 200,
                  cachedReadTokens: 3000,
                  totalTokens: 5200,
                },
              },
            },
          },
          _meta: {
            agentTimestampMs: 1789473600000,
            eventId: "event-1",
          },
        },
      }),
    ];

    await writeFile(
      join(sessionsDir, "updates.jsonl"),
      `${lines.join("\n")}\n`,
      "utf8",
    );

    const start = new Date(0);
    const end = new Date("2030-01-01T00:00:00.000Z");

    const summary = await loadGrokRows(start, end);

    assert.equal(summary.provider, "grok");
    assert.equal(summary.daily.length, 1);
    assert.equal(summary.daily[0].total, 5200);
    assert.equal(summary.daily[0].breakdown[0].name, "grok-4.6-build");
  } finally {
    if (originalHome !== undefined) {
      process.env.GROK_HOME = originalHome;
    } else {
      delete process.env.GROK_HOME;
    }

    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--grok CLI renders JSON and SVG output correctly", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "slopmeter-grok-cli-"));
  const sessionsDir = join(tempDir, "sessions", "p1", "s1");

  await mkdir(sessionsDir, { recursive: true });

  const now = new Date();
  const usageDoc = {
    sessionId: "s1",
    updatedAt: now.toISOString(),
    turns: [
      {
        turnNumber: 1,
        endedAt: now.toISOString(),
        inputTokens: 15000,
        outputTokens: 600,
        cachedReadTokens: 10000,
        totalTokens: 15600,
        modelUsage: {
          "grok-4.6-build": {
            inputTokens: 15000,
            outputTokens: 600,
            cachedReadTokens: 10000,
            totalTokens: 15600,
          },
        },
      },
    ],
  };

  await writeFile(
    join(sessionsDir, "usage.json"),
    JSON.stringify(usageDoc),
    "utf8",
  );

  const jsonOut = join(tempDir, "out.json");
  const svgOut = join(tempDir, "out.svg");

  try {
    await execFileAsync(
      process.execPath,
      [cliPath, "--grok", "--format", "json", "--output", jsonOut],
      {
        env: {
          ...process.env,
          GROK_HOME: tempDir,
        },
      },
    );

    const jsonContent = JSON.parse(await readFile(jsonOut, "utf8"));
    assert.equal(jsonContent.providers.length, 1);
    assert.equal(jsonContent.providers[0].provider, "grok");
    assert.equal(jsonContent.providers[0].daily.length, 1);
    assert.equal(jsonContent.providers[0].daily[0].total, 15600);
    assert.equal(
      jsonContent.providers[0].daily[0].breakdown[0].name,
      "grok-4.6-build",
    );

    await execFileAsync(
      process.execPath,
      [cliPath, "--grok", "--format", "svg", "--output", svgOut],
      {
        env: {
          ...process.env,
          GROK_HOME: tempDir,
        },
      },
    );

    const svgContent = await readFile(svgOut, "utf8");
    assert.ok(svgContent.includes("<svg"));
    assert.ok(svgContent.includes("Grok"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
