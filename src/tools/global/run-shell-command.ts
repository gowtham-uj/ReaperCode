import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import treeKill from "tree-kill";

import { evaluateCommandPolicy, type SafetyProfile } from "../../policy/rules.js";
import type { RuleEvaluationContext } from "../../policy/rules.js";
import { getReaperScratchpadPaths } from "../../workspace/scratchpad.js";
import { PathPolicyError, normalizeWorkspacePath } from "../../policy/paths.js";

function getStallWatchdogIntervalMs(): number {
  return Number(process.env.REAPER_STALL_WATCHDOG_INTERVAL_MS ?? 5_000);
}
function getStallWatchdogNoOutputThresholdMs(): number {
  return Number(process.env.REAPER_STALL_WATCHDOG_NO_OUTPUT_MS ?? 45_000);
}
function getSizeWatchdogMaxBytes(): number {
  return Number(process.env.REAPER_MAX_SHELL_OUTPUT_BYTES ?? 50 * 1024 * 1024);
}
const INTERACTIVE_PROMPT_RE = /\(\s*y\s*\/\s*n\s*\)|press\s+enter|password\s*:|continue\?|confirm\s*\?|type\s+\'yes\'|type\s+\"yes\"/i;

export interface ForegroundShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  wouldBlock: boolean;
  nextCwd?: string;
  logPath?: string;
  persistedOutputSize?: number;
}

export interface BackgroundShellResult {
  pid: number;
  status: "running";
  wouldBlock: boolean;
  logPath?: string;
  startupOutput: string[];
  child: import("node:child_process").ChildProcess;
}

export type ShellCommandResult = ForegroundShellResult | BackgroundShellResult;

export function isBackgroundShellResult(value: ShellCommandResult): value is BackgroundShellResult {
  return "child" in value && (value as BackgroundShellResult).status === "running";
}

export function isForegroundShellResult(value: ShellCommandResult): value is ForegroundShellResult {
  return !isBackgroundShellResult(value);
}

