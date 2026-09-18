export type UsageProviderId =
  | "antigravity"
  | "amp"
  | "claude"
  | "codex"
  | "cursor"
  | "gemini"
  | "opencode"
  | "pi"
  | "trae"
  | "grok"
  | "windsurf"
  | "all";

export interface UsageSummary {
  provider: UsageProviderId;
  daily: DailyUsage[];
  insights?: Insights;
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
}

export interface JsonExportPayload {
  version: string;
  start: string;
  end: string;
  providers: JsonUsageSummary[];
}

export interface JsonUsageSummary {
  provider: UsageProviderId;
  daily: JsonDailyUsage[];
  insights?: Insights;
  models?: ModelTableEntry[];
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
  breakdown: ModelUsage[];
}
