export interface SemanticFailureSignal {
  reason: string;
  line: string;
}

export function detectSemanticFailureText(text: string): SemanticFailureSignal | undefined {
  const rawLines = text.split(/\r?\n/).filter((line) => line.trim());
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const normalized = line.replace(/\s+/g, " ").trim();
    if (!normalized || isBenignFailureCountLine(normalized)) continue;
    for (const rule of semanticFailureRules) {
      if (rule.pattern.test(normalized)) {
        return { reason: rule.reason, line: normalized.slice(0, 500) };
      }
    }
  }
  return detectContradictoryNumericCounts(lines) ?? detectStructuredOutputFormattingFailure(rawLines);
}

const semanticFailureRules: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(?:match|matched|matches)\s*[:=]\s*(?:false|no)\b/i, reason: "explicit match=false output" },
  { pattern: /\b(?:ok|success|successful|passed)\s*[:=]\s*(?:false|no)\b/i, reason: "explicit success=false output" },
  { pattern: /["']?(?:status|result|outcome)["']?\s*:\s*["']?(?:fail|failed|failure|error)["']?/i, reason: "explicit failed status output" },
  { pattern: /\b(?:status|result|outcome)\s*[:=]\s*(?:fail|failed|failure|error)\b/i, reason: "explicit failed status output" },
  { pattern: /\bAssertionError\b|\bassertion failed\b|\bassert failed\b/i, reason: "assertion failure output" },
  { pattern: /\bTraceback \(most recent call last\):/i, reason: "runtime traceback output" },
  { pattern: /\b(?:Expected|expected)\b.*\b(?:Actual|actual|Received|received|Got|got|but got)\b/i, reason: "expected/actual mismatch output" },
  { pattern: /\b(?:hash|content|output|value|result|schema)\b.*\b(?:mismatch|does not match|differs|incorrect|wrong)\b/i, reason: "artifact mismatch output" },
  { pattern: /^(?:=+\s*)?FAILURES?(?:\s*=+)?$/i, reason: "test failure section output" },
  { pattern: /\b[1-9]\d*\s+failed\b/i, reason: "nonzero failed-count output" },
  { pattern: /\bfailed\s*[:=]\s*[1-9]\d*\b/i, reason: "nonzero failed-count output" },
  { pattern: /\berrors?\s*[:=]\s*[1-9]\d*\b/i, reason: "nonzero error-count output" },
  { pattern: /\b(?:BUILD|RC|RET|RETCODE|EXIT(?:_CODE)?|STATUS|ERRORLEVEL|ERRORCODE)\s*=\s*[1-9]\d*\b/i, reason: "hidden nonzero exit-status output" },
];

function isBenignFailureCountLine(line: string): boolean {
  return (
    /\b0\s+(?:failed|failures|errors)\b/i.test(line) ||
    /\b(?:failed|failures|errors)\s*[:=]\s*0\b/i.test(line) ||
    /\b(?:all|everything)\s+(?:passed|succeeded|successful)\b/i.test(line)
  );
}

interface CountFact {
  value: number;
  label: string;
  normalizedLabel: string;
  line: string;
  qualifier: "found" | "total" | "unique" | "bucket" | "other";
}

function detectContradictoryNumericCounts(lines: string[]): SemanticFailureSignal | undefined {
  const facts = lines.flatMap(extractCountFacts);
  if (facts.length < 2) return undefined;

  for (const found of facts.filter((fact) => fact.qualifier === "found")) {
    const matchingTotal = facts.find((fact) => fact.qualifier === "total" && labelsReferToSamePopulation(found.normalizedLabel, fact.normalizedLabel));
    if (matchingTotal && found.value !== matchingTotal.value) {
      return {
        reason: "numeric count mismatch output",
        line: `${found.line}; ${matchingTotal.line}`.slice(0, 500),
      };
    }
  }

  const populationCounts = facts.filter((fact) => fact.qualifier === "found" || fact.qualifier === "total");
  for (const unique of facts.filter((fact) => fact.qualifier === "unique")) {
    const compatiblePopulation = populationCounts.find((fact) => labelsLookRelated(unique.normalizedLabel, fact.normalizedLabel));
    if (compatiblePopulation && unique.value > compatiblePopulation.value) {
      return {
        reason: "numeric count mismatch output",
        line: `${unique.line}; ${compatiblePopulation.line}`.slice(0, 500),
      };
    }
  }

  const totals = populationCounts.filter((fact) => fact.value > 1);
  for (const unique of facts.filter((fact) => fact.qualifier === "unique" && fact.value <= 1)) {
    const matchingBucket = facts.find((fact) => fact.qualifier === "bucket" && totals.some((total) => total.value === fact.value));
    if (matchingBucket) {
      return {
        reason: "numeric count mismatch output",
        line: `${unique.line}; ${matchingBucket.line}`.slice(0, 500),
      };
    }
  }

  return undefined;
}

function detectStructuredOutputFormattingFailure(rawLines: string[]): SemanticFailureSignal | undefined {
  const hasNumberedDistribution = rawLines.some((line) => /^\s*\d+\.\s*(?:Count|Rows|Items|Entries|Matches)\s*:/i.test(line));
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (/^Frame\s+\d+\s*:\s+(?:in|at)\s+\S/i.test(trimmed)) {
      return {
        reason: "artifact formatting mismatch output",
        line: trimmed.slice(0, 500),
      };
    }
    if (hasNumberedDistribution && /^ {2}Frame\s+\d+\s*:/i.test(line)) {
      return {
        reason: "artifact formatting mismatch output",
        line: line.slice(0, 500),
      };
    }
  }
  return undefined;
}

