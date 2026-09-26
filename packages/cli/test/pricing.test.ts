import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { UsageProviderId, UsageSummary } from "../src/interfaces";
import {
  BUILT_IN_RULES,
  createPricingContext,
  formatUsageCost,
  hasPricedCost,
  inferCurrencyFromLocale,
  priceUsageSummary,
} from "../src/pricing";
import { mergeUsageCosts, mergeUsageSummaries } from "../src/lib/utils";

function createSummary(options: {
  provider: UsageProviderId;
  model: string;
  date?: string;
  input?: number;
  output?: number;
  cacheInput?: number;
  cacheOutput?: number;
  reportedCost?: UsageSummary["daily"][number]["reportedCost"];
}): UsageSummary {
  const {
    provider,
    model,
    date = "2026-09-15T12:00:00",
    input = 1_000,
    output = 500,
    cacheInput = 0,
    cacheOutput = 0,
    reportedCost,
  } = options;

  return {
    provider,
    daily: [
      {
        date: new Date(date),
        input,
        output,
        cache: { input: cacheInput, output: cacheOutput },
        total: input + output,
        ...(reportedCost ? { reportedCost } : {}),
        breakdown: [
          {
            name: model,
            tokens: {
              input,
              output,
              cache: { input: cacheInput, output: cacheOutput },
              total: input + output,
            },
            ...(reportedCost ? { reportedCost } : {}),
          },
        ],
      },
    ],
  };
}

async function writePricingFile(t: test.TestContext, value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "slopmeter-pricing-test-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const filePath = join(directory, "pricing.json");
  await writeFile(filePath, JSON.stringify(value), "utf8");

  return filePath;
}

test("pricing subtracts cache components before applying ordinary rates", async (t) => {
  const pricingPath = await writePricingFile(t, {
    baseCurrency: "USD",
    rules: [
      {
        provider: "codex",
        model: "formula-model",
        inputPerMillion: 1,
        outputPerMillion: 2,
        cacheReadPerMillion: 0.1,
        cacheWritePerMillion: 0.2,
      },
    ],
  });
  const context = createPricingContext("USD", pricingPath);
  const priced = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "formula-model",
      input: 1_000,
      output: 500,
      cacheInput: 200,
      cacheOutput: 50,
    }),
    context,
  );
  const cost = priced.daily[0]?.cost;

  assert.ok(cost);
  assert.ok(Math.abs(cost.amount - 0.00173) < 1e-12);
  assert.equal(cost.coverage, "complete");
  assert.equal(cost.basis, "estimated");
  assert.equal(cost.pricedTokens, 1_500);
  assert.equal(cost.unpricedTokens, 0);
});

test("bundled OpenAI coding-agent rates use standard pricing", () => {
  const context = createPricingContext("USD");
  const expectedByModel = new Map([
    ["gpt-6-astra", 60],
    ["gpt-5.6-sol", 24],
    ["gpt-5.6-terra", 14],
    ["gpt-5.6-luna", 1.4],
    ["gpt-5.3-codex", 15.75],
    ["gpt-5.2-codex", 15.75],
    ["gpt-5.1-codex", 11.25],
  ]);

  for (const [model, expected] of expectedByModel) {
    const priced = priceUsageSummary(
      createSummary({
        provider: "codex",
        model,
        input: 1_000_000,
        output: 1_000_000,
      }),
      context,
    );

    assert.equal(priced.daily[0]?.cost?.amount, expected, model);
  }

  const cachedWrite = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "gpt-5.6-sol",
      input: 0,
      output: 1_000_000,
      cacheOutput: 1_000_000,
    }),
    context,
  );

  assert.equal(cachedWrite.daily[0]?.cost?.amount, 5);
});

