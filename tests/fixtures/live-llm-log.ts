import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { logLangfuseEvent } from "../../src/logging/langfuse.js";

const liveLlmLogPath = path.join("/workspace", ".reaper", "test-live-llm-responses.jsonl");

export interface LiveLlmLogEntry {
  testName: string;
  operation: "generate" | "stream" | "generate_attempt" | "stream_attempt" | "embed_attempt" | "route_decision" | "retry_attempt";
  provider: string;
  model: string;
  role: string;
  request: {
    messageCount?: number;
    responseFormat?: string;
    maxTokens?: number;
    promptPreview?: string;
    promptTail?: string;
    promptChars?: number;
    promptContainsCommandLedger?: boolean;
    promptContainsRecentToolResults?: boolean;
    promptContainsExecutionResult?: boolean;
    attempt?: number;
    maxAttempts?: number;
    retrying?: boolean;
    strategy?: string;
    reason?: string;
    kind?: string;
    fallbackTriggered?: boolean;
  };
  response: Record<string, unknown>;
  timestamp: string;
}

export async function writeLiveLlmLog(entry: LiveLlmLogEntry): Promise<void> {
  try {
    await mkdir(path.dirname(liveLlmLogPath), { recursive: true });
    await appendFile(liveLlmLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err: unknown) {
    // Non-fatal: log path may be read-only (eg shared volume, EACCES). The langfuse event
    // below still captures the data. Without this fail-soft, every model call aborts the
    // run with EACCES — fatal across an entire benchmark suite.
    const code = (err as { code?: string } | undefined)?.code;
    if (code !== "EACCES" && code !== "EROFS" && code !== "ENOSPC" && code !== "EPERM") {
      throw err;
    }
  }
  await logLangfuseEvent({
    workspaceRoot: path.join("/workspace"),
    name: `reaper.live_llm.${entry.operation}`,
    type: entry.operation.startsWith("generate") || entry.operation.startsWith("stream") ? "generation" : "event",
    input: entry.request,
    output: entry.response,
    metadata: {
      testName: entry.testName,
      provider: entry.provider,
      model: entry.model,
      role: entry.role,
      operation: entry.operation,
    },
    trace: {
      runId: entry.testName,
      sessionId: entry.testName,
      traceId: entry.testName,
      tags: ["reaper-test", "live-llm"],
    },
  });
}

export function getLiveLlmLogPath(): string {
  return liveLlmLogPath;
}
