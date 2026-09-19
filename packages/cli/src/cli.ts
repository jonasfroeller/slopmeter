import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import ora, { type Ora } from "ora";
import ow from "ow";
import sharp from "sharp";
import { heatmapThemes, renderUsageHeatmapsSvg, type ColorMode } from "./graph";
import type {
  JsonExportPayload,
  JsonInsights,
  JsonModelUsage,
  JsonUsageSummary,
  ModelUsage,
  UsageSummary,
  UsageProviderId,
} from "./interfaces";
import { getDefaultOutputPath } from "./output-path";
import {
  sortProviderSummaries,
  type ProviderSortBy,
  type ProviderSortDirection,
  type ProviderSortOptions,
} from "./provider-sort";
import type { ProviderId } from "./providers";
import { formatLocalDate, loadEnv } from "./lib/utils";
import {
  aggregateUsage,
  defaultProviderIds,
  getProviderAvailability,
  mergeProviderUsage,
  providerIds,
  providerStatusLabel,
} from "./providers";

import { aggregateModelsTable } from "./models-card";
import {
  createPricingContext,
  getPricingMetadata,
  hasPricedCost,
  priceUsageSummary,
} from "./pricing";

type OutputFormat = "png" | "svg" | "json";
interface CliArgValues {
  output?: string;
  format?: string;
  currency?: string;
  pricing?: string;
  sort: ProviderSortBy;
  order: ProviderSortDirection;
  help: boolean;
  dark: boolean;
  models: boolean;
  all: boolean;
  antigravity: boolean;
  amp: boolean;
  claude: boolean;
  cline: boolean;
  codex: boolean;
  continue: boolean;
  cursor: boolean;
  fx: boolean;
  freebuff: boolean;
  gemini: boolean;
  kilo: boolean;
  opencode: boolean;
  ollama: boolean;
  pi: boolean;
  roo: boolean;
  trae: boolean;
  grok: boolean;
  windsurf: boolean;
  warp: boolean;
}

const PNG_BASE_WIDTH = 1000;
const PNG_SCALE = 4;
const PNG_RENDER_WIDTH = PNG_BASE_WIDTH * PNG_SCALE;
const PNG_MAX_DIMENSION = 32760;
const SVG_RENDER_DENSITY = 192;
const JSON_EXPORT_VERSION = "2026-09-19";

const HELP_TEXT = `slopmeter

Generate rolling 1-year usage heatmap image(s) (today is the latest day).

Usage:
  slopmeter [--all] [--sort tokens|name] [--order asc|desc] [--currency auto|EUR] [--pricing ./pricing.json] [--antigravity] [--amp] [--claude] [--cline] [--codex] [--continue] [--cursor] [--fx] [--freebuff] [--gemini] [--grok] [--kilo] [--opencode] [--ollama] [--pi] [--roo] [--trae] [--windsurf] [--warp] [--models] [--dark] [--format png|svg|json] [--output ./heatmap-last-year.png]

Options:
  --all                       Render one merged graph for all providers
  --sort <tokens|name>        Sort provider sections by total tokens or name (default: tokens)
  --order <asc|desc>          Sort direction (default: desc)
  --currency <auto|ISO-4217>  Display estimated costs in this currency (default: auto)
  --pricing <path>            Load custom model pricing and FX overrides from JSON
  --antigravity               Render Antigravity graph
  --amp                       Render Amp graph
  --claude                    Render Claude Code graph
  --cline                     Render Cline graph
  --codex                     Render Codex graph
  --continue                  Render Continue graph
  --cursor                    Render Cursor graph
  --fx                        Render Vercel FX graph
  --freebuff                  Render Freebuff graph
  --gemini                    Render Gemini CLI graph
  --grok                      Render Grok graph
  --kilo                      Render Kilo Code graph
  --opencode                  Render Open Code graph
  --ollama                    Render Ollama graph
  --pi                        Render Pi Coding Agent graph
  --roo                       Render Roo Code graph
  --trae                      Render Trae graph
  --windsurf                  Render Windsurf graph
  --warp                      Render Warp graph
  -m, --models                Include a detailed card with all models listed in a table
  --dark                      Render with the dark theme
  -f, --format                Output format: png, svg, or json (default: png)
  -o, --output                Output file path (default: ./heatmap-last-year_<timestamp>.png)
  -h, --help                  Show this help
`;

function printHelp() {
  process.stdout.write(HELP_TEXT);
}

