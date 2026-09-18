export type ProviderId =
  | "antigravity"
  | "amp"
  | "claude"
  | "codex"
  | "continue"
  | "cursor"
  | "freebuff"
  | "gemini"
  | "opencode"
  | "pi"
  | "trae"
  | "grok"
  | "windsurf"
  | "warp";

export const providerIds: ProviderId[] = [
  "antigravity",
  "amp",
  "claude",
  "codex",
  "continue",
  "cursor",
  "freebuff",
  "gemini",
  "opencode",
  "pi",
  "trae",
  "grok",
  "windsurf",
  "warp",
];

export const defaultProviderIds: ProviderId[] = ["claude", "codex", "cursor"];

export const providerStatusLabel: Record<ProviderId, string> = {
  antigravity: "Antigravity",
  amp: "Amp",
  claude: "Claude code",
  codex: "Codex",
  continue: "Continue",
  cursor: "Cursor",
  freebuff: "Freebuff",
  gemini: "Gemini CLI",
  grok: "Grok",
  opencode: "Open Code",
  pi: "Pi Coding Agent",
  trae: "Trae",
  windsurf: "Windsurf",
  warp: "Warp",
};
