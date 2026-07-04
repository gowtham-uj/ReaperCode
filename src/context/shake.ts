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

/** Minimum savings (in chars) to justify a shake pass. */
const MIN_SAVINGS_CHARS = 100;

/** Protect the most recent tool results (in chars) from shaking. */
const PROTECT_WINDOW_CHARS = 12_000;

/** Minimum tool result size (in chars) to be eligible for shake. */
const FENCE_MIN_CHARS = 200;

/** Context window threshold (% of max tokens) to trigger shake. */
const SHAKE_TRIGGER_PCT = 50;

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
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / (2 + 2));
}

/**
 * Should shake trigger? Checks if context exceeds the threshold percentage
 * of the model's max context window.
 */
export function shouldShake(
  messages: Message[],
  contextWindowTokens: number,
): boolean {
  const totalChars = estimateTotalChars(messages);
  const totalTokens = estimateTokens(totalChars);
  const effectiveWindow = effectiveContextWindowTokens(contextWindowTokens);
  const threshold = Math.floor(effectiveWindow * SHAKE_TRIGGER_PCT / 100);
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
  if (toolName === "bash" || toolName === "run_shell_command") {
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
 */
function getShakeReplacement(
  toolName: string,
  content: string,
  args: string,
): string | null {
  const size = content.length;

  // write_file / file_edit / replace_in_file acks — always shake even small
  // ones because there can be 100+ of them and they're pure noise.
  if (toolName === "write_file" || toolName === "file_edit" || toolName === "replace_in_file") {
    return buildPlaceholder(toolName, content, args);
  }

  // Too small to bother shaking (for other tools)
  if (size < FENCE_MIN_CHARS) return null;

  // bash: shake install/build outputs (large and stale after the step)
  if (toolName === "bash" || toolName === "run_shell_command") {
    if (args) {
      try {
        const parsed = JSON.parse(args);
        const cmd = (parsed.cmd ?? parsed.command ?? "").toLowerCase();
        if (
          cmd.includes("install") ||
          (cmd.includes("pnpm") && !cmd.includes("test")) ||
          cmd.includes("build") ||
          cmd.includes("tsc")
        ) {
          return buildPlaceholder(toolName, content, args);
        }
      } catch {
        // fall through
      }
    }
    // Shake large bash outputs that aren't tests
    if (size > 2_000 && !content.includes("[REAPER SEARCH RESULT]")) {
      // But keep if it contains errors the model might still need
      if (!content.includes("Error:") && !content.includes("error TS")) {
        return buildPlaceholder(toolName, content, args);
      }
    }
  }

  // file_view: keep if recent (protected by window), shake old large views
  if (toolName === "file_view" || toolName === "read_file") {
    if (size > 1_500) {
      return buildPlaceholder(toolName, content, args);
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
): ShakeResult {
  const totalChars = estimateTotalChars(messages);

  // Check if we should shake
  if (!shouldShake(messages, contextWindowTokens)) {
    return { shaken: 0, savedChars: 0, performed: false };
  }

  // Calculate the protect window: keep the most recent tool results intact.
  // Protect ~1/3 of the tool result chars, minimum 200, capped at 12K.
  // This ensures recent results survive while old ones get shaken.
  const toolResultChars = messages
    .filter(m => m.role === "tool")
    .reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  const protectWindow = Math.min(PROTECT_WINDOW_CHARS, Math.max(200, Math.floor(toolResultChars / 3)));

  let protectedFromEnd = 0;
  let firstUnprotectedIdx = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.role !== "tool") continue;
    const content = msg.content ?? "";
    if (protectedFromEnd + content.length > protectWindow) {
      firstUnprotectedIdx = i + 1;
      break;
    }
    protectedFromEnd += content.length;
    firstUnprotectedIdx = i;
  }

  // Shake tool results before the protect window
  let shaken = 0;
  let savedChars = 0;
  const seenToolCallIds = new Set<string>();

  for (let i = 0; i < Math.min(firstUnprotectedIdx, messages.length); i += 1) {
    const msg = messages[i];
    if (!msg) continue;

    // Skip the cockpit message (first user message)
    if (msg.role === "user" && i === 0) continue;

    if (msg.role !== "tool") continue;

    // Skip if already shaken (content already starts with [)
    const content = msg.content ?? "";
    if (content.startsWith("[") && content.endsWith("]")) continue;

    // Find the tool name and args
    const { name: toolName, args: toolArgs } = findToolNameForCall(messages, i);

    // Check if this tool result is eligible for shaking
    const replacement = getShakeReplacement(toolName, content, toolArgs);
    if (replacement === null) continue;

    // Only shake if we haven't already shaken for this same tool call id
    const callId = msg.tool_call_id ?? `idx-${i}`;
    if (seenToolCallIds.has(callId)) continue;
    seenToolCallIds.add(callId);

    // Perform the shake
    const originalSize = content.length;
    const targetMsg = messages[i];
    if (targetMsg) {
      targetMsg.content = replacement;
    }
    savedChars += originalSize - replacement.length;
    shaken += 1;
  }

  // Only return as performed if savings are meaningful
  if (savedChars < MIN_SAVINGS_CHARS) {
    return { shaken: 0, savedChars: 0, performed: false };
  }

  return { shaken, savedChars, performed: true };
}