function validateArgs(values: unknown): asserts values is CliArgValues {
  ow(
    values,
    ow.object.exactShape({
      output: ow.optional.string.nonEmpty,
      format: ow.optional.string.nonEmpty,
      currency: ow.optional.string.nonEmpty,
      pricing: ow.optional.string.nonEmpty,
      sort: ow.string.oneOf(["name", "tokens"] as const),
      order: ow.string.oneOf(["asc", "desc"] as const),
      help: ow.boolean,
      dark: ow.boolean,
      models: ow.boolean,
      all: ow.boolean,
      antigravity: ow.boolean,
      amp: ow.boolean,
      claude: ow.boolean,
      cline: ow.boolean,
      codex: ow.boolean,
      continue: ow.boolean,
      cursor: ow.boolean,
      fx: ow.boolean,
      freebuff: ow.boolean,
      gemini: ow.boolean,
      kilo: ow.boolean,
      opencode: ow.boolean,
      ollama: ow.boolean,
      pi: ow.boolean,
      roo: ow.boolean,
      trae: ow.boolean,
      grok: ow.boolean,
      windsurf: ow.boolean,
      warp: ow.boolean,
    }),
  );
}

function inferFormat(
  formatArg: string | undefined,
  outputArg: string | undefined,
) {
  if (formatArg) {
    ow(formatArg, ow.string.oneOf(["png", "svg", "json"] as const));

    return formatArg;
  }

  if (outputArg) {
    const outputExtension = extname(outputArg).toLowerCase();

    if (outputExtension === ".svg") {
      return "svg" as const;
    }

    if (outputExtension === ".json") {
      return "json" as const;
    }
  }

  return "png" as const;
}

async function writeOutputImage(
  outputPath: string,
  format: Exclude<OutputFormat, "json">,
  svg: string,
  background: string,
) {
  if (format === "svg") {
    writeFileSync(outputPath, svg, "utf8");

    return;
  }

  const svgRoot = svg.match(/<svg\b[^>]*>/)?.[0] ?? "";
  const svgWidth = Number(svgRoot.match(/\bwidth="([\d.]+)"/)?.[1]);
  const svgHeight = Number(svgRoot.match(/\bheight="([\d.]+)"/)?.[1]);
  const svgMaxDimension = Math.max(svgWidth, svgHeight);
  const density = Number.isFinite(svgMaxDimension)
    ? Math.max(
        1,
        Math.min(
          SVG_RENDER_DENSITY,
          Math.floor((PNG_MAX_DIMENSION * 72) / svgMaxDimension),
        ),
      )
    : SVG_RENDER_DENSITY;

  const pngBuffer = await sharp(Buffer.from(svg), { density })
    .resize({
      width: PNG_RENDER_WIDTH,
      height: PNG_MAX_DIMENSION,
      fit: "inside",
    })
    .flatten({ background })
    .png()
    .toBuffer();

  writeFileSync(outputPath, pngBuffer);
}

