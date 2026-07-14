/**
 * context/shake.ts — Context pruning ("shake") for the live agent loop.
 *
 * Ported from oh-my-pi's shake technique. Mechanically replaces old/stale
 * tool results with short placeholders to reduce context bloat. No LLM call
 * needed — pure string manipulation.
 *
 * Strategy:
 * 1. Protect the most recent N tokens (keep recent results intact)
 * 2. Identify stale tool results eligible for replacement:
 *    - write_file/file_edit acks (just "File written" — no useful content)
 *    - Old bash install/build outputs (large, stale after the step completes)
 *    - Any tool result older than the protect window
 * 3. Replace eligible results with one-line summaries
 * 4. Never touch the cockpit message (first user message) or the last assistant turn
 */

import { getContextTunables } from "../config/config-tunables.js";
import { normalizeToolResult } from "../tools/tool-result.js";
import { findSupersededReadIndices, isReadObservationTool } from "./supersede-prune.js";

/** Fallback minimum savings (in chars) when tunables are unavailable.
 * OMP shake minSavings ≈ 4_000 tokens → ~16_000 chars. */
const DEFAULT_MIN_SAVINGS_CHARS = 16_000;

/** Fallback protect window (chars) when tunables are unavailable.
 * OMP protectTokens ≈ 16_000 → ~64_000 chars. */
const DEFAULT_PROTECT_WINDOW_CHARS = 64_000;
const MIN_PROTECT_WINDOW_CHARS = 200;
/** 256k active tokens reaches the default 64k-character protection ceiling. */
const PROTECT_WINDOW_TOKEN_DIVISOR = 4;

/** Minimum tool result size (in chars) to be eligible for shake. */
const FENCE_MIN_CHARS = 200;

/** Fallback trigger percentage when tunables are unavailable. */
const DEFAULT_SHAKE_TRIGGER_PCT = 60;

/** Fallback circuit-breaker cap when tunables are unavailable. */
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export interface ShakeTunables {
  shakeEnabled?: boolean;
  shakeTriggerPct?: number;
  shakeProtectWindowChars?: number;
  shakeMinSavingsChars?: number;
  maxConsecutiveShakeFailures?: number;
}

function resolveShakeTunables(override?: ShakeTunables): Required<
  Pick<
    ShakeTunables,
    | "shakeEnabled"
    | "shakeTriggerPct"
    | "shakeProtectWindowChars"
    | "shakeMinSavingsChars"
    | "maxConsecutiveShakeFailures"
  >
> {
  let fromConfig: ShakeTunables = {};
  try {
    fromConfig = getContextTunables();
  } catch {
    /* tunables may be unavailable in isolated unit tests */
  }
  return {
    shakeEnabled: override?.shakeEnabled ?? fromConfig.shakeEnabled ?? true,
    shakeTriggerPct: override?.shakeTriggerPct ?? fromConfig.shakeTriggerPct ?? DEFAULT_SHAKE_TRIGGER_PCT,
    shakeProtectWindowChars:
      override?.shakeProtectWindowChars ??
      fromConfig.shakeProtectWindowChars ??
      DEFAULT_PROTECT_WINDOW_CHARS,
    shakeMinSavingsChars:
      override?.shakeMinSavingsChars ?? fromConfig.shakeMinSavingsChars ?? DEFAULT_MIN_SAVINGS_CHARS,
    maxConsecutiveShakeFailures:
      override?.maxConsecutiveShakeFailures ??
      fromConfig.maxConsecutiveShakeFailures ??
      DEFAULT_MAX_CONSECUTIVE_FAILURES,
  };
}

/**
 * Optional test/debug override for forcing shake in small smoke runs.
 * Production default is the real runtime context window passed by engine.
 */
function effectiveContextWindowTokens(contextWindowTokens: number): number {
  const raw = process.env.REAPER_SHAKE_CONTEXT_WINDOW_TOKENS;
  if (!raw) return contextWindowTokens;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return contextWindowTokens;
  return Math.max(1, Math.floor(parsed));
}

interface Message {
  role: string;
  content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  is_error?: boolean;
}

export interface ShakeResult {
  /** Number of tool results that were replaced. */
  shaken: number;
  /** Chars saved by the shake. */
  savedChars: number;
  /** Whether a shake was performed. */
  performed: boolean;
}

