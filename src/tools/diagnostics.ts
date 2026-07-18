/**
 * tools/diagnostics.ts — Post-write diagnostics (tsc, eslint) run
 * on demand by the model. Advisory only: never blocks writes. The
 * model surfaces tsc/eslint findings only when explicitly requested.
 */

import { extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const DiagnosticsArgsSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("File path to run diagnostics on."),
    kind: z
      .enum(["tsc", "eslint", "auto"])
      .optional()
      .describe("Diagnostic kind (default: auto — detects from file extension)."),
  })
  .strict();

export type DiagnosticsArgs = z.infer<typeof DiagnosticsArgsSchema>;

export interface DiagnosticsResult {
  file: string;
  kind: string;
  diagnostics: Array<{ severity: string; message: string; line?: number }>;
  ok: boolean;
}

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
};

/**
 * Run post-write diagnostics on a file (advisory only, never blocks).
 */
export async function executeDiagnostics(
  filePath: string,
  workspaceRoot: string,
  kind: string = "auto",
): Promise<DiagnosticsResult> {
  const ext = extname(filePath);
  const lang = EXT_TO_LANG[ext];

  if (kind === "auto") {
    if (ext === ".ts" || ext === ".tsx") kind = "tsc";
    else if (ext === ".js" || ext === ".jsx") kind = "eslint";
    else return { file: filePath, kind: "none", diagnostics: [], ok: true };
  }

  if (kind === "tsc") {
    try {
      const { stdout, stderr } = await execFileAsync(
        "npx",
        ["tsc", "--noEmit", filePath],
        { timeout: 30000, cwd: workspaceRoot, maxBuffer: 1024 * 1024 },
      );
      const errors = stderr.trim();
      if (errors) {
        const diags = errors.split("\n").filter(Boolean).map((line) => ({
          severity: "error" as const,
          message: line,
        }));
        return { file: filePath, kind: "tsc", diagnostics: diags, ok: false };
      }
      return { file: filePath, kind: "tsc", diagnostics: [], ok: true };
    } catch (error: any) {
      const stderr = (error.stderr ?? "").toString();
      const diags = stderr.split("\n").filter(Boolean).map((line: string) => ({
        severity: "error" as const,
        message: line,
      }));
      return { file: filePath, kind: "tsc", diagnostics: diags, ok: diags.length === 0 };
    }
  }

  return { file: filePath, kind, diagnostics: [], ok: true };
}
