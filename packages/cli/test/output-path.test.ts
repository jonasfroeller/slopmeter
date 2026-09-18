import assert from "node:assert/strict";
import test from "node:test";
import {
  formatFileTimestamp,
  getDefaultOutputPath,
  getDefaultOutputSuffix,
} from "../src/output-path";

function createValues(overrides?: Partial<{
  all: boolean;
  antigravity: boolean;
  amp: boolean;
  claude: boolean;
  cline: boolean;
  codex: boolean;
  cursor: boolean;
  freebuff: boolean;
  gemini: boolean;
  opencode: boolean;
  pi: boolean;
  roo: boolean;
  trae: boolean;
  grok: boolean;
  windsurf: boolean;
}>) {
  return {
    all: false,
    antigravity: false,
    amp: false,
    claude: false,
    cline: false,
    codex: false,
    cursor: false,
    freebuff: false,
    gemini: false,
    opencode: false,
    pi: false,
    roo: false,
    trae: false,
    grok: false,
    windsurf: false,
    ...overrides,
  };
}


const fixedDate = new Date(2026, 8, 15, 14, 30, 45);

test("formatFileTimestamp formats dates as YYYY-MM-DD_HH-mm-ss", () => {
  assert.equal(formatFileTimestamp(fixedDate), "2026-09-15_14-30-45");
});

test("default output path includes timestamp when no provider flags are set", () => {
  assert.equal(
    getDefaultOutputPath(createValues(), "png", fixedDate),
    "./heatmap-last-year_2026-09-15_14-30-45.png",
  );
});

test("default output path includes timestamp and adds _cursor for --cursor", () => {
  assert.equal(
    getDefaultOutputPath(createValues({ cursor: true }), "png", fixedDate),
    "./heatmap-last-year_cursor_2026-09-15_14-30-45.png",
  );
});

test("default output path adds _all for --all with timestamp", () => {
  assert.equal(
    getDefaultOutputPath(createValues({ all: true, cursor: true }), "json", fixedDate),
    "./heatmap-last-year_all_2026-09-15_14-30-45.json",
  );
});

test("default output path reflects multiple explicit provider flags with timestamp", () => {
  assert.equal(
    getDefaultOutputPath(
      createValues({ codex: true, cursor: true, pi: true }),
      "svg",
      fixedDate,
    ),
    "./heatmap-last-year_codex_cursor_pi_2026-09-15_14-30-45.svg",
  );
});

test("default output path adds _antigravity with timestamp", () => {
  assert.equal(
    getDefaultOutputPath(createValues({ antigravity: true }), "png", fixedDate),
    "./heatmap-last-year_antigravity_2026-09-15_14-30-45.png",
  );
});

test("default output path omits timestamp when null is provided", () => {
  assert.equal(
    getDefaultOutputPath(createValues({ antigravity: true }), "png", null),
    "./heatmap-last-year_antigravity.png",
  );
});

test("default output suffix follows provider flag order", () => {
  assert.equal(
    getDefaultOutputSuffix(
      createValues({ pi: true, gemini: true, amp: true, opencode: true }),
    ),
    "_amp_gemini_opencode_pi",
  );
});

test("default output path adds _trae with timestamp", () => {
  assert.equal(
    getDefaultOutputPath(createValues({ trae: true }), "svg", fixedDate),
    "./heatmap-last-year_trae_2026-09-15_14-30-45.svg",
  );
});

test("default output path adds _grok with timestamp", () => {
  assert.equal(
    getDefaultOutputPath(createValues({ grok: true }), "png", fixedDate),
    "./heatmap-last-year_grok_2026-09-15_14-30-45.png",
  );
});

test("default output path adds _windsurf with timestamp", () => {
  assert.equal(
    getDefaultOutputPath(createValues({ windsurf: true }), "png", fixedDate),
    "./heatmap-last-year_windsurf_2026-09-15_14-30-45.png",
  );
});

test("default output path adds _freebuff with timestamp", () => {
  assert.equal(
    getDefaultOutputPath(createValues({ freebuff: true }), "png", fixedDate),
    "./heatmap-last-year_freebuff_2026-09-15_14-30-45.png",
  );
});
