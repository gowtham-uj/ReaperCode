import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseAgentRequestEnvelope, type TransportKind } from "../connection/schemas.js";
import { parseReaperConfig, type ReaperConfig } from "../config/model-config.js";
import { RuntimeStateSchema, type RuntimeRepoInspection, type RuntimeState } from "./state.js";

const DEFAULT_SOFT_CAP_TOKENS = 200_000;

function resolveSoftCapFromWorkspaceConfig(workspaceRoot: string | undefined): number {
  if (!workspaceRoot) return DEFAULT_SOFT_CAP_TOKENS;
  const candidate = path.join(workspaceRoot, ".reaper", "config.json");
  try {
    if (!existsSync(candidate)) return DEFAULT_SOFT_CAP_TOKENS;
    const raw = readFileSync(candidate, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_SOFT_CAP_TOKENS;
    const tokenBudget = (parsed as Record<string, unknown>).tokenBudget;
    if (!tokenBudget || typeof tokenBudget !== "object" || Array.isArray(tokenBudget)) return DEFAULT_SOFT_CAP_TOKENS;
    const softCap = (tokenBudget as Record<string, unknown>).softCap;
    return typeof softCap === "number" && Number.isFinite(softCap) && softCap > 0
      ? Math.floor(softCap)
      : DEFAULT_SOFT_CAP_TOKENS;
  } catch {
    return DEFAULT_SOFT_CAP_TOKENS;
  }
}

export interface Phase0BootstrapInput {
  config: unknown;
  transport: TransportKind;
  requestEnvelope: unknown;
  workspaceRoot?: string;
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
      softCap: resolveSoftCapFromWorkspaceConfig(input.workspaceRoot),
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
