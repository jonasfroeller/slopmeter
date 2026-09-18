# slopmeter

CLI tool that generates usage heatmaps for Antigravity, Amp, Claude Code, Cline, Codex, Continue, Cursor, Vercel FX, Freebuff, Gemini CLI, Grok, Open Code, Pi Coding Agent, Trae, Warp, and Windsurf for the rolling past year (ending today).

## Monorepo layout

```text
packages/
  cli/
  registry/
tooling/
  typescript-config/
```

## Setup

```bash
bun install
bun run check
```

## Usage

```bash
# Build once
bun run build

# Run from built output
node packages/cli/dist/cli.js

# Run the CLI package directly in dev mode
bun run --cwd packages/cli dev

# Or if installed as a package binary
slopmeter
```

### Options

```bash
# Output file (default: `./heatmap-last-year.png`; explicit provider flags add suffixes like `./heatmap-last-year_cursor.png`, and `--all` uses `./heatmap-last-year_all.png`)
slopmeter --output ./out/heatmap.svg
slopmeter -o ./out/heatmap.svg

# Output format
slopmeter --format png
slopmeter --format svg
slopmeter --format json
slopmeter -f svg

# Dark theme
slopmeter --dark
slopmeter --dark --format svg

# Merge all providers into one graph
slopmeter --all

# Provider filters (optional)
slopmeter --claude
slopmeter --cline
slopmeter --codex
slopmeter --continue
slopmeter --cursor
slopmeter --fx
slopmeter --freebuff
slopmeter --antigravity
slopmeter --gemini
slopmeter --grok
slopmeter --opencode
slopmeter --pi
slopmeter --trae
slopmeter --windsurf
slopmeter --warp
```

## What the image shows

- Monday-first contribution-style heatmap for the last year.
- Top metrics per provider:
  - `LAST 30 DAYS`
  - `INPUT TOKENS`
  - `OUTPUT TOKENS`
  - `TOTAL TOKENS` (includes cache tokens)
- Bottom metrics per provider:
  - `MOST USED MODEL` (with total tokens)
  - `RECENT USE (LAST 30 DAYS)` (with total tokens)
  - `LONGEST STREAK`
  - `CURRENT STREAK`

Model names are normalized to remove a trailing date suffix like `-20251101`.

## Format behavior

- Default format is PNG.
- If `--output` is omitted, the default filename is `heatmap-last-year.<ext>`, `heatmap-last-year_<providers>.<ext>` for explicit provider flags, or `heatmap-last-year_all.<ext>` for `--all`.

- If `--format` is omitted, format is inferred from `--output` extension (`.png`, `.svg`, or `.json`).
- If neither provides a format, PNG is used.

## JSON export

- Use `--format json` (or an `.json` output filename) to export data for interactive rendering.
- Export includes fixed `version: "2026-03-03"`.
- Each provider includes:
  - `title` and `colors`
  - `daily` rows with `date`, `input`, `output`, `cache`, `total`
  - `daily[].breakdown` per-model usage for that day, sorted by `tokens.total` (includes `input` and `output`)
  - `insights` (`mostUsedModel`, `recentMostUsedModel`) when available

## Provider/data behavior

- If no provider flags are passed, the CLI renders all providers with available data.
- If `--all` is passed, the CLI renders one merged graph across all providers with consolidated totals, streaks, and model rankings.
- Pi Coding Agent usage is derived from assistant messages in Pi session logs, grouped by the model that handled each turn.
- Antigravity usage is derived from local Antigravity language server trajectory RPCs plus trajectory IDs from local Antigravity unified state.
- Freebuff usage is derived from assistant-message usage records in local `chat-messages.json` files, or, when those files are unavailable, from the authenticated local Freebuff Desktop API.
- When Freebuff does not record a model on an individual usage record, Slopmeter labels that usage `Mixed` instead of attributing it to the thread's current model.
- Continue usage is derived from `promptTokens` and `generatedTokens` records in `~/.continue/dev_data/**/tokensGenerated.jsonl`; records without timestamps use the source file's modification date.
- Vercel FX usage is derived from local generation facts in `~/.fx/usage.jsonl`. On Windows, Slopmeter also scans every registered WSL2 distribution for its own `~/.fx/usage.jsonl`.
- Warp usage is derived from aggregate `warp_tokens` and `byok_tokens` entries in the local Warp `agent_conversations` SQLite table. Warp does not persist an input/output split, so the aggregate is kept as the total and input-compatible usage count.
- If provider flags are passed, `slopmeter` only loads those providers and only prints availability for those providers.
- If no provider flags are passed, the CLI loads all providers and prints availability for all providers.
- If explicit provider flags are passed and any requested provider has no data, the command exits with an error.
- If no provider flags are passed and no provider has data, the command exits with an error.

GitHub Copilot is intentionally not supported. Its documented usage surfaces are organization/enterprise administration APIs that expose request and activity metrics, not the local prompt/input/output token telemetry used by `slopmeter`. Supporting it would require account credentials and external API access while producing numbers that are not comparable with the other providers. GitHub's reports also have limited historical retention, so Copilot cannot provide the same local and all-time history behavior. See the [Copilot usage metrics API](https://docs.github.com/rest/copilot/copilot-usage-metrics) and [user activity metrics](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/review-activity/review-user-activity-data).

