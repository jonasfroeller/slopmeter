import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CostBasis,
  CostCoverage,
  DailyUsage,
  ModelUsage,
  PricingMetadata,
  ReportedUsageCost,
  UsageCost,
  UsageProviderId,
  UsageSummary,
} from "./interfaces";
import { cloneUsageCost, formatLocalDate, mergeUsageCosts } from "./lib/utils";

export const PRICING_BASE_CURRENCY = "USD";
export const PRICING_CATALOG_VERSION = "2026-09-26";
export const BUILT_IN_FX_AS_OF = "2026-09-19";

export interface PricingRule {
  provider: string;
  model: string;
  inputPerMillion?: number | null;
  outputPerMillion?: number | null;
  cacheReadPerMillion?: number | null;
  cacheWritePerMillion?: number | null;
  effectiveFrom?: string;
  effectiveTo?: string;
  source?: string;
  sourceUrl?: string;
}

export interface PricingFile {
  baseCurrency?: string;
  fx?: {
    asOf?: string;
    rates?: Record<string, unknown>;
  };
  rules?: PricingRule[];
}

interface LoadedRule extends PricingRule {
  custom: boolean;
  index: number;
}

interface LoadedPricing {
  baseCurrency: string;
  fxAsOf: string;
  fxRates: Record<string, number>;
  rules: LoadedRule[];
}

export interface PricingContext {
  pricing: LoadedPricing;
  metadata: PricingMetadata;
  fxRate: number;
}

interface TokenTotalsLike {
  input: number;
  output: number;
  cache: { input: number; output: number };
  total?: number;
}