export async function runShellCommandTool(
  workspaceRoot: string,
  args: { cmd: string; timeoutMs?: number; idleTimeoutMs?: number; isBackground?: boolean },
  safetyProfile: SafetyProfile,
  workingDirectory = workspaceRoot,
  ruleContext?: RuleEvaluationContext,
  runtime?: { runId: string; artifactDir: string; toolCallId: string },
): Promise<ShellCommandResult> {
  args = { ...args, cmd: normalizeWorkspaceShellAliases(args.cmd, workspaceRoot) };
  enforceShellWorkspaceBoundary(workspaceRoot, workingDirectory, args.cmd);
  const packageCommandResolution = resolveBarePackageCommandCwd(workspaceRoot, workingDirectory, args.cmd);
  const effectiveWorkingDirectory = packageCommandResolution?.cwd ?? workingDirectory;

  if (/\bcd\s+(?:\S*\/)?\.reaper-scratch\b[\s\S]*\bnpm\s+init\b/i.test(args.cmd)) {
    throw new Error(
      `Do not run npm init inside .reaper-scratch because npm derives the invalid package name ".reaper-scratch". ` +
      `Create .reaper-scratch/package.json with write_file using a valid package name, then run npm install inside .reaper-scratch.`,
    );
  }
  if (/&\s*(?:sleep|wait|kill\b|$)|kill\s+%\d+/i.test(args.cmd)) {
    throw new Error(
      "Shell job-control backgrounding is disabled for reliability. Use run_shell_command with isBackground:true, then read_background_output and signal_process.",
    );
  }
  if (isInteractiveShellCommand(args.cmd)) {
    throw new Error(
      "Interactive shell commands are disabled because they can hang unattended. Provide a script/file, use a non-interactive one-liner such as 'node -e \"...\"', or set isBackground:true only for long-running servers.",
    );
  }
  if (isUnboundedRecursiveListing(args.cmd)) {
    throw new Error(
      "Unbounded recursive listing is disabled because it floods context with dependency/build artifacts. " +
      "Use list_directory for repository structure, grep_search for file discovery, or a pruned shell command that excludes node_modules, .git, dist, build, coverage, and cache directories.",
    );
  }
  if (isDockerRuntimeCommand(args.cmd) && !isDockerDaemonAvailable()) {
    throw new Error(
      "Docker daemon is unavailable in this environment. Do not run docker, docker compose, or docker-compose for this task. " +
      "Create or inspect Docker-related files with file tools/static checks, document the limitation, and continue with non-Docker verification.",
    );
  }
  const ecosystemMismatch = classifyWrongEcosystemDependencyInstall(workspaceRoot, effectiveWorkingDirectory, args.cmd);
  if (ecosystemMismatch) {
    throw new Error(ecosystemMismatch);
  }
  const unsafeTargetedTest = targetedNpmTestWithoutForwarding(workspaceRoot, effectiveWorkingDirectory, args.cmd);
  if (unsafeTargetedTest) {
    throw new Error(
      `Targeted package test command '${unsafeTargetedTest.rest}' is ambiguous because npm scripts do not always forward positional paths. ` +
      `Inspect '${path.relative(workspaceRoot, unsafeTargetedTest.cwd) || "."}/package.json', then run the package's actual test runner directly or use 'npm test -- <path>' only when the script supports argument forwarding. ` +
      "Do not accidentally run unrelated repository tests.",
    );
  }

  const decision = evaluateCommandPolicy(args.cmd, safetyProfile, ruleContext);
  if (decision.outcome === "deny") {
    const error = new Error(decision.message);
    (error as Error & { code?: string }).code = decision.ruleId;
    throw error;
  }

  const timeoutMs = args.timeoutMs ?? defaultTimeoutMsForCommand(args.cmd);
  const idleTimeoutMs = args.idleTimeoutMs ?? defaultIdleTimeoutMsForCommand(args.cmd);

  const isServerCommand = isLikelyServerCommand(args.cmd);
  const isBackground = args.isBackground || isServerCommand;

  if (isBackground) {
    const logPath = runtime ? await createProcessLog(runtime, args.cmd, effectiveWorkingDirectory) : undefined;
    const child = spawn(resolveShellBinary(), ["-c", args.cmd], {
      cwd: effectiveWorkingDirectory,
      env: buildCommandEnv(workspaceRoot),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.unref();

    if (!child.pid) {
      throw new Error("Failed to spawn background process");
    }

    const startup = await observeBackgroundStartup(child, logPath, args.cmd);
    if (startup.exited) {
      if (startup.exitCode === 0 && !startup.signal) {
        return {
          stdout: startup.stdout,
          stderr: startup.stderr,
          exitCode: 0,
          wouldBlock: decision.outcome === "would_block",
          ...(logPath ? { logPath, persistedOutputSize: Buffer.byteLength(`${startup.stdout}\n${startup.stderr}`, "utf8") } : {}),
        };
      }
      throw new Error(
        formatCommandFailure({
          cmd: args.cmd,
          exitCode: startup.exitCode,
          signal: startup.signal,
          stdout: startup.stdout,
          stderr: startup.stderr,
          timedOut: false,
        }),
      );
    }

    return {
      pid: child.pid,
      status: "running",
      wouldBlock: decision.outcome === "would_block",
      ...(logPath ? { logPath } : {}),
      startupOutput: [startup.stdout, startup.stderr].filter(Boolean) as string[],
      child, // Caller handles buffering if needed
    };
  }
  return await new Promise<{ stdout: string; stderr: string; exitCode: number | null; wouldBlock: boolean; nextCwd?: string; logPath?: string; persistedOutputSize?: number }>(
    (resolve, reject) => {
      const wrapper = `
set -o pipefail
(
${packageCommandResolution?.notice ? `printf '[REAPER PACKAGE ROOT] ${shellSingleQuoteForPrintf(packageCommandResolution.notice)}\\n'\n` : ""}
${args.cmd}
)
__REAPER_EXIT_CODE=$?
__REAPER_CWD="$(pwd)"
printf '\\n___REAPER_CWD:%s___\\n' "$__REAPER_CWD"
printf '___REAPER_EXIT_CODE:%s___\\n' "$__REAPER_EXIT_CODE"
exit 0
`;

      const child = spawn(resolveShellBinary(), ["-c", wrapper], {
        cwd: effectiveWorkingDirectory,
        env: buildCommandEnv(workspaceRoot),
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let stalled = false;
      let sizeLimitExceeded = false;
      let lastOutputAt = Date.now();
      let lastOutputLength = 0;
      let sigkillTimer: NodeJS.Timeout | undefined;
      let wrapperExitObserved = false;
      let wrapperExitCleanupTimer: NodeJS.Timeout | undefined;
      const startTime = Date.now();
      const logPathPromise = runtime ? createProcessLog(runtime, args.cmd, effectiveWorkingDirectory) : Promise.resolve(undefined);
      let totalOutputBytes = 0;
      const maxBufferedOutputChars = Math.max(16_384, Math.min(getSizeWatchdogMaxBytes(), 256 * 1024));

      // Wall-clock timeout
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid, "SIGTERM");
        sigkillTimer = setTimeout(() => killProcessTree(child.pid, "SIGKILL"), 2_000);
      }, timeoutMs);

      // Idle timeout
      const idleTimer = idleTimeoutMs
        ? setInterval(() => {
            if (Date.now() - lastOutputAt >= idleTimeoutMs) {
              timedOut = true;
              killProcessTree(child.pid, "SIGTERM");
              sigkillTimer = sigkillTimer ?? setTimeout(() => killProcessTree(child.pid, "SIGKILL"), 2_000);
            }
          }, Math.min(1000, idleTimeoutMs))
        : undefined;

      // Stall watchdog: detects interactive prompts and hung commands
      const stallTimer = setInterval(() => {
        const now = Date.now();
        const totalLen = stdout.length + stderr.length;
        if (now - lastOutputAt >= getStallWatchdogNoOutputThresholdMs() && totalLen === lastOutputLength) {
          const combinedTail = (stdout + stderr).slice(-512);
          if (INTERACTIVE_PROMPT_RE.test(combinedTail)) {
            stalled = true;
            killProcessTree(child.pid, "SIGKILL");
          }
        }
        lastOutputLength = totalLen;
      }, getStallWatchdogIntervalMs());

      child.stdout.on("data", (chunk) => {
        const str = String(chunk);
        totalOutputBytes += Buffer.byteLength(str, "utf8");
        stdout = appendBoundedOutput(stdout, str, maxBufferedOutputChars);
        lastOutputAt = Date.now();
        void logPathPromise.then((logPath) => appendProcessLog(logPath, "stdout", str));
        if (stdout.includes("___REAPER_EXIT_CODE:") && !wrapperExitObserved) {
          wrapperExitObserved = true;
          // Foreground commands sometimes launch a temporary server with `&`
          // and then print Reaper's wrapper exit marker while that child still
          // holds stdout/stderr open. Once the wrapper has reported its real
          // exit code, clean up the detached foreground process group so the
          // ChildProcess `close` event can fire and the tool result can return
          // to the model instead of hanging behind an orphan server.
          wrapperExitCleanupTimer = setTimeout(() => killProcessTree(child.pid, "SIGTERM"), 250);
        }
        if (totalOutputBytes > getSizeWatchdogMaxBytes()) {
          sizeLimitExceeded = true;
        }
        // Heartbeat
        if (stdout.length % 1024 === 0) {
          console.log(`[shell] ${args.cmd.slice(0, 50)}... (${stdout.length} buffered bytes, ${totalOutputBytes} total bytes)`);
        }
      });
      child.stderr.on("data", (chunk) => {
        const str = String(chunk);
        totalOutputBytes += Buffer.byteLength(str, "utf8");
        stderr = appendBoundedOutput(stderr, str, maxBufferedOutputChars);
        lastOutputAt = Date.now();
        void logPathPromise.then((logPath) => appendProcessLog(logPath, "stderr", str));
        if (totalOutputBytes > getSizeWatchdogMaxBytes()) {
          sizeLimitExceeded = true;
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        if (idleTimer) clearInterval(idleTimer);
        clearInterval(stallTimer);
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
        }
        if (wrapperExitCleanupTimer) {
          clearTimeout(wrapperExitCleanupTimer);
        }
        reject(error);
      });
      child.on("close", async (exitCode, signal) => {
        clearTimeout(timer);
        if (idleTimer) clearInterval(idleTimer);
        clearInterval(stallTimer);
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
        }
        if (wrapperExitCleanupTimer) {
          clearTimeout(wrapperExitCleanupTimer);
        }
        const logPath = await logPathPromise;

        // Extract CWD and real Exit Code from wrapper output
        let realCwd = effectiveWorkingDirectory;
        let realExitCode = exitCode;

        const cwdMatch = stdout.match(/___REAPER_CWD:(.*)___/);
        if (cwdMatch) {
          realCwd = cwdMatch[1]!.trim();
          stdout = stdout.replace(/___REAPER_CWD:.*___\n?/, "");
        }
        try {
          normalizeWorkspacePath(workspaceRoot, realCwd);
        } catch {
          reject(new PathPolicyError(`Command changed directory outside workspace root '${path.resolve(workspaceRoot)}': ${realCwd}`));
          return;
        }
        const codeMatch = stdout.match(/___REAPER_EXIT_CODE:(\d+)___/);
        if (codeMatch) {
          realExitCode = parseInt(codeMatch[1]!, 10);
          stdout = stdout.replace(/___REAPER_EXIT_CODE:.*___\n?/, "");
        }

        if (stalled) {
          reject(
            new Error(
              [
                `Shell command stalled on interactive prompt: ${args.cmd}`,
                `stdout: ${tail(stdout.trim(), 2000) || "<empty>"}`,
                `stderr: ${tail(stderr.trim(), 2000) || "<empty>"}`,
                "",
                "[REMEDIATION TIP]: The command appears to be waiting for interactive input. Use non-interactive flags, provide input via file tools, or run with explicit stdin. Do not run interactive commands.",
              ].join("\n"),
            ),
          );
          return;
        }

        if (sizeLimitExceeded && logPath) {
          stdout = appendOutputSpillNotice(stdout, logPath, totalOutputBytes);
        }

        if (timedOut) {
          reject(
            new Error(
              formatCommandFailure({
                cmd: args.cmd,
                timeoutMs,
                stdout,
                stderr,
                signal,
                timedOut: true,
                timedOutKind: args.idleTimeoutMs && Date.now() - lastOutputAt >= args.idleTimeoutMs ? "idle" : "wall",
              }),
            ),
          );
          return;
        }
        if (realExitCode === 1 && isNoMatchSearchCommand(args.cmd, stdout, stderr)) {
          resolve({
            stdout: stdout.trimEnd() ? stdout : "[REAPER SEARCH RESULT]: no matches found\n",
            stderr,
            exitCode: 0,
            wouldBlock: decision.outcome === "would_block",
            nextCwd: realCwd,
            ...(logPath ? { logPath, persistedOutputSize: totalOutputBytes } : {}),
          });
          return;
        }
        if (realExitCode && realExitCode !== 0 && isIdempotentMissingMoveAlreadyApplied(workspaceRoot, effectiveWorkingDirectory, args.cmd, stdout, stderr)) {
          resolve({
            stdout:
              `${stdout.trimEnd()}\n[REAPER IDEMPOTENT FILE OP]: mv source was already absent and the target already exists; treating this as already applied.\n`.trimStart(),
            stderr,
            exitCode: 0,
            wouldBlock: decision.outcome === "would_block",
            nextCwd: realCwd,
            ...(logPath ? { logPath, persistedOutputSize: totalOutputBytes } : {}),
          });
          return;
        }
        if (realExitCode && realExitCode !== 0) {
          reject(
            new Error(
              formatCommandFailure({
                cmd: args.cmd,
                exitCode: realExitCode,
                stdout,
                stderr,
                signal,
                timedOut: false,
              }),
            ),
          );
          return;
        }
        if (isCancelledScaffoldCommand(args.cmd, stdout, stderr)) {
          reject(
            new Error(
              [
                "Interactive scaffold command exited without creating the project.",
                `Command: ${args.cmd}`,
                `stdout: ${tail(stdout.trim(), 4000) || "<empty>"}`,
                `stderr: ${tail(stderr.trim(), 4000) || "<empty>"}`,
                "",
                "[REMEDIATION TIP]: The scaffold tool cancelled because it needed interactive input or refused an existing directory. Do not repeat the same command unchanged. Use documented non-interactive flags, create the files directly with file tools, or inspect the target directory and continue from its current state.",
              ].join("\n"),
            ),
          );
          return;
        }
        resolve({
          stdout: appendCommandWarnings(args.cmd, stdout, stderr, Date.now() - startTime, timeoutMs),
          stderr,
          exitCode: realExitCode,
          wouldBlock: decision.outcome === "would_block",
          nextCwd: realCwd,
          ...(logPath ? { logPath, persistedOutputSize: totalOutputBytes } : {}),
        });
      });
    },
  );
}

