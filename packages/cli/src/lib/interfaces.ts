export type ProviderId =
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
  | "warp";

export const providerIds: ProviderId[] = [
  "antigravity",
  "amp",
  "claude",
  "cline",
  "codex",
  "continue",
  "cursor",
  "fx",
  "freebuff",
  "gemini",
  "kilo",
  "opencode",
  "ollama",
  "pi",
  "roo",
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
  cline: "Cline",
  codex: "Codex",
  continue: "Continue",
  cursor: "Cursor",
  fx: "Vercel FX",
  freebuff: "Freebuff",
  gemini: "Gemini CLI",
  grok: "Grok",
  kilo: "Kilo Code",
  opencode: "Open Code",
  ollama: "Ollama",
  pi: "Pi Coding Agent",
  roo: "Roo Code",
  trae: "Trae",
  windsurf: "Windsurf",
  warp: "Warp",
};
