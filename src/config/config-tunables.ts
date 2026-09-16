/**
 * config/config-tunables.ts — runtime-tunable cache.
 *
 * The engine calls `applyConfigToTunables(config)` at boot. Each tunable
 * module (bash, bg-process, retry, etc.) exposes a getter that reads from
 * the cached values. Source code never reads from process.env anymore —
 * the config file is the single source of truth.
 *
 * The setters are idempotent and fall back safely so partial applies
 * still produce a working system. The "fallback" defaults here match the
 * starter-config values so anything not explicitly set gets the same
 * default the user would see if they ran `reaper init-config`.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { ReaperConfig } from "./model-config.js";
import {
  clampSoftCapTokens,
  REAPER_DEFAULT_SOFT_CAP_TOKENS,
} from "./context-hard-cap.js";

interface TunablesCache {
  bash: {
    defaultTimeoutMs: number;
    idleTimeoutMs: number;
    persistThresholdChars: number;
    previewSizeChars: number;
    assistantBlockingBudgetMs: number;
    maxOutputBytes: number;
    stallWatchdogIntervalMs: number;
    stallWatchdogNoOutputMs: number;
  };
  contextManagement: {
    /** Master switch for shake (default true). */
    shakeEnabled: boolean;
    /** Soft cap in tokens; default 100k for MiniMax-class windows. */
    softCap: number;
    /** When to fire shake (default 60% of softCap). */
    shakeTriggerPct: number;
    /** Protect the most-recent N chars from shake (default 20_000). */
    shakeProtectWindowChars: number;
    /** Min savings to actually run shake (default 100 chars). */
    shakeMinSavingsChars: number;
    /** Circuit breaker caps consecutive failures (default 3). */
    maxConsecutiveShakeFailures: number;
    /** PTL recovery: how many tool results to drop (default 5). */
    ptlRecoveryMaxDrops: number;
    /** PTL recovery: min content size to be drop-target (default 200). */
    ptlRecoveryMinChars: number;
    /** Spillover: outputs > this many bytes get persisted (default 8K). */
    spilloverThresholdBytes: number;
    /** Spillover: preview size to keep inline (default 1.2K). */
    spilloverPreviewChars: number;
    /** Time microcompact enabled (default true). */
    timeMicrocompactEnabled: boolean;
    /** Time microcompact gap in ms (default 5min production, 30s stress). */
    timeMicrocompactGapMs: number;
    /** Time microcompact keep-recent messages (default 5). */
    timeMicrocompactKeepRecent: number;
    /** Full summarization enabled (default true). */
    fullSummaryEnabled: boolean;
    /** Max recent files to re-anchor after summarization (default 5). */
    fullSummaryMaxFilesToRestore: number;
    /** Token budget for re-anchored files (default 50K). */
    fullSummaryFileTokenBudget: number;
    /** Max PTL retries during summarization (default 3). */
    fullSummaryMaxPtlRetries: number;
    /** Min chars before a tool result can be PTL-dropped during summary (default 200). */
    fullSummaryMinCharsForPtlDrop: number;
    /** Absolute character ceiling for an accepted summary body. */
    fullSummaryMaxOutputChars: number;
    /** Required fractional context savings before applying a summary. */
    fullSummaryMinSavingsRatio: number;
    /** Total character budget for checkpoint golden facts. */
    fullSummaryGoldenFactsMaxChars: number;
    /** Min tool batches after a full_summary before another may fire (default 2). */
    fullSummaryCooldownMinToolBatches: number;
    /**
     * Min token growth after a full_summary before another may fire.
     * 0 means derive as 8% of softCap at runtime.
     */
    fullSummaryCooldownMinTokenGrowth: number;
    /** Bash head+tail enabled (default true). */
    bashHeadTailEnabled: boolean;
    /** Bash preview size (default 1.2K head). */
    bashHeadPreviewChars: number;
    /** Bash tail preview size (default 1.2K tail). */
    bashTailPreviewChars: number;
    /** When outputs > this many chars they get persisted to disk (default 30K). */
    bashPersistThresholdChars: number;
    /** A user prompt larger than this many chars is spilled to a file instead
     *  of entering the conversation (default 20K, ~5K tokens). */
    promptSpillChars: number;
    /** Threshold ratios for context-warning-state telemetry. */
    warningThresholdRatio: number;
    errorThresholdRatio: number;
    blockingThresholdRatio: number;
    /** #21 Promote Context Model: enabled (default true). */
    modelPromotionEnabled: boolean;
    /** #21 Promote threshold ratio. */
    modelPromotionThresholdRatio: number;
    /**
     /** #21 Promote target role name. The wiring promotes to this
     * role (if registered in `config.models` and strictly larger
     * context than the active profile). Set to `null` to disable
     * the auto-pick and only emit the trajectory event.
     */
    modelPromotionTargetRole: string | null;
    /**
     * T1 Idle Compaction: when true, schedule a proactive compaction
     * via setTimeout(idleTimeoutSeconds * 1000) if the model has been
     * idle for that long and tokens exceed idleThresholdTokens. OMP
     * equivalent of `event-controller.ts:#scheduleIdleCompaction`.
     */
    idleEnabled: boolean;
    /** T1 Idle threshold: token-count that triggers idle compaction (OMP default 200k). */
    idleThresholdTokens: number;
    /**
     * T1 Idle timeout (clamped to [60, 3600] seconds per OMP).
     */
    idleTimeoutSeconds: number;
    /**
     * T2 Incomplete (length-stop) recovery: when true, proactively
     * compact when the model emits stopReason === "length" (i.e. hit
     * max_output_tokens without producing a usable deliverable).
     */
    incompleteRecoveryEnabled: boolean;
    /** T3 Handoff: prefer the smaller-context handoff LLM call over the
     * full OMP 9-section summary template.
     */
    handoffEnabled: boolean;
    /** T4 Snapcompact: image-cluster-aware compaction hook. No-op when
     * there are no image blocks in the live conversation.
     */
    snapcompactEnabled: boolean;
  };
  bg: {
    descendantTermGraceMs: number;
    killGraceMs: number;
    maxOutputLines: number;
    termGraceMs: number;
  };
  browser: {
    executablePath: string;
    headless: boolean;
    /**
     * The CDP endpoint of the browser Reaper attaches to.
     *
     * Configuration rather than a constant because it is the one thing that
     * changes if the arrangement does: `:9222` is Chrome's own remote-debugging
     * port, `:9223` is Steel's nginx forwarding to the same Chrome, and if Steel
     * ever became launcher-only this would point straight at Chrome. All three
     * are the same browser from Playwright's side.
     */
    cdpUrl: string;
    /**
     * Close a thread's browser after this long without use, in milliseconds.
     *
     * A browser per thread is memory held per thread, and a chat someone
     * abandoned an hour ago should not keep a page open forever. Ten minutes is
     * long enough that a conversation with a pause in it does not lose its
     * login.
     */
    idleCloseMs: number;
  };
  concurrency: {
    queueMaxConcurrency: number;
    tuiNoQueue: boolean;
  };
  engine: {
    liveModelTimeoutMs: number;
    mainAgentTransportRetryLimit: number;
    modelCallTimeoutMs: number;
    permissionMode: "yolo" | "accept_edits" | "auto" | "strict";
    printReasoning: boolean;
    progressGuardV2: boolean;
    rescueMaxAttemptsPerDiagnostic: number;
    rescueMaxStagnantTurns: number;
    streamIdleTimeoutMs: number;
    strictTempCleanup: boolean;
    swarmDebug: boolean;
  };
  sandbox: {
    tbenchContainerName: string;
    tbenchHostWorkspace: string;
    workspacePathAliases: string;
  };
}

