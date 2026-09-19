const narrowCharacters = new Set(" .,:;!|'`ijlrtfI");
const wideCharacters = new Set("MW@#%&");

/**
 * Estimate the width of text in the system UI font used by the SVG output.
 *
 * SVG text is rendered by the consumer, so the CLI cannot use a browser text
 * measurement API here. The estimate intentionally errs slightly wide so a
 * title gets the stacked layout before it can collide with neighbouring
 * metrics.
 */
export function estimateTextWidth(value: string, fontSize: number) {
  let width = 0;

  for (const character of value) {
    if (narrowCharacters.has(character)) {
      width += fontSize * 0.28;
    } else if (wideCharacters.has(character)) {
      width += fontSize * 0.82;
    } else if (character === "/") {
      width += fontSize * 0.36;
    } else if (/\d/.test(character)) {
      width += fontSize * 0.56;
    } else if (/[A-Z]/.test(character)) {
      width += fontSize * 0.65;
    } else {
      width += fontSize * 0.52;
    }
  }

  return width;
}

function splitLongPart(value: string, maxWidth: number, fontSize: number) {
  const lines: string[] = [];
  let current = "";

  for (const character of value) {
    const candidate = `${current}${character}`;

    if (current && estimateTextWidth(candidate, fontSize) > maxWidth) {
      lines.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

/**
 * Wrap provider-style titles at the existing slash separators. Long single
 * parts fall back to character wrapping so the result always stays in the
 * requested width.
 */
export function wrapText(value: string, maxWidth: number, fontSize: number) {
  const trimmed = value.trim();

  if (!trimmed) {
    return [];
  }

  const separatedParts = trimmed.includes(" / ")
    ? trimmed.split(" / ")
    : trimmed.split(/\s+/);
  const separator = trimmed.includes(" / ") ? " / " : " ";
  const lines: string[] = [];
  let current = "";

  for (const part of separatedParts) {
    const candidate = current ? `${current}${separator}${part}` : part;

    if (!current || estimateTextWidth(candidate, fontSize) <= maxWidth) {
      if (estimateTextWidth(part, fontSize) <= maxWidth) {
        current = candidate;
        continue;
      }
    }

    if (current) {
      lines.push(current);
      current = "";
    }

    const partLines = splitLongPart(part, maxWidth, fontSize);

    if (partLines.length > 1) {
      lines.push(...partLines.slice(0, -1));
    }

    current = partLines.at(-1) ?? "";
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}