## Environment knobs

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
- `CLINE_CONFIG_DIR`: override one or more comma-separated VS Code `User` data directories used for Cline task discovery. Defaults to Code, Code Insiders, and VSCodium user-data roots.
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
- `TRAE_SQLCIPHER_KEY`: 64-character raw hex key to decrypt Trae's SQLCipher database (`ModularData/ai-agent/database.db`) on the fly.
- `TRAE_CONFIG_DIR`: override the Trae root data directory used for database discovery.
- `WARP_DATABASE_PATH`: override the Warp `warp.sqlite` database path.
- `SLOPMETER_FILE_PROCESS_CONCURRENCY`: positive integer file-processing limit for Claude Code, Codex, and Freebuff usage files. Default: `16`.
- `SLOPMETER_MAX_JSONL_RECORD_BYTES`: byte cap for Claude Code and Codex JSONL records, Freebuff chat JSON documents, OpenCode JSON documents, and OpenCode SQLite `message.data` payloads. Default: `67108864` (`64 MB`).


## JSONL oversized-record behavior

- Claude Code and Codex now share the same bounded JSONL record splitter and do not materialize whole files in memory.
- Oversized Claude Code JSONL records fail the affected file with a clear error that names the file, line number, byte cap, and `SLOPMETER_MAX_JSONL_RECORD_BYTES`.
- OpenCode legacy JSON message files use a bounded JSON document reader before `JSON.parse`.
- OpenCode SQLite `message.data` payloads use the same byte cap before `JSON.parse`.
- Oversized OpenCode JSON documents and SQLite message payloads fail clearly with the source path or row label, byte cap, and `SLOPMETER_MAX_JSONL_RECORD_BYTES`.
- Codex now streams JSONL records and only parses records that affect usage aggregation.
- Oversized irrelevant Codex records are skipped and summarized with a warning after processing.
- Oversized relevant Codex records fail the affected file with a clear error that names the file, line number, byte cap, and `SLOPMETER_MAX_JSONL_RECORD_BYTES`.
- Pi Coding Agent session logs are streamed and only assistant messages are parsed for usage aggregation.

## Data locations


- Claude Code: `$CLAUDE_CONFIG_DIR/*/projects` (comma-separated dirs) or defaults `~/.config/claude/projects` and `~/.claude/projects`
- Cline: `$CLINE_CONFIG_DIR/globalStorage/saoudrizwan.claude-dev/tasks/**/ui_messages.json`, or the VS Code `User` global-storage roots for Code, Code Insiders, and VSCodium
- Codex: `$CODEX_HOME/sessions` or `~/.codex/sessions`
- Antigravity: discovers local Antigravity language server metadata from `%APPDATA%/Antigravity/logs/**/Antigravity.log` (Windows), `~/Library/Application Support/Antigravity/logs/**/Antigravity.log` (macOS), or `~/.config/Antigravity/logs/**/Antigravity.log` (Linux), then reads usage from local LS protobuf RPC endpoints
- Freebuff: `~/.config/manicode/projects/**/chats/**/chat-messages.json`, plus `manicode-dev` and `manicode-staging`; when those files are absent, the running Desktop orchestrator's local `/api/projects` and `/api/thread/:id` endpoints are used; override file roots with `FREEBUFF_CONFIG_DIR` or `FREEBUFF_DATA_DIR`, and the API with `FREEBUFF_API_URL`
- Freebuff and paid Codebuff can share the `manicode` root. If both are installed and must be separated, point `FREEBUFF_CONFIG_DIR` at an isolated Freebuff root.
- Cline usage is derived from `api_req_started` records in each local VS Code Cline task's `ui_messages.json`. Cline's local history does not reliably retain the model for each request, so those tokens are grouped under `Cline`.
- Continue: `$CONTINUE_CONFIG_DIR/dev_data/**/tokensGenerated.jsonl` or `~/.continue/dev_data/**/tokensGenerated.jsonl`
- Vercel FX: `$FX_HOME/usage.jsonl` or `~/.fx/usage.jsonl`; on Windows, each registered WSL2 distribution's `~/.fx/usage.jsonl` is also checked
- Windsurf: discovers running or installed Windsurf language servers and reads Cascade trajectory usage from Codeium protobuf RPCs; when Windsurf is closed, a discovered language server may be started briefly for a read-only scan
- Cursor: reads `cursorAuth/accessToken` and `cursorAuth/refreshToken` from `$CURSOR_STATE_DB_PATH`, `$CURSOR_CONFIG_DIR/User/globalStorage/state.vscdb`, `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (macOS), `%APPDATA%/Cursor/User/globalStorage/state.vscdb` (Windows), or `~/.config/Cursor/User/globalStorage/state.vscdb` (Linux), then loads usage from Cursor's CSV export endpoint
- Gemini CLI: `$GEMINI_CONFIG_DIR/tmp/**/chats/session-*.json` or `~/.gemini/tmp/**/chats/session-*.json`
- `Open Code`: prefers `$OPENCODE_DATA_DIR/opencode.db` or `~/.local/share/opencode/opencode.db`, and falls back to `$OPENCODE_DATA_DIR/storage/message` or `~/.local/share/opencode/storage/message`
- `Pi Coding Agent`: `$PI_CODING_AGENT_DIR/sessions` or `~/.pi/agent/sessions`
- `Trae`: `$TRAE_DATABASE_PATH`, auto-discovered `database_decrypted.db` in `%APPDATA%/Trae/ModularData/ai-agent/` (or `TRAE SOLO`, macOS `~/Library/Application Support/Trae`, Linux `~/.config/Trae`), or `database.db` when `TRAE_SQLCIPHER_KEY` is provided
- `Warp`: `$WARP_DATABASE_PATH` or `%LOCALAPPDATA%/warp/Warp/data/warp.sqlite` (macOS and Linux platform defaults are also checked)