const DEFAULTS: TunablesCache = {
  bash: {
    defaultTimeoutMs: 60_000,
    idleTimeoutMs: 45_000,
    persistThresholdChars: 30_000,
    previewSizeChars: 1_200,
    assistantBlockingBudgetMs: 120_000,
    maxOutputBytes: 50 * 1024 * 1024,
    stallWatchdogIntervalMs: 10_000,
    stallWatchdogNoOutputMs: 30_000,
  },
  contextManagement: {
    shakeEnabled: true,
    softCap: REAPER_DEFAULT_SOFT_CAP_TOKENS,
    shakeTriggerPct: 60,
    shakeProtectWindowChars: 64_000,
    shakeMinSavingsChars: 16_000,
    maxConsecutiveShakeFailures: 3,
    ptlRecoveryMaxDrops: 5,
    ptlRecoveryMinChars: 200,
    spilloverThresholdBytes: 8_192,
    spilloverPreviewChars: 1_200,
    timeMicrocompactEnabled: true,
    timeMicrocompactGapMs: 5 * 60 * 1000,
    timeMicrocompactKeepRecent: 5,
    fullSummaryEnabled: true,
    fullSummaryMaxFilesToRestore: 5,
    fullSummaryFileTokenBudget: 50_000,
    fullSummaryMaxPtlRetries: 3,
    fullSummaryMinCharsForPtlDrop: 200,
    fullSummaryMaxOutputChars: 16_000,
    fullSummaryMinSavingsRatio: 0.10,
    fullSummaryGoldenFactsMaxChars: 4_000,
    fullSummaryCooldownMinToolBatches: 2,
    fullSummaryCooldownMinTokenGrowth: 0,
    bashHeadTailEnabled: true,
    bashHeadPreviewChars: 1_200,
    bashTailPreviewChars: 1_200,
    bashPersistThresholdChars: 25_000,
    promptSpillChars: 20_000,
    modelPromotionEnabled: true,
    modelPromotionThresholdRatio: 0.5,
    modelPromotionTargetRole: "secondary_model" as string | null,
    // T1 Idle Compaction (defaults match OMP — disabled until user opts in).
    idleEnabled: false,
    idleThresholdTokens: 200_000,
    idleTimeoutSeconds: 300,
    // T2 Incomplete (length-stop) recovery — on by default.
    incompleteRecoveryEnabled: true,
    // T3 Handoff (smaller-context alternative) — off by default; users opt in.
    handoffEnabled: false,
    // T4 Snapcompact (image-cluster hook) — off by default; inert unless images flow.
    snapcompactEnabled: false,
    warningThresholdRatio: 0.70,
    errorThresholdRatio: 0.85,
    blockingThresholdRatio: 0.95,
  },
  bg: {
    descendantTermGraceMs: 5_000,
    killGraceMs: 3_000,
    maxOutputLines: 5_000,
    termGraceMs: 5_000,
  },
  browser: { executablePath: "", headless: true, cdpUrl: "http://127.0.0.1:9222", idleCloseMs: 600_000 },
  concurrency: { queueMaxConcurrency: 4, tuiNoQueue: false },
  engine: {
    liveModelTimeoutMs: 60_000,
    mainAgentTransportRetryLimit: 2,
    modelCallTimeoutMs: 120_000,
    permissionMode: "yolo",
    printReasoning: false,
    progressGuardV2: true,
    rescueMaxAttemptsPerDiagnostic: 1,
    rescueMaxStagnantTurns: 8,
    streamIdleTimeoutMs: 30_000,
    strictTempCleanup: true,
    swarmDebug: false,
  },
  sandbox: {
    tbenchContainerName: "",
    tbenchHostWorkspace: "",
    workspacePathAliases: "",
  },
};

