import { execFile, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { promisify } from "node:util";

import { RuntimeEngine } from "../src/runtime/engine.js";
import { createLiveReaperGateway } from "../tests/fixtures/live-gateway.js";
import type { AgentRequestEnvelope } from "../src/connection/schemas.js";
import type { ShellRunner } from "../src/tools/executor.js";
import { classifyVerificationOutput } from "../src/verify/failure-classifier.js";

const execFileAsync = promisify(execFile);

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function loadDotEnv(): void {
  for (const candidate of [path.resolve(process.cwd(), ".env"), "/workspace/.env"]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) continue;
      const key = match[1]!;
      if (process.env[key]) continue;
      const raw = match[2] ?? "";
      process.env[key] = raw.replace(/^['"]|['"]$/g, "");
    }
  }
}

function makeRequest(prompt: string): AgentRequestEnvelope {
  const now = new Date().toISOString();
  const id = randomUUID();
  return {
    connection_id: `terminal-bench-${id}`,
    session_id: `terminal-bench-${id}`,
    turn_id: "turn-1",
    request_id: `request-${id}`,
    message_type: "user_prompt",
    timestamp: now,
    trace_id: `trace-${id}`,
    payload: {
      prompt,
    },
    metadata: {
      source: "terminal-bench",
      transport: "custom-agent-bridge",
    },
  };
}

async function ensureGitRepo(workspaceRoot: string): Promise<void> {
  execSync(`git config --global --add safe.directory ${shellQuote(workspaceRoot)}`, { stdio: "ignore" });
  if (!existsSync(path.join(workspaceRoot, ".git"))) {
    execSync("git init", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git config user.email 'reaper@terminal-bench.local'", { cwd: workspaceRoot, stdio: "ignore" });
    execSync("git config user.name 'Reaper Terminal-Bench'", { cwd: workspaceRoot, stdio: "ignore" });
  }
  execSync("git add .", { cwd: workspaceRoot, stdio: "ignore" });
  execSync("git commit --allow-empty -m 'terminal-bench initial snapshot'", { cwd: workspaceRoot, stdio: "ignore" });
}

function createDockerShellRunner(containerName: string, containerWorkspace = "/app"): ShellRunner {
  return async (workspaceRoot, args, workingDirectory, runtime) => {
    const relativeCwd = path.relative(workspaceRoot, workingDirectory);
    if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
      throw new Error(`Working directory is outside Terminal-Bench workspace: ${workingDirectory}`);
    }
    const containerCwd = path.posix.join(containerWorkspace, relativeCwd.split(path.sep).filter(Boolean).join("/"));

    await syncHostWorkspaceToContainer(workspaceRoot, containerName, containerWorkspace);
    if (args.isBackground) {
      return startDockerBackgroundCommand(
        containerName,
        containerCwd,
        { ...args, cmd: rewriteHostWorkspacePathsForContainer(args.cmd, workspaceRoot, containerWorkspace) },
        runtime,
      );
    }

    const output = await runDockerCommand(
      containerName,
      containerCwd,
      workspaceRoot,
      { ...args, cmd: rewriteHostWorkspacePathsForContainer(args.cmd, workspaceRoot, containerWorkspace) },
      runtime,
    );
    await syncContainerWorkspaceToHost(containerName, containerWorkspace, workspaceRoot);
    return output;
  };
}

async function startDockerBackgroundCommand(
  containerName: string,
  containerCwd: string,
  args: { cmd: string; timeoutMs?: number; idleTimeoutMs?: number; isBackground?: boolean },
  runtime: { artifactDir: string; toolCallId: string },
): Promise<{ stdout: string; stderr: string; exitCode: number | null; wouldBlock: boolean; nextCwd?: string; logPath?: string }> {
  const safeId = `${runtime.toolCallId}-${Date.now()}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  const containerLogPath = `/tmp/reaper-bg-${safeId}.log`;
  const containerPidPath = `${containerLogPath}.pid`;
  const wrapper = `
set -e
cd ${shellQuote(containerCwd)}
nohup bash -lc ${shellQuote(args.cmd)} > ${shellQuote(containerLogPath)} 2>&1 < /dev/null &
pid=$!
printf '%s' "$pid" > ${shellQuote(containerPidPath)}
sleep 0.5
if kill -0 "$pid" 2>/dev/null; then
  printf '___REAPER_BACKGROUND_PID:%s___\\n' "$pid"
  printf '___REAPER_BACKGROUND_LOG:%s___\\n' ${shellQuote(containerLogPath)}
  head -80 ${shellQuote(containerLogPath)} 2>/dev/null || true
else
  status=$?
  printf '___REAPER_BACKGROUND_EXITED:%s___\\n' "$status"
  cat ${shellQuote(containerLogPath)} 2>/dev/null || true
  exit 1
fi
`;

  try {
    const result = await execFileAsync("docker", ["exec", containerName, "bash", "-lc", wrapper], {
      timeout: args.timeoutMs ?? 10_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
      wouldBlock: false,
      nextCwd: containerCwd,
      logPath: containerLogPath,
    };
  } catch (error) {
    const err = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean };
    const stdout = String(err.stdout ?? "");
    const stderr = String(err.stderr ?? "");
    throw new Error(
      [
        err.killed ? `Background command startup timed out` : err.message,
        `Command: ${args.cmd}`,
        `stdout: ${stdout.trim() || "<empty>"}`,
        `stderr: ${stderr.trim() || "<empty>"}`,
      ].join("\n"),
    );
  }
}

function rewriteHostWorkspacePathsForContainer(cmd: string, hostWorkspaceRoot: string, containerWorkspace: string): string {
  const root = path.resolve(hostWorkspaceRoot);
  const escapedRoot = escapeRegExp(root);
  return cmd
    .replace(new RegExp(escapedRoot, "g"), containerWorkspace)
    .replace(new RegExp(escapeRegExp(shellQuote(root)), "g"), shellQuote(containerWorkspace));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function syncHostWorkspaceToContainer(workspaceRoot: string, containerName: string, containerWorkspace: string): Promise<void> {
  await execFileAsync("docker", ["exec", "-u", "0", containerName, "bash", "-lc", `mkdir -p ${shellQuote(containerWorkspace)}`], {
    maxBuffer: 10 * 1024 * 1024,
  });
  // Do not copy Reaper's scratchpad into the task container; it is runtime
  // bookkeeping, not task state, and can be written while shell sync runs.
  // Keep .reaper host-only for the same reason; deleting/copying it during
  // container sync races active logging and result persistence.
  //
  // Overlay rather than clearing /app first. Terminal-Bench task images often
  // contain original input files that must survive even if a host mirror becomes
  // incomplete during recovery after a failed command.
  await execFileAsync(
    "bash",
    [
      "-lc",
      `tar -C ${shellQuote(workspaceRoot)} --exclude='./scratchpad' --exclude='./.reaper' --exclude='./.git' -cf - . | docker exec -u 0 -i ${shellQuote(containerName)} tar -C ${shellQuote(containerWorkspace)} -xf -`,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
}

async function syncContainerWorkspaceToHost(containerName: string, containerWorkspace: string, workspaceRoot: string): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "reaper-tbench-sync-"));
  try {
    // Use docker cp for container -> host synchronization. Streaming a tar
    // pipeline through docker exec proved fragile under Terminal-Bench because
    // Reaper validates artifacts from the host mirror immediately after
    // container commands create them. docker cp gives us a completed filesystem
    // copy boundary before host-side tools observe the workspace.
    await execFileAsync("docker", ["cp", `${containerName}:${containerWorkspace}/.`, tmp], {
      maxBuffer: 20 * 1024 * 1024,
    });
    await rm(path.join(tmp, "scratchpad"), { recursive: true, force: true });
    await rm(path.join(tmp, ".reaper"), { recursive: true, force: true });
    await rm(path.join(tmp, ".git"), { recursive: true, force: true });
    await mkdir(workspaceRoot, { recursive: true });
    await execFileAsync(
      "bash",
      [
        "-lc",
        [
          `find ${shellQuote(workspaceRoot)} -mindepth 1 -maxdepth 1`,
          `! -name scratchpad ! -name .reaper ! -name .git -exec rm -rf {} +`,
          `&& cp -a ${shellQuote(tmp)}/. ${shellQuote(workspaceRoot)}/`,
        ].join(" "),
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function runDockerCommand(
  containerName: string,
  containerCwd: string,
  hostWorkspaceRoot: string,
  args: { cmd: string; timeoutMs?: number; idleTimeoutMs?: number },
  runtime: { artifactDir: string; toolCallId: string },
): Promise<{ stdout: string; stderr: string; exitCode: number | null; wouldBlock: boolean; nextCwd?: string; logPath?: string }> {
  await mkdir(runtime.artifactDir, { recursive: true });
  const logPath = path.join(runtime.artifactDir, `${runtime.toolCallId}.docker-shell.log`);
  const timeoutMs = args.timeoutMs ?? 120_000;
  const wrapper = `
cd ${shellQuote(containerCwd)}
(
${args.cmd}
)
__REAPER_EXIT_CODE=$?
__REAPER_CWD="$(pwd)"
printf '\\n___REAPER_CWD:%s___\\n' "$__REAPER_CWD"
printf '___REAPER_EXIT_CODE:%s___\\n' "$__REAPER_EXIT_CODE"
exit 0
`;

  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync("docker", ["exec", containerName, "bash", "-lc", wrapper], {
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const err = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean; signal?: string };
    stdout = String(err.stdout ?? "");
    stderr = String(err.stderr ?? "");
    await writeFile(logPath, `COMMAND:\n${args.cmd}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n`, "utf8");
    throw new Error(
      [
        err.killed ? `Command timed out after ${timeoutMs}ms` : err.message,
        `Command: ${args.cmd}`,
        `stdout: ${stdout.trim() || "<empty>"}`,
        `stderr: ${stderr.trim() || "<empty>"}`,
      ].join("\n"),
    );
  }

  let nextCwd = containerCwd;
  const cwdMatch = stdout.match(/___REAPER_CWD:(.*)___/);
  if (cwdMatch) {
    nextCwd = cwdMatch[1]!.trim();
    stdout = stdout.replace(/___REAPER_CWD:.*___\n?/, "");
  }
  let exitCode = 0;
  const codeMatch = stdout.match(/___REAPER_EXIT_CODE:(\d+)___/);
  if (codeMatch) {
    exitCode = Number.parseInt(codeMatch[1]!, 10);
    stdout = stdout.replace(/___REAPER_EXIT_CODE:.*___\n?/, "");
  }

  await writeFile(logPath, `COMMAND:\n${args.cmd}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\nEXIT:${exitCode}\n`, "utf8");

  if (exitCode === 1 && isNoMatchSearchCommand(args.cmd, stdout, stderr)) {
    return {
      stdout: "[REAPER SEARCH RESULT]: no matches found\n",
      stderr,
      exitCode: 0,
      wouldBlock: false,
      nextCwd: hostWorkspaceRoot,
      logPath,
    };
  }

  if (exitCode !== 0) {
    throw new Error([`Command exited with code ${exitCode}`, `Command: ${args.cmd}`, `stdout: ${stdout.trim() || "<empty>"}`, `stderr: ${stderr.trim() || "<empty>"}`].join("\n"));
  }

  return {
    stdout,
    stderr,
    exitCode,
    wouldBlock: false,
    nextCwd: hostWorkspaceRoot,
    logPath,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isNoMatchSearchCommand(cmd: string, stdout: string, stderr: string): boolean {
  if (stdout.trim() || stderr.trim()) return false;
  const command = stripLeadingCdCommands(cmd.trim());
  return /^(?:grep|rg)\b/.test(command);
}

function stripLeadingCdCommands(cmd: string): string {
  let rest = cmd.trim();
  while (true) {
    const match = rest.match(/^cd\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*(.*)$/s);
    if (!match) return rest;
    rest = match[1]!.trim();
  }
}

function appendSandboxDiagnosticsToPrompt(instruction: string, diagnostics: string | undefined): string {
  if (!diagnostics?.trim()) return instruction;
  return [
    instruction,
    "",
    "Host-side sandbox diagnostics for this run:",
    diagnostics.trim(),
    "",
    "Use these diagnostics only as environment evidence. If a sibling service is exited, unhealthy, or unreachable by hostname from the task container, do not keep retrying curl/wget/nc against guessed hostnames and do not create a mock replacement. First inspect the listed workspace snapshot paths with read_file/list_directory/grep_search. When the sibling service itself needs logs, file repair, command execution, or restart, call search_tools with select:sandbox_service_control and use that tool. Do not run docker from inside the sandbox unless inspect_environment proves it is available there. Repair the requested behavior from the real service logs/config/artifacts, then verify through the task-facing API or output.",
  ].join("\n");
}

async function collectSandboxServiceDiagnostics(containerName: string, workspaceRoot: string): Promise<string | undefined> {
  const project = await dockerInspectFormat(containerName, "{{ index .Config.Labels \"com.docker.compose.project\" }}").catch(() => "");
  const composeProject = (project || containerName).trim();
  if (!composeProject) return undefined;
  process.env.REAPER_TBENCH_COMPOSE_PROJECT = composeProject;
  const ps = await execFileAsync(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${composeProject}`,
      "--format",
      "{{.Names}}\t{{.Status}}\t{{.Image}}",
    ],
    { timeout: 5_000, maxBuffer: 512 * 1024 },
  ).catch(() => undefined);
  const rows = (ps?.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (rows.length === 0) return undefined;

  const lines = [`compose_project=${composeProject}`, "containers:"];
  const siblingNames: string[] = [];
  for (const row of rows.slice(0, 12)) {
    const [name = "", status = "", image = ""] = row.split("\t");
    if (!name) continue;
    lines.push(`- ${name}: ${status}${image ? ` (${image})` : ""}`);
    if (name !== containerName) siblingNames.push(name);
  }

  for (const sibling of siblingNames.slice(0, 4)) {
    const state = await dockerInspectFormat(
      sibling,
      "{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}}",
    ).catch(() => "");
    const logs = await execFileAsync("docker", ["logs", "--tail", "80", sibling], {
      timeout: 5_000,
      maxBuffer: 512 * 1024,
    }).catch((error: Error & { stdout?: string | Buffer; stderr?: string | Buffer }) => ({
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message),
    }));
    const combinedLogs = `${logs.stdout ?? ""}${logs.stderr ? `\n${logs.stderr}` : ""}`.trim();
    const snapshot = await snapshotSandboxServiceApp(sibling, workspaceRoot).catch(() => undefined);
    lines.push("");
    lines.push(`service ${sibling}: ${state.trim() || "state unavailable"}`);
    if (snapshot) {
      lines.push(`workspace snapshot: ${snapshot.path}`);
      if (snapshot.inventory.trim()) lines.push(`snapshot files:\n${snapshot.inventory.trim()}`);
    }
    lines.push("recent logs:");
    lines.push(combinedLogs ? combinedLogs.slice(-5000) : "<no logs>");
  }

  return lines.join("\n").slice(0, 18_000);
}

