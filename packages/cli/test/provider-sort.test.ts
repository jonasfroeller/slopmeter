import assert from "node:assert/strict";
import test from "node:test";
import type { UsageSummary } from "../src/interfaces";
import { sortProviderSummaries } from "../src/provider-sort";

function summary(
  provider: UsageSummary["provider"],
  totals: number[],
): UsageSummary {
  return {
    provider,
    daily: totals.map((total, index) => ({
      date: new Date(`2026-09-${String(index + 1).padStart(2, "0")}T00:00:00`),
      input: total,
      output: 0,
      cache: { input: 0, output: 0 },
      total,
      breakdown: [],
    })),
  };
}

const providers = [
  summary("cursor", [20]),
  summary("antigravity", [100]),
  summary("codex", [20]),
];

test("sortProviderSummaries sorts names and token totals in both directions", () => {
  assert.deepEqual(
    sortProviderSummaries(providers, { by: "name", direction: "asc" }).map(
      (item) => item.provider,
    ),
    ["antigravity", "codex", "cursor"],
  );
  assert.deepEqual(
    sortProviderSummaries(providers, { by: "name", direction: "desc" }).map(
      (item) => item.provider,
    ),
    ["cursor", "codex", "antigravity"],
  );
  assert.deepEqual(
    sortProviderSummaries(providers, { by: "tokens", direction: "asc" }).map(
      (item) => item.provider,
    ),
    ["codex", "cursor", "antigravity"],
  );
  assert.deepEqual(
    sortProviderSummaries(providers, { by: "tokens", direction: "desc" }).map(
      (item) => item.provider,
    ),
    ["antigravity", "codex", "cursor"],
  );
});
