import type { ReaperConfig } from "../../src/config/model-config.js";
import type { AgentRequestEnvelope } from "../../src/connection/schemas.js";

export function createValidConfig(): ReaperConfig {
  return {
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
    pruner: {
      enabled: true,
      localOnly: true,
      threshold: 0.5,
    },
    logging: {
      devMode: false,
      sampleRate: 1.0,
      sessionMetrics: true,
    },
    runtime: {
      progressGuard: {
        enabled: true,
        actionRepeatLimit: 3,
        observationRepeatLimit: 3,
        sameFailedActionLimit: 3,
        recoveryStrategyRepeatLimit: 2,
        stallSteps: 2,
      },
      completionGateMax: 3,
      recedingHorizonPlanContext: true,
      voteAttempts: 1,
      artifactObligations: {
        enabled: true,
      },
      hypothesisRescue: {
        enabled: true,
      },
      expandedStuckDetection: {
        enabled: true,
        alternatingPatternLength: 6,
        noActionTurnLimit: 3,
      },
      serviceSupervisor: {
        enabled: true,
        readinessTimeoutMs: 30_000,
        minimumStableMs: 1_500,
        autoRecover: true,
        maxAutoRecoveriesPerService: 1,
        crashLoopThreshold: 2,
      },
      editorGuard: {
        enabled: true,
        syntaxCheckTimeoutMs: 30_000,
      },
    },
    verification: {
      requireGroundedCompletion: false,
      enforceFailBeforeFixForGeneratedChecks: true,
      selfDebugExplanation: {
        enabled: false,
      },
      freshContextDiffReview: {
        enabled: false,
        maxDiffChars: 12_000,
      },
      contractCoverage: {
        enabled: true,
      },
      executionConsensusRanking: true,
    },
    modelRouting: {
      planner: "main_reasoner",
      executor: "fast_reasoner",
      repair: "main_reasoner",
      patcher: "fast_reasoner",
      completionGate: "fast_reasoner",
      summarizer: "fast_reasoner",
      judge: "judge",
    },
    mcp: {
      enabled: false,
      maxActiveMCPTools: 6,
      refreshIntervalTurns: 10,
      servers: [],
    },
    models: {
      default_model: {
        provider: "cerebras",
        model: "qwen-3-235b-a22b-instruct-2507",
        apiKeyEnv: "CEREBRAS_PROVIDER_KEY",
        timeoutMs: 300000,
        maxRetries: 2,
        capabilities: {
          streaming: true,
          toolCalling: true,
          jsonMode: true,
          structuredOutput: true,
          embeddings: false,
          maxContextTokens: 131000,
          maxOutputTokens: 8192,
        },
      },
    },
  };
}

export function createValidRequestEnvelope(): AgentRequestEnvelope {
  return {
    connection_id: "conn-1",
    session_id: "session-1",
    turn_id: "turn-1",
    request_id: "request-1",
    message_type: "user_prompt",
    timestamp: "2026-05-05T12:00:00.000Z",
    trace_id: "trace-1",
    payload: {
      prompt: "Fix the failing test",
    },
    metadata: {
      source: "test",
    },
  };
}
