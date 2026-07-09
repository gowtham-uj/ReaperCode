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
import { compactionContextTokens } from "../config/context-budget.js";
import { getContextTunables } from "../config/config-tunables.js";
import { tokenUsageFromResponse } from "../context/token-budget.js";
import { TrajectoryLogger } from "../logging/trajectory.js";

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
    namedSession?: string;
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

export function createContextEngineeringHooks(
  options: ContextEngineeringHooksOptions = {},
): ContextEngineeringHooks {
  const infer = options.infer;
  const config = options.config;
  const countTokens = options.countTokens ?? ((msgs) => Math.ceil(estimateLiveConversationChars(msgs) / 4));

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
        }

        const { loadAllSummaries } = await import("../context/persistent-summary.js");
        const summaries = loadAllSummaries(workspaceRoot);
        if (namedSession || summaries.length > 0) {
          const { buildSessionResumeWithBody } = await import("../context/session-resume.js");
          const resume = await buildSessionResumeWithBody(workspaceRoot, {
            ...(sessionId ? { sessionId } : {}),
          });
          (globalThis as Record<string, unknown>)[`${runId}::session-resume`] = {
            resume,
            namedSession: namedSession ?? null,
            sessionId,
            stashedAt: Date.now(),
          };
        }
      } catch {
        /* best-effort — boot must not fail the run */
      }
    },

    async onBeforeModelCall({ workspaceRoot, runId, sessionId, traceId, messages, softCap, trajectoryLogger }) {
      const cmTunablesBefore = getContextTunables();
      let working: unknown[] = Array.isArray(messages) ? [...(messages as unknown[])] : [];

      // ─── OMP port: apply a stashed full-summary (post-compact messages)
      //   BEFORE running the cheaper layers. Same effect as OMP's
      //   `replaceMessages()` after `runAutoCompaction()`. The
      //   `runId::full-summary-applied` slot is set by the async
      //   summary path (line ~244) and consumed here on the next
      //   model call. Stale summaries (>30s old) are dropped — they
      //   are out of date by the time we'd consume them.
      const appliedSlot = (globalThis as any)[`${runId}::full-summary-applied`];
      if (appliedSlot && Array.isArray(appliedSlot.messages) && appliedSlot.messages.length > 0) {
        const ageMs = Date.now() - (appliedSlot.appliedAt ?? 0);
        if (ageMs <= 30_000) {
          working = appliedSlot.messages.slice();
          delete (globalThis as any)[`${runId}::full-summary-applied`];
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
          delete (globalThis as any)[`${runId}::full-summary-applied`];
        }
      }

      // T1 + T2: Consume the idle-compaction or
      // incomplete-recovery slot. When either is set, force a
      // full-summary compaction by lowering the threshold so
      // `shouldCompact` returns true. OMP equivalent: the
      // `runAutoCompaction` arm that fires post-event-controller
      // (idle) or post-checkCompaction (incomplete).
      const idleSlot = (globalThis as any)[`${runId}::idle-compaction`];
      const incompleteSlot = (globalThis as any)[`${runId}::incomplete-recovery`];
      const forceCompactFromIdleOrIncomplete = !!(idleSlot || incompleteSlot);
      if (idleSlot) delete (globalThis as any)[`${runId}::idle-compaction`];
      if (incompleteSlot) delete (globalThis as any)[`${runId}::incomplete-recovery`];

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
        const stashed = (globalThis as any)[`${runId}::last-input-tokens`];
        if (typeof stashed === "number" && Number.isFinite(stashed) && stashed > 0) {
          providerInputTokens = stashed;
        }
      } catch {
        /* best-effort */
      }
      const tokensForCompactGate = compactionContextTokens(providerInputTokens, tokensAfterShake);

      if (cmTunablesBefore.shakeEnabled && shaken > 0) {
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
      const cooldownSlotKey = `${runId}::full-summary-cooldown`;
      const cooldown = (globalThis as any)[cooldownSlotKey] as
        | { baselineTokens: number; toolBatchesSince: number; appliedAt: number }
        | undefined;
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
      if (fireFullSummary && infer) {
        const inflightKey = `${runId}::full-summary`;
        const runInfer = async (jsonl: string): Promise<string> => {
          if (!useHandoff) return infer(jsonl);
          const { HANDOFF_SUMMARY_SYSTEM_PROMPT, HANDOFF_SUMMARY_USER_PROMPT_INSTRUCTIONS } = await import("../context/handoff.js");
          return infer(`${HANDOFF_SUMMARY_SYSTEM_PROMPT}\n\n---\n\n${HANDOFF_SUMMARY_USER_PROMPT_INSTRUCTIONS}\n\n---\n\n${jsonl}`);
        };
        const applySummary = async (summaryText: string): Promise<void> => {
          const { persistSummary } = await import("../context/persistent-summary.js");
          const { buildPostCompactMessages } = await import("../context/full-summary.js");
          const preChars = estimateLiveConversationChars(working);
          const newMsgs = buildPostCompactMessages(summaryText, working as any, { softCap } as any);
          const postChars = estimateLiveConversationChars(newMsgs as unknown[]);
          working = newMsgs as unknown[];
          fullSummarized = true;
          const postTokens = countTokens(working);
          (globalThis as any)[`${runId}::full-summary-applied`] = {
            messages: newMsgs,
            summaryText,
            appliedAt: Date.now(),
          };
          (globalThis as any)[cooldownSlotKey] = {
            baselineTokens: postTokens,
            toolBatchesSince: 0,
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
            summary_chars: summaryText.length,
            kept_messages: newMsgs.length,
            ptl_drops: 0,
            saved_chars: Math.max(0, preChars - postChars),
            blocking: blockingFullSummary,
            ...(useHandoff ? { handoff_kind: "omp-4-section" } : {}),
          } as any).catch(() => undefined);
        };

        if (blockingFullSummary) {
          try {
            const existing = (globalThis as any)[inflightKey];
            let summaryText: string;
            if (existing?.promise && typeof existing.promise.then === "function") {
              summaryText = await existing.promise;
            } else {
              const jsonl = JSON.stringify(working);
              const inflightRef = { promise: runInfer(jsonl) };
              (globalThis as any)[inflightKey] = inflightRef;
              try {
                summaryText = await inflightRef.promise;
              } finally {
                if ((globalThis as any)[inflightKey] === inflightRef) {
                  (globalThis as any)[inflightKey] = undefined;
                }
              }
            }
            if (typeof summaryText === "string" && summaryText.length > 0) {
              await applySummary(summaryText);
            }
          } catch {
            /* best-effort — fall through with unshaken working set */
          }
        } else if (!(globalThis as any)[inflightKey]) {
          const jsonl = JSON.stringify(working);
          const inflightRef: { promise: Promise<string> } = (globalThis as any)[inflightKey] = {
            promise: runInfer(jsonl),
          };
          inflightRef.promise
            .then(async (summaryText: string) => {
              try {
                await applySummary(summaryText);
              } catch {
                /* best-effort */
              }
              return summaryText;
            })
            .finally(() => {
              if ((globalThis as any)[inflightKey] === inflightRef) {
                (globalThis as any)[inflightKey] = undefined;
              }
            });
        }
      }

      // #13: Compact tool history (T2.5)
      let toolHistoryCompacted = 0;
      try {
        const toolResults = (working as Array<Record<string, unknown>>)
          .filter((m) => m && (m as any).role === "tool" && (m as any).content)
          .map((m) => ({
            name: "tool",
            durationMs: 0,
            ok: true as const,
            toolCallId: (m as any).tool_call_id ?? "",
            output: (m as any).content,
          }));
        if (toolResults.length > 0) {
          const compact = compactToolHistory({
            toolResults,
            maxEntries: 40,
            enableStrategies: true,
          });
          toolHistoryCompacted = toolResults.length - compact.retained.length;
          if (toolHistoryCompacted > 0) {
            const compactMap = new Map(
              compact.retained.map((r: any) => [r.toolCallId, r.output ?? ""]),
            );
            working = (working as Array<Record<string, unknown>>).map((m) => {
              if (
                m && (m as any).role === "tool" && compactMap.has((m as any).tool_call_id)
              ) {
                return { ...m, content: compactMap.get((m as any).tool_call_id) };
              }
              return m;
            });
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
      workspaceRoot: _w, runId, sessionId, traceId, toolCallId: _tcid, toolName, output, trajectoryLogger, persistedOutputSize,
    }) {
      // Advance full-summary cooldown with every tool result so the
      // model can do real work before another expensive compact.
      const cooldownKey = `${runId}::full-summary-cooldown`;
      const cooldownState = (globalThis as any)[cooldownKey];
      if (cooldownState && typeof cooldownState === "object") {
        cooldownState.toolBatchesSince = Number(cooldownState.toolBatchesSince ?? 0) + 1;
      }
      const cm = getContextTunables();
      if (!cm.bashHeadTailEnabled) return { savedChars: 0 };
      if (toolName !== "bash" && toolName !== "run_shell_command") {
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
              // Stash a flag on the global slot so the next
              // `onBeforeModelCall` triggers a full summary before
              // the next model call (same pattern as
              // `full-summary-applied`).
              (globalThis as any)[`${runId}::incomplete-recovery`] = {
                triggeredAt: Date.now(),
                stopReason,
                tokensUsed,
              };
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
            const idleKey = `${runId}::idle-compaction-timer`;
            const existing = (globalThis as any)[idleKey];
            if (existing) clearTimeout(existing);
            const timeoutMs = cm.idleTimeoutSeconds * 1000;
            const t = setTimeout(() => {
              (globalThis as any)[idleKey] = undefined;
              // Re-check conditions when the timer fires (per OMP).
              const cm2 = getContextTunables();
              if (!cm2.idleEnabled || cm2.idleThresholdTokens <= 0) return;
              const tokensNow = Math.ceil(estimateLiveConversationChars(messages) / 4);
              if (tokensNow < cm2.idleThresholdTokens) return;
              // Stash a flag for the next onBeforeModelCall.
              (globalThis as any)[`${runId}::idle-compaction`] = {
                triggeredAt: Date.now(),
                tokensUsed: tokensNow,
              };
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
            (globalThis as any)[idleKey] = t;
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
        const rawUsage = tokenUsageFromResponse(modelResponse as any);
        let inputTokens = rawUsage?.inputTokens;
        let outputTokens = rawUsage?.outputTokens;
        if (inputTokens === undefined && outputTokens === undefined) {
          inputTokens = totalTokens;
          outputTokens = 0;
        }
        if (inputTokens || outputTokens) {
          await (trajectoryLogger as TrajectoryLogger).write({
            event_id: randomUUID(),
            run_id: runId,
            session_id: sessionId,
            trace_id: traceId ?? runId,
            timestamp: new Date().toISOString(),
            log_schema_version: 1,
            kind: "token_budget",
            level: "info",
            turn_input_tokens: inputTokens ?? 0,
            turn_output_tokens: outputTokens ?? 0,
            turn_cache_read_tokens: 0,
            turn_cache_write_tokens: 0,
            turn_call_count: 1,
            cumulative_input_tokens: inputTokens ?? 0,
            cumulative_output_tokens: outputTokens ?? 0,
            cumulative_cache_read_tokens: 0,
            cumulative_cache_write_tokens: 0,
            cumulative_call_count: 1,
            source: "wiring-token-budget",
          } as any).catch(() => undefined);
        }
      } catch {
        /* swallow */
      }
      return { used: totalTokens, totalChars, state, timeCompacted };
    },

    async onProviderTokenLimitError({ messages, softCap: _softCap, runId: providedRunId }) {
      const runKey = providedRunId ?? "default";
      const inflightKey = `${runKey}::full-summary`;
      const inflight = (globalThis as any)[inflightKey];
      if (inflight && typeof inflight.promise?.then === "function") {
        try {
          const summary = await Promise.race([
            inflight.promise,
            new Promise<string>((_resolve, reject) =>
              setTimeout(() => reject(new Error("timeout")), 240_000),
            ),
          ]);
          if (typeof summary === "string" && summary.length > 0) {
            (globalThis as any)[`${runKey}::full-summary-applied`] = {
              summaryText: summary,
              appliedAt: Date.now(),
            };
          }
        } catch {
          // best-effort
        }
      }
      const truncated = truncateHeadForPTLRecovery(messages as Array<Record<string, unknown>>, {
        maxDrops: 5,
      });
      const messagesArr = (truncated.messages as unknown[]) ?? messages;
      const ptlsaved = truncated.savedChars ?? 0;
      return { messages: messagesArr, savedChars: ptlsaved };
    },

    async onRunComplete({ workspaceRoot: _w, runId, sessionId, namedSession: _ns, assistantMessage, trajectoryLogger, success: _success, softCap: _softCap, usedChars }) {
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
      return { summaryPersisted: typeof assistantMessage === "string" };
    },
  };
}