test("custom exact and provider-specific rules override wildcard rules and honor dates", async (t) => {
  const pricingPath = await writePricingFile(t, {
    baseCurrency: "USD",
    rules: [
      {
        provider: "*",
        model: "same-model",
        inputPerMillion: 1,
      },
      {
        provider: "codex",
        model: "same-*",
        inputPerMillion: 2,
      },
      {
        provider: "codex",
        model: "same-model",
        inputPerMillion: 3,
        effectiveFrom: "2026-09-16",
      },
      {
        provider: "codex",
        model: "date-model",
        inputPerMillion: 1,
        effectiveFrom: "2026-01-01",
      },
      {
        provider: "codex",
        model: "date-model",
        inputPerMillion: 2,
        effectiveFrom: "2026-09-01",
      },
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        inputPerMillion: 99,
      },
    ],
  });
  const context = createPricingContext("USD", pricingPath);
  const beforeDate = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "same-model",
      input: 1_000_000,
      output: 0,
    }),
    context,
  );
  const afterDate = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "same-model",
      date: "2026-09-16T12:00:00",
      input: 1_000_000,
      output: 0,
    }),
    context,
  );

  assert.equal(beforeDate.daily[0]?.cost?.amount, 1);
  assert.equal(afterDate.daily[0]?.cost?.amount, 3);

  const latestDateRule = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "date-model",
      input: 1_000_000,
      output: 0,
    }),
    context,
  );

  assert.equal(latestDateRule.daily[0]?.cost?.amount, 2);

  const customOverride = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "gpt-5.6-sol",
      input: 1_000_000,
      output: 0,
    }),
    context,
  );

  assert.equal(customOverride.daily[0]?.cost?.amount, 99);
});

test("custom FX conversion and unsupported explicit currencies are handled clearly", async (t) => {
  const pricingPath = await writePricingFile(t, {
    baseCurrency: "USD",
    fx: {
      asOf: "2026-09-19",
      rates: { EUR: 0.5 },
    },
    rules: [
      {
        provider: "codex",
        model: "fx-model",
        inputPerMillion: 2,
      },
    ],
  });
  const context = createPricingContext("EUR", pricingPath);
  const priced = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "fx-model",
      input: 1_000_000,
      output: 0,
    }),
    context,
  );

  assert.equal(context.metadata.currency, "EUR");
  assert.equal(context.metadata.fxAsOf, "2026-09-19");
  assert.equal(priced.daily[0]?.cost?.amount, 1);
  assert.throws(
    () => createPricingContext("XYZ", pricingPath),
    /No bundled or custom FX rate is available for XYZ/,
  );
});

test("automatic currency uses the locale region and never the time zone", () => {
  assert.equal(inferCurrencyFromLocale("en-GB", "Europe/Vienna"), "GBP");
  assert.equal(inferCurrencyFromLocale("en-GB", "Europe/London"), "GBP");
  assert.equal(inferCurrencyFromLocale("de-DE", "Europe/Vienna"), "EUR");
  assert.equal(inferCurrencyFromLocale("en", "Europe/Vienna"), "USD");
});

test("bundled family aliases price common telemetry model labels", () => {
  const context = createPricingContext("USD");
  const models = [
    "Gemini 3.8 Flash (High)",
    "GPT-5.2",
    "claude 4.5 sonnet",
    "claude-fable-5-thinking-high",
    "cursor-grok-4.6-medium",
    "deepseek-v4-pro",
    "qwen3.8-max-preview",
    "mimo-v2.5-free",
    "muse-spark-1.3-contributor-free",
    "qwen3.6-plus-free",
    "minimax-m2.5-free",
    "Google Gemini 2.5 Flash",
    "Google Gemini 2.5 Flash Lite",
  ];

  for (const model of models) {
    const priced = priceUsageSummary(
      createSummary({
        provider: "codex",
        model,
      }),
      context,
    );

    assert.notEqual(priced.daily[0]?.cost?.coverage, "unknown", model);
  }
});

test("free event labels show API-equivalent value and count in totals", () => {
  const context = createPricingContext("USD");
  const pricedEvent = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "deepseek-v4-flash-free",
      input: 1_000_000,
      output: 0,
    }),
    context,
  );
  const eventCost = pricedEvent.daily[0]?.cost;

  assert.equal(eventCost?.amount, 0.3);
  assert.equal(eventCost?.basis, "estimated");
  assert.equal(eventCost?.isFree, true);
  assert.match(formatUsageCost(eventCost), /^Free \(/);

  const localKnownModel = priceUsageSummary(
    createSummary({
      provider: "ollama",
      model: "deepseek-v4-flash",
      input: 1_000_000,
      output: 0,
    }),
    context,
  );
  const localCost = localKnownModel.daily[0]?.cost;

  assert.equal(localCost?.amount, 0.3);
  assert.equal(localCost?.isFree, true);
  assert.match(formatUsageCost(localCost), /^Free \(/);
});