function appendBoundedOutput(current: string, chunk: string, maxChars: number): string {
  const combined = current + chunk;
  if (combined.length <= maxChars) return combined;
  return combined.slice(-maxChars);
}

function appendOutputSpillNotice(output: string, logPath: string, totalBytes: number): string {
  const notice = `\n\n[REAPER OUTPUT SPILLED]: output exceeded ${getSizeWatchdogMaxBytes()} bytes; kept a bounded tail here and wrote ${totalBytes} bytes to ${logPath}\n`;
  if (output.includes("[REAPER OUTPUT SPILLED]")) return output;
  return `${output.trimEnd()}${notice}`;
}

function isIdempotentMissingMoveAlreadyApplied(
  workspaceRoot: string,
  workingDirectory: string,
  command: string,
  stdout: string,
  stderr: string,
): boolean {
  const output = `${stdout}\n${stderr}`;
  const missing = output.match(/mv:\s+cannot stat ['"]?([^'"\n:]+)['"]?:\s+No such file or directory/i);
  if (!missing) return false;
  const missingSource = missing[1]!.trim();
  for (const operation of extractMoveOperations(command)) {
    if (stripShellQuotes(operation.source) !== missingSource && path.basename(stripShellQuotes(operation.source)) !== path.basename(missingSource)) {
      continue;
    }
    const cwd = resolveCommandCwd(workingDirectory, operation.cwd);
    const target = path.resolve(cwd, stripShellQuotes(operation.target));
    try {
      normalizeWorkspacePath(workspaceRoot, target);
    } catch {
      continue;
    }
    if (existsSync(target)) return true;
  }
  return false;
}

function extractMoveOperations(command: string): Array<{ cwd?: string; source: string; target: string }> {
  const operations: Array<{ cwd?: string; source: string; target: string }> = [];
  let cwd: string | undefined;
  const parts = command.split(/\s*(?:&&|;)\s*/);
  for (const part of parts) {
    const cdMatch = part.match(/^cd\s+(.+)$/);
    if (cdMatch) {
      cwd = stripShellQuotes(cdMatch[1]!.trim());
      continue;
    }
    const mvMatch = part.match(/^mv\s+(-[A-Za-z]+\s+)?(\S+)\s+(\S+)$/);
    if (mvMatch) {
      operations.push({ ...(cwd ? { cwd } : {}), source: mvMatch[2]!, target: mvMatch[3]! });
    }
  }
  return operations;
}

function resolveCommandCwd(workingDirectory: string, maybeCwd?: string): string {
  if (!maybeCwd) return workingDirectory;
  return path.isAbsolute(maybeCwd) ? maybeCwd : path.resolve(workingDirectory, maybeCwd);
}

