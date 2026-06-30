import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { GenerateRequest, GenerateResult, EmbeddingRequest, EmbeddingResult, ResolvedModelProfile, StreamEvent } from "../model/types.js";
import { getActiveModelCallContext } from "../model/observability.js";
import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";

export interface ModelCallLogContext {
  workspaceRoot: string;
  runId: string;
}

type ModelCallKind = "generate" | "stream" | "embed";

type ModelCallLogPayload = {
  kind: ModelCallKind;
  callId?: string;
  role?: string;
  profile?: Partial<ResolvedModelProfile>;
  request?: GenerateRequest | EmbeddingRequest;
  response?: GenerateResult | EmbeddingResult;
  streamEvents?: StreamEvent[];
  error?: unknown;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
};

let context: ModelCallLogContext | undefined;
const counters = new Map<string, number>();

export function setModelCallLogContext(next: ModelCallLogContext | undefined): void {
  context = next;
}

export function currentModelCallLogContext(): ModelCallLogContext | undefined {
  return context;
}

export async function logModelCall(payload: ModelCallLogPayload): Promise<void> {
  const observed = getActiveModelCallContext();
  const active = context ?? (observed ? { workspaceRoot: observed.workspaceRoot, runId: observed.runId } : undefined);
  if (!active) return;
  const callId = payload.callId ?? nextCallId(active.runId, payload.kind);
  const paths = getReaperScratchpadPaths(active.workspaceRoot);
  const dir = path.join(paths.runs, active.runId, "model-calls");
  await mkdir(dir, { recursive: true });
  const safe = toJsonSafe({
    schema_version: 1,
    run_id: active.runId,
    call_id: callId,
    ...payload,
  });
  await writeFile(path.join(dir, `${callId}.json`), JSON.stringify(safe, null, 2), "utf8");
}

export function nextCallId(runId: string, kind: ModelCallKind): string {
  const next = (counters.get(runId) ?? 0) + 1;
  counters.set(runId, next);
  return `${String(next).padStart(4, "0")}-${kind}`;
}

function toJsonSafe(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...("cause" in value ? { cause: toJsonSafe((value as { cause?: unknown }).cause) } : {}),
    };
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === "function") continue;
      if (entry instanceof AbortSignal) {
        out[key] = { aborted: entry.aborted, reason: toJsonSafe(entry.reason) };
        continue;
      }
      out[key] = toJsonSafe(entry);
    }
    return out;
  }
  return value;
}