test("mixed totals do not inherit the free label from an event row", () => {
  const context = createPricingContext("USD");
  const free = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "deepseek-v4-flash-free",
      input: 1_000_000,
      output: 0,
    }),
    context,
  ).daily[0]?.cost;
  const paid = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "gpt-5.6-sol",
      input: 1_000_000,
      output: 0,
    }),
    context,
  ).daily[0]?.cost;

  const mixed = mergeUsageCosts(free, paid);

  assert.ok(mixed);
  assert.notEqual(mixed.isFree, true);
  assert.doesNotMatch(formatUsageCost(mixed), /^Free/);
});

test("reported costs take precedence over estimates and are converted from USD", async (t) => {
  const pricingPath = await writePricingFile(t, {
    baseCurrency: "USD",
    fx: { rates: { EUR: 0.5 } },
    rules: [
      {
        provider: "grok",
        model: "grok-4.6",
        inputPerMillion: 100,
        outputPerMillion: 100,
      },
    ],
  });
  const reportedCost = {
    amountUsd: 0.25,
    tokens: {
      input: 1_000,
      output: 500,
      cache: { input: 0, output: 0 },
    },
  } as const;
  const priced = priceUsageSummary(
    createSummary({
      provider: "grok",
      model: "grok-4.6",
      reportedCost,
    }),
    createPricingContext("EUR", pricingPath),
  );
  const cost = priced.daily[0]?.cost;

  assert.ok(cost);
  assert.equal(cost.amount, 0.125);
  assert.equal(cost.currency, "EUR");
  assert.equal(cost.basis, "reported");
  assert.equal(cost.coverage, "complete");
});

test("provider-specific pricing survives all-provider aggregation for identical model names", async (t) => {
  const pricingPath = await writePricingFile(t, {
    baseCurrency: "USD",
    rules: [
      { provider: "codex", model: "shared-model", inputPerMillion: 1 },
      { provider: "gemini", model: "shared-model", inputPerMillion: 3 },
    ],
  });
  const context = createPricingContext("USD", pricingPath);
  const codex = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "shared-model",
      input: 1_000_000,
      output: 0,
    }),
    context,
  );
  const gemini = priceUsageSummary(
    createSummary({
      provider: "gemini",
      model: "shared-model",
      input: 1_000_000,
      output: 0,
    }),
    context,
  );
  const merged = mergeUsageSummaries(
    "all",
    [codex, gemini],
    new Date("2026-09-15T23:59:59"),
  );

  assert.equal(merged.daily[0]?.cost?.amount, 4);
  assert.equal(merged.daily[0]?.breakdown[0]?.cost?.amount, 4);
});

test("free local, partial, and unknown pricing statuses remain distinguishable", async (t) => {
  const partialPath = await writePricingFile(t, {
    baseCurrency: "USD",
    rules: [
      {
        provider: "claude",
        model: "partial-model",
        inputPerMillion: 1,
      },
    ],
  });
  const free = priceUsageSummary(
    createSummary({ provider: "ollama", model: "llama3" }),
    createPricingContext("USD"),
  );
  const partial = priceUsageSummary(
    createSummary({ provider: "claude", model: "partial-model" }),
    createPricingContext("USD", partialPath),
  );
  const unknown = priceUsageSummary(
    createSummary({ provider: "claude", model: "not-in-catalog" }),
    createPricingContext("USD"),
  );

  assert.equal(free.daily[0]?.cost?.basis, "free");
  assert.equal(free.daily[0]?.cost?.coverage, "complete");
  assert.equal(formatUsageCost(free.daily[0]?.cost), "Free");
  assert.equal(partial.daily[0]?.cost?.basis, "estimated");
  assert.equal(partial.daily[0]?.cost?.coverage, "partial");
  assert.equal(unknown.daily[0]?.cost?.basis, "unknown");
  assert.equal(unknown.daily[0]?.cost?.coverage, "unknown");
  assert.equal(hasPricedCost(unknown), false);
});

