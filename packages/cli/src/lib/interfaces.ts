export type ProviderId =
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
  | "windsurf";

export const providerIds: ProviderId[] = [
  "antigravity",
  "amp",
  "claude",
  "codex",
  "cursor",
  "gemini",
  "opencode",
  "pi",
  "trae",
  "grok",
  "windsurf",
];

export const defaultProviderIds: ProviderId[] = ["claude", "codex", "cursor"];

export const providerStatusLabel: Record<ProviderId, string> = {
  antigravity: "Antigravity",
  amp: "Amp",
  claude: "Claude code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  grok: "Grok",
  opencode: "Open Code",
  pi: "Pi Coding Agent",
  trae: "Trae",
  windsurf: "Windsurf",
};
