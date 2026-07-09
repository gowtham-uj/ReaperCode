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
    /** T1 Idle threshold: token-count that triggers idle compaction. */
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
  };
  computer: {
    autoApprove: boolean;
    enableGlobalHook: boolean;
  };
  concurrency: {
    queueMaxConcurrency: number;
    tuiNoQueue: boolean;
  };
  engine: {
    langgraphRecursionLimit: number;
    liveModelTimeoutMs: number;
    mainAgentTransportRetryLimit: number;
    modelCallTimeoutMs: number;
    modelRouterLlmDecisions: boolean;
    permissionMode: string;
    printReasoning: boolean;
    progressGuardV2: boolean;
    rescueMaxAttemptsPerDiagnostic: number;
    rescueMaxStagnantTurns: number;
    streamIdleTimeoutMs: number;
    strictCompletionGate: boolean;
    strictTempCleanup: boolean;
    swarmDebug: boolean;
    unattendedRetry: boolean;
  };
  retry: {
    baseDelayMs: number;
    deadlineHeadroomMs: number;
    fallbackAfterOverloaded: boolean;
    keepAliveMs: number;
    maxDelayMs: number;
    maxRetries: number;
    runDeadlineEpochMs: number;
  };
  sandbox: {
    tbenchComposeProject: string;
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
    shakeProtectWindowChars: 20_000,
    shakeMinSavingsChars: 100,
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
    fullSummaryCooldownMinToolBatches: 2,
    fullSummaryCooldownMinTokenGrowth: 0,
    bashHeadTailEnabled: true,
    bashHeadPreviewChars: 1_200,
    bashTailPreviewChars: 1_200,
    bashPersistThresholdChars: 25_000,
    modelPromotionEnabled: true,
    modelPromotionThresholdRatio: 0.5,
    modelPromotionTargetRole: "secondary_model" as string | null,
    // T1 Idle Compaction (defaults match OMP — disabled until user opts in).
    idleEnabled: false,
    idleThresholdTokens: 0,
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
  browser: { executablePath: "", headless: true },
  computer: { autoApprove: false, enableGlobalHook: false },
  concurrency: { queueMaxConcurrency: 4, tuiNoQueue: false },
  engine: {
    langgraphRecursionLimit: 50,
    liveModelTimeoutMs: 60_000,
    mainAgentTransportRetryLimit: 2,
    modelCallTimeoutMs: 120_000,
    modelRouterLlmDecisions: false,
    permissionMode: "yolo",
    printReasoning: false,
    progressGuardV2: true,
    rescueMaxAttemptsPerDiagnostic: 1,
    rescueMaxStagnantTurns: 8,
    streamIdleTimeoutMs: 30_000,
    strictCompletionGate: true,
    strictTempCleanup: true,
    swarmDebug: false,
    unattendedRetry: true,
  },
  retry: {
    baseDelayMs: 500,
    deadlineHeadroomMs: 5_000,
    fallbackAfterOverloaded: true,
    keepAliveMs: 1_500,
    maxDelayMs: 8_000,
    maxRetries: 3,
    runDeadlineEpochMs: 0,
  },
  sandbox: {
    tbenchComposeProject: "",
    tbenchContainerName: "",
    tbenchHostWorkspace: "",
    workspacePathAliases: "",
  },
};

let CACHE: TunablesCache = structuredClone(DEFAULTS);