function extractCountFacts(line: string): CountFact[] {
  const facts: CountFact[] = [];
  const colonMatch = /^([A-Za-z][A-Za-z0-9 _./()%'-]{2,100}?):\s*([0-9][0-9,]*)\b/.exec(line);
  if (colonMatch) {
    facts.push(makeCountFact(Number.parseInt(colonMatch[2]!.replace(/,/g, ""), 10), colonMatch[1]!, line));
  }

  const leadingVerbMatch =
    /^(?:Found|Loaded|Read|Processed|Matched|Extracted|Generated|Created|Wrote|Produced)\s+([0-9][0-9,]*)\s+([A-Za-z][A-Za-z0-9 _./()%'-]{1,100})$/i.exec(
      line,
    );
  if (leadingVerbMatch) {
    facts.push(makeCountFact(Number.parseInt(leadingVerbMatch[1]!.replace(/,/g, ""), 10), `found ${leadingVerbMatch[2]!}`, line));
  }

  const bucketMatch = /^(?:\d+\.\s*)?(?:Count|Rows|Items|Entries|Matches)\s*:\s*([0-9][0-9,]*)\b/i.exec(line);
  if (bucketMatch) {
    facts.push({
      value: Number.parseInt(bucketMatch[1]!.replace(/,/g, ""), 10),
      label: "bucket",
      normalizedLabel: "bucket",
      line,
      qualifier: "bucket",
    });
  }

  return facts.filter((fact) => Number.isFinite(fact.value));
}

function makeCountFact(value: number, rawLabel: string, line: string): CountFact {
  const label = rawLabel.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const lower = label.toLowerCase();
  const qualifier =
    /\b(?:unique|distinct|deduplicated)\b/.test(lower)
      ? "unique"
      : /\b(?:total|analy[sz]ed|processed|read|loaded)\b/.test(lower)
        ? "total"
        : /\b(?:found|matched|extracted|generated|created|wrote|produced)\b/.test(lower)
          ? "found"
          : "other";
  return {
    value,
    label,
    normalizedLabel: normalizeCountLabel(label),
    line,
    qualifier,
  };
}

function normalizeCountLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/\b(?:number|count|of|found|matched|extracted|generated|created|wrote|produced|loaded|read|processed|total|unique|distinct|deduplicated|analy[sz]ed|based|on|top|frames?)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2)
    .map(singularizeToken)
    .join(" ")
    .trim();
}

function singularizeToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ses") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 3) return token.slice(0, -1);
  return token;
}

function labelsReferToSamePopulation(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function labelsLookRelated(left: string, right: string): boolean {
  if (labelsReferToSamePopulation(left, right)) return true;
  const leftTokens = new Set(left.split(/\s+/).filter(Boolean));
  const rightTokens = new Set(right.split(/\s+/).filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) return true;
  }
  return false;
}
