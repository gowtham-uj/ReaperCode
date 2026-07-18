/**
 * tools/eval.ts — Phase 4: eval tool for low-overhead JS/Python snippets.
 *
 * Allows the model to run small code snippets without invoking bash.
 * Supports JavaScript (via eval) and Python (via child_process).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

import { buildChildEnv } from "./child-env.js";

const execFileAsync = promisify(execFile);

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
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Evaluate a code snippet.
 *
 * JavaScript: uses `node -e` with a timeout.
 * Python: uses `python3 -c` with a timeout.
 *
 * The output is the combined stdout (stderr included as error if non-zero exit).
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

  try {
    if (lang === "python") {
      const { stdout, stderr } = await execFileAsync(
        "python3",
        ["-c", code],
        { timeout: timeoutSec * 1000, maxBuffer: 1024 * 1024, env },
      );
      return {
        output: stdout.trim(),
        exitCode: 0,
        error: stderr.trim() || null,
        language: "python",
        durationMs: Date.now() - start,
      };
    } else {
      const { stdout, stderr } = await execFileAsync(
        "node",
        ["-e", code],
        { timeout: timeoutSec * 1000, maxBuffer: 1024 * 1024, env },
      );
      return {
        output: stdout.trim(),
        exitCode: 0,
        error: stderr.trim() || null,
        language: "javascript",
        durationMs: Date.now() - start,
      };
    }
  } catch (error: any) {
    return {
      output: (error.stdout ?? "").toString().trim(),
      exitCode: error.code ?? 1,
      error: (error.stderr ?? error.message ?? "").toString().trim(),
      language: lang,
      durationMs: Date.now() - start,
    };
  }
}
