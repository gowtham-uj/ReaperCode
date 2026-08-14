import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";
import { isReaperDevMode } from "../runtime/dev-mode.js";
import { redactSecrets } from "./redaction.js";
export type LangfuseObservationType = "span" | "generation" | "event" | "tool" | "agent";

export interface ReaperLangfuseEvent {
  workspaceRoot: string;
  name: string;
  type: LangfuseObservationType;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  trace?: {
    runId?: string;
    sessionId?: string;
    traceId?: string;
    userId?: string;
    tags?: string[];
  };
}

export function isLangfuseRemoteEnabled(): false {
  return false;
}

export async function logLangfuseEvent(event: ReaperLangfuseEvent): Promise<void> {
  if (!isReaperDevMode()) return;
  const scratchpad = getReaperScratchpadPaths(event.workspaceRoot);
  const safeEvent = redactSecrets(event) as ReaperLangfuseEvent;
  const runId = event.trace?.runId;
  const logPath = path.join(runId ? path.join(scratchpad.logs, runId) : scratchpad.logs, "langfuse-events.jsonl");
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(
    logPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), exportMode: "local_only", ...safeEvent })}\n`,
    "utf8",
  );
}

export async function flushLangfuse(): Promise<void> {
  // Local-only logging writes synchronously to JSONL and has no remote exporter to flush.
}