test("bundled rules only carry first-party source URLs", () => {
  assert.ok(BUILT_IN_RULES.length > 0);

  for (const rule of BUILT_IN_RULES) {
    if (rule.provider === "ollama") {
      continue;
    }

    assert.match(
      rule.sourceUrl ?? "",
      /^https:\/\/(?:openai\.com|developers\.openai\.com|platform\.openai\.com|www\.anthropic\.com|www-cdn\.anthropic\.com|ai\.google\.dev|cloud\.google\.com|docs\.x\.ai|api-docs\.deepseek\.com|mimo\.mi\.com|www\.kimi\.ai|platform\.kimi\.ai|dev\.meta\.ai|help\.aliyun\.com|platform\.minimax\.io|www\.minimax\.io|open\.bigmodel\.cn|console\.upstage\.ai|build\.nvidia\.com|cloud\.tencent\.com|ant-ling\.com)\//,
      rule.model,
    );
    assert.doesNotMatch(
      rule.source ?? "",
      /OpenRouter|snapshot|marketplace/i,
      rule.model,
    );
  }
});

test("unverified publisher or marketplace aliases remain unknown", () => {
  const context = createPricingContext("USD");
  const models = [
    "unverified-model-alias",
    "qwen3-vl:8b-instruct",
  ];

  for (const model of models) {
    const priced = priceUsageSummary(
      createSummary({ provider: "codex", model }),
      context,
    );

    assert.equal(priced.daily[0]?.cost?.coverage, "unknown", model);
  }
});

test("verified standard rates and effective dates are used", () => {
  const context = createPricingContext("USD");
  const cases = [
    ["GPT-5.5", "2026-09-15T12:00:00", 35],
    ["gpt-5.5-pro", "2026-09-15T12:00:00", 210],
    ["gpt-5.4-mini", "2026-09-15T12:00:00", 5.25],
    ["claude-opus-4-8-thinking-high", "2026-09-15T12:00:00", 30],
    ["claude-fable-5-thinking-high", "2026-09-15T12:00:00", 60],
    ["Gemini 3.8 Flash (High)", "2026-09-15T12:00:00", 4.5],
    ["grok-code-fast-1", "2026-09-15T12:00:00", 3],
    ["mimo-v2.5", "2026-09-15T12:00:00", 0.42],
    ["muse-spark-1.3-contributor", "2026-09-15T12:00:00", 0.3],
    ["minimax-m2.5", "2026-09-15T12:00:00", 1.35],
    ["kimi-k2.7-code", "2026-09-15T12:00:00", 4.95],
    ["qwen3.8-max", "2026-09-15T12:00:00", 6.666666666666667],
    ["gpt-5__max", "2026-09-15T12:00:00", 11.25],
    ["Gemini-3-Pro-Preview", "2026-09-15T12:00:00", 14],
    ["Gemini-3-Pro-Preview (200k)", "2026-09-15T12:00:00", 14],
    ["kimi-k2.5-free", "2026-09-15T12:00:00", 3.6],
    ["kimi-k2__max", "2026-09-15T12:00:00", 3.1],
    ["glm-5.2", "2026-09-15T12:00:00", 5.8],
    ["zai/glm-5.2", "2026-09-15T12:00:00", 5.8],
    ["glm-5.1", "2026-09-15T12:00:00", 5.8],
    ["glm-5-free", "2026-09-15T12:00:00", 5.8],
    ["deepseek-v4-flash", "2026-09-15T12:00:00", 1.5],
    ["gpt-6-sol", "2026-09-23T12:00:00", 12],
    ["gpt-6-luna", "2026-09-23T12:00:00", 0.6],
    ["nemotron-3.5-lightning-free", "2026-09-15T12:00:00", 0],
    ["minimax-m2.1-free", "2026-09-15T12:00:00", 1.5],
    ["gpt-5.3-codex-spark", "2026-09-15T12:00:00", 15.75],
    ["hy3-free", "2026-09-15T12:00:00", 0.7],
    ["ling-3.0-flash-fin-free", "2026-09-15T12:00:00", 0.24],
    ["ling-3.0-flash", "2026-09-15T12:00:00", 0.084],
  ] as const;

  for (const [model, date, expected] of cases) {
    const priced = priceUsageSummary(
      createSummary({
        provider: "codex",
        model,
        date,
        input: 1_000_000,
        output: 1_000_000,
      }),
      context,
    );

    assert.ok(
      Math.abs((priced.daily[0]?.cost?.amount ?? 0) - expected) < 1e-12,
      model,
    );
  }

  const beforeRoutingChange = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "deepseek-v4-pro",
      date: "2026-09-13T12:00:00",
      input: 1_000_000,
      output: 1_000_000,
    }),
    context,
  );
  const afterRoutingChange = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "deepseek-v4-pro",
      date: "2026-09-15T12:00:00",
      input: 1_000_000,
      output: 1_000_000,
    }),
    context,
  );

  assert.equal(beforeRoutingChange.daily[0]?.cost?.amount, 5.28);
  assert.equal(afterRoutingChange.daily[0]?.cost?.amount, 1.5);
});

