/**
 * tools/diagnostics.ts — Post-write diagnostics (tsc, eslint) run
 * on demand by the model. Advisory only: never blocks writes. The
 * model surfaces tsc/eslint findings only when explicitly requested.
 *
 * Four defects lived in this file. They share a shape: the tool reported a
 * confident answer it had not earned.
 *
 *   1. It invoked `npx tsc`. `npx` is a *download*, not a lookup — with no
 *      local install it fetches a same-named package from the public registry,
 *      and there is an unrelated package literally called `tsc`. So the tool
 *      ran a stub that accepts the flags, exits zero, prints nothing, and
 *      reports a file full of type errors as clean.
 *   2. It read only `stderr`. `tsc` writes diagnostics to *stdout*, so even
 *      with the real compiler every finding was discarded.
 *   3. With no `tsconfig.json`, `tsc --noEmit <file>` falls back to ES5
 *      defaults, which reported errors in correct modern code (`Property 'at'
 *      does not exist on type 'number[]'`, `Promise only refers to a type`).
 *      That is the opposite failure of (1): confidently dirty when clean.
 *   4. Every path that could not run returned `{ ok: true, diagnostics: [] }`.
 *      eslint was never invoked at all and still reported a clean file. "I did
 *      not check" and "I checked and it is clean" were the same answer, which
 *      is the root cause the other three are instances of.
 *
 * A live run through `scripts/verify-tool-discovery.mts` surfaced all four. The
 * model was told `src/broken.ts` had no problems, did not believe it *because
 * the file was named broken.ts*, installed TypeScript by hand, and diagnosed
 * the tool correctly in its own report. Defects 1–3 are its findings.
 */

import { readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { z } from "zod";

import { normalizeWorkspacePath } from "../policy/paths.js";
import { buildSandboxedShellCommand } from "../policy/shell-sandbox.js";
import { buildChildEnv } from "./child-env.js";

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
  diagnostics: Array<{ severity: "error" | "warning"; message: string; line?: number; column?: number }>;
  ok: boolean;
  /**
   * Set when no diagnostics were produced because the tool could not run at
   * all — missing compiler, no such file, timeout. Distinct from `ok: false`,
   * which means the code was checked and had problems. A caller that cannot
   * tell these apart reads "I could not check" as "I checked and it is clean",
   * which is the whole class of bug this file used to have.
   */
  unavailable?: string;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate eslint in the workspace.
 *
 * No fallback to Reaper's own copy: eslint resolves plugins and configs
 * relative to the project it is linting, so borrowing Reaper's install would
 * lint the user's code with the wrong plugin set and report rules that are not
 * configured. Absent a workspace install, the honest answer is "not installed".
 */
async function resolveEslint(workspaceRoot: string): Promise<string | null> {
  const candidate = join(workspaceRoot, "node_modules", ".bin", "eslint");
  return (await pathExists(candidate)) ? candidate : null;
}

/**
 * Options for a single-file check when the project has no `tsconfig.json`.
 *
 * These exist to fix the third defect in the file header: with no project
 * config, `tsc` assumes ES5 and reports "Property 'at' does not exist on type
 * 'number[]'" and "Promise only refers to a type" in correct modern code.
 *
 * `jsx: Preserve` accepts JSX without requiring React's types to resolve.
 * `skipLibCheck` keeps findings in the user's own code from being buried
 * under findings in dependency typings.
 */
const DEFAULT_TSC_OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
};

/**
 * Find the nearest `tsconfig.json` at or above `fileDirName`.
 *
 * Matching `tsc`'s own upward search means a project whose tsconfig lives at
 * the repo root is honored even when the checked file is several directories
 * below it.
 */