function stripShellQuotes(value: string): string {
  return value.replace(/^(['"])(.*)\1$/, "$2");
}

function isCancelledScaffoldCommand(cmd: string, stdout: string, stderr: string): boolean {
  const normalized = stripLeadingCdCommands(cmd.trim());
  if (!/\b(?:create-vite|create-next-app|npm\s+create|pnpm\s+create|yarn\s+create|bun\s+create|ng\s+new|rails\s+new|django-admin\s+startproject)\b/i.test(normalized)) {
    return false;
  }
  return /\boperation cancelled\b|\baborted\b|\bcancelled\b/i.test(`${stdout}\n${stderr}`);
}

function isNoMatchSearchCommand(cmd: string, stdout: string, stderr: string): boolean {
  if (stdout.trim() || stderr.trim()) return false;
  const normalized = stripLeadingCdCommands(cmd.trim());
  return /^(?:grep|rg)\b/.test(normalized);
}

async function observeBackgroundStartup(
  child: import("node:child_process").ChildProcess,
  logPath: string | undefined,
  cmd: string,
): Promise<{ exited: boolean; exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  const onStdout = (chunk: Buffer | string) => {
    const text = String(chunk);
    stdout += text;
    void appendProcessLog(logPath, "stdout", text);
  };
  const onStderr = (chunk: Buffer | string) => {
    const text = String(chunk);
    stderr += text;
    void appendProcessLog(logPath, "stderr", text);
  };
  const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => {
    exitCode = code;
    signal = exitSignal;
    void appendProcessLog(logPath, "system", `Process exited code=${code ?? "null"} signal=${exitSignal ?? "null"}`);
  };
  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  child.once("exit", onExit);
  await new Promise((resolve) => setTimeout(resolve, backgroundStartupProbeMs(cmd)));
  child.stdout?.off("data", onStdout);
  child.stderr?.off("data", onStderr);
  child.off("exit", onExit);
  return { exited: exitCode !== null || signal !== null, exitCode, signal, stdout, stderr };
}

function backgroundStartupProbeMs(cmd: string): number {
  const normalized = stripLeadingCdCommands(cmd.trim());
  if (/^(npm|pnpm|yarn)\s+(?:start|run\s+(?:dev|start|serve))(?:\s|$)/.test(normalized)) return 2_500;
  return /^node\s+/.test(normalized) ? 1_500 : 1_000;
}

function isInteractiveShellCommand(cmd: string): boolean {
  const trimmed = stripLeadingCdCommands(cmd.trim());
  return /^(node|python|python3|ruby|irb|php -a|sqlite3|psql|mysql)\s*$/.test(trimmed);
}

function isLikelyServerCommand(cmd: string): boolean {
  const trimmed = stripLeadingCdCommands(cmd.trim());
  const normalized = normalizeShellCommandForServerDetection(trimmed);
  return (
    /^cd\s+(?:"[^"]*\/?(?:server|backend|api)"|'[^']*\/?(?:server|backend|api)'|[^\s;&|]*\/?(?:server|backend|api))\s*&&\s*node\s+(?:index|app|server)\.js(?:\s|$)/.test(cmd.trim()) ||
    /^(npm|pnpm|yarn)\s+run\s+(dev|start|serve)(?:\s|$)/.test(trimmed) ||
    /^npm\s+start(?:\s|$)/.test(trimmed) ||
    /^(?:npx\s+)?nodemon\s+(?:(?:index|app|server)\.[cm]?js|(?:server|src|api|backend)\/(?:server|index|app)\.[cm]?js)(?:\s|$)/.test(normalized) ||
    /^(?:npx\s+)?(?:tsx|ts-node)\s+(?:(?:index|app|server)\.ts|(?:server|src|api|backend)\/(?:server|index|app)\.ts)(?:\s|$)/.test(normalized) ||
    /^node\s+(?:(?:index|app|server)\.js|server\/(?:server|index|app)\.js|src\/(?:server|index|app)\.js)(?:\s|$)/.test(normalized) ||
    /^python(?:3)?\s+-m\s+http\.server(?:\s|$)/.test(trimmed) ||
    /^(flask run|uvicorn|fastapi|django-admin runserver|rails runserver)(?:\s|$)/.test(trimmed)
  );
}

function normalizeShellCommandForServerDetection(cmd: string): string {
  const segments = cmd.split(/\s*&&\s*/).map((segment) => segment.trim()).filter(Boolean);
  return segments.at(-1) ?? cmd.trim();
}

function isUnboundedRecursiveListing(cmd: string): boolean {
  const normalized = stripLeadingCdCommands(cmd.trim());
  if (/^ls\s+(-[A-Za-z]*R[A-Za-z]*|-R)(?:\s+\.?)?\s*$/.test(normalized)) {
    return true;
  }
  if (/^find\s+\.?\s*$/.test(normalized)) {
    return true;
  }
  return false;
}

let dockerDaemonAvailableCache: boolean | undefined;

function isDockerRuntimeCommand(cmd: string): boolean {
  const normalized = stripLeadingCdCommands(cmd.trim());
  return /^(docker-compose|docker\s+compose)\s+(up|run|build|start|restart|logs|ps|exec|pull)\b/i.test(normalized) ||
    /^docker\s+(run|build|start|restart|logs|ps|exec|pull|info)\b/i.test(normalized);
}

function isDockerDaemonAvailable(): boolean {
  if (dockerDaemonAvailableCache !== undefined) {
    return dockerDaemonAvailableCache;
  }
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 });
    dockerDaemonAvailableCache = true;
  } catch {
    dockerDaemonAvailableCache = false;
  }
  return dockerDaemonAvailableCache;
}

function stripLeadingCdCommands(cmd: string): string {
  let remaining = cmd;
  for (let index = 0; index < 4; index += 1) {
    const match = remaining.match(/^cd\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*(.+)$/s);
    if (!match) return remaining;
    remaining = match[1]!.trim();
  }
  return remaining;
}

