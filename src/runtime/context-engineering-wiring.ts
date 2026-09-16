/**
 * Reaper's context-engineering wiring (single entry point for all 21
 * OMP-aligned layers). Every layer is wired by default with a runtime
 * opt-out via the config file.
 */
import { randomUUID } from "node:crypto";
import { shakeConversationWithBreaker, truncateHeadForPTLRecovery } from "../context/shake.js";
import { maybeTimeBasedMicrocompact } from "../context/time-microcompact.js";
import { compactToolHistory } from "../context/history-compaction.js";
import { pruneSupersededToolResults } from "../context/supersede-prune.js";
import { pruneToolOutputs } from "../context/tool-output-prune.js";
import type { ContextTechnique } from "./events.js";
import { compactionContextTokens } from "../config/context-budget.js";
import { getContextTunables } from "../config/config-tunables.js";
import { TokenBudgetTracker, tokenUsageFromResponse } from "../context/token-budget.js";
import { TrajectoryLogger } from "../logging/trajectory.js";
import {
  buildCompactionCheckpoint,
} from "../context/compaction-checkpoint.js";
import {
  clearRunState,
  getRunState,
  type FullSummaryAppliedSlot,
  type FullSummaryCooldownSlot,
  type FullSummaryInflightSlot,
  type IdleCompactionSlot,
  type IncompleteRecoverySlot,
  type SessionResumeStash,
} from "./run-state.js";

export interface ContextEngineeringHooksOptions {
  /** LLM inference callback used by full-summarization. Without this, full-summary is skipped. */
  infer?: (prompt: string) => Promise<string>;
  /** Token-counting function. Defaults to chars/4 heuristic. */
  countTokens?: (messages: unknown[]) => number;
  /**
   * When true (default), await full-summary before returning from onBeforeModelCall
   * so the compacted messages are applied on the same turn (OMP semantics).
   * Set false to restore the legacy fire-and-forget async path.
   */
  blockingFullSummary?: boolean;
  /**
   * Reaper config — used by #21 model-promotion to read sibling profiles.
   */
  config?: {
    models?: { [k: string]: { capabilities?: { maxContextTokens?: number }; model?: string } | undefined };
  };
  /**
   * Observer for context-management activity.
   *
   * Emitted from here rather than from the engine because this is the only
   * place that knows which technique ran. The engine sees an aggregate return
   * value (`shaken`, `savedChars`, `fullSummarized`) and cannot tell a 40-message
   * tool-history compaction from a shake that dropped three stale reads, which
   * are very different events to a person reading the transcript.
   *
   * Delivery is fail-open, like every other runtime observer: a disconnected UI
   * must not be able to fail a run that is otherwise compacting correctly.
   */
  onContextEvent?: (event: ContextEventPayload) => void | Promise<void>;
}

/**
 * A context window as a person would say it: "1M", "270k".
 *
 * Local to this file rather than shared with the UI because the two have
 * different jobs here: this one is producing a sentence for the transcript, and
 * the UI formats its own tokens from numbers it receives.
 */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** The body of a `context.updated` runtime event, minus its `type`. */
export interface ContextEventPayload {
  phase: "started" | "completed" | "failed";
  technique: ContextTechnique;
  savedChars?: number;
  savedTokens?: number;
  messagesBefore?: number;
  messagesAfter?: number;
  usedTokens?: number;
  softCap?: number;
  /**
   * A short human-readable note for the transcript, e.g. "3 superseded tool
   * results dropped". Kept out of `reason`, which means failure.
   */
  detail?: string;
  /** Why it failed. Present only on `phase: "failed"`. */
  reason?: string;
}

export interface ContextEngineeringHooks {
  onBoot(p: { workspaceRoot: string; runId: string; sessionId: string; namedSession?: string }): Promise<void>;
  onBeforeModelCall(p: {
    workspaceRoot: string;
    runId: string;
    sessionId: string;
    traceId?: string;
    messages: unknown[];
    softCap: number;
    trajectoryLogger?: unknown;
  }): Promise<{
    messages: unknown[];
    shaken: number;
    savedChars: number;
    savedTokens: number;
    fullSummarized: boolean;
    ptlDrops: number;
    toolHistoryCompacted: number;
    shakeBreakerTrips: number;
  }>;
  onAfterToolResult(p: {
    workspaceRoot: string;
    runId: string;
    sessionId: string;
    traceId?: string;
    toolCallId: string;
    toolName: string;
    output: string;
    trajectoryLogger?: unknown;
    persistedOutputSize?: number;
    /**
     * Where the *complete* output lives, when it exceeded the in-memory buffer
     * and was spilled to disk. The model is told this path in the tool result,
     * so the transcript row should name the same file rather than describing
     * the move in the abstract.
     */
    fullOutputPath?: string;
  }): Promise<{ savedChars: number }>;
  onAfterModelCall(p: {
    workspaceRoot: string;
    runId: string;
    sessionId: string;
    traceId?: string;
    modelResponse: unknown;
    messages: unknown[];
    softCap: number;
    trajectoryLogger?: unknown;
  }): Promise<{
    used: number;
    totalChars: number;
    state: { state: "ok" | "warning" | "error" | "blocking"; warnings: string[] };
    timeCompacted: number;
  }>;
  onProviderTokenLimitError(p: {
    messages: unknown[];
    softCap: number;
    runId?: string;
  }): Promise<{ messages: unknown[]; savedChars: number }>;
  onRunComplete(p: {
    workspaceRoot: string;
    runId: string;
    sessionId: string;
    traceId?: string;
    namedSession?: string;
    /** The run's user intent (exec preamble stripped) — journaled for named sessions. */
    userPrompt?: string;
    /** Final POST-TRANSFORM live conversation (shake/prune/summary applied). */
    conversation?: unknown[];
    assistantMessage: string;
    trajectoryLogger?: unknown;
    success?: boolean;
    softCap?: number;
    usedChars?: number;
  }): Promise<{ summaryPersisted: boolean }>;
}

interface ShakeBreakerState { consecutiveFailures: number; }
/** Per-run shake circuit breaker — never process-global across concurrent runs. */
const SHAKE_BREAKER_BY_RUN = new Map<string, ShakeBreakerState>();

function getShakeBreaker(runId: string): ShakeBreakerState {
  let state = SHAKE_BREAKER_BY_RUN.get(runId);
  if (!state) {
    state = { consecutiveFailures: 0 };
    SHAKE_BREAKER_BY_RUN.set(runId, state);
  }
  return state;
}

function estimateLiveConversationChars(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const content = rec.content;
    if (typeof content === "string") {
      total += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") total += part.length;
        else if (part && typeof part === "object") {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === "string") total += text.length;
        }
      }
    }
    if (Array.isArray(rec.tool_calls)) {
      for (const tc of rec.tool_calls) {
        if (tc && typeof tc === "object") {
          const fn = (tc as Record<string, unknown>).function as Record<string, unknown> | undefined;
          if (fn && typeof fn.arguments === "string") total += fn.arguments.length;
          if (fn && typeof fn.name === "string") total += (fn.name as string).length;
        }
      }
    }
  }
  return total;
}

