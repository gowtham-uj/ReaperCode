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