interface TokenComponents {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface CostCalculation {
  cost: UsageCost;
  components: TokenComponents;
}

const LOCALE_CURRENCY_BY_REGION: Record<string, string> = {
  AT: "EUR",
  AU: "AUD",
  BE: "EUR",
  BR: "BRL",
  CA: "CAD",
  CH: "CHF",
  CN: "CNY",
  CZ: "CZK",
  DE: "EUR",
  DK: "DKK",
  ES: "EUR",
  FI: "EUR",
  FR: "EUR",
  GB: "GBP",
  GR: "EUR",
  HK: "HKD",
  HU: "HUF",
  IE: "EUR",
  IL: "ILS",
  IN: "INR",
  IT: "EUR",
  JP: "JPY",
  KR: "KRW",
  MX: "MXN",
  NL: "EUR",
  NO: "NOK",
  NZ: "NZD",
  PL: "PLN",
  PT: "EUR",
  SE: "SEK",
  SG: "SGD",
  TR: "TRY",
  TW: "TWD",
  US: "USD",
  ZA: "ZAR",
};

// These are a reproducible display-only FX snapshot. Users can replace any
// rate through --pricing when they need accounting-grade conversion.
const BUILT_IN_FX_RATES: Record<string, number> = {
  AUD: 1.54,
  BRL: 5.4,
  CAD: 1.38,
  CHF: 0.79,
  CNY: 7.2,
  CZK: 22.5,
  DKK: 6.7,
  EUR: 0.85,
  GBP: 0.76,
  HKD: 7.8,
  HUF: 340,
  ILS: 3.4,
  INR: 84,
  JPY: 147,
  KRW: 1400,
  MXN: 18.5,
  NOK: 10.3,
  NZD: 1.75,
  PLN: 3.65,
  SEK: 10.5,
  SGD: 1.3,
  TRY: 41,
  TWD: 32,
  USD: 1,
  ZAR: 17.5,
};

const officialRule = (
  source: string,
  sourceUrl: string,
  rule: Omit<PricingRule, "provider" | "source" | "sourceUrl">,
): PricingRule => ({
  provider: "*",
  source,
  sourceUrl,
  ...rule,
});

// Every non-local rule below is tied to a first-party pricing page. Rates are
// ordinary API/standard rates; Batch, priority, flex, marketplace, and
// subscription-credit prices are deliberately excluded.
export const BUILT_IN_RULES: PricingRule[] = [
  // OpenAI standard API pricing.
  officialRule(
    "OpenAI standard API pricing",
    "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
    {
      model: "gpt-6-astra*",
      inputPerMillion: 10,
      outputPerMillion: 50,
      cacheReadPerMillion: 1,
      cacheWritePerMillion: 12.5,
    },
  ),
  officialRule(
    "OpenAI GPT-5.6 Sol launch API pricing",
    "https://openai.com/index/gpt-5-6/",
    {
      model: "gpt-5.6-sol*",
      inputPerMillion: 5,
      outputPerMillion: 30,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
      effectiveFrom: "2026-07-09",
      effectiveTo: "2026-08-20",
    },
  ),
  officialRule(
    "OpenAI GPT-5.6 Sol promotional API pricing",
    "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
    {
      model: "gpt-5.6-sol*",
      inputPerMillion: 4,
      outputPerMillion: 20,
      cacheReadPerMillion: 0.4,
      cacheWritePerMillion: 5,
      effectiveFrom: "2026-08-21",
    },
  ),
  officialRule(
    "OpenAI GPT-5.6 Terra launch API pricing",
    "https://openai.com/index/gpt-5-6/",
    {
      model: "gpt-5.6-terra*",
      inputPerMillion: 2.5,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.25,
      cacheWritePerMillion: 3.125,
      effectiveFrom: "2026-07-09",
      effectiveTo: "2026-07-29",
    },
  ),
  officialRule(
    "OpenAI GPT-5.6 Terra reduced API pricing",
    "https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/",
    {
      model: "gpt-5.6-terra*",
      inputPerMillion: 2,
      outputPerMillion: 12,
      cacheReadPerMillion: 0.2,
      cacheWritePerMillion: 2.5,
      effectiveFrom: "2026-07-30",
    },
  ),
  officialRule(
    "OpenAI GPT-5.6 Luna launch API pricing",
    "https://openai.com/index/gpt-5-6/",
    {
      model: "gpt-5.6-luna*",
      inputPerMillion: 1,
      outputPerMillion: 6,
      cacheReadPerMillion: 0.1,
      cacheWritePerMillion: 1.25,
      effectiveFrom: "2026-07-09",
      effectiveTo: "2026-07-29",
    },
  ),
  officialRule(
    "OpenAI GPT-5.6 Luna reduced API pricing",
    "https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/",
    {
      model: "gpt-5.6-luna*",
      inputPerMillion: 0.2,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.02,
      cacheWritePerMillion: 0.25,
      effectiveFrom: "2026-07-30",
    },
  ),
  officialRule(
    "OpenAI standard API pricing",
    "https://developers.openai.com/api/docs/models/gpt-5.5-pro",
    {
      model: "gpt-5.5-pro*",
      inputPerMillion: 30,
      outputPerMillion: 180,
      cacheReadPerMillion: null,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "OpenAI standard API pricing",
    "https://developers.openai.com/api/docs/models/gpt-5.5",
    {
      model: "gpt-5.5*",
      inputPerMillion: 5,
      outputPerMillion: 30,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "OpenAI standard API pricing",
    "https://developers.openai.com/api/docs/models/gpt-5.4-pro",
    {
      model: "gpt-5.4-pro*",
      inputPerMillion: 30,
      outputPerMillion: 180,
      cacheReadPerMillion: null,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "OpenAI standard API pricing",
    "https://developers.openai.com/api/docs/models/gpt-5.4-mini",
    {
      model: "gpt-5.4-mini*",
      inputPerMillion: 0.75,
      outputPerMillion: 4.5,
      cacheReadPerMillion: 0.075,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "OpenAI standard API pricing",
    "https://developers.openai.com/api/docs/models/gpt-5.4-nano",
    {
      model: "gpt-5.4-nano*",
      inputPerMillion: 0.2,
      outputPerMillion: 1.25,
      cacheReadPerMillion: 0.02,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "OpenAI standard API pricing",
    "https://developers.openai.com/api/docs/models/gpt-5.4",
    {
      model: "gpt-5.4*",
      inputPerMillion: 2.5,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.25,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "OpenAI standard API pricing",
    "https://developers.openai.com/api/docs/models/gpt-5.3-codex",
    {
      model: "gpt-5.3-codex",
      inputPerMillion: 1.75,
      outputPerMillion: 14,
      cacheReadPerMillion: 0.175,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "OpenAI standard API pricing",
    "https://developers.openai.com/api/docs/models/gpt-5.2-pro",
    {
      model: "gpt-5.2-pro*",
      inputPerMillion: 21,
      outputPerMillion: 168,
      cacheReadPerMillion: null,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "OpenAI standard API pricing",
    "https://developers.openai.com/api/docs/models/gpt-5.2-codex",
    {
      model: "gpt-5.2-codex*",
      inputPerMillion: 1.75,
      outputPerMillion: 14,
      cacheReadPerMillion: 0.175,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "OpenAI standard API pricing",
    "https://developers.openai.com/api/docs/models/gpt-5.2",
    {
      model: "gpt-5.2*",
      inputPerMillion: 1.75,
      outputPerMillion: 14,
      cacheReadPerMillion: 0.175,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "OpenAI standard API pricing",
    "https://developers.openai.com/api/docs/models/gpt-5.1-codex",
    {
      model: "gpt-5.1-codex*",
      inputPerMillion: 1.25,
      outputPerMillion: 10,
      cacheReadPerMillion: 0.125,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "OpenAI standard API pricing",
    "https://developers.openai.com/api/docs/models/gpt-5-codex",
    {
      model: "gpt-5-codex*",
      inputPerMillion: 1.25,
      outputPerMillion: 10,
      cacheReadPerMillion: 0.125,
      cacheWritePerMillion: null,
    },
  ),
  ...["gpt-5", "gpt-5-high", "gpt-5-medium"].map((model) =>
    officialRule(
      "OpenAI standard API pricing",
      "https://developers.openai.com/api/docs/models/gpt-5",
      {
        model,
        inputPerMillion: 1.25,
        outputPerMillion: 10,
        cacheReadPerMillion: 0.125,
        cacheWritePerMillion: null,
      },
    ),
  ),
  officialRule(
    "OpenAI standard API pricing",
    "https://developers.openai.com/api/docs/pricing",
    {
      model: "gpt-4o-mini*",
      inputPerMillion: 0.15,
      outputPerMillion: 0.6,
      cacheReadPerMillion: 0.075,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "OpenAI standard API pricing",
    "https://developers.openai.com/api/docs/pricing",
    {
      model: "gpt-4o*",
      inputPerMillion: 2.5,
      outputPerMillion: 10,
      cacheReadPerMillion: 1.25,
      cacheWritePerMillion: null,
    },
  ),

  // Anthropic standard API rates. Cache writes use the five-minute rate,
  // which is the lowest standard cache-write price in Anthropic's table.
  officialRule(
    "Anthropic standard API pricing",
    "https://www.anthropic.com/news/claude-opus-5",
    {
      model: "claude-opus-5*",
      inputPerMillion: 5,
      outputPerMillion: 25,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
    },
  ),
  ...["4.8", "4-8", "4.7", "4-7", "4.6", "4-6", "4.5", "4-5"].map((version) =>
    officialRule(
      "Anthropic standard API pricing",
      version.startsWith("4.8") || version === "4-8"
        ? "https://www.anthropic.com/news/claude-opus-4-8"
        : version.startsWith("4.7") || version === "4-7"
          ? "https://www.anthropic.com/news/claude-opus-4-7"
          : "https://www-cdn.anthropic.com/files/4zrzovbb/website/3684c2faafb97418665782cea0001f439f74b1d2.pdf",
      {
        model: `*claude*opus*${version}*`,
        inputPerMillion: 5,
        outputPerMillion: 25,
        cacheReadPerMillion: 0.5,
        cacheWritePerMillion: 6.25,
      },
    ),
  ),
  ...["4.8", "4-8", "4.7", "4-7", "4.6", "4-6", "4.5", "4-5"].map((version) =>
    officialRule(
      "Anthropic standard API pricing",
      version.startsWith("4.8") || version === "4-8"
        ? "https://www.anthropic.com/news/claude-opus-4-8"
        : version.startsWith("4.7") || version === "4-7"
          ? "https://www.anthropic.com/news/claude-opus-4-7"
          : "https://www-cdn.anthropic.com/files/4zrzovbb/website/3684c2faafb97418665782cea0001f439f74b1d2.pdf",
      {
        model: `*claude*${version}*opus*`,
        inputPerMillion: 5,
        outputPerMillion: 25,
        cacheReadPerMillion: 0.5,
        cacheWritePerMillion: 6.25,
      },
    ),
  ),
  officialRule(
    "Anthropic standard API pricing",
    "https://www-cdn.anthropic.com/files/4zrzovbb/website/3684c2faafb97418665782cea0001f439f74b1d2.pdf",
    {
      model: "claude-opus-4",
      inputPerMillion: 15,
      outputPerMillion: 75,
      cacheReadPerMillion: 1.5,
      cacheWritePerMillion: 18.75,
    },
  ),
  officialRule(
    "Anthropic standard API pricing",
    "https://www.anthropic.com/claude/fable",
    {
      model: "*claude*fable*5.1*",
      inputPerMillion: 10,
      outputPerMillion: 50,
      cacheReadPerMillion: 0.25,
      cacheWritePerMillion: 12.5,
    },
  ),
  officialRule(
    "Anthropic standard API pricing",
    "https://www.anthropic.com/claude/fable",
    {
      model: "*claude*fable*5*",
      inputPerMillion: 10,
      outputPerMillion: 50,
      cacheReadPerMillion: 1,
      cacheWritePerMillion: 12.5,
    },
  ),
  officialRule(
    "Anthropic standard API pricing",
    "https://www.anthropic.com/news/claude-sonnet-5",
    {
      model: "claude-sonnet-5*",
      inputPerMillion: 2,
      outputPerMillion: 10,
      cacheReadPerMillion: 0.2,
      cacheWritePerMillion: 2.5,
    },
  ),
  ...["4.6", "4-6", "4.5", "4-5"].map((version) =>
    officialRule(
      "Anthropic standard API pricing",
      "https://www-cdn.anthropic.com/files/4zrzovbb/website/3684c2faafb97418665782cea0001f439f74b1d2.pdf",
      {
        model: `*claude*sonnet*${version}*`,
        inputPerMillion: 3,
        outputPerMillion: 15,
        cacheReadPerMillion: 0.3,
        cacheWritePerMillion: 3.75,
      },
    ),
  ),
  ...["4.6", "4-6", "4.5", "4-5"].map((version) =>
    officialRule(
      "Anthropic standard API pricing",
      "https://www-cdn.anthropic.com/files/4zrzovbb/website/3684c2faafb97418665782cea0001f439f74b1d2.pdf",
      {
        model: `*claude*${version}*sonnet*`,
        inputPerMillion: 3,
        outputPerMillion: 15,
        cacheReadPerMillion: 0.3,
        cacheWritePerMillion: 3.75,
      },
    ),
  ),
  ...["claude-3.7-sonnet*", "claude-3-7-sonnet*"].map((model) =>
    officialRule(
      "Anthropic standard API pricing",
      "https://www-cdn.anthropic.com/files/4zrzovbb/website/3684c2faafb97418665782cea0001f439f74b1d2.pdf",
      {
        model,
        inputPerMillion: 3,
        outputPerMillion: 15,
        cacheReadPerMillion: 0.3,
        cacheWritePerMillion: 3.75,
      },
    ),
  ),
  officialRule(
    "Anthropic standard API pricing",
    "https://www-cdn.anthropic.com/files/4zrzovbb/website/3684c2faafb97418665782cea0001f439f74b1d2.pdf",
    {
      model: "claude-4-sonnet*",
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    },
  ),
  ...["4.5", "4-5"].map((version) =>
    officialRule(
      "Anthropic standard API pricing",
      "https://www-cdn.anthropic.com/files/4zrzovbb/website/3684c2faafb97418665782cea0001f439f74b1d2.pdf",
      {
        model: `*claude*${version}*haiku*`,
        inputPerMillion: 1,
        outputPerMillion: 5,
        cacheReadPerMillion: 0.1,
        cacheWritePerMillion: 1.25,
      },
    ),
  ),
  officialRule(
    "Anthropic standard API pricing",
    "https://www-cdn.anthropic.com/files/4zrzovbb/website/3684c2faafb97418665782cea0001f439f74b1d2.pdf",
    {
      model: "claude-3-5-haiku*",
      inputPerMillion: 0.8,
      outputPerMillion: 4,
      cacheReadPerMillion: 0.08,
      cacheWritePerMillion: 1,
    },
  ),

  // Google Gemini standard pricing. Where Google publishes context-length
  // tiers, these are the standard <=200K (or listed standard) token rates.
  ...[["3.8", "3.7", "3.6"]].flatMap((versions) =>
    versions.flatMap((version) => [
      officialRule(
        "Google Gemini standard introductory pricing",
        "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing",
        {
          model: `*gemini*${version}*flash*`,
          inputPerMillion: 0.75,
          outputPerMillion: 3.75,
          cacheReadPerMillion: 0.075,
          cacheWritePerMillion: null,
          effectiveFrom:
            version === "3.8"
              ? "2026-09-02"
              : version === "3.7"
                ? "2026-08-13"
                : "2026-07-21",
          effectiveTo: "2026-12-31",
        },
      ),
      officialRule(
        "Google Gemini standard API pricing",
        "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing",
        {
          model: `*gemini*${version}*flash*`,
          inputPerMillion: 1.5,
          outputPerMillion: 7.5,
          cacheReadPerMillion: 0.15,
          cacheWritePerMillion: null,
          effectiveFrom: "2027-01-01",
        },
      ),
    ]),
  ),
  officialRule(
    "Google Gemini standard API pricing",
    "https://ai.google.dev/gemini-api/docs/pricing",
    {
      model: "*gemini*3.5*flash*lite*",
      inputPerMillion: 0.3,
      outputPerMillion: 2.5,
      cacheReadPerMillion: 0.03,
      cacheWritePerMillion: null,
      effectiveFrom: "2026-07-21",
    },
  ),
  officialRule(
    "Google Gemini standard API pricing",
    "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing",
    {
      model: "*gemini*3.5*flash*",
      inputPerMillion: 1.5,
      outputPerMillion: 9,
      cacheReadPerMillion: 0.15,
      cacheWritePerMillion: null,
      effectiveFrom: "2026-07-21",
    },
  ),
  officialRule(
    "Google Gemini standard API pricing",
    "https://ai.google.dev/gemini-api/docs/pricing",
    {
      model: "*gemini*3.1*flash*lite*",
      inputPerMillion: 0.25,
      outputPerMillion: 1.5,
      cacheReadPerMillion: 0.025,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Google Gemini standard API pricing (<=200K context tier)",
    "https://ai.google.dev/gemini-api/docs/pricing",
    {
      model: "*gemini*3.1*pro*",
      inputPerMillion: 2,
      outputPerMillion: 12,
      cacheReadPerMillion: 0.2,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Google Gemini standard API pricing (display alias, <=200K context tier)",
    "https://ai.google.dev/gemini-api/docs/pricing",
    {
      model: "*gemini 2.5 pro*",
      inputPerMillion: 1.25,
      outputPerMillion: 10,
      cacheReadPerMillion: 0.125,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Google Gemini standard API pricing",
    "https://ai.google.dev/gemini-api/docs/pricing",
    {
      model: "gemini-3-flash-preview*",
      inputPerMillion: 0.5,
      outputPerMillion: 3,
      cacheReadPerMillion: 0.05,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Google Gemini standard API pricing (<=200K context tier)",
    "https://ai.google.dev/gemini-api/docs/pricing",
    {
      model: "gemini-2.5-pro*",
      inputPerMillion: 1.25,
      outputPerMillion: 10,
      cacheReadPerMillion: 0.125,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Google Gemini standard API pricing (display alias)",
    "https://ai.google.dev/gemini-api/docs/pricing",
    {
      model: "*gemini 2.5 flash lite*",
      inputPerMillion: 0.1,
      outputPerMillion: 0.4,
      cacheReadPerMillion: 0.01,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Google Gemini standard API pricing",
    "https://ai.google.dev/gemini-api/docs/pricing",
    {
      model: "gemini-2.5-flash-lite*",
      inputPerMillion: 0.1,
      outputPerMillion: 0.4,
      cacheReadPerMillion: 0.01,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Google Gemini standard API pricing (display alias)",
    "https://ai.google.dev/gemini-api/docs/pricing",
    {
      model: "*gemini 2.5 flash*",
      inputPerMillion: 0.3,
      outputPerMillion: 2.5,
      cacheReadPerMillion: 0.03,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Google Gemini standard API pricing",
    "https://ai.google.dev/gemini-api/docs/pricing",
    {
      model: "gemini-2.5-flash*",
      inputPerMillion: 0.3,
      outputPerMillion: 2.5,
      cacheReadPerMillion: 0.03,
      cacheWritePerMillion: null,
    },
  ),

  // xAI's short-context standard API rates. The long-context surcharge is not
  // inferable from aggregate telemetry, so it is not silently guessed.
  officialRule(
    "xAI standard API pricing (short context)",
    "https://docs.x.ai/developers/pricing",
    {
      model: "grok-4.6",
      inputPerMillion: 2,
      outputPerMillion: 6,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "xAI standard API pricing (short context)",
    "https://docs.x.ai/developers/pricing",
    {
      model: "*grok*4.6*medium*",
      inputPerMillion: 2,
      outputPerMillion: 6,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "xAI standard API pricing (short context)",
    "https://docs.x.ai/developers/pricing",
    {
      model: "grok-4.5",
      inputPerMillion: 2,
      outputPerMillion: 6,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "xAI standard API pricing (short context)",
    "https://docs.x.ai/developers/pricing",
    {
      model: "grok-4.3",
      inputPerMillion: 1.25,
      outputPerMillion: 2.5,
      cacheReadPerMillion: 0.2,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "xAI standard API pricing (Grok Build 0.1 alias)",
    "https://docs.x.ai/developers/models/grok-build-0.1",
    {
      model: "grok-code-fast-1",
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheReadPerMillion: 0.2,
      cacheWritePerMillion: null,
    },
  ),

  // DeepSeek's public page publishes peak and off-peak rates. We use the
  // published peak rate because local records do not include the UTC billing
  // window needed to select the cheaper off-peak tier.
  officialRule(
    "DeepSeek V4.1 Flash standard peak API pricing",
    "https://api-docs.deepseek.com/news/news260910/",
    {
      model: "deepseek-v4-flash*",
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.006,
      cacheWritePerMillion: null,
      effectiveFrom: "2026-09-10",
    },
  ),
  officialRule(
    "DeepSeek V4 Pro standard peak API pricing after V4 GA",
    "https://api-docs.deepseek.com/quick_start/pricing/",
    {
      model: "deepseek-v4-pro",
      inputPerMillion: 1.32,
      outputPerMillion: 3.96,
      cacheReadPerMillion: 0.044,
      cacheWritePerMillion: null,
      effectiveFrom: "2026-08-16",
      effectiveTo: "2026-09-13",
    },
  ),
  officialRule(
    "DeepSeek standard peak API pricing after V4.1 Flash routing",
    "https://api-docs.deepseek.com/news/news260910/",
    {
      model: "deepseek-v4-pro",
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.006,
      cacheWritePerMillion: null,
      effectiveFrom: "2026-09-14",
    },
  ),

  // Xiaomi MiMo regular API pricing, not the separate Token Plan used by
  // coding tools. Cache writes are temporarily free on the official table.
  officialRule(
    "Xiaomi MiMo international API pricing",
    "https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go",
    {
      model: "*mimo-v2.6-pro*",
      inputPerMillion: 0.435,
      outputPerMillion: 0.87,
      cacheReadPerMillion: 0.0036,
      cacheWritePerMillion: 0,
      effectiveFrom: "2026-08-01",
    },
  ),
  officialRule(
    "Xiaomi MiMo international API pricing",
    "https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go",
    {
      model: "*mimo-v2.6*",
      inputPerMillion: 0.14,
      outputPerMillion: 0.28,
      cacheReadPerMillion: 0.0028,
      cacheWritePerMillion: 0,
      effectiveFrom: "2026-08-01",
    },
  ),
  officialRule(
    "Xiaomi MiMo international API pricing",
    "https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go",
    {
      model: "*mimo-v2.5-pro*",
      inputPerMillion: 0.435,
      outputPerMillion: 0.87,
      cacheReadPerMillion: 0.0036,
      cacheWritePerMillion: 0,
      effectiveFrom: "2026-05-27",
    },
  ),
  officialRule(
    "Xiaomi MiMo international API pricing",
    "https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go",
    {
      model: "*mimo-v2.5*",
      inputPerMillion: 0.14,
      outputPerMillion: 0.28,
      cacheReadPerMillion: 0.0028,
      cacheWritePerMillion: 0,
      effectiveFrom: "2026-05-27",
    },
  ),

  // Moonshot/Kimi international API pricing.
  officialRule(
    "Moonshot international API pricing",
    "https://platform.kimi.ai/",
    {
      model: "*kimi-k3*",
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Moonshot international API pricing",
    "https://www.kimi.ai/resources/kimi-k2-7-code",
    {
      model: "*kimi-k2.7-code*",
      inputPerMillion: 0.95,
      outputPerMillion: 4,
      cacheReadPerMillion: 0.19,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Moonshot international API pricing",
    "https://www.kimi.ai/es-419/resources/kimi-k2-6-pricing",
    {
      model: "*kimi-k2.6*",
      inputPerMillion: 0.95,
      outputPerMillion: 4,
      cacheReadPerMillion: 0.16,
      cacheWritePerMillion: null,
    },
  ),

  // Meta Model API standard and Contributor rates.
  ...["1.3", "1.2"].map((version) =>
    officialRule(
      "Meta Model API Contributor pricing",
      "https://dev.meta.ai/docs/pricing-rate-limits",
      {
        model: `*muse-spark-${version}-contributor*`,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0.002,
        cacheWritePerMillion: null,
      },
    ),
  ),
  ...["1.3", "1.2", "1.1"].map((version) =>
    officialRule(
      "Meta Model API standard pricing",
      "https://dev.meta.ai/docs/pricing-rate-limits",
      {
        model: `*muse-spark-${version}*`,
        inputPerMillion: 1.25,
        outputPerMillion: 4.25,
        cacheReadPerMillion: 0.15,
        cacheWritePerMillion: null,
      },
    ),
  ),

  // Alibaba publishes these Model Studio rates in CNY for the global region.
  // They are converted with the bundled CNY/USD snapshot; context-cache hits
  // use the documented 20% implicit-cache rate.
  officialRule(
    "Alibaba Model Studio global pricing (CNY converted)",
    "https://help.aliyun.com/en/model-studio/model-pricing",
    {
      model: "*qwen3.8-max*",
      inputPerMillion: 12 / 7.2,
      outputPerMillion: 36 / 7.2,
      cacheReadPerMillion: (12 * 0.2) / 7.2,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Alibaba Model Studio global pricing (CNY converted, <=256K tier)",
    "https://help.aliyun.com/en/model-studio/model-pricing",
    {
      model: "*qwen3.7-plus*",
      inputPerMillion: 2 / 7.2,
      outputPerMillion: 8 / 7.2,
      cacheReadPerMillion: (2 * 0.2) / 7.2,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Alibaba Model Studio global pricing (CNY converted, <=256K tier)",
    "https://help.aliyun.com/en/model-studio/model-pricing",
    {
      model: "*qwen3.6-plus*",
      inputPerMillion: 2 / 7.2,
      outputPerMillion: 12 / 7.2,
      cacheReadPerMillion: (2 * 0.2) / 7.2,
      cacheWritePerMillion: null,
    },
  ),

  // MiniMax standard API pricing.
  officialRule(
    "MiniMax standard API pricing",
    "https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise",
    {
      model: "*minimax-m3*",
      inputPerMillion: 0.6,
      outputPerMillion: 2.4,
      cacheReadPerMillion: 0.12,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "MiniMax standard API pricing",
    "https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise",
    {
      model: "*minimax-m2.7*",
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.06,
      cacheWritePerMillion: 0.375,
    },
  ),
  officialRule(
    "MiniMax standard API pricing",
    "https://www.minimax.io/news/minimax-m25",
    {
      model: "*minimax-m2.5*",
      inputPerMillion: 0.15,
      outputPerMillion: 1.2,
      cacheReadPerMillion: null,
      cacheWritePerMillion: null,
    },
  ),

  // Z.ai standard API pricing.
  officialRule(
    "Z.ai standard API pricing",
    "https://open.bigmodel.cn/pricing",
    {
      model: "*glm-5.3-flash*",
      inputPerMillion: 0.15,
      outputPerMillion: 0.5,
      cacheReadPerMillion: 0.03,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Z.ai standard API pricing",
    "https://open.bigmodel.cn/pricing",
    {
      model: "*glm-5.3-flashx*",
      inputPerMillion: 0.37,
      outputPerMillion: 1.25,
      cacheReadPerMillion: 0.075,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Z.ai standard API pricing",
    "https://open.bigmodel.cn/pricing",
    {
      model: "*glm-5.3*",
      inputPerMillion: 1.4,
      outputPerMillion: 4.4,
      cacheReadPerMillion: 0.26,
      cacheWritePerMillion: null,
    },
  ),

  // Upstage standard API pricing.
  officialRule(
    "Upstage standard API pricing",
    "https://console.upstage.ai/docs/pricing",
    {
      model: "*solar-pro4*",
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.06,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Upstage standard API pricing",
    "https://console.upstage.ai/docs/pricing",
    {
      model: "*solar-pro*",
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.06,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Upstage standard API pricing",
    "https://console.upstage.ai/docs/pricing",
    {
      model: "*solar-mini4*",
      inputPerMillion: 0.05,
      outputPerMillion: 0.2,
      cacheReadPerMillion: 0.005,
      cacheWritePerMillion: null,
    },
  ),
  officialRule(
    "Upstage standard API pricing",
    "https://console.upstage.ai/docs/pricing",
    {
      model: "*solar-mini*",
      inputPerMillion: 0.05,
      outputPerMillion: 0.2,
      cacheReadPerMillion: 0.005,
      cacheWritePerMillion: null,
    },
  ),

  // Ollama is local inference by default. This is intentionally a separate
  // free status rather than an unknown price.
  {
    provider: "ollama",
    model: "*",
    inputPerMillion: 0,
    outputPerMillion: 0,
    cacheReadPerMillion: 0,
    cacheWritePerMillion: 0,
    source: "local inference",
  },
];

function cloneRule(
  rule: PricingRule,
  custom: boolean,
  index: number,
): LoadedRule {
  return { ...rule, custom, index };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid pricing configuration: ${field} must be a string`);
  }

  return value.trim();
}

function asRate(value: unknown, field: string): number | null | undefined {
  if (value === undefined || value === null) {
    return value as null | undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `Invalid pricing configuration: ${field} must be a non-negative number or null`,
    );
  }

  return value;
}

function parseRule(value: unknown, index: number): PricingRule {
  const record = asRecord(value);

  if (!record) {
    throw new Error(
      `Invalid pricing configuration: rules[${index}] must be an object`,
    );
  }

  const provider = asNonEmptyString(
    record.provider,
    `rules[${index}].provider`,
  );
  const model = asNonEmptyString(record.model, `rules[${index}].model`);

  if (!provider || !model) {
    throw new Error(
      `Invalid pricing configuration: rules[${index}] needs provider and model`,
    );
  }

  return {
    provider,
    model,
    inputPerMillion: asRate(
      record.inputPerMillion,
      `rules[${index}].inputPerMillion`,
    ),
    outputPerMillion: asRate(
      record.outputPerMillion,
      `rules[${index}].outputPerMillion`,
    ),
    cacheReadPerMillion: asRate(
      record.cacheReadPerMillion,
      `rules[${index}].cacheReadPerMillion`,
    ),
    cacheWritePerMillion: asRate(
      record.cacheWritePerMillion,
      `rules[${index}].cacheWritePerMillion`,
    ),
    effectiveFrom: asNonEmptyString(
      record.effectiveFrom,
      `rules[${index}].effectiveFrom`,
    ),
    effectiveTo: asNonEmptyString(
      record.effectiveTo,
      `rules[${index}].effectiveTo`,
    ),
    source: asNonEmptyString(record.source, `rules[${index}].source`),
    sourceUrl: asNonEmptyString(record.sourceUrl, `rules[${index}].sourceUrl`),
  };
}

function validateDate(value: string | undefined, field: string) {
  if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(
      `Invalid pricing configuration: ${field} must use YYYY-MM-DD`,
    );
  }
}

function loadCustomPricingFile(filePath: string): PricingFile {
  const resolvedPath = resolve(filePath);
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`Unable to read pricing file ${resolvedPath}: ${message}`);
  }

  const record = asRecord(parsed);

  if (!record) {
    throw new Error(
      `Invalid pricing configuration: ${resolvedPath} must be an object`,
    );
  }

  const baseCurrency = asNonEmptyString(record.baseCurrency, "baseCurrency");

  if (baseCurrency && baseCurrency.toUpperCase() !== PRICING_BASE_CURRENCY) {
    throw new Error(
      `Invalid pricing configuration: baseCurrency must be ${PRICING_BASE_CURRENCY}`,
    );
  }

  const fxRecord = record.fx === undefined ? undefined : asRecord(record.fx);

  if (record.fx !== undefined && !fxRecord) {
    throw new Error("Invalid pricing configuration: fx must be an object");
  }

  const ratesRecord = fxRecord?.rates;

  if (ratesRecord !== undefined && asRecord(ratesRecord) === undefined) {
    throw new Error(
      "Invalid pricing configuration: fx.rates must be an object",
    );
  }

  const rules = record.rules;

  if (rules !== undefined && !Array.isArray(rules)) {
    throw new Error("Invalid pricing configuration: rules must be an array");
  }

  const parsedRules = (rules ?? []).map(parseRule);

  for (const [index, rule] of parsedRules.entries()) {
    validateDate(rule.effectiveFrom, `rules[${index}].effectiveFrom`);
    validateDate(rule.effectiveTo, `rules[${index}].effectiveTo`);

    if (
      rule.effectiveFrom &&
      rule.effectiveTo &&
      rule.effectiveFrom > rule.effectiveTo
    ) {
      throw new Error(
        `Invalid pricing configuration: rules[${index}] effectiveFrom is after effectiveTo`,
      );
    }
  }

  validateDate(asNonEmptyString(fxRecord?.asOf, "fx.asOf"), "fx.asOf");

  const fxRates: Record<string, unknown> = asRecord(ratesRecord) ?? {};

  for (const [currency, value] of Object.entries(fxRates)) {
    if (!/^[A-Z]{3}$/.test(currency.toUpperCase())) {
      throw new Error(
        `Invalid pricing configuration: fx.rates key ${currency} must be an ISO-4217 code`,
      );
    }

    asRate(value, `fx.rates.${currency}`);
  }

  return {
    baseCurrency: PRICING_BASE_CURRENCY,
    fx: {
      asOf: asNonEmptyString(fxRecord?.asOf, "fx.asOf"),
      rates: fxRates,
    },
    rules: parsedRules,
  };
}

export function loadPricing(pricingFile?: string): LoadedPricing {
  const rules = BUILT_IN_RULES.map((rule, index) =>
    cloneRule(rule, false, index),
  );
  const fxRates = { ...BUILT_IN_FX_RATES };
  let fxAsOf = BUILT_IN_FX_AS_OF;

  if (pricingFile) {
    const custom = loadCustomPricingFile(pricingFile);

    for (const [currency, value] of Object.entries(custom.fx?.rates ?? {})) {
      if (typeof value === "number") {
        fxRates[currency.toUpperCase()] = value;
      } else if (value === null) {
        delete fxRates[currency.toUpperCase()];
      }
    }

    fxAsOf = custom.fx?.asOf ?? fxAsOf;

    for (const [index, rule] of (custom.rules ?? []).entries()) {
      rules.push(cloneRule(rule, true, BUILT_IN_RULES.length + index));
    }
  }

  return {
    baseCurrency: PRICING_BASE_CURRENCY,
    fxAsOf,
    fxRates,
    rules,
  };
}

export function inferCurrencyFromLocale(
  locale = Intl.DateTimeFormat().resolvedOptions().locale,
  _timeZone?: string,
) {
  void _timeZone;

  try {
    const region = new Intl.Locale(locale).region;

    return (
      (region ? LOCALE_CURRENCY_BY_REGION[region] : undefined) ??
      PRICING_BASE_CURRENCY
    );
  } catch {
    return PRICING_BASE_CURRENCY;
  }
}

export function createPricingContext(
  currencyArg?: string,
  pricingFile?: string,
): PricingContext {
  const pricing = loadPricing(pricingFile);
  const requested = currencyArg?.trim() || "auto";
  const isAuto = requested.toLowerCase() === "auto";

  if (!isAuto && !/^[A-Za-z]{3}$/.test(requested)) {
    throw new Error(
      `Invalid currency ${requested}; use auto or a three-letter ISO-4217 code`,
    );
  }

  const inferred = isAuto ? inferCurrencyFromLocale() : undefined;
  const candidate = (
    isAuto ? (inferred ?? PRICING_BASE_CURRENCY) : requested
  ).toUpperCase();
  const fxRate = Object.hasOwn(pricing.fxRates, candidate)
    ? pricing.fxRates[candidate]!
    : undefined;

  if (fxRate === undefined) {
    if (isAuto) {
      return createPricingContext(PRICING_BASE_CURRENCY, pricingFile);
    }

    throw new Error(
      `No bundled or custom FX rate is available for ${candidate}; add it under fx.rates in the pricing file`,
    );
  }

  return {
    pricing,
    fxRate,
    metadata: {
      baseCurrency: pricing.baseCurrency,
      currency: candidate,
      fxAsOf: pricing.fxAsOf,
      rateCatalogVersion: PRICING_CATALOG_VERSION,
    },
  };
}

function isEffective(rule: PricingRule, date: string) {
  return (
    (!rule.effectiveFrom || date >= rule.effectiveFrom) &&
    (!rule.effectiveTo || date <= rule.effectiveTo)
  );
}

function matchesGlob(pattern: string, value: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const expression = `^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`;

  return new RegExp(expression, "i").test(value);
}

function stripProviderPrefix(model: string): string {
  const slashIndex = model.lastIndexOf("/");

  if (slashIndex >= 0 && slashIndex < model.length - 1) {
    return model.slice(slashIndex + 1);
  }

  return model;
}

function matchesRuleModel(pattern: string, model: string): boolean {
  if (matchesGlob(pattern, model)) {
    return true;
  }

  const stripped = stripProviderPrefix(model);

  return stripped !== model && matchesGlob(pattern, stripped);
}

function selectRule(
  rules: LoadedRule[],
  provider: UsageProviderId,
  model: string,
  date: string,
) {
  const matchingRules = rules
    .filter(
      (rule) =>
        isEffective(rule, date) &&
        (rule.provider === "*" || rule.provider.toLowerCase() === provider) &&
        matchesRuleModel(rule.model, model),
    )
    .filter((rule, _, matching) => {
      // Keep Ollama's zero-rate fallback for genuinely unknown local models,
      // but let a known model family use its API-equivalent rate. This is how
      // local/event usage can contribute a meaningful value to the total.
      if (
        rule.custom ||
        provider !== "ollama" ||
        rule.provider !== "ollama" ||
        rule.model !== "*"
      ) {
        return true;
      }

      return matching.every(
        (candidate) =>
          candidate.provider === "ollama" && candidate.model === "*",
      );
    });

  return matchingRules.sort((left, right) => {
    const customScore = Number(right.custom) - Number(left.custom);

    if (customScore !== 0) {
      return customScore;
    }

    const exactModelScore =
      Number(!right.model.includes("*") && !right.model.includes("?")) -
      Number(!left.model.includes("*") && !left.model.includes("?"));

    if (exactModelScore !== 0) {
      return exactModelScore;
    }

    const directScore =
      Number(matchesGlob(right.model, model)) -
      Number(matchesGlob(left.model, model));

    if (directScore !== 0) {
      return directScore;
    }

    const providerScore =
      Number(right.provider !== "*") - Number(left.provider !== "*");

    if (providerScore !== 0) {
      return providerScore;
    }

    const specificity = right.model.length - left.model.length;

    if (specificity !== 0) {
      return specificity;
    }

    const leftEffectiveFrom = left.effectiveFrom ?? "";
    const rightEffectiveFrom = right.effectiveFrom ?? "";

    if (leftEffectiveFrom !== rightEffectiveFrom) {
      return rightEffectiveFrom.localeCompare(leftEffectiveFrom);
    }

    return right.index - left.index;
  })[0];
}

function getComponents(tokens: TokenTotalsLike): TokenComponents {
  return {
    input: Math.max(0, tokens.input - tokens.cache.input),
    output: Math.max(0, tokens.output - tokens.cache.output),
    cacheRead: Math.max(0, tokens.cache.input),
    cacheWrite: Math.max(0, tokens.cache.output),
  };
}

function componentTotal(components: TokenComponents) {
  return (
    components.input +
    components.output +
    components.cacheRead +
    components.cacheWrite
  );
}

function subtractComponents(left: TokenComponents, right: TokenComponents) {
  return {
    input: Math.max(0, left.input - right.input),
    output: Math.max(0, left.output - right.output),
    cacheRead: Math.max(0, left.cacheRead - right.cacheRead),
    cacheWrite: Math.max(0, left.cacheWrite - right.cacheWrite),
  };
}

function componentsToTotals(components: TokenComponents): TokenTotalsLike {
  return {
    input: components.input + components.cacheRead,
    output: components.output + components.cacheWrite,
    cache: { input: components.cacheRead, output: components.cacheWrite },
    total: componentTotal(components),
  };
}

function subtractReportedCost(
  reported: ReportedUsageCost | undefined,
  covered: ReportedUsageCost | undefined,
): ReportedUsageCost | undefined {
  if (!reported) {
    return undefined;
  }

  const coveredTokens = covered?.tokens;
  const tokens = {
    input: Math.max(0, reported.tokens.input - (coveredTokens?.input ?? 0)),
    output: Math.max(0, reported.tokens.output - (coveredTokens?.output ?? 0)),
    cache: {
      input: Math.max(
        0,
        reported.tokens.cache.input - (coveredTokens?.cache.input ?? 0),
      ),
      output: Math.max(
        0,
        reported.tokens.cache.output - (coveredTokens?.cache.output ?? 0),
      ),
    },
  };

  const coveredAmount = covered?.amountUsd ?? 0;
  const amountUsd = Math.max(0, reported.amountUsd - coveredAmount);

  if (componentTotal(getComponents(tokens)) <= 0 && amountUsd <= 0) {
    return undefined;
  }

  return { amountUsd, tokens };
}

function cloneReportedUsageCost(cost: ReportedUsageCost | undefined) {
  if (!cost) {
    return undefined;
  }

  return {
    amountUsd: cost.amountUsd,
    tokens: {
      input: cost.tokens.input,
      output: cost.tokens.output,
      cache: {
        input: cost.tokens.cache.input,
        output: cost.tokens.cache.output,
      },
    },
  } satisfies ReportedUsageCost;
}

function addReportedUsageCost(
  left: ReportedUsageCost | undefined,
  right: ReportedUsageCost | undefined,
) {
  if (!left) {
    return cloneReportedUsageCost(right);
  }

  if (!right) {
    return cloneReportedUsageCost(left);
  }

  return {
    amountUsd: left.amountUsd + right.amountUsd,
    tokens: {
      input: left.tokens.input + right.tokens.input,
      output: left.tokens.output + right.tokens.output,
      cache: {
        input: left.tokens.cache.input + right.tokens.cache.input,
        output: left.tokens.cache.output + right.tokens.cache.output,
      },
    },
  } satisfies ReportedUsageCost;
}

function getRate(
  rule: PricingRule | undefined,
  name:
    | "inputPerMillion"
    | "outputPerMillion"
    | "cacheReadPerMillion"
    | "cacheWritePerMillion",
) {
  return rule?.[name];
}

function isFreeModelLabel(model: string | undefined) {
  return model ? /(?:^|[-_])free(?:$|[-_])/i.test(model) : false;
}

function calculateCost(
  context: PricingContext,
  provider: UsageProviderId,
  model: string | undefined,
  date: Date,
  tokens: TokenTotalsLike,
  reportedCost: ReportedUsageCost | undefined,
): CostCalculation {
  const components = getComponents(tokens);
  const dateKey = formatLocalDate(date);
  const rule = model
    ? selectRule(context.pricing.rules, provider, model, dateKey)
    : undefined;
  const isFreeUsage =
    !reportedCost && (provider === "ollama" || isFreeModelLabel(model));
  const reportedComponents = reportedCost
    ? getComponents(componentsToTotals(getComponents(reportedCost.tokens)))
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const coveredComponents = {
    input: Math.min(components.input, reportedComponents.input),
    output: Math.min(components.output, reportedComponents.output),
    cacheRead: Math.min(components.cacheRead, reportedComponents.cacheRead),
    cacheWrite: Math.min(components.cacheWrite, reportedComponents.cacheWrite),
  };
  const remaining = subtractComponents(components, coveredComponents);
  const reportedAmount = reportedCost?.amountUsd ?? 0;
  let estimatedAmount = 0;
  let estimatedTokens = 0;
  let unpricedTokens = 0;
  let paidEstimateCount = 0;

  const pricedComponent = (amount: number, rate: number | null | undefined) => {
    if (amount <= 0) {
      return;
    }

    if (rate === undefined || rate === null) {
      unpricedTokens += amount;

      return;
    }

    estimatedAmount += (amount / 1_000_000) * rate;
    estimatedTokens += amount;
    if (rate !== 0) {
      paidEstimateCount += 1;
    }
  };

  pricedComponent(remaining.input, getRate(rule, "inputPerMillion"));
  pricedComponent(remaining.output, getRate(rule, "outputPerMillion"));
  pricedComponent(remaining.cacheRead, getRate(rule, "cacheReadPerMillion"));
  pricedComponent(remaining.cacheWrite, getRate(rule, "cacheWritePerMillion"));

  const reportedTokens = componentTotal(coveredComponents);
  const pricedTokens = reportedTokens + estimatedTokens;
  const basisParts = new Set<CostBasis>();

  if (reportedAmount > 0 || reportedTokens > 0) {
    basisParts.add("reported");
  }
  if (estimatedTokens > 0) {
    basisParts.add(paidEstimateCount === 0 ? "free" : "estimated");
  }

  const basis: CostBasis =
    basisParts.size === 0
      ? "unknown"
      : basisParts.size === 1
        ? [...basisParts][0]!
        : "mixed";
  const coverage: CostCoverage =
    pricedTokens <= 0 ? "unknown" : unpricedTokens > 0 ? "partial" : "complete";

  return {
    components,
    cost: {
      amount: (reportedAmount + estimatedAmount) * context.fxRate,
      currency: context.metadata.currency,
      basis,
      coverage,
      pricedTokens,
      unpricedTokens,
      ...(isFreeUsage ? { isFree: true } : {}),
    },
  };
}

function sumTokenTotals(rows: ModelUsage[]): TokenTotalsLike {
  return rows.reduce(
    (total, row) => ({
      input: total.input + row.tokens.input,
      output: total.output + row.tokens.output,
      cache: {
        input: total.cache.input + row.tokens.cache.input,
        output: total.cache.output + row.tokens.cache.output,
      },
      total: total.total + row.tokens.total,
    }),
    {
      input: 0,
      output: 0,
      cache: { input: 0, output: 0 },
      total: 0,
    },
  );
}

function sumReportedCosts(rows: ModelUsage[]) {
  return rows.reduce<ReportedUsageCost | undefined>(
    (total, row) => addReportedUsageCost(total, row.reportedCost),
    undefined,
  );
}

function hasComponents(tokens: TokenTotalsLike) {
  return componentTotal(getComponents(tokens)) > 0;
}

function calculateDailyCost(
  context: PricingContext,
  provider: UsageProviderId,
  row: DailyUsage,
  pricedBreakdown: ModelUsage[],
) {
  if (pricedBreakdown.length === 0) {
    return calculateCost(
      context,
      provider,
      undefined,
      row.date,
      row,
      row.reportedCost,
    ).cost;
  }

  let combined: UsageCost | undefined;

  for (const model of pricedBreakdown) {
    combined = mergeUsageCosts(combined, model.cost);
  }

  const modelTotals = sumTokenTotals(pricedBreakdown);
  const remainingComponents = subtractComponents(
    getComponents(row),
    getComponents(modelTotals),
  );
  const remainingTotals = componentsToTotals(remainingComponents);
  const remainingReported = subtractReportedCost(
    row.reportedCost,
    sumReportedCosts(pricedBreakdown),
  );

  if (hasComponents(remainingTotals) || remainingReported) {
    const remainderCost = calculateCost(
      context,
      provider,
      undefined,
      row.date,
      remainingTotals,
      remainingReported,
    ).cost;

    combined = mergeUsageCosts(combined, remainderCost);
  }

  return (
    combined ??
    calculateCost(context, provider, undefined, row.date, row, row.reportedCost)
      .cost
  );
}

function attachInsightCost(
  model: ModelUsage | undefined,
  costs: Map<string, UsageCost>,
) {
  if (!model) {
    return undefined;
  }

  const cost = costs.get(model.name);

  return {
    ...model,
    ...(cost ? { cost: cloneUsageCost(cost) } : {}),
  };
}

export function priceUsageSummary(
  summary: UsageSummary,
  context: PricingContext,
): UsageSummary {
  const modelCosts = new Map<string, UsageCost>();
  const recentModelCosts = new Map<string, UsageCost>();
  const recentEnd = summary.daily.at(-1)?.date ?? new Date();
  const recentStart = new Date(recentEnd);

  recentStart.setDate(recentStart.getDate() - 29);
  recentStart.setHours(0, 0, 0, 0);

  const daily = summary.daily.map((row) => {
    const breakdown = row.breakdown.map((model) => {
      const cost = calculateCost(
        context,
        summary.provider,
        model.name,
        row.date,
        model.tokens,
        model.reportedCost,
      ).cost;
      const mergedModelCost = mergeUsageCosts(modelCosts.get(model.name), cost);

      if (mergedModelCost) {
        modelCosts.set(model.name, mergedModelCost);
      }

      if (row.date >= recentStart) {
        const mergedRecentCost = mergeUsageCosts(
          recentModelCosts.get(model.name),
          cost,
        );

        if (mergedRecentCost) {
          recentModelCosts.set(model.name, mergedRecentCost);
        }
      }

      return { ...model, cost };
    });

    const pricedRow = { ...row, breakdown };

    return {
      ...pricedRow,
      cost: calculateDailyCost(context, summary.provider, pricedRow, breakdown),
    };
  });

  return {
    ...summary,
    pricing: context.metadata,
    daily,
    insights: summary.insights
      ? {
          ...summary.insights,
          mostUsedModel: attachInsightCost(
            summary.insights.mostUsedModel,
            modelCosts,
          ),
          recentMostUsedModel: attachInsightCost(
            summary.insights.recentMostUsedModel,
            recentModelCosts,
          ),
        }
      : summary.insights,
  };
}

export function hasPricedCost(summary: UsageSummary) {
  return summary.daily.some(
    (row) => row.cost && row.cost.coverage !== "unknown",
  );
}

export function formatUsageCost(cost: UsageCost | undefined, compact = false) {
  if (!cost || cost.coverage === "unknown") {
    return "—";
  }

  if (cost.basis === "free" && cost.amount === 0) {
    return "Free";
  }

  const smallAmount = cost.amount > 0 && cost.amount < 0.01;
  const formatter = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: cost.currency,
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: smallAmount ? 4 : 2,
    minimumFractionDigits: smallAmount ? 4 : 2,
  });

  const formatted = formatter.format(cost.amount);

  if (cost.isFree && cost.amount > 0) {
    return `Free (${formatted})`;
  }

  return formatted;
}

export function getPricingMetadata(context: PricingContext) {
  return { ...context.metadata };
}
