# slopmeter

`slopmeter` is a Node.js CLI that scans local Antigravity, Amp, Claude Code, Codex, Continue, Cursor, Vercel FX, Freebuff, Gemini CLI, Grok, Open Code, Pi Coding Agent, Trae, Warp, and Windsurf usage data and generates a contribution-style heatmap for the rolling past year.

## Requirements

- Node.js `>=22`

## Run with npm

Use it without installing:

```bash
npx slopmeter
```

Install it globally:

```bash
npm install -g slopmeter
slopmeter
```



## Usage

```bash
slopmeter [--all] [--antigravity] [--amp] [--claude] [--codex] [--continue] [--cursor] [--fx] [--freebuff] [--gemini] [--grok] [--opencode] [--pi] [--trae] [--windsurf] [--warp] [--dark] [--format png|svg|json] [--output ./heatmap-last-year.png]
```

By default, the CLI:

- scans all supported providers
- writes `./heatmap-last-year.png`
- infers the date window as the rolling last year ending today

## Options

- `--claude`: include only Claude Code data
- `--codex`: include only Codex data
- `--continue`: include only Continue data
- `--cursor`: include only Cursor data
- `--fx`: include only Vercel FX data
- `--freebuff`: include only Freebuff data
- `--antigravity`: include only Antigravity data
- `--gemini`: include only Gemini CLI data
- `--grok`: include only Grok data
- `--opencode`: include only Open Code data
- `--pi`: include only Pi Coding Agent data
- `--trae`: include only Trae data
- `--windsurf`: include only Windsurf data
- `--warp`: include only Warp data
- `--all`: merge all providers into one combined graph
- `--dark`: render the image with the dark theme
- `-f, --format <png|svg|json>`: choose the output format
- `-o, --output <path>`: write output to a custom path
- `-h, --help`: print the help text

## Examples

Generate the default PNG:

```bash
npx slopmeter
```

Write an SVG:

```bash
npx slopmeter --format svg --output ./out/heatmap.svg
```

Write JSON for custom rendering:

```bash
npx slopmeter --format json --output ./out/heatmap.json
```

Render only Codex usage:

```bash
npx slopmeter --codex
```

Render only Cursor usage:

```bash
npx slopmeter --cursor
```

Render only Continue usage:

```bash
npx slopmeter --continue
```

Render only Vercel FX usage:

```bash
npx slopmeter --fx
```

Render only Antigravity usage:

```bash
npx slopmeter --antigravity
```

Render only Gemini CLI usage:

```bash
npx slopmeter --gemini
```

Render only Pi Coding Agent usage:

```bash
npx slopmeter --pi
```

Render only Windsurf usage:

```bash
npx slopmeter --windsurf
```

Render only Warp usage:

```bash
npx slopmeter --warp
```

Render one merged graph across all providers:

```bash
npx slopmeter --all
```

When provider flags are present, `slopmeter` only loads those providers and only prints availability for those providers.

Render a dark-theme SVG:

```bash
npx slopmeter --dark --format svg --output ./out/heatmap-dark.svg
```

## Output behavior

- If `--format` is omitted, the format is inferred from the `--output` extension when possible.
- If `--output` is omitted, the default filename becomes `heatmap-last-year.<ext>`, `heatmap-last-year_<providers>.<ext>` for explicit provider flags, or `heatmap-last-year_all.<ext>` for `--all`.
- Supported extensions are `.png`, `.svg`, and `.json`.
- If neither `--format` nor a recognized output extension is provided, PNG is used.

## Data locations