/**
 * Estimate total chars in the conversation messages.
 */
function estimateTotalChars(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += typeof msg.content === "string" ? msg.content.length : 0;
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += tc.function.arguments.length;
      }
    }
  }
  return total;
}

/**
 * Estimate tokens from chars (rough heuristic).
 * Prefer provider usage when available; this is the fallback.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Should shake trigger? Checks if context exceeds the threshold percentage
 * of the model's max context window.
 */
export function shouldShake(
  messages: Message[],
  contextWindowTokens: number,
  tunables?: ShakeTunables,
): boolean {
  const t = resolveShakeTunables(tunables);
  if (!t.shakeEnabled) return false;
  const totalChars = estimateTotalChars(messages);
  const totalTokens = estimateTokens(totalChars);
  const effectiveWindow = effectiveContextWindowTokens(contextWindowTokens);
  const pct = Math.min(99, Math.max(1, t.shakeTriggerPct));
  const threshold = Math.floor((effectiveWindow * pct) / 100);
  return totalTokens > threshold;
}

/**
 * Build a one-line placeholder for a shaken tool result.
 * Preserves the tool name and a brief hint about what it did.
 */
function buildPlaceholder(
  toolName: string,
  originalContent: string,
  toolCallArgs?: string,
): string {
  // For write_file/file_edit: extract the file path from args
  if (toolName === "write_file" || toolName === "file_edit" || toolName === "replace_in_file") {
    if (toolCallArgs) {
      try {
        const args = JSON.parse(toolCallArgs);
        const p = args.path ?? args.file ?? "";
        if (p) return `[wrote: ${p}]`;
      } catch {
        // fall through
      }
    }
    return `[${toolName}: file written — completed]`;
  }

  // For bash: extract a hint about the command
  if (toolName === "bash") {
    if (toolCallArgs) {
      try {
        const args = JSON.parse(toolCallArgs);
        const cmd = (args.cmd ?? args.command ?? "").trim();
        if (cmd) {
          const shortCmd = cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd;
          const size = originalContent.length;
          return `[bash: "${shortCmd}" — executed, ${size} bytes output]`;
        }
      } catch {
        // fall through
      }
    }
    return `[bash: executed, ${originalContent.length} bytes output]`;
  }

  // Generic placeholder
  return `[${toolName}: completed, ${originalContent.length} bytes]`;
}

/**
 * Find the tool name for a given tool result message by looking backwards
 * for the matching tool_call in the preceding assistant message.
 */
function findToolNameForCall(
  messages: Message[],
  toolResultIdx: number,
): { name: string; args: string } {
  const toolResultMsg = messages[toolResultIdx];
  if (!toolResultMsg) return { name: "unknown", args: "" };
  const toolCallId = toolResultMsg.tool_call_id;
  if (!toolCallId) return { name: "unknown", args: "" };

  // Walk backwards to find the assistant message with this tool call
  for (let j = toolResultIdx - 1; j >= 0; j -= 1) {
    const candidate = messages[j];
    if (!candidate || candidate.role !== "assistant" || !candidate.tool_calls) continue;
    for (const tc of candidate.tool_calls) {
      if (tc.id === toolCallId) {
        return { name: tc.function.name, args: tc.function.arguments };
      }
    }
  }
  return { name: "unknown", args: "" };
}

/**
 * Determine if a tool result is eligible for shaking.
 * Returns the replacement string, or null if the result should be kept.
 *
 * The normalized tool-result envelope is the single source of truth for what
 * is safe to prune and what the replacement text should look like. We fall
 * back to tool-specific heuristics only for bash (where we want a richer
 * command-aware placeholder) and for unknown tool names.
 */