let CACHE: TunablesCache = structuredClone(DEFAULTS);
const tunablesStorage = new AsyncLocalStorage<TunablesCache>();

function buildTunables(config: ReaperConfig): TunablesCache {
  const rt = config.runtimeTunables;
  const cm = (config as { contextManagement?: Record<string, number | boolean | string | null> }).contextManagement ?? {};
  return {
    bash: {
      defaultTimeoutMs: rt.bashDefaultTimeoutMs,
      idleTimeoutMs: rt.bashIdleTimeoutMs,
      persistThresholdChars: rt.bashPersistThresholdChars,
      previewSizeChars: rt.bashPreviewSizeChars,
      assistantBlockingBudgetMs: rt.bashAssistantBlockingBudgetMs,
      maxOutputBytes: rt.maxShellOutputBytes,
      stallWatchdogIntervalMs: rt.stallWatchdogIntervalMs,
      stallWatchdogNoOutputMs: rt.stallWatchdogNoOutputMs,
    },
    contextManagement: {
      shakeEnabled: Boolean(cm.shakeEnabled ?? true),
      softCap: clampSoftCapTokens(Number(cm.softCap ?? REAPER_DEFAULT_SOFT_CAP_TOKENS)),
      shakeTriggerPct: Number(cm.shakeTriggerPct ?? 60),
      shakeProtectWindowChars: Number(cm.shakeProtectWindowChars ?? 64_000),
      shakeMinSavingsChars: Number(cm.shakeMinSavingsChars ?? 16_000),
      maxConsecutiveShakeFailures: Number(cm.maxConsecutiveShakeFailures ?? 3),
      ptlRecoveryMaxDrops: Number(cm.ptlRecoveryMaxDrops ?? 5),
      ptlRecoveryMinChars: Number(cm.ptlRecoveryMinChars ?? 200),
      spilloverThresholdBytes: Number(cm.spilloverThresholdBytes ?? 8_192),
      spilloverPreviewChars: Number(cm.spilloverPreviewChars ?? 1_200),
      timeMicrocompactEnabled: Boolean(cm.timeMicrocompactEnabled ?? true),
      timeMicrocompactGapMs: Number(cm.timeMicrocompactGapMs ?? 5 * 60 * 1000),
      timeMicrocompactKeepRecent: Number(cm.timeMicrocompactKeepRecent ?? 5),
      fullSummaryEnabled: Boolean(cm.fullSummaryEnabled ?? true),
      fullSummaryMaxFilesToRestore: Number(cm.fullSummaryMaxFilesToRestore ?? 5),
      fullSummaryFileTokenBudget: Number(cm.fullSummaryFileTokenBudget ?? 50_000),
      fullSummaryMaxPtlRetries: Number(cm.fullSummaryMaxPtlRetries ?? 3),
      fullSummaryMinCharsForPtlDrop: Number(cm.fullSummaryMinCharsForPtlDrop ?? 200),
      fullSummaryMaxOutputChars: Math.min(16_384, Math.max(1, Number(cm.fullSummaryMaxOutputChars ?? 16_000))),
      fullSummaryMinSavingsRatio: Math.min(1, Math.max(0, Number(cm.fullSummaryMinSavingsRatio ?? 0.10))),
      fullSummaryGoldenFactsMaxChars: Math.min(16_000, Math.max(0, Number(cm.fullSummaryGoldenFactsMaxChars ?? 4_000))),
      fullSummaryCooldownMinToolBatches: Number(cm.fullSummaryCooldownMinToolBatches ?? 2),
      fullSummaryCooldownMinTokenGrowth: Number(cm.fullSummaryCooldownMinTokenGrowth ?? 0),
      bashHeadTailEnabled: Boolean(cm.bashHeadTailEnabled ?? true),
      bashHeadPreviewChars: Number(cm.bashHeadPreviewChars ?? 1_200),
      bashTailPreviewChars: Number(cm.bashTailPreviewChars ?? 1_200),
      bashPersistThresholdChars: Number(cm.bashPersistThresholdChars ?? 25_000),
      promptSpillChars: Number(cm.promptSpillChars ?? 20_000),
      modelPromotionEnabled: Boolean(cm.modelPromotionEnabled ?? true),
      modelPromotionThresholdRatio: Number(cm.modelPromotionThresholdRatio ?? 0.5),
      modelPromotionTargetRole: ((): string | null => {
        const raw = (cm as any).modelPromotionTargetRole;
        if (raw === null || raw === undefined) {
          return raw === null ? null : "secondary_model";
        }
        return String(raw);
      })(),
      // T1 Idle Compaction (OMP port).
      idleEnabled: Boolean((cm as any).idleEnabled ?? false),
      idleThresholdTokens: Number((cm as any).idleThresholdTokens ?? 200_000),
      idleTimeoutSeconds: Math.max(60, Math.min(3600, Number((cm as any).idleTimeoutSeconds ?? 300))),
      // T2 Incomplete (length-stop) recovery.
      incompleteRecoveryEnabled: Boolean((cm as any).incompleteRecoveryEnabled ?? true),
      // T3 Handoff (smaller-context summary alternative).
      handoffEnabled: Boolean((cm as any).handoffEnabled ?? false),
      // T4 Snapcompact (image-cluster hook; inert when no images).
      snapcompactEnabled: Boolean((cm as any).snapcompactEnabled ?? false),
      warningThresholdRatio: Number(cm.warningThresholdRatio ?? 0.70),
      errorThresholdRatio: Number(cm.errorThresholdRatio ?? 0.85),
      blockingThresholdRatio: Number(cm.blockingThresholdRatio ?? 0.95),
    },
    bg: {
      descendantTermGraceMs: rt.bgDescendantTermGraceMs,
      killGraceMs: rt.bgKillGraceMs,
      maxOutputLines: rt.bgMaxOutputLines,
      termGraceMs: rt.bgTermGraceMs,
    },
    browser: { executablePath: rt.browserExecutablePath, headless: rt.browserHeadless, cdpUrl: rt.browserCdpUrl, idleCloseMs: rt.browserIdleCloseMs },
    concurrency: { queueMaxConcurrency: rt.queueMaxConcurrency, tuiNoQueue: rt.tuiNoQueue },
    engine: {
      liveModelTimeoutMs: rt.liveModelTimeoutMs,
      mainAgentTransportRetryLimit: rt.mainAgentTransportRetryLimit,
      modelCallTimeoutMs: rt.modelCallTimeoutMs,
      permissionMode: rt.permissionMode,
      printReasoning: rt.printReasoning,
      progressGuardV2: rt.progressGuardV2,
      rescueMaxAttemptsPerDiagnostic: rt.rescueMaxAttemptsPerDiagnostic,
      rescueMaxStagnantTurns: rt.rescueMaxStagnantTurns,
      streamIdleTimeoutMs: rt.streamIdleTimeoutMs,
      strictTempCleanup: rt.strictTempCleanup,
      swarmDebug: rt.swarmDebug,
    },
    sandbox: {
      tbenchContainerName: rt.tbenchContainerName,
      tbenchHostWorkspace: rt.tbenchHostWorkspace,
      workspacePathAliases: rt.workspacePathAliases,
    },
  };
}

