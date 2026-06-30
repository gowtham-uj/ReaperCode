export interface SwePrunerConfig {
  enabled: boolean;
  localOnly?: boolean | undefined;
  url?: string | undefined;
  threshold: number;
}

export interface SwePrunerResult {
  prunedCode: string;
  keptFrags: number[];
  originTokenCount: number;
  leftTokenCount: number;
  source: "swe-pruner-local" | "swe-pruner-service" | "heuristic";
}

export async function pruneWithSwePruner(input: {
  config: SwePrunerConfig;
  query: string;
  code: string;
}): Promise<SwePrunerResult> {
  if (input.config.enabled && input.config.url && input.config.localOnly === false) {
    try {
      const response = await fetch(input.config.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: input.query,
          code: input.code,
          threshold: input.config.threshold,
        }),
      });
      if (!response.ok) {
        throw new Error(`SWE-Pruner request failed with status ${response.status}`);
      }
      const parsed = (await response.json()) as {
        pruned_code: string;
        kept_frags: number[];
        origin_token_cnt: number;
        left_token_cnt: number;
      };
      return {
        prunedCode: parsed.pruned_code,
        keptFrags: parsed.kept_frags,
        originTokenCount: parsed.origin_token_cnt,
        leftTokenCount: parsed.left_token_cnt,
        source: "swe-pruner-service",
      };
    } catch {
      // fall through to heuristic path
    }
  }

  const prunedCode = input.config.enabled ? localSwePrune(input.code, input.query, input.config.threshold) : heuristicPrune(input.code, input.query);
  return {
    prunedCode,
    keptFrags: [],
    originTokenCount: estimateTokens(input.code),
    leftTokenCount: estimateTokens(prunedCode),
    source: input.config.enabled ? "swe-pruner-local" : "heuristic",
  };
}

function localSwePrune(code: string, query: string, threshold: number): string {
  const lines = code.split(/\r?\n/);
  if (lines.length <= 180) {
    return code;
  }

  const tokens = query.toLowerCase().split(/[^a-z0-9_./-]+/).filter((token) => token.length > 2);
  const keep = new Set<number>();
  const contextRadius = threshold >= 0.7 ? 2 : threshold <= 0.3 ? 6 : 4;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lower = line.toLowerCase();
    const lexicalHit = tokens.some((token) => lower.includes(token));
    const structuralHit = /^\s*(export\s+)?(async\s+)?(function|class|interface|type|const|let|var|def)\b/.test(line);
    const diagnosticHit = /\b(error|throw|catch|todo|fixme|fail|assert|expect|test|describe|it)\b/i.test(line);
    const importHit = /^\s*(import|from|require\(|#include)\b/.test(line);
    if (lexicalHit || structuralHit || diagnosticHit || importHit) {
      for (let offset = -contextRadius; offset <= contextRadius; offset += 1) {
        const target = index + offset;
        if (target >= 0 && target < lines.length) {
          keep.add(target);
        }
      }
    }
  }

  if (keep.size === 0) {
    return lines.slice(0, 180).join("\n");
  }

  const sorted = [...keep].sort((a, b) => a - b);
  const rendered: string[] = [];
  let previous = -1;
  for (const index of sorted) {
    if (previous >= 0 && index > previous + 1) {
      rendered.push(`\n// ... ${index - previous - 1} line(s) pruned ...`);
    }
    rendered.push(lines[index] ?? "");
    previous = index;
  }
  return rendered.join("\n");
}

function heuristicPrune(code: string, query: string): string {
  const tokens = query.toLowerCase().split(/[^a-z0-9_./-]+/).filter(Boolean);
  const lines = code.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const lower = line.toLowerCase();
    return tokens.some((token) => lower.includes(token)) || /import|throw|error|todo|function|class|const/i.test(line);
  });
  return kept.length > 0 ? kept.join("\n") : lines.slice(0, 120).join("\n");
}

function estimateTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}
