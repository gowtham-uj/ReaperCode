/**
 * tools/eval.ts — Phase 4: eval tool for low-overhead JS/Python snippets.
 *
 * Allows the model to run small code snippets without invoking bash.
 * Supports JavaScript (via eval) and Python (via child_process).
 */

import { spawn } from "node:child_process";
import { z } from "zod";

import { buildChildEnv } from "./child-env.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const EvalArgsSchema = z
  .object({
    code: z.string().min(1).describe("Code to evaluate."),
    language: z
      .enum(["javascript", "python"])
      .optional()
      .describe("Language: javascript (default) or python."),
    timeout: z
      .number()
      .int()
      .positive()
      .max(30)
      .optional()
      .describe("Timeout in seconds (default 10, max 30)."),
  })
  .strict();

export type EvalArgs = z.infer<typeof EvalArgsSchema>;

export interface EvalResult {
  output: string;
  exitCode: number;
  error: string | null;
  language: string;
  durationMs: number;
  /** True when the run was terminated because the timeout fired. */
  timedOut?: boolean;
}

export interface ExecuteEvalOptions {
  workspaceRoot: string;
  allowlist?: ReadonlyArray<string>;
  /**
   * Optional source environment to sanitize. Defaults to `process.env`.
   * Tests pass a fixture here; production callers should leave it
   * unset.
   */
  sourceEnv?: NodeJS.ProcessEnv;
  /** Optional abort signal — abort kills the child tree immediately. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Evaluate a code snippet.
 *
 * JavaScript: uses `node -e` with a timeout.
 * Python: uses `python3 -c` with a timeout.
 *
 * Uses spawn() + AbortSignal so the timeout actually kills the child tree.
 * The previous promisify(execFile) implementation used execFile's `timeout`
 * option, which sends SIGTERM but does not propagate to descendants and
 * does not honor an external AbortSignal — a runaway eval would leak
 * children past the timeout.
 *
 * The child environment is sanitized via {@link buildChildEnv} so
 * provider keys, GitHub tokens, AWS creds, and database URLs cannot
 * leak into JS/Python snippets even if the model or a tool consumer
 * tries to exfiltrate them.
 */
export async function executeEval(
  code: string,
  language: string = "javascript",
  timeoutSec: number = 10,
  options: ExecuteEvalOptions = { workspaceRoot: process.cwd() },
): Promise<EvalResult> {
  const start = Date.now();
  const lang = language === "python" ? "python" : "javascript";

  const env = buildChildEnv({
    workspaceRoot: options.workspaceRoot,
    ...(options.allowlist ? { allowlist: options.allowlist } : {}),
    ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
  }).env;

  const interpreter = lang === "python" ? "python3" : "node";
  const args = lang === "python" ? ["-c", code] : ["-e", code];

  return await new Promise<EvalResult>((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(interpreter, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // detached so we can signal the whole group on timeout/abort.
        detached: true,
      });
    } catch (error) {
      resolve({
        output: "",
        exitCode: 1,
        error: error instanceof Error ? error.message : String(error),
        language: lang,
        durationMs: Date.now() - start,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const finish = (result: EvalResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Kill the whole process group because the interpreter may have
        // forked helpers that execFile's built-in timeout would have left
        // orphaned.
        if (child?.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        try { child?.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }, timeoutSec * 1000);
    timer.unref?.();

    const onAbort = (): void => {
      try {
        if (child?.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        try { child?.kill("SIGKILL"); } catch { /* ignore */ }
      }
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        try { child?.kill("SIGKILL"); } catch { /* ignore */ }
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        try { child?.kill("SIGKILL"); } catch { /* ignore */ }
        return;
      }
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      finish({
        output: stdout.trim(),
        exitCode: 1,
        error: error.message,
        language: lang,
        durationMs: Date.now() - start,
        ...(timedOut ? { timedOut: true } : {}),
      });
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      const exitCode = typeof code === "number" ? code : signal === "SIGKILL" ? 137 : 1;
      finish({
        output: stdout.trim(),
        exitCode,
        error: stderr.trim() || null,
        language: lang,
        durationMs: Date.now() - start,
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
  });
}
