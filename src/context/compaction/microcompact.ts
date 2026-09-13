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

  // 1. Collapse repeated identical file_view/list_directory outputs
  const seenOutputs = new Map<string, number>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (!r.ok || !["file_view", "list_directory", "grep_search", "skim_file"].includes(r.name)) continue;
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

  // 2. Truncate large successful file_view outputs that exceed per-item budget
  const perItemBudget = Math.max(2000, Math.floor(targetOutputChars / Math.max(1, results.filter((r) => r.ok).length)));
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (!r.ok || (r.name !== "file_view")) continue;
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
    if (!r.ok || r.name !== "bash") continue;
    const key = shellOutputKey(r);
    /*
     * An empty key means the result carries nothing to compare, and treating
     * "nothing" as "the same as the last nothing" is how every bash result came
     * to be replaced by "[same as earlier]". Skipped, so an unrecognised shape
     * is left alone rather than silently rewritten.
     */
    if (!key) continue;
    if (seenShellOutputs.has(key)) {
      const originalChars = estimateChars(r);
      /*
       * Only a structured `output` can have its `stdout`/`stderr` replaced.
       *
       * `r.output` is frequently a plain string — that is what the engine holds
       * for a tool message pulled back out of the conversation — and spreading a
       * string into an object does not fail, it *succeeds*: `{..."ab"}` is
       * `{"0":"a","1":"b"}`. A 20k-character shell result became a 229KB object
       * with one key per character, so the "compaction" made the conversation
       * larger and handed the provider a JSON blob where it expected text. A
       * string is replaced wholesale instead, which is the same claim ("this
       * output was seen before") in a form the model can actually read.
       */
      results[i] = typeof r.output === "string"
        ? { ...r, output: "[same as earlier]" }
        : {
            ...r,
            output: { ...(r.output as Record<string, unknown>), stdout: "[same as earlier]", stderr: "[same as earlier]" },
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

/**
 * Identity of a shell result's output, for the repeated-command check.
 *
 * Returning `""` for an unrecognised shape was a false-positive generator: on
 * the conversation path `output` is a plain string, so *every* bash result
 * keyed to `""`, the first one added `""` to the seen-set, and every later one
 * was rewritten to "[same as earlier]" — regardless of what it contained. The
 * model then read "[same as earlier]" for a command it had never run, which is
 * worse than the duplication this pass exists to remove: it silently replaces
 * real output with a claim that the output was seen before.
 *
 * A string `output` is therefore keyed by its own text. Only a shape that
 * carries neither text nor a stdout/stderr pair returns empty, and empty keys
 * are skipped by the caller rather than treated as equal.
 */
function shellOutputKey(result: ToolResult): string {
  if (typeof result.output === "string") return result.output.slice(0, 200);
  if (!result.output || typeof result.output !== "object") return "";
  const out = result.output as Record<string, unknown>;
  const stdout = typeof out.stdout === "string" ? out.stdout : "";
  const stderr = typeof out.stderr === "string" ? out.stderr : "";
  if (!stdout && !stderr) return "";
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