function estimateModelResponseTokens(response: unknown): number {
  if (!response || typeof response !== "object") return 0;
  const record = response as Record<string, unknown>;
  let chars = 0;
  for (const key of ["content", "reasoningContent", "assistantMessage"]) {
    const value = record[key];
    if (typeof value === "string") chars += value.length;
  }
  if (Array.isArray(record.toolCalls)) {
    try {
      chars += JSON.stringify(record.toolCalls).length;
    } catch {
      /* best-effort estimate */
    }
  }
  return Math.ceil(chars / 4);
}

export function createContextEngineeringHooks(
  options: ContextEngineeringHooksOptions = {},
): ContextEngineeringHooks {
  const infer = options.infer;
  const config = options.config;
  const countTokens = options.countTokens ?? ((msgs) => Math.ceil(estimateLiveConversationChars(msgs) / 4));
  const tokenBudgetTracker = new TokenBudgetTracker();

  /**
   * Report one technique's activity without ever letting the report fail the run.
   *
   * `void` on the result: an observer that returns a promise is not awaited, so
   * a slow UI transport cannot add latency to the compaction path it is merely
   * describing. A rejection is swallowed for the same reason.
   */
  const noteContext = (payload: ContextEventPayload): void => {
    const sink = options.onContextEvent;
    if (!sink) return;
    try {
      void Promise.resolve(sink(payload)).catch(() => undefined);
    } catch {
      /* an observer is never part of runtime correctness */
    }
  };


  return {
    async onBoot({ workspaceRoot, runId, sessionId, namedSession }) {
      // Soft-context continuity: init journal (when named) and stash a
      // session-resume payload for the engine to prepend. Signature stays
      // Promise<void>; resume data lives on globalThis.
      try {
        if (namedSession) {
          const { initJournal, journalExists, isValidSessionName } = await import(
            "../context/session-journal.js"
          );
          if (isValidSessionName(namedSession) && !journalExists(workspaceRoot, namedSession)) {
            await initJournal({
              name: namedSession,
              workspaceRoot,
              cwd: workspaceRoot,
            }).catch(() => undefined);
          }

          // Coding-agent session continuity: when the named-session journal
          // already holds a prior conversation, rehydrate the REAL prior
          // messages so the next prompt sees the full session history — not
          // a lossy summary. This is the primary continuity path; the
          // summary/turn-index re-anchor below is only a fallback.
          if (isValidSessionName(namedSession) && journalExists(workspaceRoot, namedSession)) {
            const { buildActiveBranchMessages } = await import("../context/session-journal.js");
            const prior = buildActiveBranchMessages(workspaceRoot, namedSession)
              .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
              .map((m) => {
                const toolCalls =
                  Array.isArray(m.tool_calls) && m.tool_calls.length > 0
                    ? m.tool_calls.map((c) => ({
                        id: c.id,
                        type: "function" as const,
                        function: {
                          name: c.name,
                          arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args ?? {}),
                        },
                      }))
                    : undefined;
                return {
                  role: m.role,
                  content: typeof m.content === "string" ? m.content : "",
                  ...(typeof m.tool_call_id === "string" ? { tool_call_id: m.tool_call_id } : {}),
                  ...(toolCalls ? { tool_calls: toolCalls } : {}),
                  ...(typeof m.name === "string" && m.name !== "reaper_current_request" ? { name: m.name } : {}),
                  ...(typeof m.is_error === "boolean" ? { is_error: m.is_error } : {}),
                };
              })
              /*
               * Drop empty messages, but never a tool result.
               *
               * This read `content.trim().length > 0 || tool_calls`, which
               * removes a `tool` message whose output is an empty string while
               * keeping the assistant message that announced the call. The
               * result is a conversation the provider rejects:
               *
               *   HTTP 400 — An assistant message with 'tool_calls' must be
               *   followed by tool messages responding to each 'tool_call_id'.
               *
               * A tool result with empty content is still a well-formed answer
               * to its call, and it is the *pairing* that the provider checks,
               * not the content. The gateway repairs any orphan that reaches it
               * (see `model/repair-tool-pairing.ts`), but the cheapest place to
               * not create one is here.
               */
              .filter((m) => m.role === "tool" || m.content.trim().length > 0 || (m as { tool_calls?: unknown[] }).tool_calls);
            if (prior.length > 0) {
              const stash: SessionResumeStash = {
                resume: {
                  reAnchor: "",
                  rehydratedMessages: prior,
                  summary: null,
                  stats: { recentTurns: prior.length, recentChars: 0, summariesAvailable: 0 },
                  seededFromJournal: true,
                },
                namedSession,
                sessionId,
                stashedAt: Date.now(),
              };
              getRunState(runId).sessionResume = stash;
              return; // journal wins — skip the summary fallback
            }
          }
        }

        const { loadAllSummaries } = await import("../context/persistent-summary.js");
        const summaries = loadAllSummaries(workspaceRoot);
        if (namedSession || summaries.length > 0) {
          const { buildSessionResumeWithBody } = await import("../context/session-resume.js");
          const resume = await buildSessionResumeWithBody(workspaceRoot, {
            ...(sessionId ? { sessionId } : {}),
          });
          const stash: SessionResumeStash = {
            resume,
            namedSession: namedSession ?? null,
            sessionId,
            stashedAt: Date.now(),
          };
          getRunState(runId).sessionResume = stash;
        }
      } catch {
        /* best-effort — boot must not fail the run */
      }
    },

    async onBeforeModelCall({ workspaceRoot, runId, sessionId, traceId, messages, softCap, trajectoryLogger }) {
      const runState = getRunState(runId);
      const cmTunablesBefore = getContextTunables();
      let working: unknown[] = Array.isArray(messages) ? [...(messages as unknown[])] : [];

      // ─── OMP port: apply a stashed full-summary (post-compact messages)
      //   BEFORE running the cheaper layers. Same effect as OMP's
      //   `replaceMessages()` after `runAutoCompaction()`. The
      //   full-summary-applied slot is set by the async summary path
      //   (line ~244) and consumed here on the next model call. Stale
      //   summaries (>30s old) are dropped — they are out of date by
      //   the time we'd consume them.
      const appliedSlot = runState.fullSummaryApplied;
      if (appliedSlot && Array.isArray(appliedSlot.messages) && appliedSlot.messages.length > 0) {
        const ageMs = Date.now() - (appliedSlot.appliedAt ?? 0);
        if (ageMs <= 30_000) {
          working = appliedSlot.messages.slice();
          runState.fullSummaryApplied = undefined;
          try {
            await (trajectoryLogger as TrajectoryLogger).write({
              event_id: randomUUID(),
              run_id: runId,
              session_id: sessionId,
              trace_id: traceId ?? runId,
              timestamp: new Date().toISOString(),
              log_schema_version: 1,
              kind: "state_transition",
              level: "info",
              from_step: "Live Conversation",
              to_step: `Summary Replaced (age=${ageMs}ms, ${working.length} msgs)`,
            } as any);
          } catch { /* best-effort */ }
        } else {
          runState.fullSummaryApplied = undefined;
        }
      }

      // T1 + T2: Consume the idle-compaction or
      // incomplete-recovery slot. When either is set, force a
      // full-summary compaction by lowering the threshold so
      // `shouldCompact` returns true. OMP equivalent: the
      // `runAutoCompaction` arm that fires post-event-controller
      // (idle) or post-checkCompaction (incomplete).
      const idleSlot = runState.idleCompaction;
      const incompleteSlot = runState.incompleteRecovery;
      const forceCompactFromIdleOrIncomplete = !!(idleSlot || incompleteSlot);
      if (idleSlot) runState.idleCompaction = undefined;
      if (incompleteSlot) runState.incompleteRecovery = undefined;

      // #21: Promote Context Model (OMP port).
      if (cmTunablesBefore.modelPromotionEnabled && config?.models) {
        const tokensAfterShakeForPromote = countTokens(working);
        const ratio = softCap > 0 ? tokensAfterShakeForPromote / softCap : 0;
        if (ratio >= cmTunablesBefore.modelPromotionThresholdRatio) {
          const models = config.models as Record<string, any>;
          const activeProfile = models.mainAgent ?? models.default_model;
          const allProfiles = Object.entries(models) as Array<[string, any]>;
          if (activeProfile && typeof activeProfile?.capabilities?.maxContextTokens === "number") {
            const activeCtx = activeProfile.capabilities.maxContextTokens as number;
            // The promote-target role is configurable via
            // `contextManagement.modelPromotionTargetRole` in
            // .reaper/config.json. Defaults to "secondary_model".
            // Setting it to null disables auto-pick.
            const targetRole = cmTunablesBefore.modelPromotionTargetRole;
            const candidates = allProfiles
              .filter(([_, p]) => p && typeof p.capabilities?.maxContextTokens === "number")
              .filter(([_n, p]) => (p.capabilities.maxContextTokens as number) > activeCtx)
              .filter(
                ([n, _p]) =>
                  targetRole === null ? true : n === targetRole,
              )
              .sort((a, b) => (b[1].capabilities.maxContextTokens as number) - (a[1].capabilities.maxContextTokens as number));
            if (candidates.length > 0) {
              // The wiring's `candidates` is filtered to siblings with
              // strictly larger `capabilities.maxContextTokens` and
              // matching `modelPromotionTargetRole`. The first entry
              // is the chosen promote-target. We need the role name
              // (not just the model id) so the engine can swap
              // `modelRouting.mainAgent` correctly even when both
              // profiles use the same model id.
              const [promotedRoleName, promotedProfile] = candidates[0]!;
              // OMP port: persist the promotion so the engine can swap
              // the active mainAgent role on the next model call.
              try {
                const { recordPromotion } = await import("../context/promotions.js");
                await recordPromotion(workspaceRoot, {
                  runId,
                  sessionId,
                  timestamp: new Date().toISOString(),
                  // The wiring picks the active profile by
                  // `models.mainAgent ?? models.default_model`. We
                  // mirror that for the role name.
                  fromRole: models.mainAgent ? "mainAgent" : "default_model",
                  fromProfile: activeProfile.model ?? "(unknown)",
                  fromContextTokens: activeCtx,
                  toRole: promotedRoleName,
                  toProfile: promotedProfile.model ?? "(unknown)",
                  toContextTokens: promotedProfile.capabilities.maxContextTokens as number,
                  ratioTrigger: ratio,
                  softCap,
                });
              } catch {
                /* best-effort */
              }
              try {
                await (trajectoryLogger as TrajectoryLogger).write({
                  event_id: randomUUID(),
                  run_id: runId,
                  session_id: sessionId,
                  trace_id: traceId ?? runId,
                  timestamp: new Date().toISOString(),
                  log_schema_version: 1,
                  kind: "promoted_context_model",
                  level: "info",
                  from_role: models.mainAgent ? "mainAgent" : "default_model",
                  from_profile: activeProfile.model ?? "(unknown)",
                  from_context_tokens: activeCtx,
                  to_role: promotedRoleName,
                  to_profile: promotedProfile.model ?? "(unknown)",
                  to_context_tokens: promotedProfile.capabilities.maxContextTokens as number,
                  ratio_trigger: ratio,
                } as any);
              } catch {
                /* best-effort */
              }
              /*
               * Promotion is a context-management technique even though it
               * removes nothing: it is the alternative to compacting, chosen
               * because a bigger window is available. Without this the user
               * sees the model change with no explanation.
               */
              noteContext({
                phase: "completed",
                technique: "model_promotion",
                usedTokens: tokensAfterShakeForPromote,
                softCap,
                detail: `${activeProfile.model ?? "current model"} → ${promotedProfile.model ?? promotedRoleName} (${formatContextWindow(activeCtx)} → ${formatContextWindow(promotedProfile.capabilities.maxContextTokens as number)} window)`,
              });
            }
          }
        }
      }

      // #5b: Supersede prune (cheaper than shake for read-heavy loops)
      let superseded = 0;
      let supersedeSaved = 0;
      try {
        const pruneResult = pruneSupersededToolResults(working as Array<Record<string, unknown>>, {
          warmPrefixCount: 1,
        });
        superseded = pruneResult.pruned;
        supersedeSaved = pruneResult.savedChars;
        if (superseded > 0) {
          noteContext({
            phase: "completed",
            technique: "supersede",
            savedChars: supersedeSaved,
            softCap,
            detail: `${superseded} superseded tool result${superseded === 1 ? "" : "s"} dropped`,
          });
        }
      } catch {
        /* best-effort */
      }

      // OMP pruneToolOutputs: age-based truncate outside protect window
      // before shake / full-summary so cheap reclaim happens first.
      let toolOutputsPruned = 0;
      let toolOutputSaved = 0;
      try {
        const out = pruneToolOutputs(working as Array<Record<string, unknown>>, {
          warmPrefixCount: 1,
        });
        toolOutputsPruned = out.pruned;
        toolOutputSaved = out.savedChars;
        if (toolOutputsPruned > 0) {
          noteContext({
            phase: "completed",
            technique: "tool_output_prune",
            savedChars: toolOutputSaved,
            softCap,
            detail: `${toolOutputsPruned} aged tool output${toolOutputsPruned === 1 ? "" : "s"} truncated`,
          });
        }
      } catch {
        /* best-effort */
      }

      // #6, #7: Shake (cheapest LLM-free pass after supersede)
      const tokensBeforeShake = countTokens(working);
      let shaken = 0;
      let savedChars = 0;
      const breaker = getShakeBreaker(runId);
      if (cmTunablesBefore.shakeEnabled) {
        try {
          const { result, nextFailures } = shakeConversationWithBreaker(
            working as any,
            softCap,
            breaker.consecutiveFailures,
          );
          breaker.consecutiveFailures = nextFailures;
          if (result.performed && result.shaken > 0) {
            shaken = result.shaken;
            savedChars = result.savedChars;
            noteContext({
              phase: "completed",
              technique: "shake",
              savedChars,
              savedTokens: Math.max(0, tokensBeforeShake - countTokens(working)),
              softCap,
              // The count only. "Shook out stale results" beside "7 results
              // shaken out" said one thing twice; the label states the action
              // and the number is the new information.
              detail: `${shaken} result${shaken === 1 ? "" : "s"}`,
            });
          }
        } catch {
          breaker.consecutiveFailures += 1;
        }
      }

      const tokensAfterShake = countTokens(working);
      const tokensSavedByShake = Math.max(0, tokensBeforeShake - tokensAfterShake);

      // OMP compactionContextTokens: floor local estimate with last provider
      // input tokens so compressed wire payloads cannot under-trigger.
      let providerInputTokens = 0;
      try {
        const stashed = runState.lastInputTokens;
        if (typeof stashed === "number" && Number.isFinite(stashed) && stashed > 0) {
          providerInputTokens = stashed;
        }
      } catch {
        /* best-effort */
      }
      const tokensForCompactGate = compactionContextTokens(providerInputTokens, tokensAfterShake);

      if (
        cmTunablesBefore.shakeEnabled
        && (shaken > 0 || superseded > 0 || toolOutputsPruned > 0)
      ) {
        try {
          await (trajectoryLogger as TrajectoryLogger).write({
            event_id: randomUUID(),
            run_id: runId,
            session_id: sessionId,
            trace_id: traceId ?? runId,
            timestamp: new Date().toISOString(),
            log_schema_version: 1,
            kind: "context_shake",
            level: "info",
            shaken_results: shaken,
            saved_chars: savedChars,
            saved_tokens: tokensSavedByShake,
            consecutive_failures: breaker.consecutiveFailures,
            superseded_results: superseded,
            supersede_saved_chars: supersedeSaved,
            tool_outputs_pruned: toolOutputsPruned,
            tool_output_saved_chars: toolOutputSaved,
          } as any).catch(() => undefined);
        } catch {
          /* best-effort */
        }
      }

      // #10: Full summarization (LLM). When blockingFullSummary is true
      // (default), await and apply post-compact messages on THIS call —
      // OMP `runAutoCompaction` semantics. Legacy async path remains
      // available via options.blockingFullSummary === false.
      // T1/T2: also force-compact when idle-compaction or incomplete-
      // recovery slots are set, even if the natural threshold isn't crossed.
      // T3: optional handoff prompt for smaller-context summaries.
      // Cooldown: after a summary, suppress re-fire until enough tool
      // batches / token growth so post-compact rebuild cannot thrash.
      const fullSummaryEnabledConfig = cmTunablesBefore.fullSummaryEnabled;
      const { shouldCompact } = await import("../context/should-compact.js");
      const cooldown = runState.fullSummaryCooldown as FullSummaryCooldownSlot | undefined;
      const minBatches = Math.max(0, cmTunablesBefore.fullSummaryCooldownMinToolBatches ?? 2);
      const minGrowthConfigured = cmTunablesBefore.fullSummaryCooldownMinTokenGrowth ?? 0;
      const minGrowth =
        minGrowthConfigured > 0
          ? minGrowthConfigured
          : Math.max(1_000, Math.floor(softCap * 0.08));
      const cooldownActive = Boolean(
        cooldown &&
          cooldown.toolBatchesSince < minBatches &&
          tokensAfterShake < cooldown.baselineTokens + minGrowth,
      );
      const overThreshold = shouldCompact(tokensForCompactGate, softCap);
      const fireFullSummary =
        fullSummaryEnabledConfig &&
        (forceCompactFromIdleOrIncomplete || (overThreshold && !cooldownActive));
      let fullSummarized = false;
      const blockingFullSummary = options.blockingFullSummary !== false;
      const useHandoff = cmTunablesBefore.handoffEnabled === true;
      const fullSummaryOptions = {
        softCap,
        workspaceRoot,
        maxFilesToRestore: cmTunablesBefore.fullSummaryMaxFilesToRestore,
        postCompactFileTokenBudget: cmTunablesBefore.fullSummaryFileTokenBudget,
        maxPtlRetries: cmTunablesBefore.fullSummaryMaxPtlRetries,
        minCharsForPtlDrop: cmTunablesBefore.fullSummaryMinCharsForPtlDrop,
        maxSummaryChars: cmTunablesBefore.fullSummaryMaxOutputChars,
        minSavingsRatio: cmTunablesBefore.fullSummaryMinSavingsRatio,
        goldenFactsMaxChars: cmTunablesBefore.fullSummaryGoldenFactsMaxChars,
      };
      if (fireFullSummary && infer) {
        const inflightKey = "fullSummary" as const;
        const ptlConsumedKey = "fullSummaryPtlConsumed" as const;
        /*
         * Which label this compaction reports under. A handoff summary is a
         * different prompt chosen for smaller-context models and a forced
         * compaction triggered by a pending idle/recovery slot is different
         * again; all three land here, so the label is resolved once and reused
         * by both the failure and success branches rather than being restated.
         */
        const technique: ContextTechnique =
          forceCompactFromIdleOrIncomplete
            ? (idleSlot ? "idle_compaction" : "incomplete_recovery")
            : useHandoff
              ? "handoff_summary"
              : "full_summary";
        const preMessageCount = Array.isArray(working) ? working.length : 0;
        noteContext({
          phase: "started",
          technique,
          softCap,
          ...(providerInputTokens > 0 ? { usedTokens: providerInputTokens } : {}),
        });
        const armSummaryCooldown = (): void => {
          runState.fullSummaryCooldown = {
            baselineTokens: countTokens(working),
            toolBatchesSince: 0,
            appliedAt: Date.now(),
          };
        };
        const runInfer = async (summaryPrompt: string): Promise<string> => {
          if (!useHandoff) return infer(summaryPrompt);
          const { HANDOFF_SUMMARY_SYSTEM_PROMPT, HANDOFF_SUMMARY_USER_PROMPT_INSTRUCTIONS } = await import("../context/handoff.js");
          const conversationMarker = "## Conversation to summarize";
          const markerIndex = summaryPrompt.indexOf(conversationMarker);
          const conversation = markerIndex >= 0 ? summaryPrompt.slice(markerIndex) : summaryPrompt;
          const handoff = await infer(
            `${HANDOFF_SUMMARY_SYSTEM_PROMPT}\n\n---\n\n${HANDOFF_SUMMARY_USER_PROMPT_INSTRUCTIONS}\n\n---\n\n${conversation}`,
          );
          const cleaned = handoff
            .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
            .replace(/<\/?summary>/gi, "")
            .trim();
          return `<summary>${cleaned}</summary>`;
        };
        const summarizeWorkingConversation = async (): Promise<string> => {
          const { tryFullSummarization } = await import("../context/full-summary.js");
          const result = await tryFullSummarization(working as any[], {
            ...fullSummaryOptions,
            // The outer gate already decided to compact, including forced
            // idle/incomplete paths. Do not apply a second threshold here.
            thresholdTokens: 0,
            infer: runInfer,
          });
          if (!result?.performed) {
            throw new Error(
              result?.rejectionReason ??
              result?.summary ??
              "full-summary inference produced no usable summary",
            );
          }
          return result.summary;
        };
        const applySummary = async (summaryText: string): Promise<void> => {
          const { persistSummary } = await import("../context/persistent-summary.js");
          const { buildPostCompactMessages } = await import("../context/full-summary.js");
          const checkpoint = buildCompactionCheckpoint(summaryText, working as any[], {
            goldenFactsMaxChars: cmTunablesBefore.fullSummaryGoldenFactsMaxChars,
            maxFiles: cmTunablesBefore.fullSummaryMaxFilesToRestore,
          });
          const preChars = estimateLiveConversationChars(working);
          const newMsgs = buildPostCompactMessages(summaryText, working as any, {
            ...fullSummaryOptions,
            checkpoint,
          });
          const postChars = estimateLiveConversationChars(newMsgs as unknown[]);
          const savedChars = preChars - postChars;
          if (savedChars <= 0) {
            // A verbose summarizer can produce more context than it consumes.
            // Keep the source conversation and cool down before retrying.
            noteContext({
              phase: "failed",
              technique: technique,
              messagesBefore: (working as unknown[]).length,
              softCap,
              reason: "summary was larger than the conversation it replaced",
            });
            armSummaryCooldown();
            return;
          }
          working = newMsgs as unknown[];
          fullSummarized = true;
          const postTokens = countTokens(working);
          noteContext({
            phase: "completed",
            technique,
            savedChars,
            savedTokens: Math.max(0, tokensForCompactGate - postTokens),
            messagesBefore: preMessageCount,
            messagesAfter: (newMsgs as unknown[]).length,
            softCap,
            ...(providerInputTokens > 0 ? { usedTokens: providerInputTokens } : {}),
            ...(checkpoint.goldenFacts.length > 0
              ? { detail: `${checkpoint.goldenFacts.length} facts carried through the rewrite` }
              : {}),
          });
          // Blocking compaction is already returned to the engine in this
          // call. Only async compaction needs a one-shot next-call handoff;
          // replaying a blocking result would discard newer tool messages.
          if (!blockingFullSummary) {
            if (runState.fullSummaryPtlConsumed) {
              runState.fullSummaryPtlConsumed = undefined;
            } else {
              runState.fullSummaryApplied = {
                messages: newMsgs,
                summaryText,
                checkpoint,
                appliedAt: Date.now(),
              };
            }
          }
          runState.fullSummaryCooldown = {
            baselineTokens: postTokens,
            toolBatchesSince: 0,
            appliedAt: Date.now(),
          };
          // Session write-back: keep the LAST applied summary for this run so
          // onRunComplete can persist it as a journal compaction entry
          // (named sessions rehydrate summary + raw tail, OMP semantics).
          runState.lastFullSummary = {
            summaryText,
            preChars,
            postChars,
            checkpoint,
            epoch: checkpoint.epoch,
            appliedAt: Date.now(),
          };
          await persistSummary(workspaceRoot, {
            sessionId: sessionId,
            runId: runId,
            preChars,
            postChars,
            savedChars: preChars - postChars,
            ptlDrops: 0,
            reattachedFiles: 0,
            body: summaryText,
            epoch: checkpoint.epoch,
            checkpoint,
          } as any).catch(() => undefined);
          await (trajectoryLogger as TrajectoryLogger).write({
            event_id: randomUUID(),
            run_id: runId,
            session_id: sessionId,
            trace_id: traceId ?? runId,
            timestamp: new Date().toISOString(),
            log_schema_version: 1,
            kind: useHandoff ? "handoff_summary" : "full_summary",
            level: "info",
            summary: summaryText,
            summary_chars: summaryText.length,
            kept_messages: newMsgs.length,
            ptl_drops: 0,
            saved_chars: Math.max(0, preChars - postChars),
            summary_epoch: checkpoint.epoch,
            checkpoint_chars: JSON.stringify(checkpoint).length,
            golden_fact_count: checkpoint.goldenFacts.length,
            blocking: blockingFullSummary,
          } as any).catch(() => undefined);
        };

        if (blockingFullSummary) {
          try {
            const existing = runState.fullSummary;
            let summaryText: string;
            if (existing?.promise && typeof existing.promise.then === "function") {
              summaryText = await existing.promise;
            } else {
              const inflightRef: FullSummaryInflightSlot = {
                promise: summarizeWorkingConversation(),
              };
              runState.fullSummary = inflightRef;
              try {
                summaryText = await inflightRef.promise;
              } finally {
                if (runState.fullSummary === inflightRef) {
                  runState.fullSummary = undefined;
                }
              }
            }
            if (typeof summaryText === "string" && summaryText.length > 0) {
              await applySummary(summaryText);
            }
          } catch (error) {
            /*
             * Reported, not swallowed.
             *
             * The `started` event already told the user this technique was
             * running, so a silent catch here leaves a row that says
             * "Summarizing conversation…" and then never resolves — the worst
             * of the three outcomes, because it looks like a hang rather than a
             * decision. `tryFullSummarization` rejects a summary that costs more
             * than it saves, and that is information worth showing.
             */
            noteContext({
              phase: "failed",
              technique,
              messagesBefore: preMessageCount,
              softCap,
              reason: error instanceof Error ? error.message : "summarization failed",
            });
            armSummaryCooldown();
            /* best-effort — fall through with unshaken working set */
          }
        } else if (!runState.fullSummary) {
          const inflightRef: FullSummaryInflightSlot = {
            promise: summarizeWorkingConversation(),
          };
          runState.fullSummary = inflightRef;
          inflightRef.promise
            .then(async (summaryText: string) => {
              try {
                await applySummary(summaryText);
              } catch {
                /* best-effort */
              }
              return summaryText;
            })
            .catch(() => {
              armSummaryCooldown();
              runState.fullSummaryPtlConsumed = undefined;
            })
            .finally(() => {
              if (runState.fullSummary === inflightRef) {
                runState.fullSummary = undefined;
              }
            });
        }
      }

      // #13: Compact tool history (T2.5)
      let toolHistoryCompacted = 0;
      try {
        // Reconstruct the originating tool name + args for each tool
        // message from the preceding assistant `tool_calls` block so the
        // compactor sees real per-message identity instead of a hardcoded
        // `name: "tool"`. `ok` must reflect `is_error`, otherwise the
        // file-ops/latest-failure summaries mislabel every failed write as
        // a successful generic tool.
        const toolMeta = new Map<string, { name: string; args: unknown }>();
        for (const m of working as Array<Record<string, unknown>>) {
          const calls = (m as any)?.tool_calls;
          if (m && (m as any).role === "assistant" && Array.isArray(calls)) {
            for (const c of calls) {
              const id = c?.id;
              const name = c?.function?.name ?? c?.name;
              const args = c?.function?.arguments ?? c?.args;
              if (typeof id === "string" && typeof name === "string") {
                toolMeta.set(id, { name, args });
              }
            }
          }
        }
        const toolResults = (working as Array<Record<string, unknown>>)
          .filter((m) => m && (m as any).role === "tool" && (m as any).content)
          .map((m) => {
            const id = (m as any).tool_call_id ?? "";
            const meta = toolMeta.get(id);
            const output = (m as any).content;
            return {
              name: meta?.name ?? "tool",
              durationMs: 0,
              ok: !((m as any).is_error === true),
              toolCallId: id,
              output,
              ...(meta?.args !== undefined ? { args: meta.args } : {}),
            };
          });
        if (toolResults.length > 0) {
          const compact = compactToolHistory({
            toolResults,
            maxEntries: 40,
            enableStrategies: true,
          });
          toolHistoryCompacted = toolResults.length - compact.retained.length;
          if (toolHistoryCompacted > 0) {
            const beforeReplaceChars = estimateLiveConversationChars(working);
            /*
             * `content` must be a string, and the compactor does not always
             * return one.
             *
             * `renderCompactOutputForModel` returns a *record* for the tool
             * families it knows how to summarize (`file_view`, `bash`), because
             * that shape is what the tool-result renderer wants. Assigning it
             * here put a bare object where the provider expects text — measured,
             * a 15-character tool message became a 229KB JSON object with
             * character-indexed keys (`{"0":"R","1":"E",…}`), which both
             * invalidates the request and *grows* the conversation the pass was
             * supposed to shrink. A compacted conversation ended up 53% larger
             * than the original.
             *
             * Strings pass through untouched; anything structured is serialized,
             * which is what the model would have read anyway.
             */
            const asContent = (value: unknown): string =>
              typeof value === "string" ? value : JSON.stringify(value ?? "");
            const compactMap = new Map(
              compact.retained.map((r: any) => [r.toolCallId, asContent(r.output ?? "")]),
            );
            working = (working as Array<Record<string, unknown>>).map((m) => {
              if (
                m && (m as any).role === "tool" && compactMap.has((m as any).tool_call_id)
              ) {
                return { ...m, content: compactMap.get((m as any).tool_call_id) };
              }
              return m;
            });
            // Insert the compacted summaries of the dropped middle results
            // as synthetic context so the evidence survives — the full
            // middle messages are not deleted, but the summarizer's
            // distilled form is what the model actually reads next turn.
            if (compact.compacted.length > 0) {
              const summaryBlock = compact.compacted.join("\n");
              working = [...(working as unknown[]), {
                role: "user",
                name: "reaper_tool_compaction",
                content: `[Context Memory: compacted tool history]\n${summaryBlock}`,
              }];
            }
            /*
             * Reported only when the pass actually reclaimed something.
             *
             * `toolHistoryCompacted` counts results the compactor *chose* to
             * summarize, which is not the same as characters removed: on an
             * already-compacted conversation the summaries it produces can be
             * the same size as what they replace. Measured on the second pass of
             * a 12,977-character conversation, this reported "18 of 38 tool
             * results summarized — saved 0 characters", which tells a user the
             * agent rewrote their history to no effect. The honest outcome is
             * silence.
             */
            const toolHistorySavedChars = Math.max(0, beforeReplaceChars - estimateLiveConversationChars(working));
            if (toolHistorySavedChars > 0) {
              noteContext({
                phase: "completed",
                technique: "tool_history",
                savedChars: toolHistorySavedChars,
                softCap,
                detail: `${toolHistoryCompacted} of ${toolResults.length} tool results summarized`,
              });
            }
          }
        }
      } catch {
        /* swallow */
      }

      // T4: Snapcompact (image-cluster hook). OMP equivalent of
      // `compaction/snapcompact.ts:maybeSnapcompact`. Inert unless
      // `cmTunablesBefore.snapcompactEnabled === true` AND the live
      // conversation contains consecutive image blocks (≥3 by
      // default). Reaper treats images as opaque text today (no
      // media channels), so this hook is a no-op for current
      // models — but the path is wired so future image-aware
      // providers automatically benefit.
      let snapcompactedImages = 0;
      let snapcompactSavedChars = 0;
      if (cmTunablesBefore.snapcompactEnabled) {
        try {
          const { maybeSnapcompact } = await import("../context/snapcompact.js");
          const beforeCount = Array.isArray(working) ? working.length : 0;
          const snapResult = maybeSnapcompact(working as Array<Record<string, unknown>>);
          if (snapResult.performed) {
            snapcompactedImages = snapResult.collapsedImages;
            snapcompactSavedChars = snapResult.savedChars;
            noteContext({
              phase: "completed",
              technique: "snapcompact",
              savedChars: snapResult.savedChars,
              messagesBefore: beforeCount,
              messagesAfter: Array.isArray(working) ? working.length : 0,
              softCap,
              detail: `${snapResult.collapsedImages} image cluster${snapResult.collapsedImages === 1 ? "" : "s"} collapsed`,
            });
            await (trajectoryLogger as TrajectoryLogger).write({
              event_id: randomUUID(),
              run_id: runId,
              session_id: sessionId,
              trace_id: traceId ?? runId,
              timestamp: new Date().toISOString(),
              log_schema_version: 1,
              kind: "snapcompact",
              level: "info",
              collapsed_images: snapResult.collapsedImages,
              messages_before: beforeCount,
              messages_after: Array.isArray(working) ? working.length : 0,
              saved_chars: snapResult.savedChars,
            } as any).catch(() => undefined);
          }
        } catch {
          /* best-effort */
        }
      }

      return {
        messages: working,
        shaken,
        savedChars: savedChars + supersedeSaved + toolOutputSaved,
        savedTokens: tokensSavedByShake,
        fullSummarized,
        ptlDrops: 0,
        toolHistoryCompacted,
        shakeBreakerTrips: breaker.consecutiveFailures,
      };
    },

    async onAfterToolResult({
      workspaceRoot: _w, runId, sessionId, traceId, toolCallId: _tcid, toolName, output, trajectoryLogger, persistedOutputSize, fullOutputPath,
    }) {
      // Advance full-summary cooldown with every tool result so the
      // model can do real work before another expensive compact.
      const runState = getRunState(runId);
      const cooldownState = runState.fullSummaryCooldown;
      if (cooldownState && typeof cooldownState === "object") {
        cooldownState.toolBatchesSince = Number(cooldownState.toolBatchesSince ?? 0) + 1;
      }
      const cm = getContextTunables();
      if (!cm.bashHeadTailEnabled) return { savedChars: 0 };
      if (toolName !== "bash") {
        return { savedChars: 0 };
      }
      const wireHead = cm.bashHeadPreviewChars;
      const wireTail = cm.bashTailPreviewChars;
      const persisted = typeof persistedOutputSize === "number" ? persistedOutputSize : 0;
      const liveChars = output.length;
      const originalChars = Math.max(persisted, liveChars);
      const persistThreshold = cm.bashPersistThresholdChars;
      const emitFromBashExec = persisted > 0 && persisted >= persistThreshold;
      const emitFromWire = liveChars > persistThreshold;
      if (!emitFromBashExec && !emitFromWire) {
        return { savedChars: 0 };
      }
      const savedChars = Math.max(0, originalChars - (wireHead + wireTail));
      /*
       * Reported, because for a large-file workload this is the technique that
       * matters most and it leaves no other trace.
       *
       * A 100MB log read by `bash` never enters the conversation at all: the
       * full output goes to a file in the run's artifacts directory and only a
       * head/tail preview of a few thousand characters crosses the wire. That is
       * the difference between analysing a 100MB log within a 270k window and
       * never getting started, and without this the transcript would show the
       * preview appear from nowhere with no explanation of where the other
       * 99.99MB went.
       */
      /*
       * The detail line names the file, and nothing else.
       *
       * It has said two wrong things. First "30k of command output kept out of
       * context" beside a badge reading "−28k" — two numbers for one event,
       * measuring different things (raw output size vs characters the model
       * avoided), which invites the reader to work out which is true. Then
       * "large command output written to disk instead of context", which
       * restated the label "Moved output to disk" in longer words.
       *
       * What a reader actually wants from this row is the pointer: the output
       * is still there, and here is where. The saved figure is on the badge and
       * the fact of the move is in the label, so the path is what is left to
       * say.
       */
      noteContext({
        phase: "completed",
        technique: "bash_head_tail",
        savedChars,
        ...(fullOutputPath ? { detail: `read it at ${fullOutputPath}` } : {}),
      });
      try {
        await (trajectoryLogger as TrajectoryLogger)
          .write({
            event_id: randomUUID(),
            run_id: runId,
            session_id: sessionId,
            trace_id: traceId ?? runId,
            timestamp: new Date().toISOString(),
            log_schema_version: 1,
            kind: "bash_head_tail",
            level: "info",
            tool_name: toolName,
            original_chars: originalChars,
            preview_chars: wireHead + wireTail,
            saved_chars: savedChars,
          } as any)
          .catch(() => undefined);
      } catch {
        /* best-effort */
      }
      return { savedChars };
    },

    async onAfterModelCall({ workspaceRoot: _w, runId, sessionId, traceId, modelResponse, messages, softCap, trajectoryLogger }) {
      let timeCompacted = 0;
      const cm = getContextTunables();
      const runState = getRunState(runId);

      // T2: Incomplete (length-stop) recovery. OMP's
      // `#checkCompaction("incomplete", assistantMessage)` arm —
      // when the model emits `stopReason === "length"` (i.e. hit
      // `max_output_tokens` without producing a usable deliverable),
      // proactively compact before the next model call so the
      // retry has room to breathe.
      if (cm.incompleteRecoveryEnabled) {
        try {
          const stopReason = (modelResponse as any)?.stop_reason ?? (modelResponse as any)?.stopReason;
          if (stopReason === "length") {
            const tokensUsed = Math.ceil(estimateLiveConversationChars(messages) / 4);
            const { shouldCompact } = await import("../context/should-compact.js");
            if (shouldCompact(tokensUsed, softCap)) {
              // Stash a flag in run state so the next
              // `onBeforeModelCall` triggers a full summary before
              // the next model call (same pattern as
              // `fullSummaryApplied`).
              const slot: IncompleteRecoverySlot = {
                triggeredAt: Date.now(),
                stopReason,
                tokensUsed,
              };
              runState.incompleteRecovery = slot;
              await (trajectoryLogger as TrajectoryLogger).write({
                event_id: randomUUID(),
                run_id: runId,
                session_id: sessionId,
                trace_id: traceId ?? runId,
                timestamp: new Date().toISOString(),
                log_schema_version: 1,
                kind: "incomplete_recovery",
                level: "info",
                stop_reason: stopReason,
                tokens_used: tokensUsed,
                soft_cap: softCap,
              } as any).catch(() => undefined);
            }
          }
        } catch {
          /* swallow */
        }
      }

      // T1: Idle compaction scheduler. OMP equivalent of
      // `event-controller.ts:#scheduleIdleCompaction`. When the
      // model has been idle for `idleTimeoutSeconds` (default 300s)
      // AND tokens exceed `idleThresholdTokens`, fire a
      // proactive compaction via `setTimeout`. The scheduler is
      // re-armed on every turn. Conditions are re-checked when
      // the timer fires (model might be streaming again by then).
      if (cm.idleEnabled && cm.idleThresholdTokens > 0) {
        try {
          const totalTokens = Math.ceil(estimateLiveConversationChars(messages) / 4);
          if (totalTokens >= cm.idleThresholdTokens) {
            const existing = runState.idleCompactionTimer;
            if (existing) clearTimeout(existing);
            const timeoutMs = cm.idleTimeoutSeconds * 1000;
            const t = setTimeout(() => {
              runState.idleCompactionTimer = undefined;
              // Re-check conditions when the timer fires (per OMP).
              const cm2 = getContextTunables();
              if (!cm2.idleEnabled || cm2.idleThresholdTokens <= 0) return;
              const tokensNow = Math.ceil(estimateLiveConversationChars(messages) / 4);
              if (tokensNow < cm2.idleThresholdTokens) return;
              // Stash a flag for the next onBeforeModelCall.
              const slot: IdleCompactionSlot = {
                triggeredAt: Date.now(),
                tokensUsed: tokensNow,
              };
              runState.idleCompaction = slot;
              try {
                (trajectoryLogger as TrajectoryLogger)
                  .write({
                    event_id: randomUUID(),
                    run_id: runId,
                    session_id: sessionId,
                    trace_id: traceId ?? runId,
                    timestamp: new Date().toISOString(),
                    log_schema_version: 1,
                    kind: "idle_compaction",
                    level: "info",
                    idle_threshold_tokens: cm2.idleThresholdTokens,
                    idle_timeout_seconds: cm2.idleTimeoutSeconds,
                    tokens_used: tokensNow,
                    soft_cap: softCap,
                  } as any)
                  .catch(() => undefined);
              } catch {
                /* best-effort */
              }
            }, timeoutMs);
            // Best-effort: don't keep the Node event loop alive
            // just for an idle timer.
            if (typeof (t as any).unref === "function") {
              (t as any).unref();
            }
            runState.idleCompactionTimer = t;
          }
        } catch {
          /* swallow */
        }
      }

      // #9: Time microcompact
      if (cm.timeMicrocompactEnabled) {
        try {
          const tm = maybeTimeBasedMicrocompact(messages as Array<Record<string, unknown>>, {
            nowMs: Date.now(),
            gapMs: cm.timeMicrocompactGapMs,
            keepRecent: cm.timeMicrocompactKeepRecent,
          });
          if (tm && tm.clearedResults > 0) {
            timeCompacted = tm.clearedResults;
            const beforeCount = Array.isArray(messages) ? messages.length : 0;
            noteContext({
              phase: "completed",
              technique: "microcompact",
              savedChars: tm.savedChars,
              messagesBefore: beforeCount,
              messagesAfter: beforeCount,
              detail: `${tm.clearedResults} stale tool result${tm.clearedResults === 1 ? "" : "s"} cleared after the idle gap`,
            });
            await (trajectoryLogger as TrajectoryLogger).write({
              event_id: randomUUID(),
              run_id: runId,
              session_id: sessionId,
              trace_id: traceId ?? runId,
              timestamp: new Date().toISOString(),
              log_schema_version: 1,
              kind: "time_microcompact",
              level: "info",
              cleared_messages: tm.clearedResults,
              messages_before: beforeCount,
              messages_after: beforeCount,
              saved_chars: tm.savedChars,
            } as any).catch(() => undefined);
          }
        } catch {
          /* swallow */
        }
      }
      const totalChars = estimateLiveConversationChars(messages);
      const totalTokens = Math.ceil(totalChars / 4);
      let state: { state: "ok" | "warning" | "error" | "blocking"; warnings: string[] } = { state: "ok", warnings: [] };
      const ratio = softCap > 0 ? totalTokens / softCap : 0;
      if (ratio >= cm.blockingThresholdRatio) state = { state: "blocking", warnings: ["blocking"] };
      else if (ratio >= cm.errorThresholdRatio) state = { state: "error", warnings: ["error"] };
      else if (ratio >= cm.warningThresholdRatio) state = { state: "warning", warnings: ["warning"] };
      try {
        const usage = tokenUsageFromResponse(modelResponse as any) ?? {
          inputTokens: totalTokens,
          outputTokens: estimateModelResponseTokens(modelResponse),
        };
        tokenBudgetTracker.beginTurn();
        tokenBudgetTracker.record(usage);
        const tokenSnapshot = tokenBudgetTracker.snapshot();
        await (trajectoryLogger as TrajectoryLogger).write({
          event_id: randomUUID(),
          run_id: runId,
          session_id: sessionId,
          trace_id: traceId ?? runId,
          timestamp: new Date().toISOString(),
          log_schema_version: 1,
          kind: "token_budget",
          level: "info",
          turn_input_tokens: tokenSnapshot.inputTokens,
          turn_output_tokens: tokenSnapshot.outputTokens,
          turn_cache_read_tokens: tokenSnapshot.cacheReadTokens,
          turn_cache_write_tokens: tokenSnapshot.cacheWriteTokens,
          turn_call_count: tokenSnapshot.callCount,
          cumulative_input_tokens: tokenSnapshot.cumulativeInputTokens,
          cumulative_output_tokens: tokenSnapshot.cumulativeOutputTokens,
          cumulative_cache_read_tokens: tokenSnapshot.cumulativeCacheReadTokens,
          cumulative_cache_write_tokens: tokenSnapshot.cumulativeCacheWriteTokens,
          cumulative_call_count: tokenSnapshot.cumulativeCallCount,
          source: "wiring-token-budget",
        } as any).catch(() => undefined);
      } catch {
        /* swallow */
      }
      return { used: totalTokens, totalChars, state, timeCompacted };
    },

    async onProviderTokenLimitError({ messages, softCap, runId: providedRunId }) {
      const runKey = providedRunId ?? "default";
      const runState = getRunState(runKey);
      const inflight = runState.fullSummary;
      if (inflight && typeof inflight.promise?.then === "function") {
        runState.fullSummaryPtlConsumed = Date.now();
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          const summary = await Promise.race([
            inflight.promise,
            new Promise<string>((_resolve, reject) => {
              timeoutHandle = setTimeout(() => reject(new Error("timeout")), 240_000);
            }),
          ]);
          if (typeof summary === "string" && summary.length > 0) {
            const { buildPostCompactMessages } = await import("../context/full-summary.js");
            const cmTunables = getContextTunables();
            const checkpoint = buildCompactionCheckpoint(summary, messages as any[], {
              goldenFactsMaxChars: cmTunables.fullSummaryGoldenFactsMaxChars,
              maxFiles: cmTunables.fullSummaryMaxFilesToRestore,
            });
            const postCompactMessages = buildPostCompactMessages(summary, messages as any[], {
              softCap,
              maxFilesToRestore: cmTunables.fullSummaryMaxFilesToRestore,
              postCompactFileTokenBudget: cmTunables.fullSummaryFileTokenBudget,
              maxPtlRetries: cmTunables.fullSummaryMaxPtlRetries,
              minCharsForPtlDrop: cmTunables.fullSummaryMinCharsForPtlDrop,
              maxSummaryChars: cmTunables.fullSummaryMaxOutputChars,
              minSavingsRatio: cmTunables.fullSummaryMinSavingsRatio,
              goldenFactsMaxChars: cmTunables.fullSummaryGoldenFactsMaxChars,
              checkpoint,
            });
            const savedChars = Math.max(
              0,
              estimateLiveConversationChars(messages) - estimateLiveConversationChars(postCompactMessages),
            );
            // Both PTL callers retry immediately with this same live array.
            // Replace it in place; a next-call stash would replay stale state
            // after the retry's tool results had already been appended.
            messages.splice(0, messages.length, ...postCompactMessages);
            runState.fullSummaryApplied = undefined;
            return { messages, savedChars };
          }
        } catch {
          // Best effort: fall through to bounded head truncation.
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      }
      const truncated = truncateHeadForPTLRecovery(messages as Array<Record<string, unknown>>, {
        maxDrops: 5,
      });
      const messagesArr = (truncated.messages as unknown[]) ?? messages;
      const ptlsaved = truncated.savedChars ?? 0;
      /*
       * Reported always, even at zero saved characters. This path runs because
       * the provider already rejected the request for being too long, so the
       * user needs to see that Reaper responded to it — including when the
       * recovery had nothing left to drop, which is the case that ends in a
       * hard failure and would otherwise look like the turn simply died.
       */
      noteContext({
        phase: ptlsaved > 0 ? "completed" : "failed",
        technique: "ptl_recovery",
        savedChars: ptlsaved,
        messagesBefore: Array.isArray(messages) ? messages.length : 0,
        messagesAfter: Array.isArray(messagesArr) ? messagesArr.length : 0,
        softCap,
        ...(ptlsaved > 0
          ? { detail: "oldest turns dropped after the provider rejected the request" }
          : { reason: "nothing left to drop after the provider rejected the request" }),
      });
      return { messages: messagesArr, savedChars: ptlsaved };
    },

    async onRunComplete({ workspaceRoot, runId, sessionId, namedSession, userPrompt, conversation, assistantMessage, trajectoryLogger, success: _success, softCap: _softCap, usedChars }) {
      const runState = getRunState(runId);
      try {
        await (trajectoryLogger as TrajectoryLogger).write({
          event_id: randomUUID(),
          run_id: runId,
          session_id: sessionId,
          trace_id: runId,
          timestamp: new Date().toISOString(),
          log_schema_version: 1,
          kind: "session_metrics",
          level: "info",
          tool_count: 0,
          failure_count: 0,
          verification_attempts: 0,
          total_runtime_ms: 0,
          total_tool_calls: 0,
          ...(usedChars !== undefined ? { used_chars: usedChars } : {}),
        } as any).catch(() => undefined);
      } catch {
        /* best-effort */
      }
      // Pi-style: the message tree is already in session.jsonl from mid-run
      // writes (user_message / assistant_message / tool_call → message entries).
      // No separate journal append and no live-conversation snapshot replay.
      void namedSession;
      void userPrompt;
      void conversation;
      runState.lastFullSummary = undefined;
      runState.rehydratedCount = undefined;
      // Free the per-run state entry. Pending timers and any cached
      // resume/cool-down/applied slots are dropped with it.
      clearRunState(runId);
      return { summaryPersisted: typeof assistantMessage === "string" };
    },
  };
}
