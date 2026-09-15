import type { SVGBuilderInstance } from "svg-builder";
import type { DailyUsage, ModelTableEntry } from "./interfaces";

export type { ModelTableEntry };

export interface ModelTableSummary {
  models: ModelTableEntry[];
  totalInput: number;
  totalOutput: number;
  totalCacheInput: number;
  totalCacheOutput: number;
  grandTotal: number;
}

const numberFormatter = new Intl.NumberFormat("en-US");
const percentFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function aggregateModelsTable(daily: DailyUsage[]): ModelTableSummary {
  const modelMap = new Map<
    string,
    {
      input: number;
      output: number;
      cacheInput: number;
      cacheOutput: number;
      total: number;
    }
  >();

  for (const day of daily) {
    for (const model of day.breakdown) {
      const existing = modelMap.get(model.name) ?? {
        input: 0,
        output: 0,
        cacheInput: 0,
        cacheOutput: 0,
        total: 0,
      };

      existing.input += model.tokens.input;
      existing.output += model.tokens.output;
      existing.cacheInput += model.tokens.cache.input;
      existing.cacheOutput += model.tokens.cache.output;
      existing.total += model.tokens.total;
      modelMap.set(model.name, existing);
    }
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheInput = 0;
  let totalCacheOutput = 0;
  let grandTotal = 0;

  for (const stats of modelMap.values()) {
    totalInput += stats.input;
    totalOutput += stats.output;
    totalCacheInput += stats.cacheInput;
    totalCacheOutput += stats.cacheOutput;
    grandTotal += stats.total;
  }

  const models: ModelTableEntry[] = [];

  for (const [name, stats] of modelMap.entries()) {
    const share = grandTotal > 0 ? (stats.total / grandTotal) * 100 : 0;

    models.push({
      name,
      input: stats.input,
      output: stats.output,
      cache: {
        input: stats.cacheInput,
        output: stats.cacheOutput,
      },
      total: stats.total,
      share,
    });
  }

  models.sort((a, b) => b.total - a.total);

  return {
    models,
    totalInput,
    totalOutput,
    totalCacheInput,
    totalCacheOutput,
    grandTotal,
  };
}

export function formatCompactTokens(value: number): string {
  const units = [
    { size: 1_000_000_000_000, suffix: "T" },
    { size: 1_000_000_000, suffix: "B" },
    { size: 1_000_000, suffix: "M" },
    { size: 1_000, suffix: "K" },
  ];

  for (const unit of units) {
    if (value >= unit.size) {
      const scaled = value / unit.size;
      const precision = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      const compact = scaled
        .toFixed(precision)
        .replace(/\.0+$/, "")
        .replace(/(\.\d*[1-9])0+$/, "$1");

      return `${compact}${unit.suffix}`;
    }
  }

  return numberFormatter.format(value);
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(maxLength - 3, 1))}...`;
}

export interface DrawModelsTableCardOptions {
  x: number;
  y: number;
  width: number;
  daily: DailyUsage[];
  colorMode: "light" | "dark";
  accentColor: string;
  fontFamily: string;
  providerTitle: string;
}

const CARD_PADDING_X = 16;
const CARD_PADDING_TOP = 16;
const CARD_PADDING_BOTTOM = 14;
const HEADER_HEIGHT = 38;
const TABLE_HEADER_HEIGHT = 20;
const ROW_HEIGHT = 22;
const FOOTER_TOTAL_HEIGHT = 26;

export function getModelsCardHeight(modelCount: number): number {
  if (modelCount === 0) {
    return 0;
  }

  return (
    CARD_PADDING_TOP +
    HEADER_HEIGHT +
    TABLE_HEADER_HEIGHT +
    modelCount * ROW_HEIGHT +
    FOOTER_TOTAL_HEIGHT +
    CARD_PADDING_BOTTOM
  );
}

export function drawModelsTableCard(
  svg: SVGBuilderInstance,
  options: DrawModelsTableCardOptions,
): SVGBuilderInstance {
  const {
    x,
    y,
    width,
    daily,
    colorMode,
    accentColor,
    fontFamily,
    providerTitle,
  } = options;

  const summary = aggregateModelsTable(daily);

  if (summary.models.length === 0) {
    return svg;
  }

  const cardHeight = getModelsCardHeight(summary.models.length);
  const isDark = colorMode === "dark";

  const cardBg = isDark ? "#18181b" : "#f8fafc";
  const cardBorder = isDark ? "#27272a" : "#e2e8f0";
  const textPrimary = isDark ? "#fafafa" : "#0f172a";
  const textMuted = isDark ? "#a1a1aa" : "#64748b";
  const rowDivider = isDark ? "#27272a" : "#f1f5f9";
  const footerDivider = isDark ? "#3f3f46" : "#cbd5e1";
  const barBg = isDark ? "#27272a" : "#e2e8f0";

  // Card background container
  svg = svg.rect({
    x,
    y,
    width,
    height: cardHeight,
    rx: 8,
    ry: 8,
    fill: cardBg,
    stroke: cardBorder,
    "stroke-width": 1,
  });

  // Card Header Caption
  svg = svg.text(
    {
      x: x + CARD_PADDING_X,
      y: y + CARD_PADDING_TOP,
      fill: textMuted,
      "font-size": 9,
      "font-weight": 600,
      "letter-spacing": "0.05em",
      "dominant-baseline": "hanging",
      "font-family": fontFamily,
    },
    "MODEL BREAKDOWN",
  );

  // Card Title + Summary Subtitle
  const summaryLine = `${summary.models.length} models • ${formatCompactTokens(summary.grandTotal)} tokens total`;

  svg = svg.text(
    {
      x: x + CARD_PADDING_X,
      y: y + CARD_PADDING_TOP + 14,
      "dominant-baseline": "hanging",
      "font-family": fontFamily,
    },
    `<tspan fill="${textPrimary}" font-size="14" font-weight="600">${escapeXml(providerTitle)} Models</tspan><tspan dx="10" fill="${textMuted}" font-size="11" font-weight="400">${escapeXml(summaryLine)}</tspan>`,
  );

  // Column X Coordinates (Right-aligned numbers for perfect numerical readability)
  const leftX = x + CARD_PADDING_X;
  const tableRightX = x + width - CARD_PADDING_X;
  const inputX = leftX + 245;
  const outputX = inputX + 75;
  const cacheX = outputX + 85;
  const totalX = cacheX + 85;
  const shareX = tableRightX;

  const tableHeaderY = y + CARD_PADDING_TOP + HEADER_HEIGHT;

  // Table Headers
  const headerProps = {
    y: tableHeaderY,
    fill: textMuted,
    "font-size": 9,
    "font-weight": 600,
    "letter-spacing": "0.05em",
    "dominant-baseline": "hanging",
    "font-family": fontFamily,
  };

  svg = svg
    .text({ ...headerProps, x: leftX, "text-anchor": "start" }, "MODEL")
    .text({ ...headerProps, x: inputX, "text-anchor": "end" }, "INPUT")
    .text({ ...headerProps, x: outputX, "text-anchor": "end" }, "OUTPUT")
    .text({ ...headerProps, x: cacheX, "text-anchor": "end" }, "CACHE READ")
    .text({ ...headerProps, x: totalX, "text-anchor": "end" }, "TOTAL")
    .text({ ...headerProps, x: shareX, "text-anchor": "end" }, "SHARE");

  // Header bottom divider line
  svg = svg.line({
    x1: leftX,
    y1: tableHeaderY + 14,
    x2: tableRightX,
    y2: tableHeaderY + 14,
    stroke: cardBorder,
    "stroke-width": 1,
  });

  // Table Data Rows
  let currentY = tableHeaderY + TABLE_HEADER_HEIGHT;

  for (const model of summary.models) {
    const rowMiddleY = currentY + ROW_HEIGHT / 2;

    // Row divider
    svg = svg.line({
      x1: leftX,
      y1: currentY + ROW_HEIGHT,
      x2: tableRightX,
      y2: currentY + ROW_HEIGHT,
      stroke: rowDivider,
      "stroke-width": 1,
    });

    // Model name
    svg = svg.text(
      {
        x: leftX,
        y: rowMiddleY,
        fill: textPrimary,
        "font-size": 11,
        "font-weight": 500,
        "dominant-baseline": "central",
        "font-family": fontFamily,
      },
      escapeXml(truncateText(model.name, 28)),
    );

    // Input tokens
    svg = svg.text(
      {
        x: inputX,
        y: rowMiddleY,
        fill: textMuted,
        "font-size": 11,
        "text-anchor": "end",
        "dominant-baseline": "central",
        "font-family": fontFamily,
      },
      formatCompactTokens(model.input),
    );

    // Output tokens
    svg = svg.text(
      {
        x: outputX,
        y: rowMiddleY,
        fill: textMuted,
        "font-size": 11,
        "text-anchor": "end",
        "dominant-baseline": "central",
        "font-family": fontFamily,
      },
      formatCompactTokens(model.output),
    );

    // Cache read tokens
    svg = svg.text(
      {
        x: cacheX,
        y: rowMiddleY,
        fill: textMuted,
        "font-size": 11,
        "text-anchor": "end",
        "dominant-baseline": "central",
        "font-family": fontFamily,
      },
      formatCompactTokens(model.cache.input),
    );

    // Total tokens
    svg = svg.text(
      {
        x: totalX,
        y: rowMiddleY,
        fill: textPrimary,
        "font-size": 11,
        "font-weight": 600,
        "text-anchor": "end",
        "dominant-baseline": "central",
        "font-family": fontFamily,
      },
      formatCompactTokens(model.total),
    );

    // Mini share bar + percentage text
    const shareText = `${percentFormatter.format(model.share)}%`;
    const maxBarWidth = 44;
    const barWidth = Math.max(1, Math.round((model.share / 100) * maxBarWidth));
    const barX = tableRightX - 85;
    const barY = rowMiddleY - 2.5;

    // Track background
    svg = svg.rect({
      x: barX,
      y: barY,
      width: maxBarWidth,
      height: 5,
      rx: 2.5,
      ry: 2.5,
      fill: barBg,
    });

    // Fill bar
    svg = svg.rect({
      x: barX,
      y: barY,
      width: barWidth,
      height: 5,
      rx: 2.5,
      ry: 2.5,
      fill: accentColor,
    });

    // Percentage
    svg = svg.text(
      {
        x: tableRightX,
        y: rowMiddleY,
        fill: textMuted,
        "font-size": 10,
        "text-anchor": "end",
        "dominant-baseline": "central",
        "font-family": fontFamily,
      },
      shareText,
    );

    currentY += ROW_HEIGHT;
  }

  // Footer Total Row
  const footerY = currentY + FOOTER_TOTAL_HEIGHT / 2 + 2;

  // Strong top border for totals
  svg = svg.line({
    x1: leftX,
    y1: currentY + 2,
    x2: tableRightX,
    y2: currentY + 2,
    stroke: footerDivider,
    "stroke-width": 1.5,
  });

  // Total label
  svg = svg.text(
    {
      x: leftX,
      y: footerY,
      fill: textPrimary,
      "font-size": 11,
      "font-weight": 700,
      "dominant-baseline": "central",
      "font-family": fontFamily,
    },
    "Total",
  );

  // Total Input
  svg = svg.text(
    {
      x: inputX,
      y: footerY,
      fill: textPrimary,
      "font-size": 11,
      "font-weight": 600,
      "text-anchor": "end",
      "dominant-baseline": "central",
      "font-family": fontFamily,
    },
    formatCompactTokens(summary.totalInput),
  );

  // Total Output
  svg = svg.text(
    {
      x: outputX,
      y: footerY,
      fill: textPrimary,
      "font-size": 11,
      "font-weight": 600,
      "text-anchor": "end",
      "dominant-baseline": "central",
      "font-family": fontFamily,
    },
    formatCompactTokens(summary.totalOutput),
  );

  // Total Cache
  svg = svg.text(
    {
      x: cacheX,
      y: footerY,
      fill: textPrimary,
      "font-size": 11,
      "font-weight": 600,
      "text-anchor": "end",
      "dominant-baseline": "central",
      "font-family": fontFamily,
    },
    formatCompactTokens(summary.totalCacheInput),
  );

  // Grand Total
  svg = svg.text(
    {
      x: totalX,
      y: footerY,
      fill: textPrimary,
      "font-size": 11,
      "font-weight": 700,
      "text-anchor": "end",
      "dominant-baseline": "central",
      "font-family": fontFamily,
    },
    formatCompactTokens(summary.grandTotal),
  );

  // Total share
  svg = svg.text(
    {
      x: tableRightX,
      y: footerY,
      fill: textPrimary,
      "font-size": 10,
      "font-weight": 600,
      "text-anchor": "end",
      "dominant-baseline": "central",
      "font-family": fontFamily,
    },
    "100.0%",
  );

  return svg;
}