- Claude Code: `$CLAUDE_CONFIG_DIR/*/projects` or `~/.config/claude/projects`, `~/.claude/projects`
- Older Claude Code layouts: falls back to `$CLAUDE_CONFIG_DIR/stats-cache.json`, `~/.config/claude/stats-cache.json`, or `~/.claude/stats-cache.json` for days not present in project logs
- Earliest Claude Code activity fallback: uses `$CLAUDE_CONFIG_DIR/history.jsonl`, `~/.config/claude/history.jsonl`, or `~/.claude/history.jsonl` to mark activity-only days when token totals are unavailable
- Codex: `$CODEX_HOME/sessions` or `~/.codex/sessions`
- Continue: `$CONTINUE_CONFIG_DIR/dev_data/**/tokensGenerated.jsonl` or `~/.continue/dev_data/**/tokensGenerated.jsonl`
- Vercel FX: `$FX_HOME/usage.jsonl` or `~/.fx/usage.jsonl`; on Windows, every registered WSL2 distribution's `~/.fx/usage.jsonl` is also checked
- Antigravity: discovers local Antigravity language server metadata from `%APPDATA%/Antigravity/logs/**/Antigravity.log` (Windows), `~/Library/Application Support/Antigravity/logs/**/Antigravity.log` (macOS), or `~/.config/Antigravity/logs/**/Antigravity.log` (Linux), then reads usage from local LS protobuf RPC endpoints
- Freebuff: `~/.config/manicode/projects/**/chats/**/chat-messages.json`, plus `manicode-dev` and `manicode-staging`; when those files are absent, the running Desktop orchestrator's local `/api/projects` and `/api/thread/:id` endpoints are used; override file roots with `FREEBUFF_CONFIG_DIR` or `FREEBUFF_DATA_DIR`, and the API with `FREEBUFF_API_URL`
- Freebuff and paid Codebuff can share the `manicode` root. If both are installed and must be separated, point `FREEBUFF_CONFIG_DIR` at an isolated Freebuff root.
- Windsurf: discovers running or installed Windsurf language servers and reads Cascade trajectory usage from Codeium protobuf RPCs; when Windsurf is closed, a discovered language server may be started briefly for a read-only scan
- Cursor: reads `cursorAuth/accessToken` and `cursorAuth/refreshToken` from `$CURSOR_STATE_DB_PATH`, `$CURSOR_CONFIG_DIR/User/globalStorage/state.vscdb`, `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (macOS), `%APPDATA%/Cursor/User/globalStorage/state.vscdb` (Windows), or `~/.config/Cursor/User/globalStorage/state.vscdb` (Linux), then loads usage from Cursor's CSV export endpoint
- Gemini CLI: `$GEMINI_CONFIG_DIR/tmp/**/chats/session-*.json` or `~/.gemini/tmp/**/chats/session-*.json`
- Open Code: prefers `$OPENCODE_DATA_DIR/opencode.db` or `~/.local/share/opencode/opencode.db`, and falls back to `$OPENCODE_DATA_DIR/storage/message` or `~/.local/share/opencode/storage/message`
- Pi Coding Agent: `$PI_CODING_AGENT_DIR/sessions` or `~/.pi/agent/sessions`
- Trae: `$TRAE_DATABASE_PATH`, auto-discovered `database_decrypted.db` in `%APPDATA%/Trae/ModularData/ai-agent/` (or `TRAE SOLO`, macOS `~/Library/Application Support/Trae`, Linux `~/.config/Trae`), or `database.db` when `TRAE_SQLCIPHER_KEY` is provided
- Warp: `$WARP_DATABASE_PATH` or `%LOCALAPPDATA%/warp/Warp/data/warp.sqlite` (macOS and Linux platform defaults are also checked)

When Claude Code falls back to `stats-cache.json`, the daily input/output/cache split is reconstructed from Claude's cached model totals because the older layout does not keep per-request usage logs.
When Claude Code falls back to `history.jsonl`, those days are rendered as activity-only cells and do not affect the token totals shown in the header.

## Exit behavior

- If no provider flags are passed, `slopmeter` renders every provider with available data.
- If `--all` is passed, `slopmeter` loads all providers and renders one combined graph with merged totals, streaks, and model rankings.
- Pi Coding Agent usage is derived from assistant messages in Pi session logs, grouped by the model that handled each turn.
- Antigravity usage is derived from local Antigravity language server trajectory RPCs plus trajectory IDs from local Antigravity unified state.
- Freebuff usage is derived from assistant-message usage records in local `chat-messages.json` files, or, when those files are unavailable, from the authenticated local Freebuff Desktop API.
- Continue usage is derived from `promptTokens` and `generatedTokens` records. Records without timestamps use the source file's modification date.
- Vercel FX usage is derived from `generation` facts. Repeated facts with the same generation ID are treated as updates, not double-counted.
- Warp usage is derived from aggregate `warp_tokens` and `byok_tokens` entries in the local Warp `agent_conversations` SQLite table. Warp does not persist an input/output split, so the aggregate is kept as the total and input-compatible usage count.
- If provider flags are passed and a requested provider has no data, the command exits with an error.
- If no provider has data, the command exits with an error.

GitHub Copilot is intentionally not supported. Its documented usage surfaces are organization/enterprise administration APIs that expose request and activity metrics, not the local prompt/input/output token telemetry used by `slopmeter`. Supporting it would require account credentials and external API access while producing numbers that are not comparable with the other providers. GitHub's reports also have limited historical retention, so Copilot cannot provide the same local and all-time history behavior. See the [Copilot usage metrics API](https://docs.github.com/rest/copilot/copilot-usage-metrics) and [user activity metrics](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/review-activity/review-user-activity-data).

## Environment variables

Environment variables can be exported in your shell or defined in a local `.env` file (see `.env.example`). `slopmeter` automatically loads `.env` files on startup.

- `ANTIGRAVITY_CONFIG_DIR`: override the Antigravity config root used for log discovery.
- `ANTIGRAVITY_LOG_PATH`: override Antigravity log discovery with an explicit `Antigravity.log` file path.
- `ANTIGRAVITY_LS_PID`: force a language server PID for RPC discovery.
- `ANTIGRAVITY_LS_HTTP_PORT`: force the Antigravity LS HTTP port.
- `ANTIGRAVITY_LS_CSRF_TOKEN`: force the Antigravity LS CSRF token.
- `ANTIGRAVITY_STATE_DB_PATH`: override Antigravity unified-state DB discovery with an explicit `state.vscdb` path.
- `ANTIGRAVITY_MAX_TRAJECTORIES`: cap the number of cascades scanned per run. Default: `200`.
- `ANTIGRAVITY_MAX_STEP_PAGES`: cap per-cascade step page fetches (20-step page size). Default: `100`.
- `FREEBUFF_CONFIG_DIR`: override the Freebuff configuration root. Multiple roots may be comma-separated.
- `FREEBUFF_DATA_DIR`: compatibility alias for `FREEBUFF_CONFIG_DIR`.
- `FREEBUFF_API_URL`: override the local Freebuff Desktop API URL. Multiple comma-separated URLs are supported; otherwise the running Desktop orchestrator log and `http://127.0.0.1:12382` are checked.
- `CONTINUE_CONFIG_DIR`: override the Continue configuration root used for token telemetry discovery. Defaults to `~/.continue`.
- `FX_HOME`: override the native FX state directory. When unset on Windows, all registered WSL2 distributions are scanned automatically.
- `WINDSURF_CONFIG_DIR`: override the Windsurf configuration root used for log discovery.
- `WINDSURF_CODEIUM_DIR`: override the Windsurf Codeium data directory containing Cascade files.
- `WINDSURF_LANGUAGE_SERVER_PATH`: override the Windsurf language-server binary path used for headless reads.
- `WINDSURF_LOG_PATH`: override Windsurf log discovery with an explicit `Windsurf.log` path.
- `WINDSURF_LS_PID`: force a running Windsurf language-server PID.
- `WINDSURF_LS_HTTP_PORT`: force the running Windsurf language-server HTTP port.
- `WINDSURF_LS_CSRF_TOKEN`: force the running Windsurf language-server CSRF token.
- `WINDSURF_MAX_TRAJECTORIES`: cap the number of Cascade trajectories scanned per run. Default: `1000`.
- `WINDSURF_MAX_STEP_PAGES`: cap per-trajectory step and generator-metadata page fetches. Default: `100`.
- `TRAE_DATABASE_PATH`: override Trae database discovery with an explicit decrypted SQLite database path or JSON export path.
- `TRAE_SQLCIPHER_KEY`: 64-character raw hex key to decrypt Trae's SQLCipher database on the fly.
- `TRAE_CONFIG_DIR`: override root Trae config directory used for discovery.
- `WARP_DATABASE_PATH`: override the Warp `warp.sqlite` database path.
- `SLOPMETER_FILE_PROCESS_CONCURRENCY`: positive integer file-processing limit for Claude Code, Codex, and Freebuff usage files. Default: `16`.
- `SLOPMETER_MAX_JSONL_RECORD_BYTES`: byte cap for Claude Code and Codex JSONL records, Freebuff chat JSON documents, OpenCode JSON documents, and OpenCode SQLite `message.data` payloads. Default: `67108864` (`64 MB`).

## JSONL record handling

- Claude Code and Codex JSONL files are streamed through the same bounded record splitter; `slopmeter` does not materialize whole files in memory.
- Oversized Claude Code JSONL records fail the file with a clear error that names the file, line number, byte cap, and `SLOPMETER_MAX_JSONL_RECORD_BYTES`.
- OpenCode prefers the current SQLite store (`opencode.db`) and falls back to the legacy file-backed message layout.
- OpenCode legacy JSON message files are read through a bounded JSON document reader before `JSON.parse`.
- OpenCode SQLite `message.data` payloads use the same byte cap before `JSON.parse`.
- Oversized OpenCode JSON documents and SQLite message payloads fail clearly with the source path or row label, byte cap, and `SLOPMETER_MAX_JSONL_RECORD_BYTES`.
- Only Codex `turn_context` and `event_msg` `token_count` records are parsed for usage aggregation.
- Oversized irrelevant Codex records are skipped and reported in a warning summary.
- Oversized relevant Codex records fail the file with a clear error that names the file, line number, byte cap, and `SLOPMETER_MAX_JSONL_RECORD_BYTES`.
- Pi Coding Agent session logs are streamed and only assistant messages are parsed for usage aggregation.

## License

MIT