test("provider pricing begins only when the official dated rate is available", () => {
  const context = createPricingContext("USD");
  const cases = [
    [
      "Gemini 3.8 Flash (High)",
      "2026-09-01T12:00:00",
      "2026-09-02T12:00:00",
      4.5,
    ],
    [
      "Gemini 3.7 Flash (High)",
      "2026-08-12T12:00:00",
      "2026-08-13T12:00:00",
      4.5,
    ],
    [
      "Gemini 3.6 Flash (High)",
      "2026-07-20T12:00:00",
      "2026-07-21T12:00:00",
      4.5,
    ],
    [
      "Gemini 3.5 Flash Lite",
      "2026-07-20T12:00:00",
      "2026-07-21T12:00:00",
      2.8,
    ],
    ["mimo-v2.5", "2026-05-26T12:00:00", "2026-05-27T12:00:00", 0.42],
  ] as const;

  for (const [model, beforeDate, afterDate, expectedAmount] of cases) {
    const before = priceUsageSummary(
      createSummary({
        provider: "codex",
        model,
        date: beforeDate,
        input: 1_000_000,
        output: 1_000_000,
      }),
      context,
    );
    assert.equal(before.daily[0]?.cost?.coverage, "unknown", `${model} before`);

    const after = priceUsageSummary(
      createSummary({
        provider: "codex",
        model,
        date: afterDate,
        input: 1_000_000,
        output: 1_000_000,
      }),
      context,
    );
    assert.ok(
      Math.abs((after.daily[0]?.cost?.amount ?? 0) - expectedAmount) < 1e-12,
      `${model} after`,
    );
  }

  const deepSeekProBeforeChange = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "deepseek-v4-pro",
      date: "2026-08-15T12:00:00",
      input: 1_000_000,
      output: 1_000_000,
    }),
    context,
  );
  assert.equal(deepSeekProBeforeChange.daily[0]?.cost?.coverage, "complete");
  assert.equal(deepSeekProBeforeChange.daily[0]?.cost?.amount, 5.28);
});

test("GPT-5.6 Sol uses the documented historical standard rates", () => {
  const context = createPricingContext("USD");

  const launchRate = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "gpt-5.6-sol",
      date: "2026-07-15T12:00:00",
      input: 1_000_000,
      output: 1_000_000,
    }),
    context,
  );
  assert.equal(launchRate.daily[0]?.cost?.amount, 35);

  const launchCacheRead = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "gpt-5.6-sol",
      date: "2026-08-20T12:00:00",
      input: 0,
      output: 0,
      cacheInput: 1_000_000,
    }),
    context,
  );
  assert.equal(launchCacheRead.daily[0]?.cost?.amount, 0.5);

  const launchCacheWrite = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "gpt-5.6-sol",
      date: "2026-08-20T12:00:00",
      input: 0,
      output: 0,
      cacheOutput: 1_000_000,
    }),
    context,
  );
  assert.equal(launchCacheWrite.daily[0]?.cost?.amount, 6.25);

  const reducedRate = priceUsageSummary(
    createSummary({
      provider: "codex",
      model: "gpt-5.6-sol",
      date: "2026-08-21T12:00:00",
      input: 1_000_000,
      output: 1_000_000,
    }),
    context,
  );
  assert.equal(reducedRate.daily[0]?.cost?.amount, 24);
});

