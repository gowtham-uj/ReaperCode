import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import ts from "typescript";

const execFileAsync = promisify(execFile);

export interface EditorGuardInput {
  path: string;
  content: string;
  timeoutMs?: number;
}

export interface EditorGuardResult {
  ok: boolean;
  checker: string;
  message: string;
  diagnostics: string[];
}

export async function validateCandidateSource(input: EditorGuardInput): Promise<EditorGuardResult> {
  const extension = path.extname(input.path).toLowerCase();
  const timeoutMs = input.timeoutMs ?? 30_000;

  if (isTypeScriptOrJavaScript(extension)) {
    return checkTypeScriptSyntax(input.path, input.content);
  }

  if (extension === ".json") {
    return checkJsonSyntax(input.content);
  }

  if (extension === ".py") {
    return checkPythonSyntax(input.path, input.content, timeoutMs);
  }

  if (extension === ".sh" || extension === ".bash") {
    return checkShellSyntax(input.path, input.content, timeoutMs);
  }

  return {
    ok: true,
    checker: "none",
    message: "No editor guard checker is configured for this file type.",
    diagnostics: [],
  };
}

export function isEditorGuardFailure(result: EditorGuardResult): boolean {
  return !result.ok && result.checker !== "none";
}

function isTypeScriptOrJavaScript(extension: string): boolean {
  return [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(extension);
}

function checkTypeScriptSyntax(filePath: string, content: string): EditorGuardResult {
  const extension = path.extname(filePath).toLowerCase();
  const scriptKind =
    extension === ".tsx"
      ? ts.ScriptKind.TSX
      : extension === ".jsx"
        ? ts.ScriptKind.JSX
        : [".js", ".mjs", ".cjs"].includes(extension)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;

  const result = ts.transpileModule(content, {
    fileName: filePath,
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
    },
  });

  const diagnostics = (result.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map(formatTypeScriptDiagnostic);

  return {
    ok: diagnostics.length === 0,
    checker: "typescript-transpile",
    message: diagnostics.length === 0 ? "TypeScript/JavaScript syntax check passed." : "TypeScript/JavaScript syntax check failed.",
    diagnostics,
  };
}

function checkJsonSyntax(content: string): EditorGuardResult {
  try {
    JSON.parse(content);
    return { ok: true, checker: "json-parse", message: "JSON syntax check passed.", diagnostics: [] };
  } catch (error) {
    return {
      ok: false,
      checker: "json-parse",
      message: "JSON syntax check failed.",
      diagnostics: [error instanceof Error ? error.message : "Invalid JSON"],
    };
  }
}

async function checkPythonSyntax(filePath: string, content: string, timeoutMs: number): Promise<EditorGuardResult> {
  return checkTempFileSyntax({
    checker: "python-py_compile",
    executableCandidates: ["python3", "python"],
    argsForFile: (candidatePath) => ["-m", "py_compile", candidatePath],
    filePath,
    content,
    timeoutMs,
  });
}

async function checkShellSyntax(filePath: string, content: string, timeoutMs: number): Promise<EditorGuardResult> {
  return checkTempFileSyntax({
    checker: "bash-n",
    executableCandidates: ["bash"],
    argsForFile: (candidatePath) => ["-n", candidatePath],
    filePath,
    content,
    timeoutMs,
  });
}

async function checkTempFileSyntax(input: {
  checker: string;
  executableCandidates: string[];
  argsForFile: (candidatePath: string) => string[];
  filePath: string;
  content: string;
  timeoutMs: number;
}): Promise<EditorGuardResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "reaper-editor-guard-"));
  const candidatePath = path.join(tempDir, `candidate${path.extname(input.filePath) || ".txt"}`);
  try {
    await writeFile(candidatePath, input.content, "utf8");
    let unavailable = false;
    for (const executable of input.executableCandidates) {
      try {
        await execFileAsync(executable, input.argsForFile(candidatePath), {
          cwd: tempDir,
          timeout: input.timeoutMs,
          maxBuffer: 1024 * 1024,
        });
        return { ok: true, checker: input.checker, message: `${input.checker} check passed.`, diagnostics: [] };
      } catch (error) {
        if (isExecutableMissing(error)) {
          unavailable = true;
          continue;
        }
        return {
          ok: false,
          checker: input.checker,
          message: `${input.checker} check failed.`,
          diagnostics: [formatExecError(error)],
        };
      }
    }

    return {
      ok: true,
      checker: input.checker,
      message: unavailable ? `${input.checker} checker unavailable; edit was not blocked.` : `${input.checker} check skipped.`,
      diagnostics: [],
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function formatTypeScriptDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (!diagnostic.file || diagnostic.start === undefined) {
    return `TS${diagnostic.code}: ${message}`;
  }
  const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${pos.line + 1}:${pos.character + 1} TS${diagnostic.code}: ${message}`;
}

function isExecutableMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function formatExecError(error: unknown): string {
  if (!error || typeof error !== "object") return "Syntax checker failed.";
  const err = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number | string; signal?: string };
  const stdout = bufferToString(err.stdout).trim();
  const stderr = bufferToString(err.stderr).trim();
  const details = [stderr, stdout].filter(Boolean).join("\n");
  const exit = err.code !== undefined ? `exit=${String(err.code)}` : err.signal ? `signal=${err.signal}` : "";
  return [exit, details || err.message].filter(Boolean).join(" ");
}

function bufferToString(value: string | Buffer | undefined): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : "";
}
