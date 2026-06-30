export interface LocalizationHint {
  path: string;
  line?: number;
  column?: number;
  symbol?: string;
  source: "python_traceback" | "js_stack" | "compiler" | "generic";
  confidence: number;
  raw: string;
  contextStart: number;
  contextEnd: number;
}

const IGNORED_PATH_PARTS = /(?:^|\/)(?:node_modules|\.venv|venv|site-packages|dist|build|coverage)(?:\/|$)/i;

export function extractLocalizationHints(output: string): LocalizationHint[] {
  const hints: LocalizationHint[] = [];
  const lines = output.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const python = line.match(/^File ["']([^"']+)["'], line (\d+)(?:, in ([\w$.<>-]+))?/);
    if (python?.[1] && python[2]) {
      addHint(hints, {
        path: python[1],
        line: Number(python[2]),
        ...(python[3] ? { symbol: python[3] } : {}),
        source: "python_traceback",
        confidence: 0.95,
        raw: line,
      });
      continue;
    }

    const jsStack = line.match(/^at\s+(?:(\S+)\s+\()?(.+?):(\d+):(\d+)\)?$/);
    if (jsStack?.[2] && jsStack[3]) {
      addHint(hints, {
        path: jsStack[2],
        line: Number(jsStack[3]),
        ...(jsStack[4] ? { column: Number(jsStack[4]) } : {}),
        ...(jsStack[1] ? { symbol: jsStack[1] } : {}),
        source: "js_stack",
        confidence: 0.9,
        raw: line,
      });
      continue;
    }

    const tsCompiler = line.match(/^(.+?)\((\d+),(\d+)\):\s+(?:error|warning)\b/i);
    if (tsCompiler?.[1] && tsCompiler[2]) {
      addHint(hints, {
        path: tsCompiler[1],
        line: Number(tsCompiler[2]),
        column: Number(tsCompiler[3] ?? 1),
        source: "compiler",
        confidence: 0.9,
        raw: line,
      });
      continue;
    }

    const generic = line.match(/((?:\.{0,2}\/)?[A-Za-z0-9_./\\-]+\.[A-Za-z0-9_+-]+):(\d+)(?::(\d+))?(?::|\s+-|\s|$)/);
    if (generic?.[1] && generic[2]) {
      addHint(hints, {
        path: generic[1],
        line: Number(generic[2]),
        ...(generic[3] ? { column: Number(generic[3]) } : {}),
        source: "generic",
        confidence: 0.75,
        raw: line,
      });
    }
  }

  return hints.sort((a, b) => b.confidence - a.confidence);
}

export function formatLocalizationHintsForFeedback(hints: LocalizationHint[], maxHints = 5): string[] {
  return hints.slice(0, maxHints).map((hint) => {
    const linePart = hint.line ? `line ${hint.line}` : "near the cited diagnostic";
    const symbolPart = hint.symbol ? `, symbol ${hint.symbol}` : "";
    return (
      `Localization hint: inspect ${hint.path} ${linePart}${symbolPart}. ` +
      `Use view_file with startLine=${hint.contextStart}, endLine=${hint.contextEnd}, then patch the smallest relevant region.`
    );
  });
}

function addHint(hints: LocalizationHint[], input: Omit<LocalizationHint, "path" | "contextStart" | "contextEnd"> & { path: string }): void {
  const normalizedPath = normalizeHintPath(input.path);
  if (!normalizedPath || IGNORED_PATH_PARTS.test(normalizedPath)) return;
  const line = input.line && Number.isFinite(input.line) && input.line > 0 ? Math.floor(input.line) : undefined;
  const contextStart = Math.max(1, (line ?? 1) - 20);
  const contextEnd = Math.max(contextStart, (line ?? contextStart) + 20);
  const key = `${normalizedPath}:${line ?? ""}:${input.column ?? ""}:${input.symbol ?? ""}`;
  if (hints.some((hint) => `${hint.path}:${hint.line ?? ""}:${hint.column ?? ""}:${hint.symbol ?? ""}` === key)) return;

  hints.push({
    path: normalizedPath,
    ...(line !== undefined ? { line } : {}),
    ...(input.column !== undefined && Number.isFinite(input.column) ? { column: Math.floor(input.column) } : {}),
    ...(input.symbol ? { symbol: input.symbol } : {}),
    source: input.source,
    confidence: input.confidence,
    raw: input.raw,
    contextStart,
    contextEnd,
  });
}

function normalizeHintPath(input: string): string | undefined {
  let value = input.trim().replace(/^file:\/\//, "").replace(/\\/g, "/");
  if (!value || value.startsWith("<") || value === "native" || value.includes("[as ")) return undefined;
  value = value.replace(/^\.\//, "");
  if (/^(?:node:|internal\/|webpack:\/\/)/i.test(value)) return undefined;
  return value;
}
