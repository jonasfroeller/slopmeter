import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import {
  isAntigravityLanguageServerProcess,
  loadAntigravityRows,
} from "../src/lib/antigravity";
import {
  concatByteArrays,
  encodeFieldKey,
  encodeStringField,
  encodeVarint,
  getProtoBytes,
  getProtoVarint,
  parseProtoFields,
  decodeUtf8,
} from "../src/lib/codeium-rpc";
import { mergeUsageSummaries } from "../src/lib/utils";

const execFileAsync = promisify(execFile);
const start = new Date("2026-01-01T00:00:00Z");
const end = new Date("2026-10-31T23:59:59Z");
const date = new Date("2026-01-05T12:00:00Z");
const envKeys = [
  "ANTIGRAVITY_CONFIG_DIR",
  "ANTIGRAVITY_CONVERSATIONS_DIR",
  "ANTIGRAVITY_STATE_DB_PATH",
  "ANTIGRAVITY_LS_PID",
  "ANTIGRAVITY_LS_HTTP_PORT",
  "ANTIGRAVITY_LS_CSRF_TOKEN",
  "ANTIGRAVITY_MAX_TRAJECTORIES",
  "ANTIGRAVITY_MAX_STEP_PAGES",
] as const;
const originalEnv = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]]),
);
const fixtureDirs: string[] = [];

function bytes(field: number, value: Uint8Array) {
  return concatByteArrays([
    encodeFieldKey(field, 2),
    encodeVarint(value.length),
    value,
  ]);
}
function integer(field: number, value: number) {
  return concatByteArrays([encodeFieldKey(field, 0), encodeVarint(value)]);
}
const timestamp = concatByteArrays([
  integer(1, date.getTime() / 1000),
  integer(2, 0),
]);
function usage(id: string) {
  return concatByteArrays([
    integer(1, 1018),
    integer(2, 1000),
    integer(3, 200),
    integer(4, 50),
    integer(5, 500),
    encodeStringField(7, id),
  ]);
}
function generator(id: string, generationDate = date) {
  const generationTimestamp = concatByteArrays([
    integer(1, Math.floor(generationDate.getTime() / 1000)), integer(2, 0),
  ]);
  return bytes(
    1,
    concatByteArrays([bytes(4, usage(id)), bytes(9, bytes(4, generationTimestamp))]),
  );
}
function stepMetadata(id: string) {
  return concatByteArrays([bytes(1, timestamp), bytes(9, usage(id))]);
}
function historicalSummary(ids: string[], sessionDate = date) {
  const sessionTimestamp = concatByteArrays([
    integer(1, Math.floor(sessionDate.getTime() / 1000)),
    integer(2, 0),
  ]);
  return concatByteArrays(
    ids.map((id) =>
      bytes(
        10,
        concatByteArrays([
          encodeStringField(1, id),
          bytes(2, sessionTimestamp),
        ]),
      ),
    ),
  );
}

let listedIds: string[] = [];
let entries = new Map<string, Uint8Array[]>();
let debugSteps = new Uint8Array();
let requests: string[] = [];
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const fields = parseProtoFields(Buffer.concat(chunks));
  const id = decodeUtf8(getProtoBytes(fields, 1)) ?? "";
  const method = (req.url ?? "").split("/").at(-1);
  res.setHeader("content-type", "application/proto");
  if (method === "GetAllCascadeTrajectories") {
    res.end(
      concatByteArrays(
        listedIds.map((value) => bytes(1, encodeStringField(1, value))),
      ),
    );
  } else if (method === "GetCascadeTrajectory") {
    requests.push(id);
    if (!entries.has(id)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.end(
      concatByteArrays([integer(3, 0), integer(4, entries.get(id)!.length)]),
    );
  } else if (method === "GetCascadeTrajectoryGeneratorMetadata") {
    const offset = Number(getProtoVarint(fields, 2) ?? 0n);
    res.end(
      concatByteArrays(
        (entries.get(id) ?? [])
          .slice(offset, offset + 20)
          .map((entry) => bytes(1, entry)),
      ),
    );
  } else if (method === "GetUserTrajectoryDebug") {
    res.end(debugSteps);
  } else {
    res.end(new Uint8Array());
  }
});