function findTsconfig(fileDirName: string, workspaceRoot: string): string | null {
  let dir = resolve(fileDirName);
  const root = resolve(workspaceRoot);
  for (;;) {
    const candidate = join(dir, "tsconfig.json");
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // keep walking
    }
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Type-check one file with the TypeScript compiler API, in process.
 *
 * The API replaces what used to be `npx tsc --noEmit <file>`, which was wrong
 * three ways at once. `npx` is a *download*, so with no local install it
 * fetched an unrelated package literally named `tsc`; the diagnostics were
 * read from stderr while tsc writes them to stdout; and PATH is consulted to
 * find the binary at all, so any `tsc` sitting earlier on PATH could answer
 * instead of the compiler.
 *
 * Checking in process removes all three by construction: there is no
 * subprocess, no PATH lookup, and no registry fetch. It is also the only
 * option that works in the single-file `bin/reaper.mjs` bundle, which
 * inlines TypeScript and therefore has no `tsc` on disk to spawn. It matches
 * `tsc --noEmit` output exactly — same TS codes, same line and column.
 *
 * The one deliberate divergence is file resolution: `tsc` follows project
 * references into other tsconfigs, this checks the file within a single
 * program. Only errors whose `file` is the target are returned, so a
 * dependency's type errors are not reported against the user's file.
 */
function runTscInProcess(
  absolutePath: string,
  /** How the caller named the file, echoed back in messages so they stay short. */
  reportedPath: string,
  sourceText: string,
  workspaceRoot: string,
): { diagnostics: DiagnosticsResult["diagnostics"]; note?: string } {
  const configPath = findTsconfig(dirname(absolutePath), workspaceRoot);

  let options: ts.CompilerOptions = { ...DEFAULT_TSC_OPTIONS };
  let note: string | undefined;

  if (configPath) {
    try {
      const read = ts.readConfigFile(configPath, (fileName) => readFileSync(fileName, "utf8"));
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), {
        noEmit: true,
        skipLibCheck: true,
      });
      options = { ...DEFAULT_TSC_OPTIONS, ...parsed.options, noEmit: true };
      note =
        `Checked with the compiler options from ${configPath} — libs, JSX mode, and strictness are ` +
        "the project's, but file resolution is single-file. Errors reported by imported files are " +
        "not included; for a whole-program check run `npx tsc --noEmit -p tsconfig.json` via bash.";
    } catch (error) {
      note =
        `Could not read ${configPath} (${error instanceof Error ? error.message : String(error)}) — ` +
        "checked with standalone defaults instead.";
    }
  }

  /*
   * Serve the target file from the text that was read once, up front, rather
   * than letting the compiler read it again. The model has usually just
   * written this file, and a re-read races that write — the file could change
   * between the existence check and the parse, and the reported line numbers
   * would then describe a version of the file the caller never saw.
   */
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const normalizedTarget = resolve(absolutePath);
  const scriptKind = /\.tsx$/.test(absolutePath)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(absolutePath)
      ? ts.ScriptKind.JSX
      : /\.(js|mjs|cjs)$/.test(absolutePath)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(fileName) === normalizedTarget
      ? ts.createSourceFile(fileName, sourceText, languageVersion, true, scriptKind)
      : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);

  const program = ts.createProgram([absolutePath], options, host);

  const diagnostics: DiagnosticsResult["diagnostics"] = [];
  const seen = new Set<string>();

  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    /*
     * Only the target's own errors. A dependency that fails to resolve its
     * types is not a finding about this file, and reporting it sends the
     * model to fix code it does not own.
     */
    const target = diagnostic.file;
    if (!target || resolve(target.fileName) !== normalizedTarget) continue;

    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");

    // getPreEmitDiagnostics already unions the syntactic and semantic passes,
    // but the same error can be reached by more than one, so dedupe on the
    // full identity rather than listing it twice.
    const key = `${diagnostic.code}:${diagnostic.start ?? -1}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const position =
      diagnostic.start === undefined ? null : target.getLineAndCharacterOfPosition(diagnostic.start);

    diagnostics.push({
      severity: diagnostic.category === ts.DiagnosticCategory.Warning ? "warning" : "error",
      // The path is echoed as the caller gave it, which is what `tsc` does and
      // keeps the message short — the model already knows which file it asked
      // about, and an absolute container path is noise in every transcript.
      message:
        `${reportedPath}(${(position?.line ?? 0) + 1},${(position?.character ?? 0) + 1}): ` +
        `TS${diagnostic.code}: ${message}`,
      ...(position ? { line: position.line + 1, column: position.character + 1 } : {}),
    });
  }

  return { diagnostics, ...(note ? { note } : {}) };
}

function unavailable(file: string, kind: string, reason: string): DiagnosticsResult {
  return { file, kind, diagnostics: [], ok: false, unavailable: reason };
}

export async function executeDiagnostics(
  filePath: string,
  workspaceRoot: string,
  kind: string = "auto",
): Promise<DiagnosticsResult> {
  const ext = extname(filePath);

  if (kind === "auto") {
    if (ext === ".ts" || ext === ".tsx") kind = "tsc";
    else if (ext === ".js" || ext === ".jsx") kind = "eslint";
    else return { file: filePath, kind: "none", diagnostics: [], ok: true };
  }

  /*
   * Validate before running anything. A path outside the workspace, or one
   * that does not exist, used to reach the compiler and come back as a
   * compiler-shaped error, which reads to the model as "your code is wrong".
   */
  let absolutePath: string;
  try {
    // Symlink escape is allowed here so the check matches what the model can
    // already read; confinement to the workspace is still enforced.
    absolutePath = normalizeWorkspacePath(workspaceRoot, filePath, { forbidSymlinkEscape: false });
  } catch (error) {
    return unavailable(filePath, kind, error instanceof Error ? error.message : String(error));
  }
  if (!(await pathExists(absolutePath))) {
    return unavailable(filePath, kind, `No such file: ${filePath}`);
  }

  if (kind === "tsc") return runTsc(filePath, absolutePath, workspaceRoot);
  if (kind === "eslint") return runEslint(filePath, workspaceRoot);

  return { file: filePath, kind, diagnostics: [], ok: true };
}

async function runTsc(
  filePath: string,
  absolutePath: string,
  workspaceRoot: string,
): Promise<DiagnosticsResult> {
  let sourceText: string;
  try {
    sourceText = await readFile(absolutePath, "utf8");
  } catch (error) {
    return unavailable(filePath, "tsc", `Could not read the file: ${(error as Error).message}`);
  }

  let result: { diagnostics: DiagnosticsResult["diagnostics"]; note?: string };
  try {
    result = runTscInProcess(absolutePath, filePath, sourceText, workspaceRoot);
  } catch (error) {
    return unavailable(filePath, "tsc", `The TypeScript compiler threw: ${(error as Error).message}`);
  }

  /*
   * The note ships *inside* the diagnostics rather than beside the result.
   * The model reads diagnostics and nothing else, so a caveat it cannot see
   * is a caveat it will not hear — and it needs to know that a file with a
   * tsconfig was not checked against that tsconfig's file resolution.
   */
  const notes: DiagnosticsResult["diagnostics"] = result.note
    ? [{ severity: "warning", message: result.note }]
    : [];
  const diagnostics = [...result.diagnostics, ...notes];

  return {
    file: filePath,
    kind: "tsc",
    diagnostics,
    ok: result.diagnostics.length === 0,
  };
}

async function runEslint(filePath: string, workspaceRoot: string): Promise<DiagnosticsResult> {
  const eslint = await resolveEslint(workspaceRoot);
  if (!eslint) {
    // Previously this returned `ok: true` with no diagnostics without running
    // anything — which is indistinguishable from a clean lint, and wrong.
    return unavailable(
      filePath,
      "eslint",
      "eslint is not installed in this workspace. Install it with `npm install -D eslint` " +
        "to run lint diagnostics.",
    );
  }

  try {
    /*
     * The linter is workspace-supplied code, so it runs confined and with a
     * scrubbed environment.
     *
     * `<workspace>/node_modules/.bin/eslint` is a file the agent can write, and
     * this ran it as a plain child of the app-server: as root, with
     * `ANTHROPIC_AUTH_TOKEN` in `process.env`, with the whole host filesystem
     * reachable and the CDP port open. Two `write_file` calls were enough to
     * turn "check this file" into arbitrary code execution as the host, with no
     * approval, and the marker the probe wrote recorded exactly that.
     *
     * So it goes through the same sandbox `bash` uses, and gets the same
     * stripped environment every other child gets. `buildSandboxedShellCommand`
     * is the shared definition, which is what keeps this from drifting away
     * from bash's confinement the way the eval sandbox once did.
     *
     * Unconfined is the fallback only when bubblewrap is unavailable, which is
     * the same trade the shell tools make and for the same reason: a host
     * without user namespaces still needs a working linter, and refusing every
     * check there would not be safer in any way the user could use.
     */
    const sandboxed = buildSandboxedShellCommand({
      workspaceRoot,
      workingDirectory: workspaceRoot,
      shell: "/bin/sh",
      shellArgs: ["-c", "exec \"$0\" \"$@\"", process.execPath, eslint, "--format", "json", filePath],
    });
    const options = {
      timeout: 30_000,
      cwd: workspaceRoot,
      maxBuffer: 4 * 1024 * 1024,
      env: buildChildEnv({ workspaceRoot }).env,
    };
    const { stdout, stderr } = sandboxed
      ? await execFileAsync(sandboxed.command, sandboxed.args, options)
      : await execFileAsync(process.execPath, [eslint, "--format", "json", filePath], options);
    return { file: filePath, kind: "eslint", diagnostics: parseEslintJson(stdout), ok: true };
  } catch (error: any) {
    // eslint exits 1 when it finds problems, which is not a failure to run.
    const stdout = (error?.stdout ?? "").toString();
    const diagnostics = parseEslintJson(stdout);
    if (diagnostics.length > 0) {
      return { file: filePath, kind: "eslint", diagnostics, ok: false };
    }
    if (error?.killed || error?.signal) {
      return unavailable(filePath, "eslint", "eslint timed out after 30s.");
    }
    const detail = (error?.stderr ?? error?.message ?? "").toString().trim();
    return unavailable(filePath, "eslint", `eslint failed to run: ${detail.slice(0, 500)}`);
  }
}

function parseEslintJson(stdout: string): DiagnosticsResult["diagnostics"] {
  const diagnostics: DiagnosticsResult["diagnostics"] = [];
  let report: Array<{ messages?: Array<{ severity?: number; message?: string; line?: number; column?: number }> }>;
  try {
    const parsed = JSON.parse(stdout);
    report = Array.isArray(parsed) ? parsed : [];
  } catch {
    // Not JSON: a config failure or a crash. Surface it rather than swallow it.
    const text = stdout.trim();
    return text ? [{ severity: "error", message: text.slice(0, 2000) }] : [];
  }

  for (const fileResult of report) {
    for (const message of fileResult.messages ?? []) {
      if (!message.message) continue;
      diagnostics.push({
        severity: message.severity === 1 ? "warning" : "error",
        message: message.message,
        ...(typeof message.line === "number" ? { line: message.line } : {}),
        ...(typeof message.column === "number" ? { column: message.column } : {}),
      });
    }
  }
  return diagnostics;
}