export function applyConfigToTunables(config: ReaperConfig): TunablesCache {
  const rt = config.runtimeTunables;
  const cm = (config as { contextManagement?: Record<string, number | boolean | string | null> }).contextManagement ?? {};
  CACHE = {
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
      shakeProtectWindowChars: Number(cm.shakeProtectWindowChars ?? 20_000),
      shakeMinSavingsChars: Number(cm.shakeMinSavingsChars ?? 100),
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
      fullSummaryCooldownMinToolBatches: Number(cm.fullSummaryCooldownMinToolBatches ?? 2),
      fullSummaryCooldownMinTokenGrowth: Number(cm.fullSummaryCooldownMinTokenGrowth ?? 0),
      bashHeadTailEnabled: Boolean(cm.bashHeadTailEnabled ?? true),
      bashHeadPreviewChars: Number(cm.bashHeadPreviewChars ?? 1_200),
      bashTailPreviewChars: Number(cm.bashTailPreviewChars ?? 1_200),
      bashPersistThresholdChars: Number(cm.bashPersistThresholdChars ?? 25_000),
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
      idleThresholdTokens: Number((cm as any).idleThresholdTokens ?? 0),
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
    browser: { executablePath: rt.browserExecutablePath, headless: rt.browserHeadless },
    computer: { autoApprove: rt.computerAutoApprove, enableGlobalHook: rt.computerEnableGlobalHook },
    concurrency: { queueMaxConcurrency: rt.queueMaxConcurrency, tuiNoQueue: rt.tuiNoQueue },
    engine: {
      langgraphRecursionLimit: rt.langgraphRecursionLimit,
      liveModelTimeoutMs: rt.liveModelTimeoutMs,
      mainAgentTransportRetryLimit: rt.mainAgentTransportRetryLimit,
      modelCallTimeoutMs: rt.modelCallTimeoutMs,
      modelRouterLlmDecisions: rt.modelRouterLlmDecisions,
      permissionMode: rt.permissionMode,
      printReasoning: rt.printReasoning,
      progressGuardV2: rt.progressGuardV2,
      rescueMaxAttemptsPerDiagnostic: rt.rescueMaxAttemptsPerDiagnostic,
      rescueMaxStagnantTurns: rt.rescueMaxStagnantTurns,
      streamIdleTimeoutMs: rt.streamIdleTimeoutMs,
      strictCompletionGate: rt.strictCompletionGate,
      strictTempCleanup: rt.strictTempCleanup,
      swarmDebug: rt.swarmDebug,
      unattendedRetry: rt.unattendedRetry,
    },
    retry: {
      baseDelayMs: rt.retryBaseDelayMs,
      deadlineHeadroomMs: rt.retryDeadlineHeadroomMs,
      fallbackAfterOverloaded: rt.retryFallbackAfterOverloaded,
      keepAliveMs: rt.retryKeepAliveMs,
      maxDelayMs: rt.retryMaxDelayMs,
      maxRetries: rt.retryMaxRetries,
      runDeadlineEpochMs: rt.runDeadlineEpochMs,
    },
    sandbox: {
      tbenchComposeProject: rt.tbenchComposeProject,
      tbenchContainerName: rt.tbenchContainerName,
      tbenchHostWorkspace: rt.tbenchHostWorkspace,
      workspacePathAliases: rt.workspacePathAliases,
    },
  };
  return CACHE;
}

export function getTunables(): Readonly<TunablesCache> {
  return CACHE;
}

export function getBashTunables(): Readonly<TunablesCache["bash"]> {
  return CACHE.bash;
}

export function getContextTunables(): Readonly<TunablesCache["contextManagement"]> {
  return CACHE.contextManagement;
}

export function getBgTunables(): Readonly<TunablesCache["bg"]> {
  return CACHE.bg;
}

export function getEngineTunables(): Readonly<TunablesCache["engine"]> {
  return CACHE.engine;
}

export function getRetryTunables(): Readonly<TunablesCache["retry"]> {
  return CACHE.retry;
}

export function getSandboxTunables(): Readonly<TunablesCache["sandbox"]> {
  return CACHE.sandbox;
}

export function getComputerTunables(): Readonly<TunablesCache["computer"]> {
  return CACHE.computer;
}

export function getBrowserTunables(): Readonly<TunablesCache["browser"]> {
  return CACHE.browser;
}

export function getConcurrencyTunables(): Readonly<TunablesCache["concurrency"]> {
  return CACHE.concurrency;
}