before(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.ANTIGRAVITY_LS_PID = "99999";
  process.env.ANTIGRAVITY_LS_HTTP_PORT = String(address.port);
  process.env.ANTIGRAVITY_LS_CSRF_TOKEN = "test-only-token";
});
after(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  for (const dir of fixtureDirs) {
    assert.equal(resolve(dirname(dir)), resolve(tmpdir()));
    assert.ok(
      dir.split(/[\\/]/).at(-1)?.startsWith("slopmeter-antigravity-test-"),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

async function fixture(historicalIds: string[] = [], sessionDate = date) {
  const dir = await mkdtemp(join(tmpdir(), "slopmeter-antigravity-test-"));
  fixtureDirs.push(dir);
  const conversationDir = join(dir, "conversations");
  await mkdir(conversationDir);
  const statePath = join(dir, "state.vscdb");
  const state = new Database(statePath);
  state.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  if (historicalIds.length) {
    state
      .prepare("INSERT INTO ItemTable VALUES (?,?)")
      .run(
        "jetskiStateSync.agentManagerInitState",
        Buffer.from(historicalSummary(historicalIds, sessionDate)).toString(
          "base64",
        ),
      );
  }
  state.close();
  process.env.ANTIGRAVITY_CONFIG_DIR = dir;
  process.env.ANTIGRAVITY_CONVERSATIONS_DIR = conversationDir;
  process.env.ANTIGRAVITY_STATE_DB_PATH = statePath;
  process.env.ANTIGRAVITY_MAX_TRAJECTORIES = "1000";
  process.env.ANTIGRAVITY_MAX_STEP_PAGES = "100";
  listedIds = [];
  entries = new Map();
  requests = [];
  debugSteps = new Uint8Array();
  return { dir, conversationDir };
}
function localDb(file: string, recordId?: string, generationDate = date) {
  const db = new Database(file);
  db.exec(
    "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, metadata BLOB)",
  );
  if (recordId) {
    db.prepare("INSERT INTO gen_metadata VALUES (?,?)").run(
      0,
      Buffer.from(generator(recordId, generationDate)),
    );
    db.prepare("INSERT INTO steps VALUES (?,?)").run(
      0,
      Buffer.from(stepMetadata(recordId)),
    );
  }
  db.close();
}
function total(summary: Awaited<ReturnType<typeof loadAntigravityRows>>) {
  return summary.daily.reduce((n, row) => n + row.total, 0);
}

test("Antigravity discovery excludes Windsurf and generic Codeium or Gemini processes", () => {
  for (const commandLine of [
    String.raw`C:\Programs\Antigravity IDE\resources\app\extensions\antigravity\bin\language_server_windows_x64.exe --csrf_token test`,
    "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --csrf_token test",
    "/usr/share/antigravity/resources/app/extensions/antigravity/bin/language_server_linux_x64 --csrf_token test",
  ]) {
    assert.equal(isAntigravityLanguageServerProcess(commandLine), true);
  }
  for (const commandLine of [
    String.raw`A:\Windsurf\resources\app\extensions\windsurf\bin\language_server_windows_x64.exe --codeium_dir C:\Users\test\.codeium --csrf_token test`,
    "/opt/windsurf/language_server --workspace /projects/antigravity --csrf_token test",
    "/opt/codeium/language_server --csrf_token test",
    "/opt/gemini/language_server --csrf_token test",
    "/opt/antigravity/antigravity --csrf_token test",
  ]) {
    assert.equal(isAntigravityLanguageServerProcess(commandLine), false);
  }
});

test("recovers January usage for a historical ID omitted from the current server list", async () => {
  await fixture(["old-january"]);
  entries.set("old-january", [generator("january-response")]);
  const summary = await loadAntigravityRows(start, end);
  assert.equal(total(summary), 1750);
  assert.deepEqual(requests, ["old-january"]);
  assert.equal(summary.coverage, undefined);
});

test("tries legacy PB IDs even without a historical summary or current server listing", async () => {
  const { conversationDir } = await fixture();
  await writeFile(join(conversationDir, "legacy.pb"), Buffer.from([1, 2, 3]));
  entries.set("legacy", [generator("legacy-response")]);
  assert.equal(total(await loadAntigravityRows(start, end)), 1750);
  assert.deepEqual(requests, ["legacy"]);
});

test("a readable empty database does not suppress the server fallback", async () => {
  const { conversationDir } = await fixture(["empty-db"]);
  localDb(join(conversationDir, "empty-db.db"));
  entries.set("empty-db", [generator("recovered-response")]);
  assert.equal(total(await loadAntigravityRows(start, end)), 1750);
  assert.deepEqual(requests, ["empty-db"]);
});

test("local, step and debug copies of the same usage are counted once", async () => {
  const { conversationDir } = await fixture(["duplicate"]);
  localDb(join(conversationDir, "duplicate.db"), "same-response");
  debugSteps = bytes(1, bytes(5, stepMetadata("same-response")));
  listedIds = ["duplicate"];
  const summary = await loadAntigravityRows(start, end);
  assert.equal(total(summary), 1750);
  assert.equal(summary.coverage, undefined);
  assert.deepEqual(requests, []);
});

test("unrecoverable January activity stays unknown instead of inventing token counts", async () => {
  await fixture(["missing-january"]);
  const summary = await loadAntigravityRows(start, end);
  assert.equal(total(summary), 0);
  assert.equal(summary.daily[0].displayValue, 1);
  assert.equal(summary.coverage?.status, "unknown");
  assert.equal(summary.coverage?.unmeasuredSessions, 1);
  const merged = mergeUsageSummaries("all", [summary], end);
  assert.deepEqual(merged.coverage, summary.coverage);
});

test("an out-of-window metadata copy cannot suppress an in-window usage record", async () => {
  const { conversationDir } = await fixture(["conflicting-date"]);
  localDb(join(conversationDir, "conflicting-date.db"), "same-response", new Date("2025-12-01T12:00:00Z"));
  const summary = await loadAntigravityRows(start, end);
  assert.equal(total(summary), 1750);
  assert.equal(summary.coverage, undefined);
});

test("page and trajectory limits are reported as incomplete coverage", async () => {
  await fixture(["large", "not-attempted"]);
  entries.set(
    "large",
    Array.from({ length: 21 }, (_, i) => generator(`page-response-${i}`)),
  );
  process.env.ANTIGRAVITY_MAX_STEP_PAGES = "1";
  process.env.ANTIGRAVITY_MAX_TRAJECTORIES = "1";
  const summary = await loadAntigravityRows(start, end);
  assert.equal(total(summary), 20 * 1750);
  assert.equal(summary.coverage?.status, "partial");
  assert.equal(summary.coverage?.truncatedSessions, 1);
  assert.equal(summary.coverage?.sessionLimitReached, true);
  assert.equal(summary.coverage?.unmeasuredSessions, 1);
});

test("CLI JSON exports missing historical coverage", async () => {
  const { dir } = await fixture(["missing-january"], new Date());
  const output = join(dir, "report.json");
  await execFileAsync(
    process.execPath,
    [
      resolve("dist/cli.js"),
      "--antigravity",
      "--format",
      "json",
      "--output",
      output,
    ],
    { env: { ...process.env }, cwd: dir },
  );
  const report = JSON.parse(await readFile(output, "utf8"));
  assert.equal(report.providers[0].provider, "antigravity");
  assert.equal(report.providers[0].coverage.status, "unknown");
  assert.equal(report.providers[0].coverage.unmeasuredSessions, 1);
  assert.equal(report.providers[0].daily[0].total, 0);
});