function getShakeReplacement(
  toolName: string,
  content: string,
  args: string,
): string | null {
  const size = content.length;
  let parsedArgs: unknown = undefined;
  try {
    parsedArgs = args ? JSON.parse(args) : undefined;
  } catch {
    parsedArgs = undefined;
  }

  // bash needs a command-aware placeholder, so it has its own branch below.
  // For everything else, defer to the envelope.
  if (toolName !== "bash") {
    // write/file-edit acks (write_file/file_edit/replace_in_file) are always
    // safe to prune regardless of size; other safe tools only when they are
    // large enough to be worth a shake.
    const normalized = normalizeToolResult({
      ok: true,
      toolCallId: "shake",
      name: toolName,
      args: parsedArgs,
      output: content,
      durationMs: 0,
    });
    if (normalized.meta?.safeToPrune) {
      const replacement = normalized.meta.pruneReplacement;
      if (typeof replacement === "string") return replacement;
    }
    return null;
  }

  // bash: install/build outputs are stale immediately, so prune when small.
  if (size < FENCE_MIN_CHARS) return null;

  if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
    const command =
      ("cmd" in parsedArgs ? parsedArgs.cmd : undefined) ??
      ("command" in parsedArgs ? parsedArgs.command : undefined);
    const lower = typeof command === "string" ? command.toLowerCase() : "";
    const isInstallOrBuild =
      lower.includes("install") ||
      lower.includes("build") ||
      lower.includes("tsc") ||
      (lower.includes("pnpm") && !lower.includes("test")) ||
      lower.includes("compile");
    if (isInstallOrBuild) {
      return buildPlaceholder(toolName, content, args);
    }
  }

  // Generic large bash outputs: keep if errors are visible, else use envelope.
  if (size > 2_000 && !content.includes("[REAPER SEARCH RESULT]")) {
    if (content.includes("Error:") || content.includes("error TS")) {
      return null;
    }
    const normalized = normalizeToolResult({
      ok: true,
      toolCallId: "shake",
      name: toolName,
      args: parsedArgs,
      output: content,
      durationMs: 0,
    });
    if (normalized.meta?.safeToPrune && typeof normalized.meta.pruneReplacement === "string") {
      return normalized.meta.pruneReplacement;
    }
  }

  return null;
}

/**
 * Perform a shake pass on the live conversation.
 * Mutates `messages` in place, replacing stale tool results with placeholders.
 *
 * @param messages The live conversation (cockpit + assistant/tool messages)
 * @param contextWindowTokens The model's max context window in tokens
 * @returns ShakeResult with stats
 */
export function shakeConversation(
  messages: Message[],
  contextWindowTokens: number,
  tunables?: ShakeTunables,
): ShakeResult {
  const t = resolveShakeTunables(tunables);
  if (!t.shakeEnabled) {
    return { shaken: 0, savedChars: 0, performed: false };
  }

  // Check if we should shake
  if (!shouldShake(messages, contextWindowTokens, t)) {
    return { shaken: 0, savedChars: 0, performed: false };
  }

  // Protect every result from the newest tool-call batch. These results have
  // not been observed by a subsequent model turn yet, so pruning any one of
  // them can make the agent repeat reads or act without evidence.
  let latestBatchStart = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      latestBatchStart = i + 1;
    }
    break;
  }

  // Extend protection backwards using the active token budget rather than
  // total historical output. Low-cap runs get a small usable floor; production
  // caps grow to (but never beyond) the configured character ceiling.
  // A trailing unobserved batch remains protected even when it alone exceeds
  // this adaptive window.
  const protectWindow = Math.min(
    t.shakeProtectWindowChars,
    Math.max(
      MIN_PROTECT_WINDOW_CHARS,
      Math.floor(effectiveContextWindowTokens(contextWindowTokens) / PROTECT_WINDOW_TOKEN_DIVISOR),
    ),
  );
  let protectedFromEnd = messages
    .slice(latestBatchStart)
    .filter((msg) => msg.role === "tool")
    .reduce((sum, msg) => sum + (msg.content?.length ?? 0), 0);
  let protectedAny = protectedFromEnd > 0;
  let firstUnprotectedIdx = latestBatchStart;
  for (let i = latestBatchStart - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.role !== "tool") continue;
    const contentLength = msg.content?.length ?? 0;
    if (protectedAny && protectedFromEnd + contentLength > protectWindow) {
      firstUnprotectedIdx = i + 1;
      break;
    }
    protectedAny = true;
    protectedFromEnd += contentLength;
    firstUnprotectedIdx = i;
  }

  // Collect replacements first. A pass below the minimum-savings threshold
  // must be a true no-op; mutating and then reporting performed=false silently
  // destroyed context in the previous implementation.
  const replacements: Array<{ index: number; content: string; savedChars: number }> = [];
  let savedChars = 0;
  const seenToolCallIds = new Set<string>();
  const supersededReadIndices = findSupersededReadIndices(messages);

  for (let i = 0; i < Math.min(firstUnprotectedIdx, messages.length); i += 1) {
    const msg = messages[i];
    if (!msg) continue;

    // Skip the cockpit message (first user message)
    if (msg.role === "user" && i === 0) continue;
    if (msg.role !== "tool") continue;

    // Skip if already shaken (content already starts with [)
    const content = msg.content ?? "";
    if (content.startsWith("[") && content.endsWith("]")) continue;

    const { name: toolName, args: toolArgs } = findToolNameForCall(messages, i);
    // File observations require same-version coverage proof. Age alone is
    // never sufficient to discard a read result.
    if (isReadObservationTool(toolName) && !supersededReadIndices.has(i)) continue;
    const replacement = getShakeReplacement(toolName, content, toolArgs);
    if (replacement === null) continue;

    const callId = msg.tool_call_id ?? `idx-${i}`;
    if (seenToolCallIds.has(callId)) continue;
    seenToolCallIds.add(callId);

    const candidateSavings = content.length - replacement.length;
    replacements.push({ index: i, content: replacement, savedChars: candidateSavings });
    savedChars += candidateSavings;
  }

  if (savedChars < t.shakeMinSavingsChars) {
    return { shaken: 0, savedChars: 0, performed: false };
  }

  for (const replacement of replacements) {
    const target = messages[replacement.index];
    if (target) target.content = replacement.content;
  }
  return { shaken: replacements.length, savedChars, performed: replacements.length > 0 };
}

