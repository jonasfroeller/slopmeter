export type UsageProviderId =
  | "antigravity"
  | "amp"
  | "claude"
  | "cline"
  | "codex"
  | "continue"
  | "cursor"
  | "fx"
  | "freebuff"
  | "gemini"
  | "kilo"
  | "opencode"
  | "ollama"
  | "pi"
  | "roo"
  | "trae"
  | "grok"
  | "windsurf"
  | "warp"
  | "all";

export type CostBasis =
  | "reported"
  | "estimated"
  | "free"
  | "unknown"
  | "mixed";

export type CostCoverage = "complete" | "partial" | "unknown";

export interface UsageCost {
  amount: number;
  currency: string;
  basis: CostBasis;
  coverage: CostCoverage;
  pricedTokens: number;
  unpricedTokens: number;
  /**
   * The usage was free to the user, but `amount` may still contain its
   * API-equivalent value when a matching model rate is available.
   */
  isFree?: boolean;
}

/**
 * Provider-reported costs are kept internally in USD until the pricing layer
 * converts them to the requested display currency.
 */
export interface ReportedUsageCost {
  amountUsd: number;
  tokens: {
    input: number;
    output: number;
    cache: {
      input: number;
      output: number;
    };
  };
}

export interface PricingMetadata {
  baseCurrency: string;
  currency: string;
  fxAsOf: string;
  rateCatalogVersion: string;
}

export interface UsageSummary {
  provider: UsageProviderId;
  daily: DailyUsage[];
  insights?: Insights;
  pricing?: PricingMetadata;
}

export interface DailyUsage {
  date: Date;
  input: number;
  output: number;
  cache: {
    input: number;
    output: number;
  };
  total: number;
  displayValue?: number;
  cost?: UsageCost;
  reportedCost?: ReportedUsageCost;
  // usage by model, sorted by total tokens
  breakdown: ModelUsage[];
}

export interface ModelUsage {
  name: string;
  tokens: {
    input: number;
    output: number;
    cache: {
      input: number;
      output: number;
    };
    total: number;
  };
  cost?: UsageCost;
  reportedCost?: ReportedUsageCost;
}

export interface Insights {
  mostUsedModel?: ModelUsage;
  recentMostUsedModel?: ModelUsage;
  streaks: {
    longest: number;
    current: number;
  };
}

export interface ModelTableEntry {
  name: string;
  input: number;
  output: number;
  cache: {
    input: number;
    output: number;
  };
  total: number;
  share: number;
  cost?: UsageCost;
}

export interface JsonExportPayload {
  version: string;
  start: string;
  end: string;
  pricing?: PricingMetadata;
  providers: JsonUsageSummary[];
}

export interface JsonUsageSummary {
  provider: UsageProviderId;
  daily: JsonDailyUsage[];
  insights?: JsonInsights;
  models?: ModelTableEntry[];
}

export interface JsonInsights {
  mostUsedModel?: JsonModelUsage;
  recentMostUsedModel?: JsonModelUsage;
  streaks: Insights["streaks"];
}

export interface JsonModelUsage {
  name: string;
  tokens: ModelUsage["tokens"];
  cost?: UsageCost;
}

export interface JsonDailyUsage {
  date: string;
  input: number;
  output: number;
  cache: {
    input: number;
    output: number;
  };
  total: number;
  displayValue?: number;
  cost?: UsageCost;
  breakdown: JsonModelUsage[];
}