function normalizeWorkspaceShellAliases(cmd: string, workspaceRoot: string): string {
  const quotedWorkspace = shellQuote(workspaceRoot);
  return cmd
    .replace(/\bcd\s+['"]\$WORKSPACE['"]/g, `cd ${quotedWorkspace}`)
    .replace(/\bcd\s+['"]\$\{WORKSPACE\}['"]/g, `cd ${quotedWorkspace}`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function enforceShellWorkspaceBoundary(workspaceRoot: string, workingDirectory: string, cmd: string): void {
  const root = path.resolve(workspaceRoot);
  normalizeWorkspacePath(root, workingDirectory);

  let simulatedCwd = path.resolve(workingDirectory);
  for (const cdTarget of extractCdTargetsInOrder(cmd)) {
    const resolved = resolveShellPath(root, simulatedCwd, cdTarget);
    if (resolved && !isInsideOrEqual(root, resolved)) {
      throw new PathPolicyError(
        `Shell command attempts to cd outside workspace root '${root}': ${cdTarget}. ` +
        `Run commands from the task workspace or use $WORKSPACE for workspace-relative paths.`,
      );
    }
    if (resolved) {
      simulatedCwd = resolved;
    }
  }

  const guardedRoot = findGuardedRepoRoot(root);
  if (!guardedRoot) {
    return;
  }

  for (const absolutePath of extractAbsolutePaths(cmd, guardedRoot)) {
    const resolved = path.resolve(absolutePath);
    if (!isInsideOrEqual(root, resolved)) {
      throw new PathPolicyError(
        `Shell command references path outside workspace root '${root}': ${absolutePath}. ` +
        `Use relative paths or $WORKSPACE paths inside the task workspace.`,
      );
    }
  }
}

function extractCdTargetsInOrder(cmd: string): string[] {
  const targets: string[] = [];
  const cdPattern = /(?:^|[;&|({]\s*)cd\s+((?:"[^"]+"|'[^']+'|[^\s;&|()]+))/g;
  for (const match of cmd.matchAll(cdPattern)) {
    if (match[1]) {
      targets.push(unquoteShellToken(match[1]));
    }
  }
  return targets;
}

function extractAbsolutePaths(cmd: string, guardedRoot: string): string[] {
  const escaped = guardedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pathPattern = new RegExp(`${escaped}(?:/[^\\s'"\\\`;|&)]*)?`, "g");
  return Array.from(cmd.matchAll(pathPattern), (match) => match[0]!).filter(Boolean);
}

function resolveShellPath(root: string, workingDirectory: string, token: string): string | null {
  if (!token || token === "-" || token.startsWith("~")) {
    return null;
  }
  const expanded = token
    .replace(/^\$WORKSPACE(?=\/|$)/, root)
    .replace(/^\$\{WORKSPACE\}(?=\/|$)/, root)
    .replace(/^\$PWD(?=\/|$)/, workingDirectory)
    .replace(/^\$\{PWD\}(?=\/|$)/, workingDirectory);
  if (expanded.includes("$")) {
    return null;
  }
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(workingDirectory, expanded));
}

function findGuardedRepoRoot(workspaceRoot: string): string | null {
  const cwd = path.resolve(process.cwd());
  if (isInsideOrEqual(cwd, workspaceRoot)) {
    return cwd;
  }
  return null;
}

function isInsideOrEqual(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function unquoteShellToken(token: string): string {
  const trimmed = token.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) {
    return;
  }
  treeKill(pid, signal, (err) => {
    if (err) {
      // Fallback to process-group kill
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // Process already exited.
        }
      }
    }
  });
}

function formatCommandFailure(input: {
  cmd: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timeoutMs?: number;
  timedOutKind?: "wall" | "idle";
  stdout: string;
  stderr: string;
  timedOut: boolean;
}): string {
  const status = input.timedOut
    ? `Command ${input.timedOutKind === "idle" ? "idle " : ""}timed out after ${input.timeoutMs}ms`
    : `Command exited with code ${input.exitCode ?? "unknown"}${input.signal ? ` signal ${input.signal}` : ""}`;
  const stdout = tail(input.stdout.trim(), 4000);
  const stderr = tail(input.stderr.trim(), 4000);

  let remediationTip = "";
  const lowerOutput = (stdout + " " + stderr).toLowerCase();
  const cmd = input.cmd.toLowerCase();
  const missingShellBinary = (stdout + "\n" + stderr).match(/(?:^|\n)\s*(?:sh|bash):(?:\s*line\s*)?\s*\d+:\s*([a-z0-9._-]+):\s*(?:command\s+)?not found\b/i);
  const relativeImportFailure = stderr.match(/(?:Error: Cannot find module|ModuleNotFoundError: No module named|cannot find module) ['"]?([^'"\n]+)['"]?[\s\S]*(?:Require stack:\s*-\s*([^\n]+))?/i);
  const missingPackageScript = (stdout + "\n" + stderr).match(/Missing script:\s*["']?([^"'\n]+)["']?/i);

  if (/\btailwindcss\s+init\b/.test(cmd) && lowerOutput.includes("could not determine executable to run")) {
    remediationTip = "\n\n[REMEDIATION TIP]: Do not use 'npx tailwindcss init -p'. Tailwind v4 does not follow the old init workflow by default. Write the config/CSS directly, use @tailwindcss/vite, or use plain CSS if Tailwind is not required.";
  } else if (cmd.includes("npm") || cmd.includes("yarn") || cmd.includes("pnpm")) {
    if (input.timedOut && /\b(?:npm\s+(?:install|i)|pnpm\s+(?:install|i)|yarn\s+install)\b/.test(cmd)) {
      remediationTip = "\n\n[REMEDIATION TIP]: Dependency installation timed out. Retry the same install command with timeoutMs 300000 before changing packages or researching alternatives.";
    }
    if (missingShellBinary) {
      const binaryName = missingShellBinary[1];
      remediationTip = `\n\n[REMEDIATION TIP]: The package script invokes missing binary '${binaryName}'. Inspect the package.json that owns this script, add the missing tool as a devDependency in that package, run install in the owning package/workspace, then rerun the same check. Do not repeat the failing test/build command before fixing the missing binary.`;
    }
    if (missingPackageScript) {
      remediationTip = `\n\n[REMEDIATION TIP]: Package script '${missingPackageScript[1]}' is not defined in the package.json for the current command directory. Inspect the repository/package layout, find the package.json that owns this script, and rerun from that directory or use an existing script. Do not repeat the same package-manager command from the same directory unchanged.`;
    }
    if (lowerOutput.includes("cannot find module") || lowerOutput.includes("ts2307") || lowerOutput.includes("not found") || lowerOutput.includes("etarget")) {
      remediationTip ||= "\n\n[REMEDIATION TIP]: The build/install failed because of missing or incorrect dependencies. You likely need to run 'npm install' in the correct directory. If you are unsure of the correct package name or version (e.g. 'etarget'), USE THE 'web_search' TOOL NATIVELY TO FIND THE CORRECT NPM NAMES BEFORE RETRYING.";
    }
  }
  if (relativeImportFailure) {
    const requestedModule = relativeImportFailure[1];
    const requiringFile = relativeImportFailure[2]?.trim();
    remediationTip = `\n\n[REMEDIATION TIP]: Import/module path resolution is runtime-specific and often depends on the executing file plus the command working directory. The module '${requestedModule}' failed${requiringFile ? ` from '${requiringFile}'` : ""}. Inspect the failing file, cwd, and runtime rules before retrying. Do not repeat the same failing import path unchanged.`;
  }
  if (/docker(?:-compose|\s+compose)/i.test(input.cmd) && /not a docker command|docker-compose:\s*(?:command\s+)?not found|Cannot connect to the Docker daemon|permission denied/i.test(stdout + "\n" + stderr)) {
    remediationTip = "\n\n[REMEDIATION TIP]: Docker or Docker Compose is unavailable in this environment. Do not repeatedly install or mutate host-level Docker tooling. Validate generated Docker files with file reads/static inspection, document the limitation, and continue with other runnable checks.";
  }
  if (
    /\b(?:curl|wget|nc|netcat)\b/i.test(input.cmd) &&
    /Could not resolve host|NameResolutionError|Temporary failure in name resolution|Failed to resolve|Name or service not known/i.test(stdout + "\n" + stderr)
  ) {
    remediationTip =
      "\n\n[REMEDIATION TIP]: A service hostname did not resolve from this execution context. Do not retry the same curl/wget/nc command unchanged and do not replace the service with a mock. If sibling services exist, use sandbox_service_control: list services, inspect logs/snapshot, exec inside the service container, repair files there, restart/start it, then verify through the real task-facing command.";
  }
  if (/\b(?:conda|mamba|micromamba)\s+env\s+create\b/i.test(input.cmd) && /\s--force(?:\s|$)/i.test(input.cmd)) {
    remediationTip =
      "\n\n[REMEDIATION TIP]: conda env create does not support --force. Use a separate explicit recovery sequence: inspect env list/prefix, remove or delete a broken target prefix if necessary, verify it is absent, then run conda env create -f <file> -y or conda env update --prune.";
  }
  if (/CondaVerificationError|SafetyError|appears to be corrupted/i.test(stdout + "\n" + stderr)) {
    remediationTip =
      "\n\n[REMEDIATION TIP]: Conda reported a corrupted package cache or partially extracted package. Do not retry create/install unchanged. First clean package caches with conda clean --packages --tarballs -y or conda clean -afy, remove any broken target environment prefix in a separate successful command, verify the prefix is gone, then recreate/update the environment.";
  }
  if (/prefix already exists|DirectoryNotACondaEnvironmentError|EnvironmentLocationNotFound|Not a conda environment/i.test(stdout + "\n" + stderr)) {
    remediationTip =
      "\n\n[REMEDIATION TIP]: The target conda prefix is missing, already exists, or is only a broken directory. Do not run conda env create again until cleanup succeeds. Inspect conda env list and the prefix directory, remove a broken prefix with a non-interactive command, verify absence, then recreate/update the environment.";
  }
  if (/\bECONNREFUSED\b|\bconnection refused\b/i.test(stdout + "\n" + stderr) && /\b(?:27017|5432|6379|3306|9200)\b/.test(stdout + "\n" + stderr)) {
    remediationTip = "\n\n[REMEDIATION TIP]: A local external service/database is unavailable. Do not repeat the same runtime check unchanged or assume Docker can start it. Inspect the app configuration and use a test-safe in-process, file-backed, mocked, or static verification path unless the service is already running in this environment.";
  }
  if (/ERR_PACKAGE_PATH_NOT_EXPORTED|Package subpath .* is not defined by "exports"|imported from .*node_modules/i.test(stdout + "\n" + stderr)) {
    remediationTip = "\n\n[REMEDIATION TIP]: The command resolved incompatible package versions or package internals. Do not rerun unchanged. Inspect the package directory that owns the script, install/update its local dependencies there, and ensure the command uses the package-local toolchain instead of a parent or host dependency tree.";
  }
  if (/\bfatal error:\s*[^:\n]+:\s*No such file or directory/i.test(stdout + "\n" + stderr)) {
    remediationTip = "\n\n[REMEDIATION TIP]: A compiler include/source path is missing. On Linux paths are case-sensitive. If a same-name file exists with different casing, either update the include/source path with a precise line-range edit or create a tiny compatibility wrapper at the exact requested path that includes the existing file. Do not rerun the build unchanged before fixing the cited include/source path.";
  }
  if (
    /does not appear to contain CMakeLists\.txt|does not match the source .*CMakeLists\.txt|CMakeCache\.txt.*different|not a CMake build directory \(missing CMakeCache\.txt\)|Build files have been written to:/i.test(
      stdout + "\n" + stderr,
    )
  ) {
    remediationTip = "\n\n[REMEDIATION TIP]: CMake is being run from the wrong source/build directory or an existing cache polluted the source root/build dir. Inspect where CMakeCache.txt, CMakeFiles/, Makefile, and cmake_install.cmake were generated. It is safe to remove only those generated task-local CMake artifacts, then reconfigure with explicit flags such as 'cmake -S . -B build' and build with 'cmake --build build'. Do not remove source files or repeat the same cmake command unchanged.";
  }
  if (
    /did you forget to [`']?#include|was not declared in this scope|undefined reference|no member named|has no member|No SOURCES given to target|No rule to make target/i.test(
      stdout + "\n" + stderr,
    )
  ) {
    remediationTip =
      "\n\n[REMEDIATION TIP]: Compiler/build diagnostics usually have one root cause followed by cascading errors. Do not rerun unchanged. Inspect the first diagnostic and referenced file, then make the smallest source/import/path/API fix before rebuilding. If the build graph has no sources or a missing target, inspect the project file and actual file tree before editing.";
  }
  if (/argument handler must be a function|handler must be a function|callback must be a function|middleware.*function/i.test(stdout + "\n" + stderr)) {
    remediationTip = "\n\n[REMEDIATION TIP]: The runtime expected a callable handler/callback but received a different value. Do not rerun the same command unchanged. Inspect the stack trace line in application code, then inspect every variable, imported symbol, or exported value passed at that call site. Fix the non-callable value before rerunning the check.";
  }
  if (/\b(?:eslint|lint)\b/.test(cmd) && /\bno-undef\b|not defined/i.test(stdout + "\n" + stderr)) {
    remediationTip = "\n\n[REMEDIATION TIP]: The static analyzer is reporting undefined runtime globals or symbols. Do not repeat the same lint command unchanged. Inspect the analyzer output, then either configure the analyzer for the target runtime/module system or edit the reported code. Rerun lint only after a concrete config/code change.";
  }
  if (
    /Jest did not exit|open handle|TCPSERVERWRAP|app\.listen/i.test(stdout + "\n" + stderr) ||
    (input.timedOut && /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(jest|vitest|mocha|ava|tap|pytest|node\s+--test)\b/i.test(input.cmd))
  ) {
    remediationTip = "\n\n[REMEDIATION TIP]: A test imported code that starts a long-running server or leaves async resources open. Split app creation from process startup: export the app/module without listen/start side effects, guard startup behind the language's main-entry check, and close servers/database connections in test teardown. Do not mask this by only increasing timeouts.";
  }
  if (
    /\b(?:jest|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test)\b/i.test(input.cmd) &&
    /Exceeded timeout|beforeAll|beforeEach|afterAll|afterEach|MongoParseError|MongoServerSelectionError|server selection timed out|buffering timed out|dropDatabase|deleteMany/i.test(stdout + "\n" + stderr)
  ) {
    remediationTip =
      "\n\n[REMEDIATION TIP]: The test failure is in async test setup/teardown or database access. Do not rerun the full suite unchanged. Inspect the referenced test hook and app/database startup code. For Mongo/Mongoose-style tests, remove obsolete driver options, use an isolated in-memory/mocked/file-backed test database or a short server-selection/connection timeout, close/disconnect resources in afterAll/afterEach, and rerun a single failing test file with single-worker/open-handle diagnostics before trying the full suite again.";
  }
  if (input.timedOut && /\bnpm\s+(?:test|run\s+\S+)\s+[^-]/i.test(input.cmd) && !/\bnpm\s+(?:test|run\s+\S+)\s+--\s+/i.test(input.cmd)) {
    remediationTip = "\n\n[REMEDIATION TIP]: This looks like a targeted npm test command without explicit argument forwarding. It may have run the wrong script or unrelated tests. Inspect package.json and run the actual test runner directly, or use 'npm test -- <path>' only if the script supports it.";
  }
  if (/\bcd\s+([A-Za-z0-9_.-]+)\s*&&[\s\S]*\btest\s+-[ef]\s+\1\//.test(input.cmd)) {
    remediationTip = "\n\n[REMEDIATION TIP]: The command changes into a directory and then checks a path still prefixed with that same directory. After 'cd dir', verify artifacts relative to the new working directory (for example 'test -f artifact') or avoid cd and use the full path from the original cwd.";
  }

  return [
    status,
    `Command: ${input.cmd}`,
    stdout ? `stdout:\n${stdout}` : "stdout: <empty>",
    stderr ? `stderr:\n${stderr}` : "stderr: <empty>",
    remediationTip
  ].filter(Boolean).join("\n");
}

function tail(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return input.slice(input.length - maxChars);
}

function appendCommandWarnings(cmd: string, stdout: string, stderr: string, durationMs: number, timeoutMs: number): string {
  const warnings: string[] = [];
  const lowerCmd = cmd.toLowerCase();
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  const isInstall = /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b|\bnpx\s+create-|pip\s+install|poetry\s+install/.test(lowerCmd);

  if (isInstall && durationMs > 120_000) {
    warnings.push(
      `Dependency install took ${Math.round(durationMs / 1000)}s. Treat this as a quality warning: prefer a leaner stack, fewer packages, or already-available runtime features unless the task explicitly requires this dependency set.`,
    );
  }
  if (/\b([1-9]\d*)\s+(?:low|moderate|high|critical)?\s*vulnerabilit(?:y|ies)\b|security vulnerability/.test(combined)) {
    warnings.push(
      "Dependency output reported vulnerabilities. Prefer patched/current package versions or a smaller dependency set before continuing feature work.",
    );
  }
  if (/\bdeprecated\b/.test(combined)) {
    warnings.push(
      "Dependency output reported deprecated packages. Avoid deprecated scaffolds/packages when a maintained alternative is available.",
    );
  }
  if (isInstall && timeoutMs > 300_000 && durationMs > timeoutMs * 0.75) {
    warnings.push(
      "Install nearly consumed its extended timeout. Do not repeat the same stack/install command; simplify or split the dependency plan.",
    );
  }

  if (warnings.length === 0) return stdout;
  return `${stdout.trimEnd()}\n\n[REAPER DEPENDENCY QUALITY WARNINGS]\n${warnings.map((warning) => `- ${warning}`).join("\n")}\n`;
}

function buildCommandEnv(workspaceRoot: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_PATH;
  const scratchpad = getReaperScratchpadPaths(workspaceRoot);
  env.REAPER_SCRATCHPAD = scratchpad.root;
  env.REAPER_ARTIFACTS_DIR = scratchpad.artifacts;
  env.REAPER_DEPENDENCIES_DIR = scratchpad.dependencies;
  env.REAPER_CACHE_DIR = scratchpad.cache;
  env.WORKSPACE = workspaceRoot;
  env.NPM_CONFIG_CACHE = path.join(scratchpad.cache, "npm");
  env.PNPM_HOME = path.join(scratchpad.dependencies, "pnpm-home");
  env.PNPM_STORE_PATH = path.join(scratchpad.cache, "pnpm-store");
  env.YARN_CACHE_FOLDER = path.join(scratchpad.cache, "yarn");
  env.PIP_CACHE_DIR = path.join(scratchpad.cache, "pip");
  env.CARGO_HOME = env.CARGO_HOME ?? path.join(scratchpad.dependencies, "cargo");
  env.GOMODCACHE = env.GOMODCACHE ?? path.join(scratchpad.cache, "go-mod");
  env.GOCACHE = env.GOCACHE ?? path.join(scratchpad.cache, "go-build");
  env.PATH = ensureSystemPath(filterHostDependencyBins(env.PATH, workspaceRoot));

  const venvBin = path.join(workspaceRoot, ".venv", "bin");
  if (existsSync(venvBin)) {
    env.PATH = `${venvBin}:${env.PATH ?? ""}`;
    env.VIRTUAL_ENV = path.join(workspaceRoot, ".venv");
  }
  const evalToolchainBin = env.REAPER_EVAL_TOOLCHAIN_BIN;
  if (evalToolchainBin && existsSync(evalToolchainBin) && !(env.PATH ?? "").split(path.delimiter).includes(evalToolchainBin)) {
    env.PATH = `${evalToolchainBin}:${env.PATH ?? ""}`;
  }
  return env;
}

function resolveShellBinary(): string {
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"]) {
    if (existsSync(candidate)) return candidate;
  }
  return process.env.SHELL || "sh";
}

function ensureSystemPath(currentPath: string | undefined): string {
  const required = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
  const entries = (currentPath ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of required) {
    if (existsSync(entry) && !entries.includes(entry)) {
      entries.push(entry);
    }
  }
  return entries.join(path.delimiter);
}

function filterHostDependencyBins(currentPath: string | undefined, workspaceRoot: string): string {
  const entries = (currentPath ?? "").split(path.delimiter).filter(Boolean);
  const resolvedWorkspace = path.resolve(workspaceRoot);
  return entries
    .filter((entry) => {
      const resolved = path.resolve(entry);
      if (!resolved.includes(`${path.sep}node_modules${path.sep}.bin`)) return true;
      return resolved === path.join(resolvedWorkspace, "node_modules", ".bin") || resolved.startsWith(`${resolvedWorkspace}${path.sep}`);
    })
    .join(path.delimiter);
}

async function createProcessLog(runtime: { runId: string; artifactDir: string; toolCallId: string }, cmd: string, cwd: string): Promise<string> {
  const processDir = path.join(runtime.artifactDir, "processes");
  await mkdir(processDir, { recursive: true });
  const logPath = path.join(processDir, `${runtime.toolCallId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.log`);
  await writeFile(
    logPath,
    JSON.stringify({ runId: runtime.runId, toolCallId: runtime.toolCallId, cmd, cwd, startedAt: new Date().toISOString() }) + "\n",
    "utf8",
  );
  return logPath;
}

async function appendProcessLog(logPath: string | undefined, stream: "stdout" | "stderr" | "system", data: string): Promise<void> {
  if (!logPath) return;
  await appendFile(logPath, JSON.stringify({ timestamp: new Date().toISOString(), stream, data }) + "\n", "utf8").catch(() => undefined);
}

function defaultTimeoutMsForCommand(cmd: string): number {
  const normalized = cmd.toLowerCase();
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b|\bnpx\s+create-|pip\s+install|poetry\s+install|cargo\s+(?:build|test|install)|go\s+(?:mod\s+download|build|test)/.test(normalized)) {
    return 600_000;
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint)\b|\b(jest|vitest|mocha|ava|tap|pytest|node\s+--test|mvn\s+test|gradle\s+test)\b/i.test(normalized)) {
    return 90_000;
  }
  return 300_000;
}

function targetedNpmTestWithoutForwarding(
  workspaceRoot: string,
  workingDirectory: string,
  cmd: string,
): { cwd: string; rest: string } | undefined {
  const parsed = parseLeadingCdAndRest(workspaceRoot, workingDirectory, cmd);
  const match = parsed.rest.match(/^npm\s+(?:test|t)(?:\s+)(?!--)(\S+)/i);
  if (!match) return undefined;
  const firstExtra = match[1] ?? "";
  if (/^(?:&&|\|\||;|\d?>|\d?>&\d+|&>|>)/.test(firstExtra)) return undefined;
  if (!existsSync(path.join(parsed.cwd, "package.json"))) return undefined;
  return parsed;
}

function classifyWrongEcosystemDependencyInstall(
  workspaceRoot: string,
  workingDirectory: string,
  cmd: string,
): string | undefined {
  const parsed = parseLeadingCdAndRest(workspaceRoot, workingDirectory, cmd);
  const command = parsed.rest.trim();
  const jsInstall = command.match(/^(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\s+(.+)$/i);
  if (jsInstall?.[1]) {
    const packages = extractInstallPackageTokens(jsInstall[1]);
    const nativeIndicators = packages.filter((pkg) =>
      /^(?:nlohmann(?:\/json)?|rapidjson|boost|catch2|gtest|googletest|vcpkg|conan)(?:[@#:/-]|$)/i.test(pkg) ||
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:[#@].*)?$/i.test(pkg),
    );
    if (nativeIndicators.length > 0 && looksLikeNativeProject(workspaceRoot, parsed.cwd)) {
      return (
        `Wrong package manager for dependency install: '${packages.join(" ")}' was requested through a JavaScript package manager in a native/C/C++ workspace. ` +
        "Use the active ecosystem's build/dependency mechanism, an existing vendored file, a documented direct source/header download, or a small local implementation. " +
        "Do not retry npm/pnpm/yarn/bun for C/C++ header/source libraries."
      );
    }
  }

  return undefined;
}

function extractInstallPackageTokens(rest: string): string[] {
  return rest
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !token.startsWith("-"))
    .filter((token) => !/^(?:&&|\|\||;|npm|pnpm|yarn|bun)$/i.test(token));
}

function looksLikeNativeProject(workspaceRoot: string, cwd: string): boolean {
  const candidates = [cwd, workspaceRoot];
  for (const dir of candidates) {
    if (
      existsSync(path.join(dir, "CMakeLists.txt")) ||
      existsSync(path.join(dir, "Makefile")) ||
      existsSync(path.join(dir, "meson.build")) ||
      existsSync(path.join(dir, "configure.ac"))
    ) {
      return true;
    }
  }
  try {
    return readdirSync(cwd).some((entry) => /\.(?:c|cc|cpp|cxx|h|hpp|hh)$/i.test(entry));
  } catch {
    return false;
  }
}

function resolveBarePackageCommandCwd(
  workspaceRoot: string,
  workingDirectory: string,
  cmd: string,
): { cwd: string; notice: string } | undefined {
  const parsed = parseLeadingCdAndRest(workspaceRoot, workingDirectory, cmd);
  if (path.resolve(parsed.cwd) !== path.resolve(workingDirectory)) return undefined;
  const scriptName = packageScriptNameForBareCommand(parsed.rest);
  if (!scriptName && !isBarePackageInstall(parsed.rest)) return undefined;

  const currentPackage = readPackageJson(parsed.cwd);
  if (scriptName) {
    const currentScript = currentPackage?.scripts?.[scriptName];
    if (currentScript && !isPlaceholderPackageScript(currentScript)) return undefined;

    const candidate = findBestPackageForScript(workspaceRoot, scriptName);
    if (candidate) {
      return {
        cwd: candidate.cwd,
        notice:
          `Bare package command '${parsed.rest}' was run from '${path.relative(workspaceRoot, candidate.cwd) || "."}' ` +
          `because '${path.relative(workspaceRoot, parsed.cwd) || "."}/package.json' ${currentPackage ? "does not define a meaningful script" : "does not exist"}.`,
      };
    }
    if (!currentPackage) {
      throw new Error(
        `Package command '${parsed.rest}' has no package.json in '${path.relative(workspaceRoot, parsed.cwd) || "."}', and Reaper found no package with script '${scriptName}'. ` +
        "Create a task-local package.json with a real script or run from the package directory that owns the command. Do not rely on parent/host package.json discovery.",
      );
    }
  }

  if (isBarePackageInstall(parsed.rest) && !currentPackage) {
    const candidate = findNearestPackageRoot(workspaceRoot, parsed.cwd) ?? findPrimaryPackageRoot(workspaceRoot);
    if (candidate) {
      return {
        cwd: candidate,
        notice:
          `Bare package install '${parsed.rest}' was run from '${path.relative(workspaceRoot, candidate) || "."}' ` +
          "because the current directory has no package.json. Reaper keeps installs inside the task package root.",
      };
    }
  }
  return undefined;
}

function packageScriptNameForBareCommand(command: string): string | undefined {
  const trimmed = command.trim();
  if (/^npm\s+(?:test|t)(?:\s|$)/i.test(trimmed)) return "test";
  const npmRun = trimmed.match(/^npm\s+run\s+([A-Za-z0-9:_-]+)(?:\s|$)/i);
  if (npmRun?.[1]) return npmRun[1];
  const otherRun = trimmed.match(/^(?:pnpm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9:_-]+)(?:\s|$)/i);
  if (otherRun?.[1]) {
    const token = otherRun[1].toLowerCase();
    // Runtime probes/options are not package scripts and must not require a
    // package.json. The model commonly checks tool availability with
    // `pnpm --version`, `yarn -v`, or help/version flags before creating the
    // workspace package.
    if (token.startsWith("-") || ["version", "help", "install", "i", "add", "create"].includes(token)) return undefined;
    return otherRun[1];
  }
  return undefined;
}

function isBarePackageInstall(command: string): boolean {
  return /^(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)(?:\s|$)/i.test(command.trim());
}

function findBestPackageForScript(workspaceRoot: string, scriptName: string): { cwd: string; script: string } | undefined {
  const candidates = discoverTaskPackages(workspaceRoot)
    .filter((pkg) => pkg.scripts[scriptName] && !isPlaceholderPackageScript(pkg.scripts[scriptName]!))
    .sort((a, b) => packageRootPriority(a.relativePath, scriptName) - packageRootPriority(b.relativePath, scriptName));
  const first = candidates[0];
  return first ? { cwd: first.cwd, script: first.scripts[scriptName]! } : undefined;
}

function findNearestPackageRoot(workspaceRoot: string, startDir: string): string | undefined {
  const root = path.resolve(workspaceRoot);
  let current = path.resolve(startDir);
  while (isInsideOrEqual(root, current)) {
    if (existsSync(path.join(current, "package.json"))) return current;
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return undefined;
}

function findPrimaryPackageRoot(workspaceRoot: string): string | undefined {
  return discoverTaskPackages(workspaceRoot).sort((a, b) => packageRootPriority(a.relativePath, "install") - packageRootPriority(b.relativePath, "install"))[0]?.cwd;
}

function discoverTaskPackages(workspaceRoot: string): Array<{ cwd: string; relativePath: string; scripts: Record<string, string> }> {
  const root = path.resolve(workspaceRoot);
  const ignored = new Set(["node_modules", ".git", "scratchpad", ".reaper", "dist", "build", "coverage", ".next", ".cache"]);
  const results: Array<{ cwd: string; relativePath: string; scripts: Record<string, string> }> = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const pkg = readPackageJson(dir);
    if (pkg) {
      results.push({ cwd: dir, relativePath: path.relative(root, dir), scripts: pkg.scripts ?? {} });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || ignored.has(entry.name)) continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  return results;
}

function readPackageJson(dir: string): { scripts?: Record<string, string> } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return parsed;
  } catch {
    return undefined;
  }
}

function packageRootPriority(relativePath: string, scriptName: string): number {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized) return scriptName === "test" ? 50 : 20;
  if (/^(server|backend|api)(?:\/|$)/i.test(normalized)) return scriptName === "test" ? 5 : 20;
  if (/^(client|frontend|web|app)(?:\/|$)/i.test(normalized)) return scriptName === "build" || scriptName === "lint" ? 5 : 15;
  if (/(?:^|\/)(server|backend|api)(?:\/|$)/i.test(normalized)) return 10;
  if (/(?:^|\/)(client|frontend|web|app)(?:\/|$)/i.test(normalized)) return 12;
  return 30;
}

function isPlaceholderPackageScript(script: string): boolean {
  const normalized = script.trim().replace(/^["']|["']$/g, "");
  return (
    /no test specified|todo|placeholder|not implemented/i.test(normalized) ||
    /\b--passWithNoTests\b/i.test(normalized) ||
    /^(?:true|exit\s+0)\s*$/i.test(normalized) ||
    (/^(?:echo|printf)\b/i.test(normalized) &&
      !/\b(jest|vitest|mocha|ava|tap|node\s+--test|pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|tsc|vite|webpack|next|react-scripts|eslint|ruff|mypy)\b/i.test(normalized))
  );
}

function shellSingleQuoteForPrintf(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function parseLeadingCdAndRest(workspaceRoot: string, workingDirectory: string, cmd: string): { cwd: string; rest: string } {
  let cwd = path.resolve(workingDirectory);
  let rest = cmd.trim();
  for (let i = 0; i < 4; i += 1) {
    const match = rest.match(/^cd\s+('([^']+)'|"([^"]+)"|([^\s;&|]+))\s*&&\s*(.+)$/);
    if (!match) break;
    const target = match[2] ?? match[3] ?? match[4] ?? ".";
    cwd = path.resolve(cwd, target);
    if (!cwd.startsWith(path.resolve(workspaceRoot))) break;
    rest = (match[5] ?? "").trim();
  }
  return { cwd, rest };
}

function defaultIdleTimeoutMsForCommand(cmd: string): number | undefined {
  const normalized = cmd.toLowerCase();
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b|\bnpx\s+create-|pip\s+install|poetry\s+install|cargo\s+(?:build|test|install)|go\s+(?:mod\s+download|build|test)/.test(normalized)) {
    return undefined;
  }
  return 60_000;
}
