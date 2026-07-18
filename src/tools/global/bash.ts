import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import treeKill from "tree-kill";

import { evaluateCommandPolicy, type SafetyProfile } from "../../policy/rules.js";
import type { RuleEvaluationContext } from "../../policy/rules.js";
import { getReaperScratchpadPaths } from "../../workspace/scratchpad.js";
import { PathPolicyError, normalizeWorkspacePath } from "../../policy/paths.js";
import { getBashTunables } from "../../config/config-tunables.js";
import { buildChildEnv, type ChildEnvBuildResult } from "../child-env.js";

function numericRuntimeOverride(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getStallWatchdogIntervalMs(): number {
  return numericRuntimeOverride("REAPER_STALL_WATCHDOG_INTERVAL_MS", getBashTunables().stallWatchdogIntervalMs);
}
function getStallWatchdogNoOutputThresholdMs(): number {
  return numericRuntimeOverride("REAPER_STALL_WATCHDOG_NO_OUTPUT_MS", getBashTunables().stallWatchdogNoOutputMs);
}
function getSizeWatchdogMaxBytes(): number {
  return numericRuntimeOverride("REAPER_MAX_SHELL_OUTPUT_BYTES", getBashTunables().maxOutputBytes);
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

export async function executeBashTool(
  workspaceRoot: string,
  args: { cmd: string; timeoutMs?: number; idleTimeoutMs?: number; isBackground?: boolean },
  safetyProfile: SafetyProfile,
  workingDirectory = workspaceRoot,
  ruleContext?: RuleEvaluationContext,
  runtime?: { runId: string; artifactDir: string; toolCallId: string },
  childEnvOptions?: {
    allowlist?: ReadonlyArray<string>;
    sourceEnv?: NodeJS.ProcessEnv;
  },
): Promise<ShellCommandResult> {
  args = { ...args, cmd: normalizeWorkspaceShellAliases(args.cmd, workspaceRoot) };
  enforceShellWorkspaceBoundary(workspaceRoot, workingDirectory, args.cmd);
  if (isBareInteractiveShellCommand(args.cmd)) {
    throw new Error(
      `Interactive shell commands are disabled: ${args.cmd.trim()}. ` +
      "Pass a script, subcommand, or non-interactive flags so the command can complete without a TTY.",
    );
  }
  const packageCommandResolution = resolveBarePackageCommandCwd(workspaceRoot, workingDirectory, args.cmd);
  const effectiveWorkingDirectory = packageCommandResolution?.cwd ?? workingDirectory;

  if (/\bcd\s+(?:\S*\/)?\.reaper-scratch\b[\s\S]*\bnpm\s+init\b/i.test(args.cmd)) {
    throw new Error(
      `Do not run npm init inside .reaper-scratch because npm derives the invalid package name ".reaper-scratch". ` +
      `Create .reaper-scratch/package.json with write_file using a valid package name, then run npm install inside .reaper-scratch.`,
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
  // Never deny — Reaper always executes the command and returns real results.
  // The decision is logged for audit but does not block execution.

  const timeoutMs = args.timeoutMs ?? defaultTimeoutMsForCommand(args.cmd);
  const idleTimeoutMs = args.idleTimeoutMs ?? defaultIdleTimeoutMsForCommand(args.cmd);

  const isServerCommand = isLikelyServerCommand(args.cmd);
  const isBackground = args.isBackground || isServerCommand;

  if (isBackground) {
    const logPath = runtime ? await createProcessLog(runtime, args.cmd, effectiveWorkingDirectory) : undefined;
    const child = spawn(resolveShellBinary(), ["-c", args.cmd], {
      cwd: effectiveWorkingDirectory,
      env: buildCommandEnv(workspaceRoot, childEnvOptions),
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
__REAPER_CWD="$(pwd -W 2>/dev/null || pwd)"
printf '\\n___REAPER_CWD:%s___\\n' "$__REAPER_CWD"
printf '___REAPER_EXIT_CODE:%s___\\n' "$__REAPER_EXIT_CODE"
exit 0
`;

      const child = spawn(resolveShellBinary(), ["-c", wrapper], {
        cwd: effectiveWorkingDirectory,
        env: buildCommandEnv(workspaceRoot, childEnvOptions),
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
      let idleGraceTimer: NodeJS.Timeout | undefined;
      let wrapperExitObserved = false;
      let wrapperExitCleanupTimer: NodeJS.Timeout | undefined;
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
            // Pi-style post-exit idle grace for the bash tool result to return
      // even when a backgrounded grandchild inherited the wrapper's stdout/
      // stderr pipes (earendil-works/pi#5303). The wrapper is `detached`,
      // so its `pid` is the foreground process-group leader and its stdio
      // pipes can be held open by a grandchild long after the wrapper has
      // exited. We listen for the actual process exit (which fires regardless
      // of stdio) and then wait for either the streams to drain to EOF
      // (preferred) or a short idle grace to elapse, then finalize the bash
      // result directly — without waiting for `close`, which is not
      // guaranteed to fire while a grandchild holds the pipes.
      const STDOUT_IDLE_GRACE_MS = 250;
      let resolved = false;
      let wrapperExitCode: number | null = null;
      let wrapperExitSignal: NodeJS.Signals | null = null;
      const finalizeFromExit = async (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (resolved) return;
        resolved = true;
        if (idleGraceTimer) clearTimeout(idleGraceTimer);
        // Mirror the same teardown the close handler performs, then run
        // the same body. Idempotent: clearTimeout on already-fired timers
        // is a no-op, and child listeners are removed by the underlying
        // promise resolution path anyway.
        clearTimeout(timer);
        if (idleTimer) clearInterval(idleTimer);
        clearInterval(stallTimer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        if (wrapperExitCleanupTimer) clearTimeout(wrapperExitCleanupTimer);
        const logPath = await logPathPromise;

        // Extract CWD and real Exit Code from wrapper output (same logic
        // as the original close handler).
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
          reject(new Error([
            `Shell command stalled on interactive prompt: ${args.cmd}`,
            `stdout: ${tail(stdout.trim(), 2000) || "<empty>"}`,
            `stderr: ${tail(stderr.trim(), 2000) || "<empty>"}`,
          ].join("\n")));
          return;
        }
        if (sizeLimitExceeded && logPath) {
          stdout = appendOutputSpillNotice(stdout, logPath, totalOutputBytes);
        }
        if (timedOut) {
          reject(new Error(formatCommandFailure({ cmd: args.cmd, timeoutMs, stdout, stderr, signal, timedOut: true, timedOutKind: args.idleTimeoutMs && Date.now() - lastOutputAt >= args.idleTimeoutMs ? "idle" : "wall" })));
          return;
        }
        if (realExitCode === 1 && isNoMatchSearchCommand(args.cmd, stdout, stderr)) {
          resolve({ stdout: stdout.trimEnd() ? stdout : "[REAPER SEARCH RESULT]: no matches found\n", stderr, exitCode: 0, wouldBlock: decision.outcome === "would_block", nextCwd: realCwd, ...(logPath ? { logPath, persistedOutputSize: totalOutputBytes } : {}) });
          return;
        }
        if (realExitCode && realExitCode !== 0 && isIdempotentMissingMoveAlreadyApplied(workspaceRoot, effectiveWorkingDirectory, args.cmd, stdout, stderr)) {
          resolve({ stdout: `${stdout.trimEnd()}\n[REAPER IDEMPOTENT FILE OP]: mv source was already absent and the target already exists; treating this as already applied.\n`.trimStart(), stderr, exitCode: 0, wouldBlock: decision.outcome === "would_block", nextCwd: realCwd, ...(logPath ? { logPath, persistedOutputSize: totalOutputBytes } : {}) });
          return;
        }
        if (realExitCode && realExitCode !== 0) {
          reject(new Error(formatCommandFailure({ cmd: args.cmd, exitCode: realExitCode, stdout, stderr, signal, timedOut: false })));
          return;
        }
        if (isCancelledScaffoldCommand(args.cmd, stdout, stderr)) {
          reject(new Error([
            "Interactive scaffold command exited without creating the project.",
            `Command: ${args.cmd}`,
            `stdout: ${tail(stdout.trim(), 4000) || "<empty>"}`,
            `stderr: ${tail(stderr.trim(), 4000) || "<empty>"}`,
          ].join("\n")));
          return;
        }
        resolve({ stdout, stderr, exitCode: realExitCode, wouldBlock: decision.outcome === "would_block", nextCwd: realCwd, ...(logPath ? { logPath, persistedOutputSize: totalOutputBytes } : {}) });
      };
      // Replace the implicit `child.on("close")` path. We now drive
      // resolution from `child.on("exit")` directly, with a Pi-style idle
      // grace (re-armed on every post-exit data chunk) to wait for
      // grandchild output to drain before finalizing. The `close` event
      // is no longer required to fire, since a grandchild holding the
      // stdio pipes open would otherwise block the bash tool result
      // indefinitely.
      child.on("exit", (exitCode, signal) => {
        wrapperExitCode = exitCode;
        wrapperExitSignal = signal;
        if (resolved) return;
        // If the stream APIs are not available (e.g. stdio was nulled),
        // finalize immediately.
        if (!child.stdout || !child.stderr) {
          void finalizeFromExit(exitCode, signal);
          return;
        }
        // Otherwise, wait for either EOF on both streams or the idle
        // grace to elapse. Re-arm the grace on every chunk so an
        // actively writing descendant keeps us reading.
        const armGrace = () => {
          if (idleGraceTimer) clearTimeout(idleGraceTimer);
          idleGraceTimer = setTimeout(() => {
            if (resolved) return;
            try { child.stdout?.destroy(); } catch {}
            try { child.stderr?.destroy(); } catch {}
            void finalizeFromExit(exitCode, signal);
          }, STDOUT_IDLE_GRACE_MS);
        };
        let stdoutEnded = false;
        let stderrEnded = false;
        const onEnd = () => {
          if (stdoutEnded && stderrEnded && !resolved) {
            void finalizeFromExit(exitCode, signal);
          }
        };
        child.stdout.on("end", () => { stdoutEnded = true; onEnd(); });
        child.stderr.on("end", () => { stderrEnded = true; onEnd(); });
        child.stdout.on("data", () => { if (!resolved) armGrace(); });
        child.stderr.on("data", () => { if (!resolved) armGrace(); });
        armGrace();
      });
      child.on("close", async (exitCode, signal) => {
        if (resolved) return;
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
              ].join("\n"),
            ),
          );
          return;
        }
        resolve({
          stdout,
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
function isBareInteractiveShellCommand(command: string): boolean {
  return /^(?:node|python3?|bash|sh|zsh|pwsh|powershell|cmd)(?:\.exe)?\s*$/i.test(command.trim());
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
  // Raw facts only, per the reference (Pi) coding agent's bash contract:
  // status, command, stdout, stderr. No injected remediation advice —
  // the model reads the output and figures out the fix itself.
  const status = input.timedOut
    ? `Command ${input.timedOutKind === "idle" ? "idle " : ""}timed out after ${input.timeoutMs}ms`
    : `Command exited with code ${input.exitCode ?? "unknown"}${input.signal ? ` signal ${input.signal}` : ""}`;
  const stdout = tail(input.stdout.trim(), 4000);
  const stderr = tail(input.stderr.trim(), 4000);

  return [
    status,
    `Command: ${input.cmd}`,
    stdout ? `stdout:\n${stdout}` : "stdout: <empty>",
    stderr ? `stderr:\n${stderr}` : "stderr: <empty>",
  ].join("\n");
}

function tail(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return input.slice(input.length - maxChars);
}

function toShellPath(value: string): string {
  return process.platform === "win32" ? value.replace(/\\/g, "/") : value;
}

function buildCommandEnv(
  workspaceRoot: string,
  childEnvOptions?: {
    allowlist?: ReadonlyArray<string>;
    sourceEnv?: NodeJS.ProcessEnv;
  },
): NodeJS.ProcessEnv {
  const result: ChildEnvBuildResult = buildChildEnv({
    workspaceRoot,
    ...(childEnvOptions?.allowlist ? { allowlist: childEnvOptions.allowlist } : {}),
    ...(childEnvOptions?.sourceEnv ? { sourceEnv: childEnvOptions.sourceEnv } : {}),
  });
  return result.env;
}

export function resolveShellBinary(): string {
  const configured = process.env.REAPER_BASH_PATH ?? process.env.GIT_BASH_PATH;
  if (configured && path.isAbsolute(configured) && existsSync(configured)) {
    return configured;
  }
  const candidates = process.platform === "win32"
    ? [
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : undefined,
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "usr", "bin", "bash.exe") : undefined,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe") : undefined,
      ]
    : ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error(
    process.platform === "win32"
      ? "Git Bash was not found. Install Git for Windows or set REAPER_BASH_PATH to an absolute bash.exe path."
      : "No supported POSIX shell was found at /bin/bash, /usr/bin/bash, /bin/sh, or /usr/bin/sh.",
  );
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
  return toShellPath(logPath);
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