/** @deprecated Prefer resolveShakeTunables().maxConsecutiveShakeFailures */
export const MAX_CONSECUTIVE_FAILURES = DEFAULT_MAX_CONSECUTIVE_FAILURES;

export interface PTLRecoveryOptions {
  maxDrops: number;
}

export interface PTLRecoveryResult {
  droppedResults: number;
  savedChars: number;
  messages: Array<Record<string, unknown>>;
}

/**
 * Replace the oldest `maxDrops` oversized tool-result messages with a
 * `[tool_result: dropped for PTL recovery]` placeholder. Used by the
 * engine when the provider returns a 413 and we need to shrink the
 * conversation without losing the overall structure.
 */
export function truncateHeadForPTLRecovery(
  messages: Array<Record<string, unknown>>,
  optionsOrMin: PTLRecoveryOptions | number,
): PTLRecoveryResult {
  const maxDrops = typeof optionsOrMin === "number" ? Math.max(1, optionsOrMin) : optionsOrMin.maxDrops;
  let dropped = 0;
  let savedChars = 0;
  for (let i = 0; i < messages.length && dropped < maxDrops; i += 1) {
    const m = messages[i]!;
    if (m["role"] !== "tool" && m["role"] !== "tool_result") continue;
    const content = typeof m["content"] === "string" ? m["content"] : "";
    if (content.length < 200) continue;
    savedChars += content.length;
    m["content"] = "[tool_result: dropped for PTL recovery]";
    dropped += 1;
  }
  return { messages, droppedResults: dropped, savedChars };
}

/**
 * Shake with a circuit breaker. After `MAX_CONSECUTIVE_FAILURES`
 * consecutive passes that did nothing, returns performed=false and
 * stops attempting. The breaker resets on any successful pass.
 *
 * Returns `{ result, nextFailures }` so callers can thread the
 * failure counter through their own state without holding a mutable
 * object.
 */
export function shakeConversationWithBreaker(
  messages: Message[],
  contextWindowTokens: number,
  consecutiveFailures: number = 0,
  tunables?: ShakeTunables,
): {
  result: ShakeResult & { aborted?: boolean };
  nextFailures: number;
} {
  const t = resolveShakeTunables(tunables);
  if (consecutiveFailures >= t.maxConsecutiveShakeFailures) {
    return {
      result: { shaken: 0, savedChars: 0, performed: false, aborted: true },
      nextFailures: consecutiveFailures,
    };
  }
  const result = shakeConversation(messages, contextWindowTokens, t);
  const nextFailures = result.performed ? 0 : consecutiveFailures + 1;
  return { result, nextFailures };
}