import type { GenerateResult, ModelRole } from "./types.js";

export type StructuredResponseMode = "native_tools" | "text_json" | "provider_json";
export type StructuredResponseShape = "plain_json" | "fenced_json" | "embedded_json" | "native_tool_calls" | "empty" | "invalid";

export interface ModelResponseObservation {
  provider: string;
  model: string;
  role: ModelRole;
  mode: StructuredResponseMode;
  shape: StructuredResponseShape;
  ok: boolean;
  timestamp: string;
}

const observations = new Map<string, ModelResponseObservation[]>();
const preferredModes = new Map<string, StructuredResponseMode>();

export function getPreferredStructuredMode(provider: string, model: string, role: ModelRole): StructuredResponseMode | undefined {
  return preferredModes.get(key(provider, model, role)) ?? getDefaultStructuredMode(provider, model);
}

export function recordStructuredResponseObservation(input: {
  result: GenerateResult;
  mode: StructuredResponseMode;
  ok: boolean;
  shape?: StructuredResponseShape;
}): ModelResponseObservation {
  const observation: ModelResponseObservation = {
    provider: input.result.provider,
    model: input.result.model,
    role: input.result.role,
    mode: input.mode,
    shape: input.shape ?? classifyStructuredResponseShape(input.result.content),
    ok: input.ok,
    timestamp: new Date().toISOString(),
  };

  const observationKey = key(observation.provider, observation.model, observation.role);
  const list = observations.get(observationKey) ?? [];
  list.push(observation);
  observations.set(observationKey, list.slice(-20));

  if (observation.ok) {
    preferredModes.set(observationKey, observation.mode);
  } else if (preferredModes.get(observationKey) === observation.mode && recentFailures(list, observation.mode) >= 2) {
    preferredModes.delete(observationKey);
  }

  return observation;
}

export function getStructuredResponseObservations(provider: string, model: string, role: ModelRole): ModelResponseObservation[] {
  return [...(observations.get(key(provider, model, role)) ?? [])];
}

export function classifyStructuredResponseShape(content: string): StructuredResponseShape {
  const trimmed = content.trim();
  if (!trimmed) {
    return "empty";
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return "plain_json";
  }
  if (/^```(?:json)?\s*[\s\S]*```$/i.test(trimmed)) {
    return "fenced_json";
  }
  if (trimmed.includes("{") && trimmed.includes("}")) {
    return "embedded_json";
  }
  return "invalid";
}

function recentFailures(list: ModelResponseObservation[], mode: StructuredResponseMode): number {
  return list
    .slice(-4)
    .filter((item) => item.mode === mode && !item.ok)
    .length;
}

function key(provider: string, model: string, role: ModelRole): string {
  return `${provider}:${model}:${role}`;
}

function getDefaultStructuredMode(provider: string, model: string): StructuredResponseMode | undefined {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();

  // MiniMax-M3 reliably supports provider JSON mode through the OpenAI-compatible
  // /v1 endpoint, while freeform text_json can spend minutes in <think> before
  // emitting a parseable object on large Reaper prompts. Prefer provider_json so
  // parity/eval runs do not burn the whole model timeout before structured output
  // enforcement kicks in.
  if (normalizedProvider === "minimax" || normalizedModel === "minimax-m3") {
    return "provider_json";
  }

  return undefined;
}