test("GPT-5.6 Terra and Luna use their documented launch and reduced rates", () => {
  const context = createPricingContext("USD");
  const cases = [
    ["gpt-5.6-terra", 17.5, 14, "2026-07-15T12:00:00", "2026-07-30T12:00:00"],
    ["gpt-5.6-luna", 7, 1.4, "2026-07-15T12:00:00", "2026-07-30T12:00:00"],
  ] as const;

  for (const [
    model,
    launchAmount,
    reducedAmount,
    launchDate,
    reducedDate,
  ] of cases) {
    const launchRate = priceUsageSummary(
      createSummary({
        provider: "codex",
        model,
        date: launchDate,
        input: 1_000_000,
        output: 1_000_000,
      }),
      context,
    );
    assert.equal(launchRate.daily[0]?.cost?.amount, launchAmount, model);

    const reducedRate = priceUsageSummary(
      createSummary({
        provider: "codex",
        model,
        date: reducedDate,
        input: 1_000_000,
        output: 1_000_000,
      }),
      context,
    );
    assert.equal(reducedRate.daily[0]?.cost?.amount, reducedAmount, model);
  }
});

test("publisher and namespace prefixes are stripped when matching pricing rules", () => {
  const context = createPricingContext("USD");
  const cases = [
    ["openai/gpt-5.6-luna", 1.4],
    ["deepseek/deepseek-v4-flash", 1.5],
    ["anthropic/claude-opus-4", 90],
    ["openrouter/openai/gpt-5.4", 17.5],
  ] as const;

  for (const [model, expected] of cases) {
    const priced = priceUsageSummary(
      createSummary({
        provider: "freebuff",
        model,
        date: "2026-09-15T12:00:00",
        input: 1_000_000,
        output: 1_000_000,
      }),
      context,
    );

    assert.equal(priced.daily[0]?.cost?.amount, expected, model);
  }
});

test("verified Z.ai, Upstage Solar, and MiMo V2.6 models are priced accurately", () => {
  const context = createPricingContext("USD");
  const cases = [
    ["z-ai/glm-5.3-flash", 0.65],
    ["glm-5.3-flash", 0.65],
    ["glm-5.3", 5.8],
    ["upstage/solar-pro4", 1.5],
    ["solar-pro4", 1.5],
    ["upstage/solar-mini4", 0.25],
    ["solar-mini4", 0.25],
    ["mimo/mimo-v2.6-pro", 1.305],
    ["mimo-v2.6-pro", 1.305],
    ["mimo/mimo-v2.6", 0.42],
  ] as const;

  for (const [model, expected] of cases) {
    const priced = priceUsageSummary(
      createSummary({
        provider: "freebuff",
        model,
        date: "2026-09-15T12:00:00",
        input: 1_000_000,
        output: 1_000_000,
      }),
      context,
    );

    assert.ok(
      Math.abs((priced.daily[0]?.cost?.amount ?? 0) - expected) < 1e-12,
      model,
    );
  }

  const cachedPro = priceUsageSummary(
    createSummary({
      provider: "freebuff",
      model: "upstage/solar-pro4",
      date: "2026-09-15T12:00:00",
      input: 0,
      output: 0,
      cacheInput: 1_000_000,
    }),
    context,
  );
  assert.equal(cachedPro.daily[0]?.cost?.amount, 0.06);

  const cachedGlm = priceUsageSummary(
    createSummary({
      provider: "freebuff",
      model: "z-ai/glm-5.3-flash",
      date: "2026-09-15T12:00:00",
      input: 0,
      output: 0,
      cacheInput: 1_000_000,
    }),
    context,
  );
  assert.equal(cachedGlm.daily[0]?.cost?.amount, 0.03);
});

