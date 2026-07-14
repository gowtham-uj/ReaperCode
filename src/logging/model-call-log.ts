import { mkdir, writeFile, appendFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { GenerateRequest, GenerateResult, EmbeddingRequest, EmbeddingResult, ResolvedModelProfile, StreamEvent } from "../model/types.js";
import { getActiveModelCallContext } from "../model/observability.js";
import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";
import { redactSecrets } from "./redaction.js";

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
  const safe = redactSecrets(toJsonSafe({
    schema_version: 1,
    run_id: active.runId,
    call_id: callId,
    ...payload,
  }));
  await writeFile(path.join(dir, `${callId}.json`), JSON.stringify(safe, null, 2), "utf8");

  // Human-readable transcript: exactly what the model sees (system + messages)
  // plus the model response. Secrets are redacted.
  try {
    const text = renderModelCallTranscript(callId, payload);
    await writeFile(path.join(dir, `${callId}.txt`), text, "utf8");
    // Append to a single chronological transcript for the whole run.
    const indexPath = path.join(dir, "TRANSCRIPT.md");
    await appendFile(indexPath, text + "\n\n", "utf8");
  } catch {
    /* best-effort — never break the model loop for logging */
  }
}

/**
 * Render a readable transcript of one model call — the context window
 * as the model receives it, then the model output.
 */
export function renderModelCallTranscript(callId: string, payload: ModelCallLogPayload): string {
  const lines: string[] = [];
  const divider = "=".repeat(72);
  const thin = "-".repeat(72);
  lines.push(divider);
  lines.push(`MODEL CALL  ${callId}`);
  lines.push(`kind=${payload.kind}  role=${payload.role ?? "?"}  durationMs=${payload.durationMs ?? "?"}`);
  if (payload.profile) {
    lines.push(
      `provider=${payload.profile.provider ?? "?"}  model=${payload.profile.model ?? "?"}  profile=${(payload.profile as any).profileName ?? "?"}`,
    );
  }
  if (payload.startedAt) lines.push(`started=${payload.startedAt}`);
  if (payload.completedAt) lines.push(`completed=${payload.completedAt}`);
  lines.push(divider);

  const req = payload.request as GenerateRequest | undefined;
  if (req && typeof req === "object") {
    lines.push("");
    lines.push("### SYSTEM (what the model sees as system)");
    lines.push(thin);
    lines.push(redactText(typeof req.system === "string" ? req.system : "(none)"));
    lines.push("");

    if (Array.isArray(req.tools) && req.tools.length > 0) {
      lines.push("### TOOLS (schemas offered this call)");
      lines.push(thin);
      for (const tool of req.tools as Array<Record<string, unknown>>) {
        const name =
          (typeof tool.name === "string" && tool.name) ||
          (tool.function && typeof (tool.function as any).name === "string"
            ? (tool.function as any).name
            : "(unnamed)");
        const desc =
          (typeof tool.description === "string" && tool.description) ||
          (tool.function && typeof (tool.function as any).description === "string"
            ? (tool.function as any).description
            : "");
        lines.push(`- ${name}${desc ? `: ${String(desc).slice(0, 160)}` : ""}`);
      }
      lines.push("");
    }

    lines.push("### MESSAGES (conversation context sent to the model)");
    lines.push(thin);
    const messages = Array.isArray(req.messages) ? req.messages : [];
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i] as Record<string, unknown>;
      const role = String(msg.role ?? "unknown");
      lines.push("");
      lines.push(`---- message[${i}] role=${role}${msg.tool_call_id ? ` tool_call_id=${msg.tool_call_id}` : ""} ----`);
      if (typeof msg.content === "string") {
        lines.push(redactText(msg.content));
      } else if (msg.content != null) {
        lines.push(redactText(JSON.stringify(msg.content, null, 2)));
      } else {
        lines.push("(empty content)");
      }
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        lines.push("[tool_calls emitted in this assistant message:]");
        for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
          const fn = (tc.function as Record<string, unknown> | undefined) ?? {};
          lines.push(`  • id=${tc.id ?? "?"} name=${fn.name ?? "?"} args=${redactText(String(fn.arguments ?? ""))}`);
        }
      }
    }
  }

  lines.push("");
  lines.push("### MODEL OUTPUT");
  lines.push(thin);
  if (payload.error) {
    lines.push("[ERROR]");
    lines.push(redactText(stringifyError(payload.error)));
  } else if (payload.response) {
    const resp = payload.response as GenerateResult;
    if (typeof resp.content === "string" && resp.content.length > 0) {
      lines.push(redactText(resp.content));
    } else {
      lines.push("(no text content)");
    }
    if (Array.isArray(resp.toolCalls) && resp.toolCalls.length > 0) {
      lines.push("");
      lines.push("[tool_calls]");
      for (const rawTc of resp.toolCalls) {
        const tc = rawTc as { id?: string; name?: string; args?: unknown };
        lines.push(
          `  • id=${tc.id ?? "?"} name=${tc.name ?? "?"} args=${redactText(JSON.stringify(tc.args ?? {}))}`,
        );
      }
    }
    if (resp.finishReason) lines.push(`finishReason=${resp.finishReason}`);
    if (resp.usage) {
      lines.push(
        `usage: input=${resp.usage.inputTokens ?? "?"} output=${resp.usage.outputTokens ?? "?"}`,
      );
    }
  } else if (payload.streamEvents) {
    lines.push(`[streamed ${payload.streamEvents.length} events]`);
    const textParts: string[] = [];
    for (const ev of payload.streamEvents) {
      if (ev.type === "message_delta" || ev.type === "reasoning_delta") {
        if (typeof ev.content === "string") textParts.push(ev.content);
        const data = ev.data as Record<string, unknown> | undefined;
        if (typeof data?.text === "string") textParts.push(data.text);
        if (typeof data?.delta === "string") textParts.push(data.delta);
      }
    }
    if (textParts.length) lines.push(redactText(textParts.join("")));
  } else {
    lines.push("(no response recorded)");
  }

  lines.push("");
  lines.push(divider);
  lines.push("");
  return lines.join("\n");
}

/**
 * Collect all per-call transcripts for a run into one ordered markdown file.
 * Useful for eval artifact packaging.
 */
export async function collectModelCallTranscripts(
  workspaceRoot: string,
  runId: string,
  destPath: string,
): Promise<{ calls: number; destPath: string }> {
  const paths = getReaperScratchpadPaths(workspaceRoot);
  const dir = path.join(paths.runs, runId, "model-calls");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".txt") && f !== "TRANSCRIPT.md").sort();
  } catch {
    await writeFile(destPath, "(no model-call transcripts found)\n", "utf8");
    return { calls: 0, destPath };
  }
  const parts: string[] = [
    `# Model I/O Transcript — run ${runId}`,
    ``,
    `Generated ${new Date().toISOString()}. Each section is exactly what was sent to / received from the model.`,
    ``,
  ];
  for (const f of files) {
    parts.push(await readFile(path.join(dir, f), "utf8"));
    parts.push("");
  }
  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, parts.join("\n"), "utf8");
  return { calls: files.length, destPath };
}

export function nextCallId(runId: string, kind: ModelCallKind): string {
  const next = (counters.get(runId) ?? 0) + 1;
  counters.set(runId, next);
  return `${String(next).padStart(4, "0")}-${kind}`;
}

function redactText(value: string): string {
  const out = redactSecrets(value);
  return typeof out === "string" ? out : String(out);
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  return String(error);
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
