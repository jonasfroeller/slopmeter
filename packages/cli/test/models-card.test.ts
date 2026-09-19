import assert from "node:assert/strict";
import test from "node:test";
import svgBuilder from "svg-builder";
import type { DailyUsage } from "../src/interfaces";
import {
  aggregateModelsTable,
  drawModelsTableCard,
  formatCompactTokens,
  getModelsCardHeight,
} from "../src/models-card";

function createMockDailyUsage(): DailyUsage[] {
  return [
    {
      date: new Date("2026-09-01T00:00:00"),
      input: 1000,
      output: 500,
      cache: { input: 200, output: 0 },
      total: 1700,
      breakdown: [
        {
          name: "Gemini 2.5 Pro",
          tokens: {
            input: 800,
            output: 400,
            cache: { input: 200, output: 0 },
            total: 1400,
          },
        },
        {
          name: "Claude 3.7 Sonnet",
          tokens: {
            input: 200,
            output: 100,
            cache: { input: 0, output: 0 },
            total: 300,
          },
        },
      ],
    },
    {
      date: new Date("2026-09-02T00:00:00"),
      input: 2000,
      output: 1000,
      cache: { input: 500, output: 0 },
      total: 3500,
      breakdown: [
        {
          name: "Claude 3.7 Sonnet",
          tokens: {
            input: 1500,
            output: 700,
            cache: { input: 500, output: 0 },
            total: 2700,
          },
        },
        {
          name: "Gemini 2.5 Flash",
          tokens: {
            input: 500,
            output: 300,
            cache: { input: 0, output: 0 },
            total: 800,
          },
        },
      ],
    },
  ];
}

test("aggregateModelsTable aggregates token usage across days and sorts by total tokens descending", () => {
  const daily = createMockDailyUsage();
  const summary = aggregateModelsTable(daily);

  assert.equal(summary.models.length, 3);
  assert.equal(summary.grandTotal, 5200);
  assert.equal(summary.totalInput, 3000);
  assert.equal(summary.totalOutput, 1500);
  assert.equal(summary.totalCacheInput, 700);

  // Claude 3.7 Sonnet: 300 + 2700 = 3000 tokens (57.69%)
  assert.equal(summary.models[0].name, "Claude 3.7 Sonnet");
  assert.equal(summary.models[0].total, 3000);
  assert.equal(summary.models[0].input, 1700);
  assert.equal(summary.models[0].output, 800);
  assert.equal(summary.models[0].cache.input, 500);
  assert.ok(Math.abs(summary.models[0].share - 57.69) < 0.1);

  // Gemini 2.5 Pro: 1400 tokens (26.92%)
  assert.equal(summary.models[1].name, "Gemini 2.5 Pro");
  assert.equal(summary.models[1].total, 1400);
  assert.ok(Math.abs(summary.models[1].share - 26.92) < 0.1);

  // Gemini 2.5 Flash: 800 tokens (15.38%)
  assert.equal(summary.models[2].name, "Gemini 2.5 Flash");
  assert.equal(summary.models[2].total, 800);
  assert.ok(Math.abs(summary.models[2].share - 15.38) < 0.1);
});

test("formatCompactTokens formats token counts with appropriate suffixes", () => {
  assert.equal(formatCompactTokens(500), "500");
  assert.equal(formatCompactTokens(1_500), "1.5K");
  assert.equal(formatCompactTokens(10_000), "10K");
  assert.equal(formatCompactTokens(250_000), "250K");
  assert.equal(formatCompactTokens(1_200_000), "1.2M");
  assert.equal(formatCompactTokens(45_000_000), "45M");
  assert.equal(formatCompactTokens(1_500_000_000), "1.5B");
  assert.equal(formatCompactTokens(2_000_000_000_000), "2T");
});

test("getModelsCardHeight returns 0 when no models exist, and positive height otherwise", () => {
  assert.equal(getModelsCardHeight(0), 0);
  assert.ok(getModelsCardHeight(1) > 0);
  assert.ok(getModelsCardHeight(5) > getModelsCardHeight(2));
});

test("drawModelsTableCard renders table headers, model rows, and total footer in SVG", () => {
  const daily = createMockDailyUsage();
  let svg = svgBuilder.create().width(800).height(400);

  svg = drawModelsTableCard(svg, {
    x: 20,
    y: 20,
    width: 760,
    daily,
    colorMode: "dark",
    accentColor: "#2dd4bf",
    fontFamily: "sans-serif",
    providerTitle: "Antigravity",
  });

  const output = svg.render();

  assert.match(output, /MODEL BREAKDOWN/);
  assert.match(output, /Antigravity Models/);
  assert.match(output, /Claude 3\.7 Sonnet/);
  assert.match(output, /Gemini 2\.5 Pro/);
  assert.match(output, /Gemini 2\.5 Flash/);
  assert.match(output, /INPUT/);
  assert.match(output, /OUTPUT/);
  assert.match(output, /CACHE READ/);
  assert.match(output, /TOTAL/);
  assert.match(output, /SHARE/);
  assert.match(output, /Total/);
  assert.match(output, /100\.0%/);
});

test("drawModelsTableCard renders a cost column without changing token sorting", () => {
  const daily = createMockDailyUsage();
  daily[0]!.breakdown[0]!.cost = {
    amount: 0.2,
    currency: "USD",
    basis: "estimated",
    coverage: "complete",
    pricedTokens: 1_400,
    unpricedTokens: 0,
  };
  daily[1]!.breakdown[0]!.cost = {
    amount: 0.3,
    currency: "USD",
    basis: "estimated",
    coverage: "complete",
    pricedTokens: 2_700,
    unpricedTokens: 0,
  };
  daily[1]!.breakdown[1]!.cost = {
    amount: 0,
    currency: "USD",
    basis: "unknown",
    coverage: "unknown",
    pricedTokens: 0,
    unpricedTokens: 800,
  };

  let svg = svgBuilder.create().width(800).height(400);

  svg = drawModelsTableCard(svg, {
    x: 20,
    y: 20,
    width: 760,
    daily,
    colorMode: "light",
    accentColor: "#14b8a6",
    fontFamily: "sans-serif",
    providerTitle: "Gemini",
    showCost: true,
  });

  const output = svg.render();
  const summary = aggregateModelsTable(daily);

  assert.equal(summary.models[0]?.name, "Claude 3.7 Sonnet");
  assert.equal(summary.totalCost?.coverage, "partial");
  assert.match(output, /COST/);
  assert.match(output, /\$0\.50/);
  assert.match(output, /—/);
});
