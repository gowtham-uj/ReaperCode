import type { ToolResult } from "../tools/types.js";

export function deriveCanonicalSecretEncodings(value: string, context: string): string[] {
  const clean = value.trim();
  if (!/^\d+$/.test(clean)) return [];
  const widths = new Set<number>();
  for (const match of context.matchAll(/%\s*(10+)\b/g)) widths.add(match[1]!.length - 1);
  for (const match of context.matchAll(/\b(\d+)\s*[- ]?digit\b/gi)) widths.add(Number(match[1]));
  for (const match of context.matchAll(/\bwidth\s*[:=]?\s*(\d+)\b/gi)) widths.add(Number(match[1]));
  return [...widths]
    .filter((width) => Number.isFinite(width) && width > clean.length && width <= 64)
    .map((width) => clean.padStart(width, "0"));
}

export function buildDerivedSecretEncodingFeedback(results: ToolResult[]): string[] {
  const latestFailure = [...results].reverse().find((result) => !result.ok && /wrong password|invalid password|authentication failed|invalid token|invalid key/i.test(result.error?.message ?? ""));
  if (!latestFailure) return [];
  const args = latestFailure.args && typeof latestFailure.args === "object" ? (latestFailure.args as Record<string, unknown>) : {};
  const command = typeof args.cmd === "string" ? args.cmd : typeof args.command === "string" ? args.command : "";
  const candidate = command.match(/(?:-p|password[=\s]+|token[=\s]+|key[=\s]+)(\d{1,63})\b/i)?.[1];
  if (!candidate) return [];
  const context = results
    .slice(-16)
    .map((result) => `${JSON.stringify(result.args)}\n${render(result.output)}\n${result.error?.message ?? ""}`)
    .join("\n");
  const encodings = deriveCanonicalSecretEncodings(candidate, context);
  if (encodings.length === 0) return [];
  return [
    `A derived numeric credential '${candidate}' was rejected. Before recomputing or brute-forcing, try this bounded canonical encoding ladder implied by the observed fixed-width/modulo contract: ${encodings.join(", ")}. Deduplicate attempts and stop after these format-preserving variants.`,
  ];
}

function render(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