async function snapshotSandboxServiceApp(
  serviceContainerName: string,
  workspaceRoot: string,
): Promise<{ path: string; inventory: string }> {
  const safeName = serviceContainerName.replace(/[^A-Za-z0-9_.-]/g, "_");
  const root = path.join(workspaceRoot, ".reaper", "sandbox-services", safeName);
  const appRoot = path.join(root, "app");
  await rm(appRoot, { recursive: true, force: true });
  await mkdir(appRoot, { recursive: true });
  await execFileAsync("docker", ["cp", `${serviceContainerName}:/app/.`, appRoot], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const inventoryResult = await execFileAsync(
    "bash",
    [
      "-lc",
      [
        `cd ${shellQuote(appRoot)}`,
        "find . -maxdepth 3 -type f -printf '%p %s bytes\\n' | sort | sed -n '1,80p'",
      ].join(" && "),
    ],
    { timeout: 5_000, maxBuffer: 256 * 1024 },
  ).catch(() => ({ stdout: "" }));
  return { path: appRoot, inventory: inventoryResult.stdout.slice(0, 6000) };
}

async function dockerInspectFormat(containerName: string, format: string): Promise<string> {
  const result = await execFileAsync("docker", ["inspect", "--format", format, containerName], {
    timeout: 5_000,
    maxBuffer: 256 * 1024,
  });
  return result.stdout.trim();
}

async function main() {
  loadDotEnv();
  const workspaceRoot = path.resolve(argValue("--workspace") ?? process.cwd());
  const instructionFile = argValue("--instruction-file");
  const instruction = instructionFile ? readFileSync(instructionFile, "utf8") : readFileSync(0, "utf8");
  const provider = process.env.REAPER_TBENCH_PROVIDER ?? process.env.REAPER_EVAL_PROVIDER ?? "openrouter";
  const model = process.env.REAPER_TBENCH_MODEL ?? process.env.REAPER_EVAL_MODEL ?? "openai/gpt-4.1";
  const containerName = process.env.REAPER_TBENCH_CONTAINER_NAME;
  const containerWorkspace = process.env.REAPER_TBENCH_CONTAINER_WORKSPACE?.trim() || "/app";
  process.env.REAPER_TBENCH_HOST_WORKSPACE = workspaceRoot;
  if (containerName) {
    process.env.REAPER_WORKSPACE_PATH_ALIASES = [containerWorkspace, "/app", process.env.REAPER_WORKSPACE_PATH_ALIASES].filter(Boolean).join(path.delimiter);
  }

  await mkdir(workspaceRoot, { recursive: true });
  await ensureGitRepo(workspaceRoot);

  const callerVerificationCommand = process.env.REAPER_EXTERNAL_VERIFICATION_COMMAND?.trim();
  const maxVerificationRepairs = parseNonNegativeInt(process.env.REAPER_EXTERNAL_VERIFICATION_MAX_REPAIRS, 2);
  const verifierTimeoutMs = parseNonNegativeInt(process.env.REAPER_EXTERNAL_VERIFICATION_TIMEOUT_MS, 300_000);
  try {
    const sandboxDiagnostics = containerName ? await collectSandboxServiceDiagnostics(containerName, workspaceRoot) : undefined;
    let prompt = appendSandboxDiagnosticsToPrompt(instruction, sandboxDiagnostics);
    let lastResult: Awaited<ReturnType<RuntimeEngine["run"]>> | undefined;
    let lastVerification: CallerVerificationResult | undefined;

    for (let attempt = 0; attempt <= maxVerificationRepairs; attempt += 1) {
      const { gateway, config } = createLiveReaperGateway(`terminal-bench:${path.basename(workspaceRoot)}:${Date.now()}:attempt-${attempt}`, provider, model);
      try {
        lastResult = await new RuntimeEngine({
          config,
          workspaceRoot,
          requestEnvelope: makeRequest(prompt),
          modelGateway: gateway,
          ...(containerName ? { shellRunner: createDockerShellRunner(containerName, containerWorkspace) } : {}),
        }).run();
      } finally {
        await gateway.dispose?.();
      }

      if (!callerVerificationCommand || !containerName) {
        await writeTerminalBenchResult(workspaceRoot, {
          status: "completed",
          provider,
          model,
          assistantMessage: lastResult.assistantMessage,
          trajectoryPath: lastResult.trajectoryPath,
          toolResultCount: lastResult.toolResults.length,
          failedToolResultCount: lastResult.toolResults.filter((item) => !item.ok).length,
        });
        console.log(lastResult.assistantMessage);
        return;
      }

      lastVerification = await runCallerVerification({
        workspaceRoot,
        containerName,
        containerWorkspace,
        command: callerVerificationCommand,
        timeoutMs: verifierTimeoutMs,
        attempt: attempt + 1,
      });
      if (lastVerification.ok) {
        await writeTerminalBenchResult(workspaceRoot, {
          status: "completed",
          provider,
          model,
          assistantMessage: lastResult.assistantMessage,
          trajectoryPath: lastResult.trajectoryPath,
          toolResultCount: lastResult.toolResults.length,
          failedToolResultCount: lastResult.toolResults.filter((item) => !item.ok).length,
          callerVerification: lastVerification,
        });
        console.log(lastResult.assistantMessage);
        return;
      }

      if (attempt >= maxVerificationRepairs) break;
      prompt = buildCallerVerificationRepairPrompt({
        originalInstruction: instruction,
        previousSummary: lastResult.assistantMessage,
        command: callerVerificationCommand,
        output: lastVerification.output,
        failureContext: lastVerification.failureContext,
        attempt: attempt + 1,
      });
    }

    await writeTerminalBenchResult(workspaceRoot, {
      status: "failed",
      failureClass: "external_verification_failed",
      provider,
      model,
      assistantMessage: [
        lastResult?.assistantMessage ?? "",
        "",
        "Caller-provided verification still failed after repair attempts.",
        lastVerification?.output ?? "",
      ].join("\n").trim(),
      trajectoryPath: lastResult?.trajectoryPath,
      toolResultCount: lastResult?.toolResults.length ?? 0,
      failedToolResultCount: lastResult?.toolResults.filter((item) => !item.ok).length ?? 0,
      callerVerification: lastVerification,
    });
    console.log(lastResult?.assistantMessage ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeTerminalBenchResult(workspaceRoot, {
      status: "failed",
      failureClass: classifyBridgeFailure(message),
      provider,
      model,
      assistantMessage: message,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message,
        stack: error instanceof Error ? error.stack : undefined,
      },
      toolResultCount: 0,
      failedToolResultCount: 0,
    });
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

async function writeTerminalBenchResult(workspaceRoot: string, data: Record<string, unknown>): Promise<void> {
  await writeFile(
    path.join(workspaceRoot, "reaper-terminal-bench-result.json"),
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        ...data,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function classifyBridgeFailure(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("402") || normalized.includes("payment required") || normalized.includes("positive balance")) {
    return "provider_unavailable";
  }
  if (normalized.includes("401") || normalized.includes("403") || normalized.includes("api key")) {
    return "provider_auth";
  }
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return "timeout";
  }
  return "runtime_error";
}

interface CallerVerificationResult {
  ok: boolean;
  command: string;
  output: string;
  failureContext?: string;
  attempt: number;
  startedAt: string;
  endedAt: string;
}

async function runCallerVerification(input: {
  workspaceRoot: string;
  containerName: string;
  containerWorkspace: string;
  command: string;
  timeoutMs: number;
  attempt: number;
}): Promise<CallerVerificationResult> {
  const startedAt = new Date().toISOString();
  try {
    await syncHostWorkspaceToContainer(input.workspaceRoot, input.containerName, input.containerWorkspace);
    const result = await runDockerCommand(
      input.containerName,
      input.containerWorkspace,
      input.workspaceRoot,
      { cmd: input.command, timeoutMs: input.timeoutMs },
      {
        artifactDir: path.join(input.workspaceRoot, ".reaper", "external-verification"),
        toolCallId: `caller-verification-${input.attempt}`,
      },
    );
    await syncContainerWorkspaceToHost(input.containerName, input.containerWorkspace, input.workspaceRoot);
    return {
      ok: true,
      command: input.command,
      output: formatCallerVerificationOutput(input.command, result.stdout, result.stderr),
      attempt: input.attempt,
      startedAt,
      endedAt: new Date().toISOString(),
    };
  } catch (error) {
    await syncContainerWorkspaceToHost(input.containerName, input.containerWorkspace, input.workspaceRoot).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    const failureContext = await collectCallerVerificationFailureContext({
      containerName: input.containerName,
      output: message,
    });
    return {
      ok: false,
      command: input.command,
      output: message.slice(-16_000),
      ...(failureContext ? { failureContext } : {}),
      attempt: input.attempt,
      startedAt,
      endedAt: new Date().toISOString(),
    };
  }
}

function buildCallerVerificationRepairPrompt(input: {
  originalInstruction: string;
  previousSummary: string;
  command: string;
  output: string;
  failureContext?: string;
  attempt: number;
}): string {
  const failure = classifyVerificationOutput(input.output);
  return [
    input.originalInstruction,
    "",
    "An external acceptance check failed after the previous completion attempt.",
    "Use this check as one acceptance signal for the current task. If the task has multiple observable contracts, satisfy all of them rather than optimizing only for one script.",
    "Do not create, edit, or replace verifier-owned files under absolute /tests. If an external /tests command is unavailable, validate the original task contract directly instead of inventing a substitute verifier under the workspace.",
    "The prior completion summary is not proof. Complete only after a real check exercises the final artifact or behavior and matches the expected content/value/shape.",
    "Repair the workspace based on the failure facts, rerun the smallest relevant check you can, and complete only when the requested task is satisfied.",
    "If the failure output shows expected-vs-actual values, hash/checksum/image-fingerprint mismatches, byte-exact text mismatches, ordering/count mismatches, or serialized output mismatches, treat the expected value and comparator as authoritative. Inspect the producer and artifacts, then make deterministic outputs that satisfy the comparator. Do not call this an environment issue unless the check itself could not run.",
    "If the failure involves remote HTTP/API artifacts, inspect the task contract, redirects, response format, and any seed/static/cache options. Prefer deterministic retrieval or deterministic artifact generation from the visible contract over assuming remote content drift is unsolvable.",
    "If the failure is a relative performance assertion, inspect the measured scripts and profile output. Preserve the required baseline-vs-optimized relationship: keep the baseline simple/correct but not accidentally optimized, remove overhead from the optimized path, and rerun the exact timing comparison.",
    "If your repair needs a compound diagnostic script with loops, functions, nested quoting, or multiple statements, create a temporary script file or use a here-doc. Do not keep retrying dense shell one-liners after syntax or quoting errors.",
    "",
    `Verification command: ${input.command}`,
    `Failed verification attempt: ${input.attempt}`,
    `Failure classes: ${failure.classes.join(", ")}`,
    failure.evidence.length > 0 ? `Failure evidence:\n${failure.evidence.map((item) => `- ${item}`).join("\n")}` : "",
    failure.facts.length > 0 ? `Failure facts:\n${failure.facts.map((item) => `- ${item}`).join("\n")}` : "",
    `Repair strategy:\n${failure.repairStrategy}`,
    input.failureContext ? `Verifier-owned context snippets:\n${input.failureContext}` : "",
    input.previousSummary.trim() ? `Previous completion summary:\n${input.previousSummary.trim()}` : "",
    `Verification failure output:\n${input.output.slice(-12_000)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatCallerVerificationOutput(command: string, stdout: string, stderr: string): string {
  return [`$ ${command}`, stdout, stderr].filter((part) => part.trim()).join("\n");
}

async function collectCallerVerificationFailureContext(input: { containerName: string; output: string }): Promise<string | undefined> {
  const snippets: string[] = [];
  const summaryLines = extractVerifierSummaryLines(input.output);
  if (summaryLines.length > 0) {
    snippets.push(["Failed tests/assertions:", ...summaryLines.map((line) => `- ${line}`)].join("\n"));
  }

  const refs = extractVerifierFileRefs(input.output).slice(0, 4);
  for (const ref of refs) {
    const start = Math.max(1, ref.line - 20);
    const end = ref.line + 20;
    try {
      const result = await execFileAsync(
        "docker",
        ["exec", input.containerName, "bash", "-lc", `test -f ${shellQuote(ref.path)} && sed -n '${start},${end}p' ${shellQuote(ref.path)}`],
        { timeout: 4_000, maxBuffer: 256 * 1024 },
      );
      const content = result.stdout.trim();
      if (content) {
        snippets.push([`$ sed -n '${start},${end}p' ${ref.path}`, content.slice(0, 6000)].join("\n"));
      }
    } catch {
      // Failure snippets are advisory; never fail the bridge because context extraction failed.
    }
  }

  if (snippets.length === 0) return undefined;
  return snippets.join("\n\n---\n\n").slice(0, 14_000);
}

function extractVerifierSummaryLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /^(FAILED|ERROR)\s|^>\s*assert\b|AssertionError|FileNotFoundError|ModuleNotFoundError|ImportError|content mismatch|hash .*mismatch|expected|received|actual/i.test(
        line,
      ),
    )
    .slice(-18)
    .map((line) => line.slice(0, 500));
}

function extractVerifierFileRefs(output: string): Array<{ path: string; line: number }> {
  const refs: Array<{ path: string; line: number }> = [];
  const add = (filePath: string | undefined, lineText: string | undefined) => {
    if (!filePath || !lineText) return;
    if (!filePath.startsWith("/tests/") && !filePath.startsWith("/app/")) return;
    const line = Number.parseInt(lineText, 10);
    if (!Number.isFinite(line) || line <= 0) return;
    refs.push({ path: filePath, line });
  };

  for (const match of output.matchAll(/(?:^|\s)(\/(?:tests|app)\/[^:\s'"]+\.[A-Za-z0-9_+-]+):(\d+)/gm)) {
    add(match[1], match[2]);
  }
  for (const match of output.matchAll(/File "((?:\/tests|\/app)\/[^"]+)", line (\d+)/g)) {
    add(match[1], match[2]);
  }

  const seen = new Set<string>();
  return refs
    .sort((a, b) => Number(!a.path.startsWith("/tests/")) - Number(!b.path.startsWith("/tests/")) || a.path.localeCompare(b.path) || a.line - b.line)
    .filter((ref) => {
      const key = `${ref.path}:${Math.floor(ref.line / 20)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}
