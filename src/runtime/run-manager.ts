import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentRequestEnvelope } from "../connection/schemas.js";
import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";

export interface ReaperRunContext {
  runId: string;
  sessionId: string;
  traceId: string;
  threadId: string;
  runDir: string;
  artifactsDir: string;
  startedAt: string;
}

export function createReaperRunContext(workspaceRoot: string, request: AgentRequestEnvelope): ReaperRunContext {
  const resumeRunId = readMetadataString(request.metadata, "resumeRunId") ?? process.env.REAPER_RESUME_RUN_ID;
  const explicitRunId = readMetadataString(request.metadata, "runId") ?? readMetadataString(request.metadata, "run_id");
  const requestTraceId = typeof request.trace_id === "string" ? request.trace_id : undefined;
  const runId = resumeRunId ?? explicitRunId ?? (isPlaceholderRunId(requestTraceId) ? createRunId() : requestTraceId ?? createRunId());
  const sessionId = isPlaceholderSessionId(request.session_id) ? `session-${runId}` : request.session_id;
  const scratchpad = getReaperScratchpadPaths(workspaceRoot);
  const runDir = path.join(scratchpad.runs, runId);
  return {
    runId,
    sessionId,
    traceId: runId,
    threadId: runId,
    runDir,
    artifactsDir: path.join(runDir, "artifacts"),
    startedAt: new Date().toISOString(),
  };
}

export async function ensureReaperRunContext(context: ReaperRunContext, request: AgentRequestEnvelope): Promise<void> {
  try {
    await mkdir(context.artifactsDir, { recursive: true });
    await writeFile(
      path.join(context.runDir, "manifest.json"),
      JSON.stringify(
        {
          runId: context.runId,
          sessionId: context.sessionId,
          traceId: context.traceId,
          threadId: context.threadId,
          startedAt: context.startedAt,
          request: {
            connection_id: request.connection_id,
            session_id: request.session_id,
            turn_id: request.turn_id,
            request_id: request.request_id,
            trace_id: request.trace_id,
            prompt: typeof request.payload.prompt === "string" ? request.payload.prompt.slice(0, 2000) : undefined,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (error) {
    throw translateRunContextFsError(error, context);
  }
}

/**
 * Convert low-level fs errors at run-context setup into actionable
 * human messages. The engine bubbles these up as `BootConfigError`s so
 * the user sees "workspace is read-only" instead of `EROFS: operation
 * not permitted, mkdir '.../runs/<id>'`.
 */
export function translateRunContextFsError(error: unknown, context: ReaperRunContext): Error {
  const errno = error as NodeJS.ErrnoException;
  const code = errno?.code;
  const target = `${context.runDir}`;
  if (code === "EROFS") {
    return new Error(`cannot create run directory at ${target}: workspace is read-only (EROFS). Check that the .reaper path is on a writable filesystem.`);
  }
  if (code === "ENOSPC") {
    return new Error(`cannot create run directory at ${target}: no space left on device (ENOSPC). Free disk space and retry.`);
  }
  if (code === "EDQUOT") {
    return new Error(`cannot create run directory at ${target}: disk quota exceeded (EDQUOT). Free disk space and retry.`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new Error(`cannot create run directory at ${target}: permission denied (${code}). The reaper process needs write access to the workspace.`);
  }
  if (code === "EEXIST") {
    return new Error(`cannot create run directory at ${target}: path already exists and is not a directory. Clear the stale path and retry.`);
  }
  // Fall back to the original error so callers still see the OS-level detail.
  return error instanceof Error ? error : new Error(String(error));
}

export async function writeLatestRunPointer(workspaceRoot: string, context: ReaperRunContext): Promise<void> {
  const scratchpad = getReaperScratchpadPaths(workspaceRoot);
  await mkdir(scratchpad.root, { recursive: true });
  await writeFile(
    path.join(scratchpad.root, "latest-run.json"),
    JSON.stringify(
      {
        runId: context.runId,
        sessionId: context.sessionId,
        traceId: context.traceId,
        threadId: context.threadId,
        runDir: context.runDir,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function createRunId(): string {
  return `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function isPlaceholderRunId(value: string | undefined): boolean {
  if (!value) return true;
  return /^(trace|run)-?1$/i.test(value) || value === "test-trace";
}

function isPlaceholderSessionId(value: string | undefined): boolean {
  if (!value) return true;
  return /^session-?1$/i.test(value) || value === "test-session";
}

function readMetadataString(metadata: unknown, key: string): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
