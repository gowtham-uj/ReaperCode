/**
 * context/handoff.ts — T3 OMP port: smaller-context summarization.
 *
 * OMP's `generateHandoffFromContext` produces a tighter narrative focused
 * on the active task rather than the full 9-section summary template.
 * This is faster (fewer output tokens), cheaper (smaller model can run it),
 * and good enough for short sessions where full-summary's structure adds
 * noise.
 *
 * Differences from full-summary:
 * - Output template: 4 sections (active task, current state, files touched,
 *   next action) instead of 9.
 * - No "primary requirements" header (handoff assumes the model already
 *   has them from the recent prefix).
 * - Compresses aggressively — drops everything older than the most-recent
 *   3 user tasks.
 *
 * Wire path: when `cm.handoffEnabled === true` AND `tokensAfterShake >
 * softCap - reserve` (the same OMP gate as full-summary), the wiring
 * calls `infer(handoffPrompt)` instead of `infer(fullSummaryPrompt)`.
 */
import { shouldCompact } from "./should-compact.js";

/**
 * OMP-style handoff summary user prompt — 4 sections, focused on the
 * active task. Mirrors OMP's `renderHandoffPrompt` template.
 */
export const HANDOFF_SUMMARY_SYSTEM_PROMPT = `You are summarizing a long-running agent conversation so it can be re-attached to a fresh context window. Write a tight 4-section handoff that gives the next agent enough information to pick up exactly where this one left off.

Rules:
- Be terse. Each section ≤ 8 short lines.
- Cite file paths verbatim; do NOT paraphrase.
- Preserve all primary requirements verbatim.
- Drop anything older than the most-recent 3 user tasks unless it is a hard prerequisite.
- Do NOT include any meta-commentary, preamble, or "I am an AI".
- Output ONLY the 4 sections, no other text.`;

export const HANDOFF_SUMMARY_USER_PROMPT_INSTRUCTIONS = `Produce a handoff summary with EXACTLY these 4 sections, in this order:

## Active Task
What the user asked for and where the agent is in completing it. Quote the latest user message verbatim.

## Current State
- What's done so far (specific file paths + line ranges where useful)
- What's in progress right now
- What's blocked and why

## Files Touched
List every file path modified, read, or otherwise inspected this session, with a one-line note on what happened to each.

## Next Action
The single most-important thing the next agent should do next, in 1-2 sentences. Be specific about which tool to call and with what arguments.

Begin the handoff now.`;

export interface HandoffSummaryOptions {
  /** Soft cap (token count) for the live conversation. */
  softCap: number;
}

export interface HandoffSummaryDecision {
  /** Whether the handoff should fire. */
  fire: boolean;
  /** The OMP-aligned threshold token count. */
  thresholdTokens: number;
  /** Token count observed. */
  tokensUsed: number;
}

/**
 * Single source of truth for the handoff fire condition. Mirrors
 * `shouldCompact` from should-compact.ts — same threshold semantics.
 */
export function shouldHandoff(
  tokensAfterShake: number,
  softCap: number,
): HandoffSummaryDecision {
  const thresholdTokens = Math.max(0, softCap - Math.max(16_384, Math.floor(softCap * 0.15)));
  return {
    fire: tokensAfterShake > thresholdTokens,
    thresholdTokens,
    tokensUsed: tokensAfterShake,
  };
}

/**
 * Re-export of shouldCompact for symmetry with full-summary. When the
 * caller wants the gate value, prefer shouldHandoff since it gives
 * explicit threshold/tokensUsed fields.
 */
export { shouldCompact };