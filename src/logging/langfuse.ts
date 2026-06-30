import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";

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
  const scratchpad = getReaperScratchpadPaths(event.workspaceRoot);
  const runId = event.trace?.runId;
  const logPath = runId
    ? path.join(scratchpad.runs, runId, "logs", "langfuse-events.jsonl")
    : path.join(scratchpad.logs, "langfuse-events.jsonl");
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(
    logPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), exportMode: "local_only", ...event })}\n`,
    "utf8",
  );
  if (runId) {
    const legacyPath = path.join(scratchpad.logs, "langfuse-events.jsonl");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await appendFile(
      legacyPath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), exportMode: "local_only", ...event, runLocalPath: logPath })}\n`,
      "utf8",
    );
  }
}

export async function flushLangfuse(): Promise<void> {
  // Local-only logging writes synchronously to JSONL and has no remote exporter to flush.
}
