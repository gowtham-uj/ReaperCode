/**
 * config/starter-config.ts — generate a starter .reaper/config.json.
 *
 * The starter writes every required field explicitly, no defaults. After
 * running `reaper init-config`, the user edits the resulting JSON to set
 * their API keys and tune thresholds. This makes the config file the
 * single source of truth — no implicit defaults, no env fallbacks.
 *
 * The starter is the only place where values are written without the
 * user's consent. After it's emitted, every value lives in the config
 * file and Reaper reads from there.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface StarterConfigInput {
  workspaceRoot: string;
  /** When true, overwrite an existing config without prompting. */
  force?: boolean;
  /** Optional model name to seed as the default model. */
  defaultModel?: string;
  /** Optional provider name to seed (e.g. "anthropic", "nuralwatt"). */
  defaultProvider?: string;
}

/** Returns the canonical starter config as a JSON-serializable object. */
export function buildStarterConfig(input: { defaultModel?: string; defaultProvider?: string } = {}): Record<string, unknown> {
  const defaultModel = input.defaultModel ?? "claude-sonnet-4-5-20250929";
  const defaultProvider = input.defaultProvider ?? "anthropic";
  return {
    // ── Logging ────────────────────────────────────────────────────
    logging: {
      devMode: false,
      sampleRate: 1.0,
      sessionMetrics: true,
    },
    // ── Pruner (compaction strategy) ───────────────────────────────
    pruner: {
      enabled: true,
      localOnly: true,
      threshold: 0.5,
    },
    // ── Runtime control (service supervisor, retries) ──────────────
    runtime: {
      recedingHorizonPlanContext: true,
      voteAttempts: 1,
      serviceSupervisor: {
        enabled: true,
        readinessTimeoutMs: 30_000,
        minimumStableMs: 1_500,
        autoRecover: true,
        maxAutoRecoveriesPerService: 1,
        crashLoopThreshold: 2,
      },
    },
    // ── Verification gates ─────────────────────────────────────────
    verification: {
      requireGroundedCompletion: true,
      enforceFailBeforeFixForGeneratedChecks: true,
      selfDebugExplanation: { enabled: true },
      freshContextDiffReview: { enabled: true, maxDiffChars: 12_000 },
      contractCoverage: { enabled: true },
      executionConsensusRanking: true,
    },
    // ── Model routing per role ─────────────────────────────────────
    modelRouting: {
      "default_model": "default_model",
      mainAgent: "main_reasoner",
      executor: "fast_reasoner",
      repair: "main_reasoner",
      planner: "main_reasoner",
      patcher: "fast_reasoner",
      completionGate: "fast_reasoner",
      summarizer: "fast_reasoner",
      judge: "judge",
    },
    // ── Connection policies ─────────────────────────────────────────
    connection: {
      auth: {
        allowAnonymous: true,
        bearerTokens: [],
      },
      rateLimit: {
        maxRequests: 60,
        windowMs: 60_000,
      },
      maxPayloadBytes: 64 * 1024,
      requestTimeoutMs: 30_000,
      maxAttachments: 8,
      maxArtifactRefs: 8,
    },
    // ── Model profiles ─────────────────────────────────────────────
    models: {
      default_model: {
        provider: defaultProvider,
        model: defaultModel,
        capabilities: {
          streaming: true,
          toolCalling: true,
          jsonMode: true,
          structuredOutput: true,
          embeddings: false,
          maxContextTokens: 200_000,
          maxOutputTokens: 32_000,
        },
      },
    },
    // ── MCP (Model Context Protocol servers) ───────────────────────
    mcp: {
      enabled: true,
      maxActiveMCPTools: 6,
      refreshIntervalTurns: 10,
      servers: [],
    },
    // ── Context management (shake, time-MC, full summary, etc.) ───
    contextManagement: {
      softCap: 270_000,
      shakeTriggerPct: 50,
      shakeProtectWindowChars: 12_000,
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
      bashHeadTailEnabled: true,
      bashHeadPreviewChars: 1_200,
      bashTailPreviewChars: 1_200,
      bashPersistThresholdChars: 30_000,
      warningThresholdRatio: 0.70,
      errorThresholdRatio: 0.85,
      blockingThresholdRatio: 0.95,
    },
    // ── Runtime tunables (previously REAPER_* env vars) ────────────
    runtimeTunables: {
      // Bash
      bashAssistantBlockingBudgetMs: 30_000,
      bashDefaultTimeoutMs: 600_000,
      bashIdleTimeoutMs: 5_000,
      bashPersistThresholdChars: 30_000,
      bashPreviewSizeChars: 1_200,
      maxShellOutputBytes: 30_000,
      stallWatchdogIntervalMs: 10_000,
      stallWatchdogNoOutputMs: 30_000,
      // Background processes
      bgDescendantTermGraceMs: 5_000,
      bgKillGraceMs: 3_000,
      bgMaxOutputLines: 5_000,
      bgTermGraceMs: 5_000,
      // Browser
      browserExecutablePath: "",
      browserHeadless: true,
      // Computer use
      computerAutoApprove: false,
      computerEnableGlobalHook: false,
      // Concurrency
      queueMaxConcurrency: 4,
      tuiNoQueue: false,
      // Engine runtime
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
      retryBaseDelayMs: 500,
      retryDeadlineHeadroomMs: 5_000,
      retryFallbackAfterOverloaded: true,
      retryKeepAliveMs: 1_500,
      retryMaxDelayMs: 8_000,
      retryMaxRetries: 3,
      runDeadlineEpochMs: 0,
      streamIdleTimeoutMs: 30_000,
      strictCompletionGate: true,
      strictTempCleanup: true,
      swarmDebug: false,
      unattendedRetry: true,
      // Sandbox / TBench
      tbenchComposeProject: "",
      tbenchContainerName: "",
      tbenchHostWorkspace: "",
      workspacePathAliases: "",
    },
      };
}

/**
 * Write the starter config to `<workspaceRoot>/.reaper/config.json`. If
 * a config already exists and `force` is not set, this throws.
 */
export async function writeStarterConfig(input: StarterConfigInput): Promise<{ path: string }> {
  const dir = path.join(input.workspaceRoot, ".reaper");
  const target = path.join(dir, "config.json");
  await mkdir(dir, { recursive: true });
  const obj = buildStarterConfig({
    ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
    ...(input.defaultProvider ? { defaultProvider: input.defaultProvider } : {}),
  });
  const json = `${JSON.stringify(obj, null, 2)}\n`;
  await writeFile(target, json, "utf8");
  return { path: target };
}
