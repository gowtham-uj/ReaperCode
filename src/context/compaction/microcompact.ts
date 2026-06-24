/**
 * Microcompact: lightweight in-process token reduction.
 * Runs before every expensive model call to reduce token count
 * without a remote summarization call.
 */

import type { ToolResult } from "../../tools/types.js";

export interface MicrocompactInput {
  toolResults: ToolResult[];
  /** Target max total characters for tool result outputs (default 50000) */
  targetOutputChars?: number;
}

export interface MicrocompactOutput {
  toolResults: ToolResult[];
  reducedChars: number;
}

export function microcompact(input: MicrocompactInput): MicrocompactOutput {
  const targetOutputChars = input.targetOutputChars ?? 50_000;
  let totalChars = 0;
  for (const r of input.toolResults) {
    totalChars += estimateChars(r);
  }
  if (totalChars <= targetOutputChars) {
    return { toolResults: input.toolResults, reducedChars: 0 };
  }

  // Build a copy we can mutate
  const results = input.toolResults.map((r) => ({ ...r }));
  let reducedChars = 0;

  // 1. Collapse repeated identical read_file/list_directory outputs
  const seenOutputs = new Map<string, number>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (!r.ok || !["read_file", "view_file", "list_directory", "grep_search", "skim_file"].includes(r.name)) continue;
    const key = outputKey(r);
    const prevIndex = seenOutputs.get(key);
    if (prevIndex !== undefined && prevIndex < i) {
      // Replace with a reference
      const originalChars = estimateChars(r);
      results[i] = {
        ...r,
        output: `[Same result as tool_call ${results[prevIndex]!.toolCallId}]`,
      };
      reducedChars += originalChars - estimateChars(results[i]!);
    } else {
      seenOutputs.set(key, i);
    }
  }

  // 2. Truncate large successful read_file outputs that exceed per-item budget
  const perItemBudget = Math.max(2000, Math.floor(targetOutputChars / Math.max(1, results.filter((r) => r.ok).length)));
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (!r.ok || (r.name !== "read_file" && r.name !== "view_file")) continue;
    const chars = estimateChars(r);
    if (chars > perItemBudget) {
      const originalChars = chars;
      results[i] = truncateToolResultOutput(r, perItemBudget);
      reducedChars += originalChars - estimateChars(results[i]!);
    }
  }

  // 3. Strip redundant stdout/stderr from repeated successful shell commands
  const seenShellOutputs = new Set<string>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (!r.ok || r.name !== "run_shell_command") continue;
    const key = shellOutputKey(r);
    if (seenShellOutputs.has(key)) {
      const originalChars = estimateChars(r);
      results[i] = {
        ...r,
        output: { ...(r.output as object), stdout: "[same as earlier]", stderr: "[same as earlier]" },
      };
      reducedChars += originalChars - estimateChars(results[i]!);
    } else {
      seenShellOutputs.add(key);
    }
  }

  return { toolResults: results, reducedChars };
}

function estimateChars(result: ToolResult): number {
  if (!result.ok) {
    return (result.error?.message ?? "").length;
  }
  const rendered = typeof result.output === "string" ? result.output : JSON.stringify(result.output) ?? "";
  return rendered.length;
}

function outputKey(result: ToolResult): string {
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  const path = typeof args.path === "string" ? args.path : "";
  const rendered = typeof result.output === "string" ? result.output : JSON.stringify(result.output) ?? "";
  return `${result.name}:${path}:${rendered.slice(0, 200)}`;
}

function shellOutputKey(result: ToolResult): string {
  if (!result.output || typeof result.output !== "object") return "";
  const out = result.output as Record<string, unknown>;
  const stdout = typeof out.stdout === "string" ? out.stdout : "";
  const stderr = typeof out.stderr === "string" ? out.stderr : "";
  return `${stdout.slice(0, 200)}:${stderr.slice(0, 200)}`;
}

function truncateToolResultOutput(result: ToolResult, maxChars: number): ToolResult {
  if (!result.output || typeof result.output !== "object") return result;
  const out = { ...(result.output as Record<string, unknown>) };
  for (const key of ["content", "stdout", "stderr", "output", "outputPreview"]) {
    if (typeof out[key] === "string" && (out[key] as string).length > maxChars) {
      const s = out[key] as string;
      const head = Math.ceil(maxChars / 2);
      const tail = Math.floor(maxChars / 2);
      out[key] = `${s.slice(0, head)}\n...[truncated by microcompact]...\n${s.slice(-tail)}`;
    }
  }
  return { ...result, output: out };
}