/** Apply config to the process fallback used outside a managed run scope. */
export function applyConfigToTunables(config: ReaperConfig): TunablesCache {
  CACHE = buildTunables(config);
  return CACHE;
}

/** Run work with an isolated set of tunables for the current async call tree. */
export function runWithConfigTunables<T>(config: ReaperConfig, fn: () => T): T {
  return tunablesStorage.run(buildTunables(config), fn);
}

export function getTunables(): Readonly<TunablesCache> {
  return tunablesStorage.getStore() ?? CACHE;
}

export function getBashTunables(): Readonly<TunablesCache["bash"]> {
  return getTunables().bash;
}

export function getContextTunables(): Readonly<TunablesCache["contextManagement"]> {
  return getTunables().contextManagement;
}

export function getBgTunables(): Readonly<TunablesCache["bg"]> {
  return getTunables().bg;
}

export function getEngineTunables(): Readonly<TunablesCache["engine"]> {
  return getTunables().engine;
}

export function getSandboxTunables(): Readonly<TunablesCache["sandbox"]> {
  return getTunables().sandbox;
}

export function getBrowserTunables(): Readonly<TunablesCache["browser"]> {
  return getTunables().browser;
}

export function getConcurrencyTunables(): Readonly<TunablesCache["concurrency"]> {
  return getTunables().concurrency;
}