function writeOutputJson(outputPath: string, payload: JsonExportPayload) {
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function toJsonModelUsage(model: ModelUsage): JsonModelUsage {
  return {
    name: model.name,
    tokens: model.tokens,
    ...(model.cost ? { cost: model.cost } : {}),
  };
}

function toJsonInsights(
  insights: UsageSummary["insights"],
): JsonInsights | undefined {
  if (!insights) {
    return undefined;
  }

  return {
    streaks: insights.streaks,
    ...(insights.mostUsedModel
      ? { mostUsedModel: toJsonModelUsage(insights.mostUsedModel) }
      : {}),
    ...(insights.recentMostUsedModel
      ? { recentMostUsedModel: toJsonModelUsage(insights.recentMostUsedModel) }
      : {}),
  };
}

function toJsonUsageSummary(
  summary: UsageSummary,
  includeModels = false,
): JsonUsageSummary {
  const models = includeModels
    ? aggregateModelsTable(summary.daily).models
    : undefined;

  return {
    provider: summary.provider,
    insights: toJsonInsights(summary.insights),
    ...(models && models.length > 0 ? { models } : {}),
    daily: summary.daily.map((row) => ({
      date: formatLocalDate(row.date),
      input: row.input,
      output: row.output,
      cache: row.cache,
      total: row.total,
      displayValue: row.displayValue,
      ...(row.cost ? { cost: row.cost } : {}),
      breakdown: row.breakdown.map(toJsonModelUsage),
    })),
  };
}

function getDateWindow() {
  const start = new Date();

  start.setHours(0, 0, 0, 0);
  start.setFullYear(start.getFullYear() - 1);

  const end = new Date();

  end.setHours(23, 59, 59, 999);

  return { start, end };
}

function printProviderAvailability(
  availabilityByProvider: Record<ProviderId, boolean>,
  providers: ProviderId[],
) {
  for (const provider of providers) {
    const status = availabilityByProvider[provider]
      ? "available"
      : "not available";

    process.stdout.write(`${providerStatusLabel[provider]} ${status}\n`);
  }
}

function getRequestedProviders(values: CliArgValues) {
  return providerIds.filter((id) => values[id]);
}

function getMergedNoDataMessage() {
  return "No usage data found for Antigravity, Amp, Claude Code, Cline, Codex, Continue, Cursor, Vercel FX, Freebuff, Gemini CLI, Grok, Kilo Code, Open Code, Ollama, Pi Coding Agent, Roo Code, Trae, Windsurf, or Warp.";
}

function getRequestedMissingProvidersMessage(missing: ProviderId[]) {
  return `Requested provider data not found: ${missing.map((provider) => providerStatusLabel[provider]).join(", ")}`;
}

function getNoDataMessage() {
  return getMergedNoDataMessage();
}

function getOutputProviders(
  values: CliArgValues,
  availabilityByProvider: Record<ProviderId, boolean>,
  rowsByProvider: Record<ProviderId, UsageSummary | null>,
  end: Date,
) {
  if (!values.all) {
    return selectProvidersToRender(
      availabilityByProvider,
      rowsByProvider,
      getRequestedProviders(values),
    );
  }

  const merged = mergeProviderUsage(rowsByProvider, end);

  if (!merged) {
    throw new Error(getMergedNoDataMessage());
  }

  return [merged];
}

function getDefaultOutputProviderIds(
  rowsByProvider: Record<ProviderId, UsageSummary | null>,
) {
  const selected: ProviderId[] = [];
  const fallbackProviders = providerIds.filter(
    (provider) => !defaultProviderIds.includes(provider),
  );

  for (const provider of [...defaultProviderIds, ...fallbackProviders]) {
    if (!rowsByProvider[provider] || selected.includes(provider)) {
      continue;
    }

    selected.push(provider);

    if (selected.length === 3) {
      return selected;
    }
  }

  return selected;
}

function getMergedProviderTitle(
  rowsByProvider: Record<ProviderId, UsageSummary | null>,
  sortOptions: ProviderSortOptions,
) {
  const summaries = providerIds
    .map((provider) => rowsByProvider[provider])
    .filter((summary): summary is UsageSummary => summary !== null);

  return sortProviderSummaries(summaries, sortOptions)
    .map((summary) => heatmapThemes[summary.provider].title)
    .join(" / ");
}

function selectProvidersToRender(
  availabilityByProvider: Record<ProviderId, boolean>,
  rowsByProvider: Record<ProviderId, UsageSummary | null>,
  requested: ProviderId[],
) {
  const defaultProviders = getDefaultOutputProviderIds(rowsByProvider);
  const providersToRender =
    requested.length > 0
      ? requested.filter((provider) => rowsByProvider[provider])
      : defaultProviders.filter((provider) => rowsByProvider[provider]);

  if (requested.length > 0 && providersToRender.length < requested.length) {
    const missing = requested.filter((provider) => !rowsByProvider[provider]);

    throw new Error(getRequestedMissingProvidersMessage(missing));
  }

  if (providersToRender.length === 0) {
    const availableProviders = providerIds.filter(
      (provider) => availabilityByProvider[provider],
    );

    if (availableProviders.length > 0) {
      const availableLabels = availableProviders
        .map((provider) => providerStatusLabel[provider])
        .join(", ");
      const defaultLabels = defaultProviderIds
        .map((provider) => providerStatusLabel[provider])
        .join(", ");

      throw new Error(
        `No usage data found for available providers (${availableLabels}). Preferred order is ${defaultLabels}. Use --all or specify providers explicitly.`,
      );
    }

    throw new Error(getNoDataMessage());
  }

  return providersToRender.map((provider) => rowsByProvider[provider]!);
}

function printRunSummary(
  outputPath: string,
  format: OutputFormat,
  colorMode: ColorMode,
  startDate: Date,
  endDate: Date,
  rendered: UsageProviderId[],
) {
  process.stdout.write(
    `${JSON.stringify(
      {
        output: outputPath,
        format,
        colorMode,
        startDate: formatLocalDate(startDate),
        endDate: formatLocalDate(endDate),
        rendered,
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  loadEnv();
  let spinner: Ora | undefined;

  const parsed = parseArgs({
    options: {
      output: { type: "string", short: "o" },
      format: { type: "string", short: "f" },
      currency: { type: "string" },
      pricing: { type: "string" },
      sort: { type: "string", default: "tokens" },
      order: { type: "string", default: "desc" },
      help: { type: "boolean", short: "h", default: false },
      dark: { type: "boolean", default: false },
      models: { type: "boolean", short: "m", default: false },
      all: { type: "boolean", default: false },
      antigravity: { type: "boolean", default: false },
      amp: { type: "boolean", default: false },
      claude: { type: "boolean", default: false },
      cline: { type: "boolean", default: false },
      codex: { type: "boolean", default: false },
      continue: { type: "boolean", default: false },
      cursor: { type: "boolean", default: false },
      fx: { type: "boolean", default: false },
      freebuff: { type: "boolean", default: false },
      gemini: { type: "boolean", default: false },
      kilo: { type: "boolean", default: false },
      opencode: { type: "boolean", default: false },
      ollama: { type: "boolean", default: false },
      pi: { type: "boolean", default: false },
      roo: { type: "boolean", default: false },
      trae: { type: "boolean", default: false },
      grok: { type: "boolean", default: false },
      windsurf: { type: "boolean", default: false },
      warp: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  validateArgs(parsed.values);

  const { values } = parsed;

  if (values.help) {
    printHelp();

    return;
  }

  try {
    spinner = ora({
      text: "Analyzing usage data...",
      spinner: "dots",
    }).start();

    const { start, end } = getDateWindow();
    const colorMode: ColorMode = values.dark ? "dark" : "light";
    const format = inferFormat(values.format, values.output);
    const pricingContext = createPricingContext(values.currency, values.pricing);
    const requestedProviders = values.all
      ? providerIds
      : getRequestedProviders(values);
    const inspectedProviders =
      requestedProviders.length > 0 ? requestedProviders : providerIds;
    const availabilityByProvider =
      await getProviderAvailability(inspectedProviders);
    const { rowsByProvider: rawRowsByProvider, warnings } = await aggregateUsage({
      start,
      end,
      requestedProviders,
    });

    const rowsByProvider = { ...rawRowsByProvider };

    for (const provider of providerIds) {
      const summary = rowsByProvider[provider];

      if (summary) {
        rowsByProvider[provider] = priceUsageSummary(summary, pricingContext);
      }
    }

    spinner.stop();

    for (const warning of warnings) {
      process.stderr.write(`${warning}\n`);
    }

    printProviderAvailability(availabilityByProvider, inspectedProviders);

    const sortOptions: ProviderSortOptions = {
      by: values.sort,
      direction: values.order,
    };
    const exportProviders = sortProviderSummaries(
      getOutputProviders(values, availabilityByProvider, rowsByProvider, end),
      sortOptions,
    );

    const outputPath = resolve(
      values.output ?? getDefaultOutputPath(values, format),
    );

    mkdirSync(dirname(outputPath), { recursive: true });

    if (format === "json") {
      spinner.start("Preparing JSON export...");

      const payload: JsonExportPayload = {
        version: JSON_EXPORT_VERSION,
        start: formatLocalDate(start),
        end: formatLocalDate(end),
        pricing: getPricingMetadata(pricingContext),
        providers: exportProviders.map((provider) =>
          toJsonUsageSummary(provider, values.models),
        ),
      };

      spinner.text = "Writing output file...";
      writeOutputJson(outputPath, payload);
    } else {
      spinner.start("Rendering heatmaps...");

      const svg = renderUsageHeatmapsSvg({
        startDate: start,
        endDate: end,
        colorMode,
        includeModelsCard: values.models,
        sections: exportProviders.map(({ provider, daily, insights }) => ({
          daily,
          insights,
          pricing: pricingContext.metadata,
          showCost: hasPricedCost({
            provider,
            daily,
            insights,
            pricing: pricingContext.metadata,
          }),
          title:
            provider === "all"
              ? getMergedProviderTitle(rowsByProvider, sortOptions)
              : heatmapThemes[provider].title,
          titleCaption: heatmapThemes[provider].titleCaption,
          colors: heatmapThemes[provider].colors,
        })),
      });
      const background = colorMode === "dark" ? "#171717" : "#ffffff";

      spinner.text = "Writing output file...";
      await writeOutputImage(outputPath, format, svg, background);
    }

    spinner.succeed("Analysis complete");

    printRunSummary(
      outputPath,
      format,
      colorMode,
      start,
      end,
      exportProviders.map(({ provider }) => provider),
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (spinner) {
      spinner.fail(`Failed: ${message}`);
    } else {
      process.stderr.write(`${message}\n`);
    }

    process.exitCode = 1;
  }
}

void main();
