import { parseAgentRequestEnvelope, type TransportKind } from "../connection/schemas.js";
import { parseReaperConfig, type ReaperConfig } from "../config/model-config.js";
import { RuntimeStateSchema, type RuntimeRepoInspection, type RuntimeState } from "./state.js";

export interface Phase0BootstrapInput {
  config: unknown;
  transport: TransportKind;
  requestEnvelope: unknown;
  userIntentSummary?: string;
  runId?: string;
  sessionId?: string;
  traceId?: string;
  repoInspection?: RuntimeRepoInspection;
}

export interface Phase0BootstrapResult {
  transport: TransportKind;
  config: ReaperConfig;
  state: RuntimeState;
}

export function bootPhase0Runtime(input: Phase0BootstrapInput): Phase0BootstrapResult {
  const config = parseReaperConfig(input.config);
  const requestEnvelope = parseAgentRequestEnvelope(input.requestEnvelope);

  const state = RuntimeStateSchema.parse({
    sessionId: input.sessionId ?? requestEnvelope.session_id,
    runId: input.runId ?? requestEnvelope.trace_id,
    turnId: requestEnvelope.turn_id,
    logLevel: "info",
    safetyProfile: "allow_all",
    noticeVerbosity: "normal",
    sessionProtocolVersion: 1,
    userIntentSummary: input.userIntentSummary ?? "Phase 0 bootstrapped session",
    tokenBudget: {
      softCap: 200000,
      inputTokens: 0,
      outputTokens: 0,
    },
    epicState: {
      objectives: [],
    },
    feedback: [],
    negativeConstraints: [],
    ...(input.repoInspection ? { repoInspection: input.repoInspection } : {}),
  });

  return {
    transport: input.transport,
    config,
    state,
  };
}
