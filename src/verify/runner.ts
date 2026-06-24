import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { runShellCommandTool, isBackgroundShellResult } from "../tools/global/run-shell-command.js";
import { detectSemanticFailureText } from "./semantic-failure.js";

export interface VerificationCommand {
  command: string;
  commands?: Array<{ id?: string; command: string; purpose?: string; required?: boolean }>;
  lite?: boolean;
  generated?: boolean;
}

export type VerificationGroundedSignalKind = "test" | "build" | "typecheck" | "lint" | "runtime_reproduction" | "artifact_check" | "none";

export interface VerificationGroundedSignal {
  kind: VerificationGroundedSignalKind;
  command: string;
  grounded: boolean;
}

export interface VerificationResult {
  ok: boolean;
  command: string;
  liteVerified: boolean;
  groundedSignal: VerificationGroundedSignal;
  stdout?: string;
  stderr?: string;
  output: string;
  startedAt: string;
  endedAt: string;
}

export async function selectVerificationCommand(
  workspaceRoot: string,
  explicit?: VerificationCommand,
): Promise<VerificationCommand | undefined> {
  if (explicit) {
    if (!(await rejectWeakVerification(workspaceRoot, explicit))) return explicit;
  }

  try {
    const packages = await discoverPackageScripts(workspaceRoot);
    const commands: Array<{ id: string; command: string; purpose: string; required: boolean }> = [];
    for (const pkg of packages) {
      if (pkg.scripts.test && !isPlaceholderScript(pkg.scripts.test) && (await hasRunnablePackageScript(workspaceRoot, pkg.relativePath, pkg.scripts.test))) {
        if (!(await hasMatchingTestFiles(workspaceRoot, pkg.relativePath, pkg.scripts.test))) continue;
        const command = await buildPackageScriptCommand(workspaceRoot, pkg.relativePath, "test");
        commands.push({
          id: `${pkg.relativePath || "root"}:test`,
          command,
          purpose: "package test script",
          required: true,
        });
      }
      if (pkg.scripts.build && !isPlaceholderScript(pkg.scripts.build) && (await hasRunnablePackageScript(workspaceRoot, pkg.relativePath, pkg.scripts.build))) {
        const command = await buildPackageScriptCommand(workspaceRoot, pkg.relativePath, "build");
        commands.push({
          id: `${pkg.relativePath || "root"}:build`,
          command,
          purpose: "package build script",
          required: true,
        });
      }
      for (const scriptName of ["check", "lint"] as const) {
        const script = pkg.scripts[scriptName];
        if (!script || isPlaceholderScript(script) || !(await hasRunnablePackageScript(workspaceRoot, pkg.relativePath, script))) continue;
        const command = await buildPackageScriptCommand(workspaceRoot, pkg.relativePath, scriptName);
        commands.push({
          id: `${pkg.relativePath || "root"}:${scriptName}`,
          command,
          purpose: `package ${scriptName} script`,
          required: true,
        });
      }
    }
    if (commands.length > 0) {
      return {
        command: commands.map((item) => item.command).join(" && "),
        commands,
        ...(explicit?.generated !== undefined ? { generated: explicit.generated } : {}),
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function discoverPackageScripts(workspaceRoot: string): Promise<Array<{ relativePath: string; scripts: Record<string, string> }>> {
  const results: Array<{ relativePath: string; scripts: Record<string, string> }> = [];
  const ignored = new Set(["node_modules", ".git", "scratchpad", ".reaper", "dist", "build", "coverage"]);
  const visit = async (relativeDir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    const absoluteDir = path.join(workspaceRoot, relativeDir);
    let entries: Awaited<ReturnType<typeof readdirWithFileTypes>>;
    try {
      entries = await readdirWithFileTypes(absoluteDir);
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
      const packageJson = JSON.parse(await readFile(path.join(absoluteDir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      results.push({ relativePath: relativeDir, scripts: packageJson.scripts ?? {} });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || ignored.has(entry.name)) continue;
      await visit(relativeDir ? path.join(relativeDir, entry.name) : entry.name, depth + 1);
    }
  };
  await visit("", 0);
  return results.sort((a, b) => packagePriority(a.relativePath) - packagePriority(b.relativePath));
}

function packagePriority(relativePath: string): number {
  if (!relativePath) return 0;
  if (/^(server|backend|api)$/i.test(relativePath)) return 1;
  if (/^(client|frontend|web|app)$/i.test(relativePath)) return 2;
  return 3;
}

async function rejectWeakVerification(workspaceRoot: string, verification: VerificationCommand): Promise<boolean> {
  const commands = normalizeVerificationCommands(verification);
  if (commands.length === 0) return true;
  for (const item of commands) {
    const command = item.command.trim();
    if (isPlaceholderCommand(command)) return true;
    const script = await resolvePackageScriptForCommand(workspaceRoot, command);
    if (script === undefined && isPackageScriptCommand(command)) return true;
    if (script !== undefined && isPlaceholderScript(script)) return true;
    const parsed = parsePackageScriptCommand(command);
    if (parsed?.scriptName === "test" && script !== undefined && !(await hasMatchingTestFiles(workspaceRoot, parsed.relativePath, script))) return true;
  }
  return false;
}

function isPlaceholderScript(script: string): boolean {
  const normalized = script.trim().replace(/^["']|["']$/g, "");
  return (
    /no test specified|todo|placeholder|not implemented/i.test(normalized) ||
    /\b--passWithNoTests\b/i.test(normalized) ||
    /^(?:echo|printf)\b[\s\S]*(?:success|passed|complete|done|ok|verified|models created|api created|frontend created)/i.test(normalized) ||
    /^(?:true|exit\s+0)\s*$/i.test(normalized) ||
    /^(?:echo|printf)\b/i.test(normalized) && !/\b(jest|vitest|mocha|ava|tap|pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|tsc|vite|webpack|next|react-scripts|eslint|ruff|mypy)\b/i.test(normalized)
  );
}

function isPlaceholderCommand(command: string): boolean {
  const normalized = command.trim().replace(/^["']|["']$/g, "");
  return (
    /^(?:true|exit\s+0)\s*$/i.test(normalized) ||
    /^(?:echo|printf)\b[\s\S]*(?:success|passed|complete|done|ok|verified|models created|api created|frontend created)/i.test(normalized)
  );
}

async function resolvePackageScriptForCommand(workspaceRoot: string, command: string): Promise<string | undefined> {
  const parsed = parsePackageScriptCommand(command);
  if (!parsed) return undefined;
  const packageJsonPath = path.join(workspaceRoot, parsed.relativePath, "package.json");
  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
    return packageJson.scripts?.[parsed.scriptName];
  } catch {
    return undefined;
  }
}

function parsePackageScriptCommand(command: string): { relativePath: string; scriptName: string } | undefined {
  const trimmed = command.trim();
  const cdMatch = trimmed.match(/^cd\s+('([^']+)'|"([^"]+)"|([^\s;&|]+))\s*&&\s*(.+)$/);
  const relativePath = cdMatch ? (cdMatch[2] ?? cdMatch[3] ?? cdMatch[4] ?? "") : "";
  const rest = (cdMatch ? (cdMatch[5] ?? "") : trimmed).trim();
  if (/^npm\s+(?:test|t)(?:\s|$)/i.test(rest)) return { relativePath, scriptName: "test" };
  const npmRun = rest.match(/^npm\s+run\s+([A-Za-z0-9:_-]+)(?:\s|$)/i);
  if (npmRun?.[1]) return { relativePath, scriptName: npmRun[1] };
  const packageRun = rest.match(/^(?:pnpm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9:_-]+)(?:\s|$)/i);
  if (packageRun?.[1]) return { relativePath, scriptName: packageRun[1] };
  return undefined;
}

function isPackageScriptCommand(command: string): boolean {
  return parsePackageScriptCommand(command) !== undefined;
}

async function hasRunnablePackageScript(workspaceRoot: string, relativePath: string, script: string): Promise<boolean> {
  const binary = extractScriptBinary(script);
  if (!binary || isShellBuiltinOrPortableCommand(binary)) return true;
  const packageRoot = path.join(workspaceRoot, relativePath);
  const localBin = process.platform === "win32" ? `${binary}.cmd` : binary;
  try {
    await readFile(path.join(packageRoot, "node_modules", ".bin", localBin));
    return true;
  } catch {
    // If dependencies are not installed yet, final verification can install them before running the script.
    return true;
  }
}

async function hasMatchingTestFiles(workspaceRoot: string, relativePath: string, script: string): Promise<boolean> {
  const packageRoot = path.join(workspaceRoot, relativePath);
  const files = await listFiles(packageRoot, 5);
  const testFiles = files.filter((file) => /(^|\/)(__tests__\/.*|tests?\/.*|.*(?:\.test|\.spec)\.[cm]?[jt]sx?|.*_test\.(?:py|go)|.*Test\.(?:java|kt))$/i.test(file));
  if (testFiles.length === 0) return false;
  if (/\b(jest|vitest|mocha|ava|tap|node\s+--test|react-scripts\s+test)\b/i.test(script)) return true;
  if (/\bpytest\b/i.test(script)) return testFiles.some((file) => /\.py$/i.test(file));
  if (/\bgo\s+test\b/i.test(script)) return testFiles.some((file) => /_test\.go$/i.test(file));
  if (/\bcargo\s+test\b/i.test(script)) return true;
  return true;
}

async function listFiles(root: string, maxDepth: number): Promise<string[]> {
  const ignored = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".cache"]);
  const output: string[] = [];
  const visit = async (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: Awaited<ReturnType<typeof readdirWithFileTypes>>;
    try {
      entries = await readdirWithFileTypes(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || ignored.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
      } else if (entry.isFile()) {
        output.push(relative);
      }
    }
  };
  await visit(root, 0);
  return output;
}

async function buildPackageScriptCommand(workspaceRoot: string, relativePath: string, scriptName: "test" | "build" | "check" | "lint"): Promise<string> {
  const packageRoot = path.join(workspaceRoot, relativePath);
  const runCommand = scriptName === "test" ? "npm test" : `npm run ${scriptName}`;
  const needsInstall = !(await pathExists(path.join(packageRoot, "node_modules")));
  const command = `${needsInstall ? "npm install && " : ""}${runCommand}`;
  return `${relativePath ? `cd ${shellQuote(relativePath)} && ` : ""}${command}`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await readdir(targetPath);
    return true;
  } catch {
    return false;
  }
}

function extractScriptBinary(script: string): string | undefined {
  const withoutEnv = script
    .replace(/^\s*(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/i, "")
    .replace(/^\s*(?:cross-env|env)\s+(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/i, "")
    .trim();
  const first = withoutEnv.match(/^["']?([A-Za-z0-9._/@+-]+)["']?/);
  return first?.[1];
}

function isShellBuiltinOrPortableCommand(binary: string): boolean {
  return /^(echo|test|\[|true|false|cd|pwd|mkdir|rm|cp|mv|cat|sed|awk|grep|find|sh|bash)$/i.test(binary);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function readdirWithFileTypes(targetPath: string) {
  return readdir(targetPath, { withFileTypes: true });
}

export async function runVerificationCommand(
  workspaceRoot: string,
  verification: VerificationCommand,
): Promise<VerificationResult> {
  const startedAt = new Date().toISOString();
  try {
    const commands = normalizeVerificationCommands(verification);
    const outputs: string[] = [];
    for (const item of commands) {
      const result = await runShellCommandTool(workspaceRoot, { cmd: item.command, timeoutMs: verification.lite ? 30_000 : verificationTimeoutMs(item.command) }, "allow_all");
      if (isBackgroundShellResult(result)) {
        throw new Error("Verification command should not be run in background");
      }
      const formatted = formatCommandOutput(item.command, result.stdout, result.stderr);
      const semanticFailure = detectSemanticFailureText(formatted);
      if (semanticFailure) {
        throw new Error(
          `Verification command exited successfully but reported failure (${semanticFailure.reason}): ${semanticFailure.line}\n${formatted}`,
        );
      }
      outputs.push(formatted);
    }
    const endedAt = new Date().toISOString();
    const groundedSignal = selectGroundedSignal(commands.map((item) => item.command));

    return {
      ok: true,
      command: commands.map((item) => item.command).join(" && "),
      liteVerified: verification.lite === true,
      groundedSignal,
      stdout: outputs.join("\n"),
      stderr: "",
      output: outputs.join("\n"),
      startedAt,
      endedAt,
    };
  } catch (error) {
    const endedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : "Unknown verification failure";
    return {
      ok: false,
      command: verification.command,
      liteVerified: verification.lite === true,
      groundedSignal: selectGroundedSignal(normalizeVerificationCommands(verification).map((item) => item.command)),
      output: message,
      startedAt,
      endedAt,
    };
  }
}

function verificationTimeoutMs(command: string): number {
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint)\b|\b(jest|vitest|mocha|ava|tap|pytest|node\s+--test|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test)\b/i.test(command)) {
    return 90_000;
  }
  return 180_000;
}

function normalizeVerificationCommands(verification: VerificationCommand): Array<{ command: string }> {
  const commands = verification.commands?.filter((item) => item.required !== false && item.command.trim()) ?? [];
  if (commands.length > 0) {
    return commands.map((item) => ({ command: item.command }));
  }
  return [{ command: verification.command }];
}

export function selectGroundedSignal(commands: string[]): VerificationGroundedSignal {
  for (const command of commands) {
    const signal = classifyGroundedVerificationSignal(command);
    if (signal.grounded) return signal;
  }
  const command = commands.find((item) => item.trim()) ?? "";
  return { kind: "none", command, grounded: false };
}

export function classifyGroundedVerificationSignal(command: string): VerificationGroundedSignal {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) return { kind: "none", command: normalized, grounded: false };
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)\b|\b(?:pytest|node\s+--test|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|jest|vitest|mocha|ava|tap|playwright\s+test|cypress)\b/i.test(normalized)) {
    return { kind: "test", command: normalized, grounded: true };
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build)\b|\b(?:tsc\s+-b|vite\s+build|webpack|next\s+build|react-scripts\s+build|cargo\s+build|go\s+build|mvn\s+package|gradle\s+build|make|cmake|ninja|gcc|g\+\+|clang|javac)\b/i.test(normalized)) {
    return { kind: "build", command: normalized, grounded: true };
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|check)\b|\b(?:tsc\s+--noEmit|mypy|pyright|go\s+vet|cargo\s+check)\b/i.test(normalized)) {
    return { kind: "typecheck", command: normalized, grounded: true };
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint)\b|\b(?:eslint|ruff|flake8|pylint|cargo\s+clippy)\b/i.test(normalized)) {
    return { kind: "lint", command: normalized, grounded: true };
  }
  if (/\b(?:test\s+|\[\s+|diff\b|cmp\b|grep\s+-q\b|jq\s+-e\b|sha1sum\b|sha256sum\b|md5sum\b)/i.test(normalized)) {
    return { kind: "artifact_check", command: normalized, grounded: true };
  }
  if (/\b(?:python3?|node|ruby|go|cargo|java|curl|wget)\b/i.test(normalized) && /\b(?:assert|raise\s+SystemExit|sys\.exit\s*\(\s*[1-9]|process\.exit\s*\(\s*[1-9]|exit\s+[1-9]|throw\s+new\s+Error|grep\s+-q|jq\s+-e|test\s+|\[\s+|diff|cmp)\b/i.test(normalized)) {
    return { kind: "runtime_reproduction", command: normalized, grounded: true };
  }
  return { kind: "none", command: normalized, grounded: false };
}

export function hasFailBeforeFixEvidence(input: {
  command: string;
  priorResults: Array<{ ok: boolean; name: string; args?: unknown }>;
}): boolean {
  const expected = normalizeCommandForEvidence(input.command);
  if (!expected) return false;
  return input.priorResults.some((result) => {
    if (result.ok || result.name !== "run_shell_command") return false;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const cmd = typeof args.cmd === "string" ? normalizeCommandForEvidence(args.cmd) : "";
    return cmd === expected;
  });
}

export function validateGeneratedVerificationInvariant(input: {
  verification: VerificationCommand;
  priorResults: Array<{ ok: boolean; name: string; args?: unknown }>;
}): { ok: true } | { ok: false; message: string; missingCommands: string[] } {
  if (!input.verification.generated) return { ok: true };
  const missingCommands = normalizeVerificationCommands(input.verification)
    .map((item) => item.command)
    .filter((command) => classifyGroundedVerificationSignal(command).grounded)
    .filter((command) => hasPriorPassingEvidenceWithoutFailure({ command, priorResults: input.priorResults }));
  if (missingCommands.length === 0) return { ok: true };
  return {
    ok: false,
    missingCommands,
    message:
      "Generated reproduction checks must not pass on the pre-change/baseline trace: an exact grounded check already passed earlier without prior failing evidence, so it cannot prove the repair.",
  };
}

function hasPriorPassingEvidenceWithoutFailure(input: {
  command: string;
  priorResults: Array<{ ok: boolean; name: string; args?: unknown }>;
}): boolean {
  const expected = normalizeCommandForEvidence(input.command);
  if (!expected) return false;
  let sawFailure = false;
  let sawMutation = false;
  for (const result of input.priorResults) {
    if (isMutationResult(result)) sawMutation = true;
    if (result.name !== "run_shell_command") continue;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const cmd = typeof args.cmd === "string" ? normalizeCommandForEvidence(args.cmd) : "";
    if (cmd !== expected) continue;
    if (!result.ok) sawFailure = true;
    if (result.ok && !sawFailure && !sawMutation) return true;
  }
  return false;
}

function isMutationResult(result: { name: string; args?: unknown }): boolean {
  if (result.name === "write_file" || result.name === "replace_in_file" || result.name === "delete_file" || result.name === "edit_file" || result.name === "replace_symbol") return true;
  if (result.name !== "run_shell_command") return false;
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  const cmd = typeof args.cmd === "string" ? cmdNormalizeForMutation(args.cmd) : "";
  return /(?:^|[;&|]\s*)(?:touch|mkdir|rm|rmdir|mv|cp|tee|sed\s+-i|perl\s+-pi|patch|git\s+apply|python3?\s+.*(?:write|open\([^)]*['"]w)|node\s+.*writeFile|npm\s+(?:install|i)|pnpm\s+(?:install|i)|yarn\s+(?:install|add)|bun\s+install)\b/i.test(cmd);
}

function cmdNormalizeForMutation(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function normalizeCommandForEvidence(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function formatCommandOutput(command: string, stdout: string, stderr: string): string {
  return [`$ ${command}`, stdout, stderr].filter((part) => part.trim().length > 0).join("\n");
}
