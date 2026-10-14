import assert from "node:assert/strict";
import test from "node:test";
import type { DailyUsage } from "../src/interfaces";
import { heatmapThemes, renderUsageHeatmapsSvg } from "../src/graph";

test("SVG pricing headline and model card show cost and partial coverage", () => {
  const daily: DailyUsage[] = [
    {
      date: new Date("2026-09-01T12:00:00"),
      input: 1_000,
      output: 500,
      cache: { input: 100, output: 25 },
      total: 1_500,
      cost: {
        amount: 1.25,
        currency: "USD",
        basis: "estimated",
        coverage: "partial",
        pricedTokens: 1_200,
        unpricedTokens: 300,
      },
      breakdown: [
        {
          name: "priced-model",
          tokens: {
            input: 800,
            output: 400,
            cache: { input: 100, output: 25 },
            total: 1_200,
          },
          cost: {
            amount: 1.25,
            currency: "USD",
            basis: "estimated",
            coverage: "complete",
            pricedTokens: 1_200,
            unpricedTokens: 0,
          },
        },
        {
          name: "unpriced-model",
          tokens: {
            input: 200,
            output: 100,
            cache: { input: 0, output: 0 },
            total: 300,
          },
          cost: {
            amount: 0,
            currency: "USD",
            basis: "unknown",
            coverage: "unknown",
            pricedTokens: 0,
            unpricedTokens: 300,
          },
        },
      ],
    },
  ];

  const svg = renderUsageHeatmapsSvg({
    startDate: new Date("2026-09-01T00:00:00"),
    endDate: new Date("2026-09-07T00:00:00"),
    colorMode: "light",
    includeModelsCard: true,
    sections: [
      {
        daily,
        title: "Codex",
        colors: heatmapThemes.codex.colors,
        showCost: true,
      },
    ],
  });

  assert.match(svg, /ESTIMATED COST/);
  assert.match(svg, /COST/);
  assert.match(svg, /priced-model/);
  assert.match(svg, /—/);
  assert.match(svg, /Some usage is unpriced; the cost total is partial\./);
});

test("SVG stays token-only when no pricing is available", () => {
  const svg = renderUsageHeatmapsSvg({
    startDate: new Date("2026-09-01T00:00:00"),
    endDate: new Date("2026-09-07T00:00:00"),
    colorMode: "light",
    includeModelsCard: true,
    sections: [
      {
        daily: [
          {
            date: new Date("2026-09-01T12:00:00"),
            input: 1_000,
            output: 500,
            cache: { input: 0, output: 0 },
            total: 1_500,
            breakdown: [
              {
                name: "unknown-model",
                tokens: {
                  input: 1_000,
                  output: 500,
                  cache: { input: 0, output: 0 },
                  total: 1_500,
                },
              },
            ],
          },
        ],
        title: "Codex",
        colors: heatmapThemes.codex.colors,
      },
    ],
  });

  assert.doesNotMatch(svg, /ESTIMATED COST/);
  assert.doesNotMatch(svg, />COST</);
});

test("activity without readable tokens is labelled unknown rather than zero lifetime usage", () => {
  const svg = renderUsageHeatmapsSvg({
    startDate: new Date("2026-01-01T00:00:00"),
    endDate: new Date("2026-01-31T00:00:00"),
    colorMode: "light",
    sections: [
      {
        title: "Antigravity",
        colors: heatmapThemes.antigravity.colors,
        daily: [
          {
            date: new Date("2026-01-05T12:00:00"),
            input: 0,
            output: 0,
            cache: { input: 0, output: 0 },
            total: 0,
            displayValue: 1,
            breakdown: [],
          },
        ],
        coverage: {
          status: "unknown",
          unmeasuredSessions: 116,
          unreadableSources: 0,
          truncatedSessions: 0,
          sessionLimitReached: false,
        },
      },
    ],
  });
  assert.match(svg, /RECORDED TOKENS/);
  assert.match(svg, /Unknown/);
  assert.match(
    svg,
    /116 sessions have activity records but no readable token counts/,
  );
  assert.doesNotMatch(svg, /started logging full token telemetry/);
});

test("missing sessions are reported even on dates that also contain measured usage", () => {
  const svg = renderUsageHeatmapsSvg({
    startDate: new Date("2026-01-01T00:00:00"),
    endDate: new Date("2026-01-31T00:00:00"),
    colorMode: "light",
    sections: [
      {
        title: "Antigravity",
        colors: heatmapThemes.antigravity.colors,
        daily: [
          {
            date: new Date("2026-01-05T12:00:00"),
            input: 100,
            output: 20,
            cache: { input: 0, output: 0 },
            total: 120,
            breakdown: [],
          },
        ],
        coverage: {
          status: "partial",
          unmeasuredSessions: 2,
          unreadableSources: 0,
          truncatedSessions: 0,
          sessionLimitReached: false,
        },
      },
    ],
  });
  assert.match(svg, /RECORDED TOKENS/);
  assert.match(
    svg,
    /2 sessions have activity records but no readable token counts/,
  );
  assert.doesNotMatch(svg, /Unknown/);
});
