import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile,  mkdir,  mkdtemp,  readFile,  readdir,  rm,  stat,  writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ForegroundShellResult } from "./global/run-shell-command.js";
import { promisify } from "node:util";
import treeKill from "tree-kill";

import { AuditLogger } from "../logging/audit.js";
import { TrajectoryLogger } from "../logging/trajectory.js";
import { loadLocalRules } from "../policy/local-rules.js";
import { PathPolicyError } from "../policy/paths.js";
import { evaluateCommandPolicy, type SafetyProfile } from "../policy/rules.js";
import { PermissionClassifier, type PermissionMode, type PermissionClassification } from "../policy/classifier.js";
import type { RecoverySession } from "../recovery/session.js";
import { classifyToolCall } from "../execution/planner.js";
import { ArtifactStore } from "../artifacts/store.js";
import { executeBashCommand, bashCommandToModelOutput, isBackgroundBashResult, toForegroundShellResult } from "./bash/index.js";
import type { BashExecutionResult } from "./bash/index.js";
import { normalizeToolCall } from "./normalize.js";
import { grepSearchTool } from "./read/grep-search.js";
import { getToolOutputTool } from "./read/get-tool-output.js";
import { listDirectoryTool } from "./read/list-directory.js";
import { readFileTool } from "./read/read-file.js";
import { skimFileTool } from "./read/skim-file.js";
import { inspectEnvironmentTool } from "./read/inspect-env.js";
import { activateSkillTool } from "./read/activate-skill.js";
import { webSearchTool, type WebSearchArgs } from "./read/web-search.js";
import { ComputerBrowserController } from "./browser/computer-browser.js";
import { NativeComputerController, type NativeComputerToolName } from "./computer/native-computer.js";
import { toolRegistry } from "./registry.js";
import { deleteFileTool } from "./write/delete-file.js";
import { applyEditFileContent, editFileTool } from "./write/edit-file.js";
import { replaceExactString, replaceInFileTool, replaceLineRange } from "./write/replace-in-file.js";
import { replaceSymbolTool } from "./write/replace-symbol.js";
import { writeFileTool } from "./write/write-file.js";
import { isEditorGuardFailure, validateCandidateSource } from "./write/editor-guard.js";
import { createTask, updateTask, listTasks } from "./write/task.js";
import { executeSearchTools } from "./write/search-tools.js";
import { webFetchTool } from "./read/web-fetch.js";
import type { Hooks } from "../adaptive/hooks.js";
import { ToolCallSchema, type ToolCall, type ToolResult } from "./types.js";
import { countFileLines } from "../workspace/roots.js";
import type { ReaperConfig } from "../config/model-config.js";
import type { MergedToolRegistry } from "./mcp/registry.js";
import { ensureReaperScratchpad, getReaperScratchpadPaths } from "../workspace/scratchpad.js";
import { normalizeWorkspacePath, relativeWorkspacePath } from "../policy/paths.js";
import { classifyServiceLifecycle, type ServiceLifecycleState } from "./service-lifecycle.js";
import { BackgroundProcessManager } from "./background-process-manager.js";
import { createCheckpoint, restoreCheckpoint } from "../runtime/checkpoints.js";
import { getGitDiffState, getGitStatusState, summarizeGitDiffState } from "../runtime/diff-state.js";
import type {ModelGateway} from "../model/types.js";
import {executeCancelSubagentTool, executePollSubagentTool, executeSubagentTool} from "./subagent-tools.js";
import type {SubagentPool} from "../runtime/subagent-pool.js";

const execFileAsync = promisify(execFile);

export interface ToolExecutorOptions {
  workspaceRoot: string;
  runId: string;
  sessionId: string;
  traceId: string;
  logLevel: "info" | "debug" | "trace";
  safetyProfile: SafetyProfile;
  permissionMode?: PermissionMode;
  trajectoryLogger?: TrajectoryLogger;
  auditLogger?: AuditLogger;
  recoverySession?: RecoverySession;
  mcpRegistry?: MergedToolRegistry;
  config?: ReaperConfig;
  /** Model gateway for call_subagent tool. */
  modelGateway?: ModelGateway;
  /** Subagent pool for background subagent jobs. */
  subagentPool?: SubagentPool | undefined;
  runDir?: string;
  artifactsDir?: string;
  shellRunner?: ShellRunner;
  /**
   * Subagent host for the `agent` and `agent_swarm` tools. When
   * provided, the model-driven subagent runtime becomes available
   * to the main model. When omitted, calls to those tools return a
   * clear error instead of silently failing.
   */
  subagentHost?: SubagentHost;
  /**
   * Hooks adapter — when provided, the executor emits
   * `PreToolUse` / `PostToolUse` / `PostToolUseFailure` around
   * every dispatched tool call. A `PreToolUse` handler that
   * returns `{ allow: false }` blocks the dispatch.
   */
  hooks?: Hooks;
  /**
   * Forwarder used by `enable_extension` to push newly activated
   * extension tools into the executor's `ExtensionToolRegistry`.
   * The runtime wires this to `installExtensionTools`.
   */
  refreshExtensionTools?: () => Promise<void> | void;
  /**
   * Optional dependencies for the 17 model-callable authoring tools
   * (5 skill + 6 extension + 6 hook tools). The wiring layer supplies
   * these at construction time so the executor's switch can route
   * to the existing lifecycle classes without re-instantiating them.
   */
  authoringTools?: AuthoringToolDeps;
}

/**
 * Backdoor hooks for the authoring tools. Each field is independently
 * optional so the executor can dispatch whatever the runtime wired.
 */
export interface AuthoringToolDeps {
  /** Skill authoring (5 tools). */
  handleCreateSkill?: (args: unknown) => Promise<unknown>;
  handleTestSkill?: (args: unknown) => Promise<unknown>;
  handleApproveSkill?: (args: unknown) => Promise<unknown>;
  handleUninstallSkill?: (args: unknown) => Promise<unknown>;
  handleReloadSkills?: (args: unknown) => unknown;
  /** Extension authoring (6 tools). */
  handleCreateExtension?: (args: unknown) => Promise<unknown>;
  handleValidateExtension?: (args: unknown) => Promise<unknown>;
  handleEnableExtension?: (args: unknown) => Promise<unknown>;
  handleTrustExtension?: (args: unknown) => Promise<unknown>;
  handleUninstallExtension?: (args: unknown) => Promise<unknown>;
  handleReloadExtensions?: (args: unknown) => unknown;
  /** Hook authoring (6 tools). */
  handleCreateHook?: (args: unknown) => Promise<unknown>;
  handleListHooks?: (args: unknown) => unknown;
  handleUpdateHook?: (args: unknown) => Promise<unknown>;
  handleApproveHook?: (args: unknown) => Promise<unknown>;
  handleUninstallHook?: (args: unknown) => Promise<unknown>;
  handleReloadHooks?: (args: unknown) => unknown;
}

export type ShellRunner = (
  workspaceRoot: string,
  args: { cmd: string; timeoutMs?: number; idleTimeoutMs?: number; isBackground?: boolean },
  workingDirectory: string,
  runtime: { runId: string; artifactDir: string; toolCallId: string },
) => Promise<import("./bash/index.js").BashExecutionResult>;

/**
 * Subagent host — the bridge between the tool executor and the
 * model-driven subagent runtime (LaborMarket + SubagentStore +
 * ForegroundSubagentRunner).
 *
 * Implemented by the runtime layer; the executor only needs the
 * two invocation methods to dispatch the `agent` and `agent_swarm`
 * tools. The runtime returns a string to feed back to the main
 * model as the tool result.
 */
export interface SubagentHost {
  invokeAgent(input: {
    description: string;
    prompt: string;
    subagentType: string;
    model: string | null;
    resume: string | null;
    runInBackground: boolean;
    timeout: number | null;
  }): Promise<string>;
  invokeAgentSwarm(input: {
    description: string;
    subagentType: string;
    promptTemplate: string;
    items: string[];
    model: string | null;
    timeout: number | null;
    maxConcurrency: number | undefined;
  }): Promise<string>;
}

interface ManagedBackgroundProcess {
  child: import("node:child_process").ChildProcess;
  output: string[];
  logPath?: string;
  startedAt: string;
  /** Wall-clock ms when the child was spawned. Used to defend against
   *  pid reuse: if the kernel recycles the pid to a different process
   *  before we get to clean up, the (startedAtMs, pid) pair is unlikely
   *  to match a new process. */
  startedAtMs: number;
  cmd: string;
  cwd: string;
  notified: boolean;
}
// Kept as a local alias so existing call sites still typecheck; the
// canonical definition lives in `background-process-manager.ts`.

type SandboxServiceAction =
  | "list"
  | "logs"
  | "snapshot"
  | "inspect_image"
  | "restore_from_image"
  | "exec"
  | "write_file"
  | "copy_to_service"
  | "restart"
  | "recreate"
  | "start"
  | "stop"
  | "wait_ready";

interface SandboxServiceControlArgs {
  action: SandboxServiceAction;
  service?: string;
  command?: string;
  sourcePath?: string;
  targetPath?: string;
  content?: string;
  tail?: number;
  intervalMs?: number;
  timeoutMs?: number;
}

type ReplaceInFileCandidateArgs =
  | { path: string; oldString: string; newString: string; allowMultiple?: boolean | undefined }
  | { path: string; startLine: number; endLine: number; content: string };

type EditFileCandidateArgs = { path: string; edits: Array<{ oldString: string; newString: string }> };

/**
 * Maximum stdout length (in characters) that the executor returns inline.
 * Anything larger is written to a file under `<workspace>/.reaper/spillover/<callId>.log`
 * and the inline stdout is replaced with a short summary pointing at the path.
 * This is the OpenCode / Hermes pattern: large outputs are spilled to disk so
 * the next model call's prompt stays small, and the model can grep the file
 * instead of re-running the command.
 */
const TOOL_RESULT_STDOUT_SPILLOVER_THRESHOLD = 8_192; // 8KB
const TOOL_RESULT_STDOUT_INLINE_PREVIEW_CHARS = 1_200;

export async function spillLargeToolResult(
  result: ForegroundShellResult | undefined,
  call: { id: string },
  workspaceRoot: string,
): Promise<ForegroundShellResult & { spilloverPath?: string } | undefined> {
  if (!result || typeof result.stdout !== "string" || result.stdout.length <= TOOL_RESULT_STDOUT_SPILLOVER_THRESHOLD) {
    return result;
  }
  try {
    const dir = path.join(workspaceRoot, ".reaper", "spillover");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${call.id}.log`);
    const head = result.stdout.slice(0, TOOL_RESULT_STDOUT_INLINE_PREVIEW_CHARS);
    const tail = result.stdout.slice(-TOOL_RESULT_STDOUT_INLINE_PREVIEW_CHARS);
    const body = `${head}\n\n... (${result.stdout.length - TOOL_RESULT_STDOUT_INLINE_PREVIEW_CHARS * 2} chars truncated; full output written to ${file}) ...\n\n${tail}`;
    await writeFile(file, result.stdout, "utf8");
    const next: ForegroundShellResult & { spilloverPath?: string } = {
      ...result,
      stdout: body,
      spilloverPath: file,
    };
    return next;
  } catch (error) {
    // If we can't write the file (read-only workspace, etc.) fall back to the
    // original result so the model at least sees the inline output.
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...result,
      stdout: result.stdout.slice(0, TOOL_RESULT_STDOUT_INLINE_PREVIEW_CHARS) + `\n... (spillover write failed: ${message}) ...`,
    };
  }
}

export class ToolExecutor {
  private readonly trajectoryLogger: TrajectoryLogger;
  private readonly auditLogger: AuditLogger;
  private readonly recoverySession: RecoverySession | undefined;
  private readonly fullReadPaths = new Set<string>();
  private readonly artifactStore: ArtifactStore;
  private readonly config: ReaperConfig | undefined;
  private readonly mcpRegistry: MergedToolRegistry | undefined;
  private readonly subagentHost: SubagentHost | undefined;
  private readonly authoringTools: AuthoringToolDeps | undefined;
  private readonly permissionClassifier: PermissionClassifier;
  private readonly readFileState = new Map<string, { sha256: string | null; mtimeMs: number | null; fullyRead: boolean }>();
  private readonly readOutputCache = new Map<string, { sha256: string | null; mtimeMs: number | null; output: unknown; hits: number }>();
  private readonly fileWriteCounts = new Map<string, number>();
  private localRulesHash?: string;
  private readonly backgroundProcessManager: BackgroundProcessManager;
  private computerBrowserController: ComputerBrowserController | undefined;
  private nativeComputerController: NativeComputerController | undefined;
  private currentWorkingDirectory: string;
  private consecutiveUnknownTools = 0;
  private lastUnknownToolName?: string;
  private readonly serviceAutoRecoveryCounts = new Map<string, number>();
  private readonly serviceRecoveryAttempts = new Map<string, number>();
  private readonly serviceImageSnapshots = new Map<string, { path: string; inventory: string }>();

  constructor(private readonly options: ToolExecutorOptions) {
    void ensureReaperScratchpad(options.workspaceRoot);
    this.trajectoryLogger = options.trajectoryLogger ?? new TrajectoryLogger(options.workspaceRoot);
    this.auditLogger = options.auditLogger ?? new AuditLogger(options.workspaceRoot, { runId: options.runId });
    this.recoverySession = options.recoverySession;
    this.artifactStore = new ArtifactStore(options.workspaceRoot);
    this.config = options.config;
    this.mcpRegistry = options.mcpRegistry;
    this.subagentHost = options.subagentHost;
    this.authoringTools = options.authoringTools;
    this.permissionClassifier = new PermissionClassifier(options.permissionMode ?? "yolo");
    this.currentWorkingDirectory = options.workspaceRoot;
    this.backgroundProcessManager = new BackgroundProcessManager({
      runId: options.runId,
      workspaceRoot: options.workspaceRoot,
    });
  }

  /**
   * Backdoor for the `enable_extension` tool handler: after the
   * extension's tools are registered on the source registry, the
   * runtime calls this to copy them into the executor's local
   * ExtensionToolRegistry so dispatch sees them on the next call.
   *
   * The actual wiring is supplied via the `refreshExtensionTools`
   * field on ToolExecutorOptions — the executor keeps it as a
   * generic forwarder because the extension registry lives outside
   * the executor's own dependencies.
   */
  async refreshExtensionTools(): Promise<{ installed: number }> {
    const fn = this.options.refreshExtensionTools;
    if (!fn) return { installed: 0 };
    await fn();
    return { installed: -1 };
  }

  /**
   * Get the underlying options for advanced callers (CLI hook
   * wiring, test harnesses). Do not mutate.
   */
  getOptions(): ToolExecutorOptions {
    return this.options;
  }

  getCurrentWorkingDirectory() {
    return this.currentWorkingDirectory;
  }

  getBackgroundProcesses() {
    return this.backgroundProcessManager.snapshot();
  }

  async cleanupBackgroundProcesses(reason = "cleanup"): Promise<void> {
    if (this.computerBrowserController) {
      await this.computerBrowserController.close();
      this.computerBrowserController = undefined;
    }
    if (this.nativeComputerController) {
      await this.nativeComputerController.close();
      this.nativeComputerController = undefined;
    }
    await this.backgroundProcessManager.terminateAll(reason);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    // Normalize tool call aliases before validation
    const normalizedCall = normalizeToolCall(call) as ToolCall;
    const start = Date.now();
    const decisionId = randomUUID();

    // Unknown-tool loop guard
    const isKnownTool = normalizedCall.name in toolRegistry || (this.mcpRegistry?.isMcpTool(normalizedCall.name) ?? false);
    if (!isKnownTool) {
      this.consecutiveUnknownTools++;
      this.lastUnknownToolName = normalizedCall.name;
      const discovery = executeSearchTools(normalizedCall.name, this.options.runId);
      const suggestionText = discovery.matches.length
        ? ` Closest discoverable tools: ${discovery.matches.map((item) => `${item.name} (${item.description})`).join("; ")}. Use search_tools with 'select:${discovery.matches.map((item) => item.name).join(",")}' if one of these is intended.`
        : " No close tool match was found; call search_tools with capability keywords before retrying.";
      if (this.consecutiveUnknownTools >= 3) {
        return {
          toolCallId: call.id,
          name: call.name,
          ok: false,
          durationMs: 0,
          args: call.args,
          error: {
            message: `Unknown tool '${call.name}' called ${this.consecutiveUnknownTools} times in a row.${suggestionText} Available core tools: ${Object.keys(toolRegistry).join(", ")}. Please use only registered tools.`,
            code: "UNKNOWN_TOOL_LOOP",
          },
        };
      }
      return {
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          message: `Unknown tool '${call.name}'.${suggestionText} Available core tools: ${Object.keys(toolRegistry).join(", ")}.`,
          code: "UNKNOWN_TOOL",
        },
      };
    }
    this.consecutiveUnknownTools = 0;

    // Validate params — return error instead of throwing so model sees feedback
    const parsed = ToolCallSchema.safeParse(normalizedCall);
    if (!parsed.success) {
      const errors = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
      const toolName = typeof normalizedCall.name === "string" ? normalizedCall.name : call.name;
      const args = normalizedCall.args ?? call.args;
      const message = `Invalid params for '${toolName}': ${errors}`;
      await this.trajectoryLogger.write({
        event_id: randomUUID(),
        run_id: this.options.runId,
        session_id: this.options.sessionId,
        trace_id: this.options.traceId,
        timestamp: new Date(start).toISOString(),
        log_schema_version: 1,
        kind: "tool_call",
        level: this.options.logLevel,
        tool_name: toolName,
        decision_id: decisionId,
        status: "failed",
        args,
        error: { message, code: "INVALID_TOOL_PARAMS" },
      });
      return {
        toolCallId: call.id,
        name: toolName,
        ok: false,
        durationMs: Date.now() - start,
        args,
        error: { message, code: "INVALID_TOOL_PARAMS" },
      };
    }
    const parsedCall = parsed.data;

    await this.trajectoryLogger.write({
      event_id: randomUUID(),
      run_id: this.options.runId,
      session_id: this.options.sessionId,
      trace_id: this.options.traceId,
      timestamp: new Date(start).toISOString(),
      log_schema_version: 1,
      kind: "tool_call",
      level: this.options.logLevel,
      tool_name: parsedCall.name,
      decision_id: decisionId,
      status: "started",
      args: parsedCall.args,
    });

    try {
      // Permission check
      const classification = this.permissionClassifier.classifyToolCall(parsedCall);
      if (classification.outcome === "dangerous") {
        throw new Error(`Permission denied: ${classification.reasoning} (rule: ${classification.ruleMatch ?? "classifier"})`);
      }

      // PreToolUse hook envelope. A handler returning { allow: false }
      // blocks the dispatch with the hook's reason.
      const hooks = this.options.hooks;
      let preHookAllow = true;
      let preHookReason: string | undefined;
      let preHookMessage: string | undefined;
      if (hooks) {
        try {
          const preHookResult = await hooks.emit({
            name: "PreToolUse",
            payload: { toolName: parsedCall.name, args: parsedCall.args },
            blockable: true,
          });
          preHookAllow = preHookResult.allow !== false;
          if (!preHookAllow) {
            throw new Error(`PreToolUse hook blocked ${parsedCall.name}: ${preHookResult.reason ?? preHookResult.message ?? "blocked by hook"}`);
          }
          preHookMessage = preHookResult.message;
        } catch (e) {
          // Hook crash on PreToolUse of a security event → fail closed.
          // For non-security tools, fall through and let the actual
          // dispatch proceed (the original exception is preserved).
          if (e instanceof Error && e.message.startsWith("PreToolUse hook blocked")) throw e;
          // Hook engine errors are logged but do not block non-security
          // tools. (Hooks.emit already has its own try/catch.)
        }
      }

      const output = await this.executeInner(parsedCall, decisionId);

      // PostToolUse hook envelope (observation only).
      if (hooks) {
        try {
          await hooks.emit({
            name: "PostToolUse",
            payload: { toolName: parsedCall.name, args: parsedCall.args, output },
            blockable: false,
          });
        } catch { /* swallow */ }
      }

      const normalizedOutput = await this.maybeStoreArtifact(parsedCall.name, output);
      // If a PreToolUse handler attached a hint, fold it into the result
      // so the model sees it alongside the tool output.
      const finalOutput = preHookMessage ? { ...((normalizedOutput as object) ?? {}), __hint: preHookMessage } : normalizedOutput;
      const result: ToolResult = {
        toolCallId: parsedCall.id,
        name: parsedCall.name,
        ok: true,
        durationMs: Date.now() - start,
        args: parsedCall.args,
        output: finalOutput,
      };

      await this.trajectoryLogger.write({
        event_id: randomUUID(),
        run_id: this.options.runId,
        session_id: this.options.sessionId,
        trace_id: this.options.traceId,
        timestamp: new Date().toISOString(),
        log_schema_version: 1,
        kind: "tool_call",
        level: this.options.logLevel,
        tool_name: parsedCall.name,
        decision_id: decisionId,
        status: "completed",
        args: parsedCall.args,
        output: finalOutput,
      });

      return result;
    } catch (error) {
      const errorMessage = await this.buildToolErrorMessage(parsedCall, error);

      // PostToolUseFailure hook envelope (observation only).
      if (this.options.hooks) {
        try {
          await this.options.hooks.emit({
            name: "PostToolUseFailure",
            payload: { toolName: parsedCall.name, args: parsedCall.args, error: errorMessage },
            blockable: false,
          });
        } catch { /* swallow */ }
      }

      const result: ToolResult = {
        toolCallId: parsedCall.id,
        name: parsedCall.name,
        ok: false,
        durationMs: Date.now() - start,
        args: parsedCall.args,
        error: {
          code:
            error instanceof PathPolicyError
              ? "path_escape"
              : error instanceof Error && "code" in error && typeof error.code === "string"
                ? error.code
                : "tool_error",
          message: errorMessage,
        },
      };

      await this.trajectoryLogger.write({
        event_id: randomUUID(),
        run_id: this.options.runId,
        session_id: this.options.sessionId,
        trace_id: this.options.traceId,
        timestamp: new Date().toISOString(),
        log_schema_version: 1,
        kind: "tool_call",
        level: this.options.logLevel,
        tool_name: parsedCall.name,
        decision_id: decisionId,
        status: "failed",
        args: parsedCall.args,
        error: result.error,
      });

      if (parsedCall.name === "bash" || error instanceof PathPolicyError) {
        const auditMessage = result.error?.message ?? "Tool execution failed";
        const localRules = await loadLocalRules(this.options.workspaceRoot);
        await this.auditLogger.write({
          event_id: randomUUID(),
          run_id: this.options.runId,
          session_id: this.options.sessionId,
          trace_id: this.options.traceId,
          timestamp: new Date().toISOString(),
          log_schema_version: 1,
          kind: error instanceof PathPolicyError ? "path_escape" : "policy_block",
          severity: "error",
          rule_id:
            parsedCall.name === "bash"
              ? evaluateCommandPolicy(parsedCall.args.cmd, this.options.safetyProfile, localRules ? { localRules } : undefined).ruleId
              : undefined,
          message: auditMessage,
        });
      }

      return result;
    }
  }

  private async buildToolErrorMessage(call: ToolCall, error: unknown): Promise<string> {
    const baseMessage = error instanceof Error ? error.message : "Unknown tool error";
    if (
      call.name === "read_file" &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EISDIR"
    ) {
      const targetPath = typeof (call.args as { path?: unknown }).path === "string" ? (call.args as { path: string }).path : "";
      const diagnostics = targetPath ? await this.buildDirectoryReadDiagnostics(targetPath) : "";
      return diagnostics ? `${baseMessage}\n\n[REMEDIATION TIP]: ${diagnostics}` : baseMessage;
    }
    if (
      call.name !== "read_file" ||
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      return baseMessage;
    }

    const targetPath = typeof (call.args as { path?: unknown }).path === "string" ? (call.args as { path: string }).path : "";
    if (!targetPath) return baseMessage;

    const diagnostics = await this.buildMissingPathDiagnostics(targetPath);
    return diagnostics ? `${baseMessage}\n\n[REMEDIATION TIP]: ${diagnostics}` : baseMessage;
  }

  private async buildMissingPathDiagnostics(targetPath: string): Promise<string> {
    const normalizedParent = path.posix.dirname(targetPath.replace(/\\/g, "/"));
    const parentPath = normalizedParent === "." ? "" : normalizedParent;
    const targetName = path.posix.basename(targetPath);
    const parts: string[] = [
      `The requested file '${targetPath}' does not exist. Do not retry the same read unchanged.`,
      "Inspect the actual repository layout with list_directory or grep_search, then use the discovered path.",
    ];

    const parentEntries = await this.safeListRelativeDirectory(parentPath);
    if (parentEntries.length > 0) {
      parts.push(`Entries in '${parentPath || "."}': ${parentEntries.slice(0, 20).join(", ")}${parentEntries.length > 20 ? ", ..." : ""}.`);
    } else {
      const rootEntries = await this.safeListRelativeDirectory("");
      if (rootEntries.length > 0) {
        parts.push(`Top-level entries: ${rootEntries.slice(0, 20).join(", ")}${rootEntries.length > 20 ? ", ..." : ""}.`);
      }
    }

    const candidates = await this.findNearbyFileCandidates(targetName);
    if (candidates.length > 0) {
      parts.push(`Files with the same name elsewhere: ${candidates.slice(0, 10).join(", ")}${candidates.length > 10 ? ", ..." : ""}.`);
    }

    return parts.join(" ");
  }

  private async buildDirectoryReadDiagnostics(targetPath: string): Promise<string> {
    const entries = await this.safeListRelativeDirectory(targetPath);
    const parts = [
      `The requested path '${targetPath}' is a directory, not a file. Do not retry the same read_file call unchanged.`,
    ];
    if (entries.length > 0) {
      parts.push(`Directory entries: ${entries.slice(0, 20).join(", ")}${entries.length > 20 ? ", ..." : ""}.`);
    } else {
      parts.push("The directory appears empty or cannot be listed from the current workspace view.");
    }
    if (/\.py(?:\/|$)/.test(targetPath.replace(/\\/g, "/"))) {
      parts.push(
        "If a service is trying to execute this Python path, inspect the service command and either point it at a real file or create an appropriate package entrypoint such as __main__.py.",
      );
    } else {
      parts.push("Use list_directory on this path, then read a specific contained file or adjust the command to target an actual file.");
    }
    return parts.join(" ");
  }

  private async safeListRelativeDirectory(relativePath: string): Promise<string[]> {
    try {
      const absolutePath = normalizeWorkspacePath(this.options.workspaceRoot, relativePath || ".");
      const entries = await readdir(absolutePath, { withFileTypes: true });
      return entries
        .filter((entry) => !entry.name.startsWith("."))
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  private async findNearbyFileCandidates(targetName: string): Promise<string[]> {
    if (!targetName || targetName === "." || targetName === "/") return [];
    const candidates: string[] = [];
    const ignored = new Set([".git", "node_modules", ".reaper", "scratchpad", "dist", "build", "coverage", ".next"]);

    const walk = async (relativeDir: string, depth: number): Promise<void> => {
      if (depth > 4 || candidates.length >= 20) return;
      let entries: Awaited<ReturnType<typeof readdirWithFileTypes>>;
      try {
        entries = await readdirWithFileTypes(normalizeWorkspacePath(this.options.workspaceRoot, relativeDir || "."));
      } catch {
        return;
      }

      for (const entry of entries) {
        if (candidates.length >= 20) return;
        if (entry.name.startsWith(".") || ignored.has(entry.name)) continue;
        const child = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (entry.isFile() && entry.name === targetName) candidates.push(child);
        if (entry.isDirectory()) await walk(child, depth + 1);
      }
    };

    await walk("", 0);
    return candidates;
  }

  private async resolveExistingPathCase(relativePath: string): Promise<string> {
    const normalizedInput = relativePath.replace(/\\/g, "/");
    try {
      await stat(normalizeWorkspacePath(this.options.workspaceRoot, normalizedInput));
      return normalizedInput;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const parent = path.posix.dirname(normalizedInput);
    const base = path.posix.basename(normalizedInput);
    const parentRelative = parent === "." ? "" : parent;
    let entries: Awaited<ReturnType<typeof readdirWithFileTypes>>;
    try {
      entries = await readdirWithFileTypes(normalizeWorkspacePath(this.options.workspaceRoot, parentRelative || "."));
    } catch {
      return relativePath;
    }
    const exactCaseInsensitive = entries.find((entry) => entry.name.toLowerCase() === base.toLowerCase());
    if (!exactCaseInsensitive) return relativePath;
    return parentRelative ? `${parentRelative}/${exactCaseInsensitive.name}` : exactCaseInsensitive.name;
  }

  private async executeInner(call: ToolCall, decisionId: string): Promise<unknown> {
    switch (call.name) {
      case "read_file":
      case "view_file":
        {
          const parsedArgs =
            call.name === "view_file" ? toolRegistry.view_file.argsSchema.parse(call.args) : toolRegistry.read_file.argsSchema.parse(call.args);
          const args = { ...parsedArgs, path: await this.resolveExistingPathCase(parsedArgs.path) };
          const unboundedRead = call.name === "read_file" && args.startLine === undefined && args.endLine === undefined;
          if (unboundedRead) {
            this.fullReadPaths.add(args.path);
          }
          const absolutePath = normalizeWorkspacePath(this.options.workspaceRoot, args.path);
          const cacheKey = this.makeReadOutputCacheKey(absolutePath, args);
          const beforeReadSnapshot = await this.getFreshnessSnapshot(args.path, absolutePath);
          const cached = this.readOutputCache.get(cacheKey);
          if (
            cached &&
            cached.sha256 !== null &&
            cached.sha256 === beforeReadSnapshot.sha256 &&
            cached.mtimeMs === beforeReadSnapshot.mtimeMs
          ) {
            cached.hits += 1;
            await this.recordReadState(args.path, unboundedRead && !(cached.output as { truncated?: boolean }).truncated);
            const baseOutput = this.withReadCacheNote(cached.output, cached.hits);
            // Non-blocking no-progress advisory: after 5+ identical re-reads
            // of a file the model has not modified, surface a runtime note so
            // the cockpit (and the model) can see the loop. The model is
            // still allowed to re-read — we just inject an advisory into the
            // tool result so the runtime can count it as a no-progress trip.
            const noProgressThreshold = 5;
            if (cached.hits >= noProgressThreshold) {
              const fileTouches = this.fileWriteCounts.get(args.path) ?? 0;
              const note =
                `Read of '${args.path}' returned the cached result (hit #${cached.hits}). ` +
                (fileTouches === 0
                  ? "This file has not been written by any tool in this run; reading it again is unlikely to make progress. Consider writing it instead."
                  : `This file has been written ${fileTouches}× already; the cached content is the current state. Re-reads are a no-progress signal — use replace_in_file or edit_file to make targeted changes instead.`);
              // Non-blocking no-progress advisory: surface a structured
              // `read_loop_advisory` error code so session-metrics can count
              // it as a no_progress_trips without making `ok: false`. The
              // model still receives the cached content (so it isn't
              // blocked from continuing); the engine just sees a count.
              const outputRecord = baseOutput && typeof baseOutput === "object" && !Array.isArray(baseOutput) ? baseOutput : { value: baseOutput };
              return {
                ...outputRecord,
                note,
                error: { code: "read_loop_advisory", message: note },
              };
            }
            return baseOutput;
          }
          const result = await readFileTool(this.options.workspaceRoot, {
            path: args.path,
            ...(args.startLine !== undefined ? { startLine: args.startLine } : {}),
            ...(args.endLine !== undefined ? { endLine: args.endLine } : {}),
          });
          if (unboundedRead && (result as { truncated?: boolean }).truncated) {
            this.fullReadPaths.delete(args.path);
          }
          await this.recordReadState(args.path, unboundedRead && !(result as { truncated?: boolean }).truncated);
          const afterReadSnapshot = await this.getFreshnessSnapshot(args.path, absolutePath);
          if (afterReadSnapshot.sha256 !== null) {
            this.readOutputCache.set(cacheKey, { ...afterReadSnapshot, output: result, hits: 0 });
          }
          return result;
        }
      case "list_directory":
        {
          const args = toolRegistry.list_directory.argsSchema.parse(call.args);
          return listDirectoryTool(this.options.workspaceRoot, {
            path: args.path,
            ...(args.includeHidden !== undefined ? { includeHidden: args.includeHidden } : {}),
          });
        }
      case "grep_search":
        {
          const args = toolRegistry.grep_search.argsSchema.parse(call.args);
          return grepSearchTool(this.options.workspaceRoot, {
            pattern: args.pattern,
            ...(args.path !== undefined ? { path: args.path } : {}),
            ...(args.include !== undefined ? { include: args.include } : {}),
          });
        }
      case "skim_file":
        {
          const args = toolRegistry.skim_file.argsSchema.parse(call.args);
          return skimFileTool(this.options.workspaceRoot, args, {
            enabled: this.config?.pruner.enabled ?? true,
            localOnly: this.config?.pruner.localOnly ?? true,
            ...(this.config?.pruner.url ? { url: this.config.pruner.url } : {}),
            threshold: this.config?.pruner.threshold ?? 0.5,
          });
        }
      case "inspect_environment":
        toolRegistry.inspect_environment.argsSchema.parse(call.args);
        return inspectEnvironmentTool(this.options.workspaceRoot);
      case "create_checkpoint": {
        const args = toolRegistry.create_checkpoint.argsSchema.parse(call.args);
        return createCheckpoint({
          workspaceRoot: this.options.workspaceRoot,
          reason: args.reason,
          ...(args.toolCallIds !== undefined ? { toolCallIds: args.toolCallIds } : {}),
        });
      }
      case "restore_checkpoint": {
        const args = toolRegistry.restore_checkpoint.argsSchema.parse(call.args);
        return restoreCheckpoint(this.options.workspaceRoot, args.checkpointId);
      }
      case "git_status":
        toolRegistry.git_status.argsSchema.parse(call.args);
        return getGitStatusState(this.options.workspaceRoot);
      case "git_diff": {
        const args = toolRegistry.git_diff.argsSchema.parse(call.args);
        const diffState = await getGitDiffState(this.options.workspaceRoot, {
          ...(args.staged !== undefined ? { staged: args.staged } : {}),
          ...(args.path !== undefined ? { path: args.path } : {}),
          ...(args.maxBytes !== undefined ? { maxBytes: args.maxBytes } : {}),
        });
        return {
          ...diffState,
          summary: summarizeGitDiffState(diffState),
        };
      }
      case "web_search":
        return webSearchTool(toolRegistry.web_search.argsSchema.parse(call.args) as WebSearchArgs);
      case "activate_skill": {
        const activateArgs = toolRegistry.activate_skill.argsSchema.parse(call.args);
        // PreSkillInvoke hook envelope.
        const hooksForSkill = this.options.hooks;
        if (hooksForSkill) {
          const pre = await hooksForSkill.emit({
            name: "PreSkillInvoke",
            payload: { skillName: activateArgs.name },
            blockable: true,
          });
          if (!pre.allow) {
            return `<activated_skill status="blocked" reason="${(pre.reason ?? pre.message ?? "blocked by hook").replace(/"/g, "&quot;")}" />`;
          }
        }
        const skillResult = await activateSkillTool(this.options.workspaceRoot, activateArgs);
        if (hooksForSkill) {
          await hooksForSkill.emit({
            name: "PostSkillInvoke",
            payload: { skillName: activateArgs.name },
            blockable: false,
          });
        }
        return skillResult;
      }
      case "get_tool_output":
        return getToolOutputTool(this.artifactStore, toolRegistry.get_tool_output.argsSchema.parse(call.args));
      case "read_background_output": {
        const args = toolRegistry.read_background_output.argsSchema.parse(call.args);
        const entry = this.backgroundProcessManager.get(args.pid);
        if (!entry) {
          throw new Error(`No background process found with PID ${args.pid}`);
        }

        const pollInterval = 100;
        const timeout = 10000;
        const startWait = Date.now();

        const minWaitMs = args.minWaitMs;
        if (typeof minWaitMs === "number") {
          await new Promise((resolve) => setTimeout(resolve, Math.min(minWaitMs, timeout)));
        }

        if (args.waitForMatch) {
          while (Date.now() - startWait < timeout) {
            const currentOutput = entry.output.join("\n");
            if (currentOutput.includes(args.waitForMatch)) {
              break;
            }
            if (entry.child.exitCode !== null) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, pollInterval));
          }
        }

        const lines = args.lines ?? 100;
        return {
          pid: args.pid,
          status: entry.child.exitCode === null ? "running" : "finished",
          exitCode: entry.child.exitCode,
          logPath: entry.logPath,
          output: this.backgroundProcessManager.recentOutput(args.pid, lines),
        };
      }
      case "signal_process": {
        const args = toolRegistry.signal_process.argsSchema.parse(call.args);
        const entry = this.backgroundProcessManager.get(args.pid);
        if (!entry) {
          throw new Error(`No background process found with PID ${args.pid}`);
        }
        try {
          await this.backgroundProcessManager.killTree(args.pid, args.signal);
          if (args.signal === "SIGTERM" || args.signal === "SIGKILL") {
            await this.backgroundProcessManager.waitForExit(
              entry.child,
              args.signal === "SIGTERM" ? 1500 : 500,
            );
            if (entry.child.exitCode !== null || args.signal === "SIGKILL") {
              this.backgroundProcessManager.delete(args.pid);
            }
          }
          await this.persistProcessManifest();
        } catch (error) {
          throw error;
        }
        return { pid: args.pid, signal: args.signal, success: true };
      }
      case "write_to_process": {
        const args = toolRegistry.write_to_process.argsSchema.parse(call.args);
        const entry = this.backgroundProcessManager.get(args.pid);
        if (!entry) {
          throw new Error(`No background process found with PID ${args.pid}`);
        }
        if (!entry.child.stdin) {
          throw new Error(`Process with PID ${args.pid} does not have an open stdin.`);
        }
        entry.child.stdin.write(args.input);
        return { pid: args.pid, success: true };
      }
      case "write_file":
        {
          const args = toolRegistry.write_file.argsSchema.parse(call.args);
          assertCompleteSourceWrite(args.path, args.content);
          await this.assertSafeFullFileOverwrite(args.path, args.content);
          await this.assertEditorGuard(args.path, args.content, "write_file");
          await this.snapshotBeforeMutation(args.path, "write_file");
          this.fileWriteCounts.set(args.path, (this.fileWriteCounts.get(args.path) ?? 0) + 1);
          return writeFileTool(this.options.workspaceRoot, args);
        }
      case "replace_in_file":
        {
          const parsedArgs = toolRegistry.replace_in_file.argsSchema.parse(call.args);
          const args = { ...parsedArgs, path: await this.resolveExistingPathCase(parsedArgs.path) } as typeof parsedArgs;
          await this.assertSafeEditGuard(args.path, args);
          await this.assertEditorGuard(args.path, await this.buildReplaceCandidateContent(args), "replace_in_file");
          await this.snapshotBeforeMutation(args.path, "replace_in_file");
          this.fileWriteCounts.set(args.path, (this.fileWriteCounts.get(args.path) ?? 0) + 1);
          return replaceInFileTool(this.options.workspaceRoot, args);
        }
      case "edit_file":
        {
          const parsedArgs = toolRegistry.edit_file.argsSchema.parse(call.args);
          const args = { ...parsedArgs, path: await this.resolveExistingPathCase(parsedArgs.path) };
          await this.assertSafeEditGuard(args.path, args);
          await this.assertEditorGuard(args.path, await this.buildEditCandidateContent(args), "edit_file");
          await this.snapshotBeforeMutation(args.path, "edit_file");
          this.fileWriteCounts.set(args.path, (this.fileWriteCounts.get(args.path) ?? 0) + 1);
          return editFileTool(this.options.workspaceRoot, args);
        }
      case "replace_symbol":
        {
          const parsedArgs = toolRegistry.replace_symbol.argsSchema.parse(call.args);
          const args = { ...parsedArgs, path: await this.resolveExistingPathCase(parsedArgs.path) };
          await this.snapshotBeforeMutation(args.path, "replace_symbol");
          this.fileWriteCounts.set(args.path, (this.fileWriteCounts.get(args.path) ?? 0) + 1);
          return replaceSymbolTool(this.options.workspaceRoot, args);
        }
      case "delete_file":
        {
          const parsedArgs = toolRegistry.delete_file.argsSchema.parse(call.args);
          const args = { ...parsedArgs, path: await this.resolveExistingPathCase(parsedArgs.path) };
          await this.snapshotBeforeMutation(args.path, "delete_file");
          this.fileWriteCounts.set(args.path, (this.fileWriteCounts.get(args.path) ?? 0) + 1);
          return deleteFileTool(this.options.workspaceRoot, args);
        }
      case "bash": {
        const args = toolRegistry.bash.argsSchema.parse(call.args) as {
          cmd: string;
          command?: string;
          description?: string;
          summary?: string;
          timeoutMs?: number;
          timeout?: number;
          idleTimeoutMs?: number;
          isBackground?: boolean;
          run_in_background?: boolean;
        };
        const effectiveCommand = (args.command || args.cmd).trim();
        const effectiveDescription = args.description ?? args.summary;
        const effectiveTimeoutMs = args.timeoutMs ?? args.timeout;
        const effectiveIsBackground = args.isBackground ?? args.run_in_background ?? false;

        if (this.options.shellRunner && hasSandboxServiceContext() && isDockerCliCommand(effectiveCommand)) {
          throw new Error(
            "docker is not available inside this task sandbox. Use sandbox_service_control instead: action=list for services, logs/snapshot to inspect, exec/write_file/copy_to_service to repair /app, and restart/start to apply the change.",
          );
        }
        const localRules = await loadLocalRules(this.options.workspaceRoot);
        if (localRules && localRules.hash !== this.localRulesHash) {
          this.localRulesHash = localRules.hash;
          await this.auditLogger.write({
            event_id: randomUUID(),
            run_id: this.options.runId,
            session_id: this.options.sessionId,
            trace_id: this.options.traceId,
            timestamp: new Date().toISOString(),
            log_schema_version: 1,
            kind: "rules_change",
            severity: "warn",
            message: `Loaded rules.local.md with hash ${localRules.hash}`,
          });
        }

        const bashInput = {
          command: effectiveCommand,
          ...(effectiveDescription ? { description: effectiveDescription } : {}),
          ...(effectiveTimeoutMs !== undefined ? { timeout: effectiveTimeoutMs } : {}),
          ...(effectiveIsBackground ? { run_in_background: true } : {}),
        };

        const decision = evaluateCommandPolicy(effectiveCommand, this.options.safetyProfile, localRules ? { localRules } : undefined);

        if (decision.outcome === "would_block") {
          await this.auditLogger.write({
            event_id: randomUUID(),
            run_id: this.options.runId,
            session_id: this.options.sessionId,
            trace_id: this.options.traceId,
            timestamp: new Date().toISOString(),
            log_schema_version: 1,
            kind: "policy_block",
            severity: "warn",
            rule_id: decision.ruleId,
            would_block: true,
            message: decision.message,
          });

          await this.trajectoryLogger.write({
            event_id: randomUUID(),
            run_id: this.options.runId,
            session_id: this.options.sessionId,
            trace_id: this.options.traceId,
            timestamp: new Date().toISOString(),
            log_schema_version: 1,
            kind: "policy_decision",
            level: this.options.logLevel,
            decision_id: decisionId,
            policy_id: decision.ruleId,
            outcome: "allow",
          });
        }

        const bashCtx = {
          workspaceRoot: this.options.workspaceRoot,
          workingDirectory: this.currentWorkingDirectory,
          safetyProfile: this.options.safetyProfile,
          ruleContext: localRules ? { localRules } : undefined,
          runtime: {
            runId: this.options.runId,
            artifactDir: this.options.artifactsDir ?? path.join(getReaperScratchpadPaths(this.options.workspaceRoot).runs, this.options.runId, "artifacts"),
            toolCallId: call.id,
          },
        };

        if (this.options.shellRunner && isHostOnlyReaperArtifactInspectionCommand(effectiveCommand, this.options.workspaceRoot)) {
          return executeBashCommand(bashInput, bashCtx);
        }

        const runBash = async (workspaceRoot: string, workingDirectory: string, command: string) => {
          const viewInput = {
            ...bashInput,
            command,
          };
          const viewCtx = {
            ...bashCtx,
            workspaceRoot,
            workingDirectory,
          };
          return executeBashCommand(viewInput, viewCtx);
        };

        if (!this.recoverySession || classifyToolCall(call) !== "shell_non_barrier" || !this.recoverySession.hasPendingWrites()) {
          const result = this.options.shellRunner
            ? await (async () => {
                const shellArgs = {
                  cmd: effectiveCommand,
                  ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {}),
                  ...(effectiveIsBackground ? { isBackground: true } : {}),
                };
                const raw = await this.options.shellRunner!(this.options.workspaceRoot, shellArgs, this.currentWorkingDirectory, bashCtx.runtime);
                if ((raw as { child?: unknown; status?: unknown }).status === "running") {
                  return raw as unknown as BashExecutionResult;
                }
                const fg = raw as unknown as { stdout: string; stderr: string; exitCode: number | null; nextCwd?: string; logPath?: string };
                return {
                  stdout: fg.stdout,
                  stderr: fg.stderr,
                  exit_code: fg.exitCode,
                  interrupted: false,
                  ...(fg.logPath ? { background_task_id: fg.logPath } : {}),
                } as BashExecutionResult;
              })()
            : await runBash(this.options.workspaceRoot, this.currentWorkingDirectory, effectiveCommand);

          if (isBackgroundBashResult(result)) {
            const entry: ManagedBackgroundProcess = {
              child: result.__backgroundChild!,
              output: result.stdout ? [result.stdout] : [],
              ...(typeof result.background_task_id === "string" ? { logPath: result.background_task_id } : {}),
              startedAt: new Date().toISOString(),
              startedAtMs: Date.now(),
              cmd: effectiveCommand,
              cwd: this.currentWorkingDirectory,
              notified: false,
            };
            this.backgroundProcessManager.register(entry);
            await this.persistProcessManifest();
            return { pid: result.pid!, status: "running", logPath: entry.logPath };
          }

          const rendered = await bashCommandToModelOutput(bashInput, result, this.options.workspaceRoot);
          const asForeground = toForegroundShellResult({
            ...result,
            stdout: rendered.content,
            stderr: "",
          });
          return spillLargeToolResult(asForeground, call, this.options.workspaceRoot);
        }

        const view = await this.recoverySession.createNonBarrierCommandView();
        try {
          const result = await runBash(view.path, view.path, rewriteWorkspaceRootInShellCommand(effectiveCommand, this.options.workspaceRoot, view.path));

          if (isBackgroundBashResult(result)) {
            const entry: ManagedBackgroundProcess = {
              child: result.__backgroundChild!,
              output: result.stdout ? [result.stdout] : [],
              ...(typeof result.background_task_id === "string" ? { logPath: result.background_task_id } : {}),
              startedAt: new Date().toISOString(),
              startedAtMs: Date.now(),
              cmd: effectiveCommand,
              cwd: view.path,
              notified: false,
            };
            this.backgroundProcessManager.register(entry);
            await this.persistProcessManifest();
            return { pid: result.pid!, status: "running", logPath: entry.logPath };
          }

          const rendered = await bashCommandToModelOutput(bashInput, result, this.options.workspaceRoot);
          const asForeground = toForegroundShellResult({
            ...result,
            stdout: rendered.content,
            stderr: "",
          });
          return spillLargeToolResult(asForeground, call, this.options.workspaceRoot);
        } finally {
          await view.cleanup();
        }
      }
      case "sandbox_service_control": {
        const args = toolRegistry.sandbox_service_control.argsSchema.parse(call.args) as SandboxServiceControlArgs;
        return this.executeSandboxServiceControl(args, call.id);
      }
      case "browser_control": {
        const args = toolRegistry.browser_control.argsSchema.parse(call.args);
        return this.getComputerBrowserController().browserControl(args, this.toolRuntimeMetadata(call.id));
      }
      case "computer_control": {
        const args = toolRegistry.computer_control.argsSchema.parse(call.args);
        return this.getComputerBrowserController().computerControl(args, this.toolRuntimeMetadata(call.id));
      }
      case "mouse_move":
      case "mouse_click":
      case "mouse_scroll":
      case "keyboard_type":
      case "keyboard_press":
      case "screenshot":
      case "get_screen_size":
      case "get_mouse_position":
      case "wait":
      case "start_live_view":
      case "stop_live_view":
      case "request_human_approval":
      case "is_human_intervening": {
        const args = toolRegistry[call.name].argsSchema.parse(call.args) as Record<string, unknown>;
        return this.getNativeComputerController().execute(call.name as NativeComputerToolName, args, this.toolRuntimeMetadata(call.id));
      }
      case "web_fetch": {
        const fetchArgs = toolRegistry.web_fetch.argsSchema.parse(call.args);
        return webFetchTool({ url: fetchArgs.url, ...(fetchArgs.extractText !== undefined ? { extractText: fetchArgs.extractText } : {}) });
      }
      case "task_create": {
        const createArgs = toolRegistry.task_create.argsSchema.parse(call.args);
        return createTask({ subject: createArgs.subject, description: createArgs.description, status: createArgs.status ?? "pending" }, this.options.runId);
      }
      case "task_update": {
        const updateArgs = toolRegistry.task_update.argsSchema.parse(call.args);
        const updated = updateTask({
          taskId: updateArgs.taskId,
          ...(updateArgs.status !== undefined ? { status: updateArgs.status as "pending" | "in_progress" | "completed" } : {}),
          ...(updateArgs.subject !== undefined ? { subject: updateArgs.subject } : {}),
          ...(updateArgs.description !== undefined ? { description: updateArgs.description } : {}),
        }, this.options.runId);
        if (!updated) throw new Error(`Task '${updateArgs.taskId}' not found`);
        return updated;
      }
      case "task_list": {
        const listArgs = toolRegistry.task_list.argsSchema.parse(call.args);
        return listTasks(listArgs.status, this.options.runId);
      }
      case "search_tools": {
        const searchArgs = toolRegistry.search_tools.argsSchema.parse(call.args);
        return executeSearchTools(searchArgs.query, this.options.runId);
      }
      case "call_subagent": {
        if (!this.options.modelGateway) {
          throw new Error("call_subagent is not configured for this run because no modelGateway was provided.");
        }
        const args = toolRegistry.call_subagent.argsSchema.parse(call.args);
        const result = await executeSubagentTool(args, {
          modelGateway: this.options.modelGateway,
          toolCallId: call.id,
          pool: this.options.subagentPool,
        });
        if (!result.ok) {
          const error = new Error(result.error?.message ?? "call_subagent failed") as Error & { code?: string };
          error.code = result.error?.code ?? "subagent_failed";
          throw error;
        }
        return result.output;
      }
      case "poll_subagent": {
        const args = toolRegistry.poll_subagent.argsSchema.parse(call.args);
        const result = executePollSubagentTool(args, call.id);
        if (!result.ok) {
          const error = new Error(result.error?.message ?? "poll_subagent failed") as Error & { code?: string };
          error.code = result.error?.code ?? "poll_subagent_failed";
          throw error;
        }
        return result.output;
      }
      case "cancel_subagent": {
        const args = toolRegistry.cancel_subagent.argsSchema.parse(call.args);
        const result = executeCancelSubagentTool(args, {toolCallId: call.id, pool: this.options.subagentPool});
        if (!result.ok) {
          const error = new Error(result.error?.message ?? "cancel_subagent failed") as Error & { code?: string };
          error.code = result.error?.code ?? "cancel_subagent_failed";
          throw error;
        }
        return result.output;
      }
      case "agent": {
        // Model-driven subagent delegation.
        if (!this.subagentHost) {
          throw new Error(
            "Agent tool is not configured for this run. The runtime needs a SubagentHost (LaborMarket + SubagentStore + model call) to dispatch subagents. " +
            "Pass `subagentHost` to the ToolExecutor constructor to enable the Agent and AgentSwarm tools.",
          );
        }
        const agentArgs = toolRegistry.agent.argsSchema.parse(call.args) as {
          description: string;
          prompt: string;
          subagent_type?: string;
          model?: string | null;
          resume?: string | null;
          run_in_background?: boolean;
          timeout?: number | null;
        };
        return this.subagentHost.invokeAgent({
          description: agentArgs.description,
          prompt: agentArgs.prompt,
          subagentType: agentArgs.subagent_type ?? "coder",
          model: agentArgs.model ?? null,
          resume: agentArgs.resume ?? null,
          runInBackground: agentArgs.run_in_background ?? false,
          timeout: agentArgs.timeout ?? null,
        });
      }
      case "agent_swarm": {
        // Model-driven parallel fan-out.
        if (!this.subagentHost) {
          throw new Error(
            "AgentSwarm tool is not configured for this run. The runtime needs a SubagentHost (LaborMarket + SubagentStore + model call) to dispatch swarms. " +
            "Pass `subagentHost` to the ToolExecutor constructor to enable the Agent and AgentSwarm tools.",
          );
        }
        const swarmArgs = toolRegistry.agent_swarm.argsSchema.parse(call.args) as {
          description: string;
          subagent_type?: string;
          prompt_template: string;
          items: string[];
          model?: string | null;
          timeout?: number | null;
          max_concurrency?: number;
        };
        return this.subagentHost.invokeAgentSwarm({
          description: swarmArgs.description,
          subagentType: swarmArgs.subagent_type ?? "coder",
          promptTemplate: swarmArgs.prompt_template,
          items: swarmArgs.items,
          model: swarmArgs.model ?? null,
          timeout: swarmArgs.timeout ?? null,
          maxConcurrency: swarmArgs.max_concurrency,
        });
      }
      /* ----------------------------------------------------------------
       * Authoring tools — 5 skill + 6 extension + 6 hook = 17 new tools.
       * Each routes through the runtime-injected authoringTools backdoor.
       * The wiring layer (engine.ts) supplies handlers that call into
       * the existing lifecycle classes; this switch stays thin so
       * the executor doesn't need to know about lifecycle internals.
       * ---------------------------------------------------------------- */
      case "create_skill": {
        const h = this.options.authoringTools?.handleCreateSkill;
        if (!h) throw new Error("create_skill is not wired for this run (no authoringTools backdoor)");
        return await h(call.args);
      }
      case "test_skill": {
        const h = this.options.authoringTools?.handleTestSkill;
        if (!h) throw new Error("test_skill is not wired for this run");
        return await h(call.args);
      }
      case "approve_skill": {
        const h = this.options.authoringTools?.handleApproveSkill;
        if (!h) throw new Error("approve_skill is not wired for this run");
        return await h(call.args);
      }
      case "uninstall_skill": {
        const h = this.options.authoringTools?.handleUninstallSkill;
        if (!h) throw new Error("uninstall_skill is not wired for this run");
        return await h(call.args);
      }
      case "reload_skills": {
        const h = this.options.authoringTools?.handleReloadSkills;
        if (!h) throw new Error("reload_skills is not wired for this run");
        return h(call.args);
      }
      case "create_extension": {
        const h = this.options.authoringTools?.handleCreateExtension;
        if (!h) throw new Error("create_extension is not wired for this run");
        return await h(call.args);
      }
      case "validate_extension": {
        const h = this.options.authoringTools?.handleValidateExtension;
        if (!h) throw new Error("validate_extension is not wired for this run");
        return await h(call.args);
      }
      case "enable_extension": {
        const h = this.options.authoringTools?.handleEnableExtension;
        if (!h) throw new Error("enable_extension is not wired for this run");
        return await h(call.args);
      }
      case "trust_extension": {
        const h = this.options.authoringTools?.handleTrustExtension;
        if (!h) throw new Error("trust_extension is not wired for this run");
        return await h(call.args);
      }
      case "uninstall_extension": {
        const h = this.options.authoringTools?.handleUninstallExtension;
        if (!h) throw new Error("uninstall_extension is not wired for this run");
        return await h(call.args);
      }
      case "reload_extensions": {
        const h = this.options.authoringTools?.handleReloadExtensions;
        if (!h) throw new Error("reload_extensions is not wired for this run");
        return h(call.args);
      }
      case "create_hook": {
        const h = this.options.authoringTools?.handleCreateHook;
        if (!h) throw new Error("create_hook is not wired for this run");
        return await h(call.args);
      }
      case "list_hooks": {
        const h = this.options.authoringTools?.handleListHooks;
        if (!h) throw new Error("list_hooks is not wired for this run");
        return h(call.args);
      }
      case "update_hook": {
        const h = this.options.authoringTools?.handleUpdateHook;
        if (!h) throw new Error("update_hook is not wired for this run");
        return await h(call.args);
      }
      case "approve_hook": {
        const h = this.options.authoringTools?.handleApproveHook;
        if (!h) throw new Error("approve_hook is not wired for this run");
        return await h(call.args);
      }
      case "uninstall_hook": {
        const h = this.options.authoringTools?.handleUninstallHook;
        if (!h) throw new Error("uninstall_hook is not wired for this run");
        return await h(call.args);
      }
      case "reload_hooks": {
        const h = this.options.authoringTools?.handleReloadHooks;
        if (!h) throw new Error("reload_hooks is not wired for this run");
        return h(call.args);
      }
      default: {
        // MCP tool dispatch fallback
        if (this.mcpRegistry && this.mcpRegistry.isMcpTool(call.name)) {
          const argsRecord = (call.args ?? {}) as Record<string, unknown>;
          const output = await this.mcpRegistry.executeMcpTool(call.name, argsRecord);
          this.mcpRegistry.markUsed(call.name);
          return output;
        }
        throw new Error(`Unknown tool: ${call.name}`);
      }
    }
  }

  private async executeSandboxServiceControl(args: SandboxServiceControlArgs, toolCallId: string): Promise<unknown> {
    if (args.action === "list") {
      const project = await this.resolveSandboxComposeProject();
      const services = await this.listSandboxServices(project);
      return { project, services };
    }

    const project = await this.resolveSandboxComposeProject();
    const service = await this.resolveSandboxServiceName(project, args.service);
    switch (args.action) {
      case "logs": {
        const tail = String(args.tail ?? 120);
        const logs = await this.dockerOutput(["logs", "--tail", tail, service], args.timeoutMs ?? 10_000, 2 * 1024 * 1024, {
          allowNonZero: true,
        });
        return { service, stdout: logs.stdout, stderr: logs.stderr, exitCode: logs.exitCode };
      }
      case "snapshot": {
        return this.snapshotSandboxService(service);
      }
      case "inspect_image": {
        return this.inspectSandboxServiceImage(service);
      }
      case "restore_from_image": {
        const targetPath = requireServiceAppPath(args.targetPath, "restore_from_image");
        return this.restoreSandboxServiceFileFromImage(service, targetPath);
      }
      case "exec": {
        if (!args.command?.trim()) throw new Error("sandbox_service_control exec requires command");
        const result = await this.dockerOutput(["exec", service, "bash", "-lc", args.command], args.timeoutMs ?? 120_000, 5 * 1024 * 1024, {
          allowNonZero: true,
        });
        if (isStoppedContainerExecResult(result) && isReadOnlyInspectionShellCommand(args.command)) {
          const snapshot = await this.snapshotSandboxService(service);
          const fallback = await this.runReadOnlySandboxSnapshotCommand(args.command, snapshot.path, args.timeoutMs ?? 30_000);
          return {
            service,
            stdout: fallback.stdout,
            stderr: [result.stderr.trim(), fallback.stderr.trim()].filter(Boolean).join("\n"),
            exitCode: fallback.exitCode,
            fallback: "stopped_container_snapshot",
            snapshotPath: snapshot.path,
            inventory: snapshot.inventory,
          };
        }
        return { service, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      }
      case "write_file": {
        if (args.content === undefined) throw new Error("sandbox_service_control write_file requires content");
        const targetPath = requireServiceAppPath(args.targetPath, "write_file");
        await this.assertServicePathIsNotImageProvided(service, targetPath);
        await this.writeFileIntoSandboxService(service, targetPath, args.content, toolCallId);
        return { service, targetPath, bytesWritten: Buffer.byteLength(args.content, "utf8") };
      }
      case "copy_to_service": {
        if (!args.sourcePath?.trim()) throw new Error("sandbox_service_control copy_to_service requires sourcePath");
        const targetPath = requireServiceAppPath(args.targetPath, "copy_to_service");
        await this.assertServicePathIsNotImageProvided(service, targetPath);
        const copiedFrom = await this.copyWorkspacePathIntoSandboxService(service, args.sourcePath, targetPath, toolCallId);
        return { service, sourcePath: copiedFrom, targetPath };
      }
      case "restart":
      case "start":
      case "stop": {
        if (args.action !== "stop") this.assertServiceRecoveryAttemptAllowed(service, args.action);
        const result = await this.dockerOutput([args.action, service], args.timeoutMs ?? 60_000, 1024 * 1024, { allowNonZero: true });
        if (args.action === "start" || args.action === "restart") {
          const ready = await this.waitForSandboxServiceReady(service, args.command, args.timeoutMs, args.intervalMs);
          return { service, action: args.action, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, ...asRecord(ready) };
        }
        const state = await this.inspectSandboxServiceState(service).catch(() => undefined);
        return {
          service,
          action: args.action,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          ...(state ?? {}),
          lifecycle: state ? classifyServiceLifecycle(state) : "absent",
        };
      }
      case "recreate": {
        this.assertServiceRecoveryAttemptAllowed(service, args.action);
        const recreatedService = await this.recreateSandboxService(project, service, args.timeoutMs);
        const ready = await this.waitForSandboxServiceReady(recreatedService, args.command, args.timeoutMs, args.intervalMs);
        return { service: recreatedService, action: args.action, ...asRecord(ready) };
      }
      case "wait_ready": {
        return this.waitForSandboxServiceReady(service, args.command, args.timeoutMs, args.intervalMs);
      }
      default:
        assertNever(args.action);
    }
  }

  private async resolveSandboxComposeProject(): Promise<string> {
    const explicit = process.env.REAPER_TBENCH_COMPOSE_PROJECT?.trim();
    if (explicit) return explicit;
    const containerName = process.env.REAPER_TBENCH_CONTAINER_NAME?.trim();
    if (!containerName) {
      throw new Error("sandbox_service_control is unavailable: no sandbox container context is configured.");
    }
    const result = await this.dockerOutput(
      ["inspect", "--format", "{{ index .Config.Labels \"com.docker.compose.project\" }}", containerName],
      5_000,
      256 * 1024,
    );
    const project = result.stdout.trim();
    if (!project || project === "<no value>") {
      throw new Error(`sandbox_service_control could not determine compose project for container '${containerName}'.`);
    }
    process.env.REAPER_TBENCH_COMPOSE_PROJECT = project;
    return project;
  }

  private async listSandboxServices(project: string): Promise<Array<{ name: string; status: string; image: string; role: "client" | "service"; provenance: "task_client" | "provided_dependency"; lifecycle: ServiceLifecycleState }>> {
    const result = await this.dockerOutput(
      [
        "ps",
        "-a",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--format",
        "{{.Names}}\t{{.Status}}\t{{.Image}}",
      ],
      5_000,
      1024 * 1024,
    );
    const client = process.env.REAPER_TBENCH_CONTAINER_NAME?.trim();
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name = "", status = "", image = ""] = line.split("\t");
        return {
          name,
          status,
          image,
          role: name === client ? ("client" as const) : ("service" as const),
          provenance: name === client ? ("task_client" as const) : ("provided_dependency" as const),
          lifecycle: classifyServiceLifecycle({ status, exists: true }),
        };
      })
      .filter((item) => item.name);
  }

  private async resolveSandboxServiceName(project: string, requested?: string): Promise<string> {
    const services = await this.listSandboxServices(project);
    const selected = selectSandboxServiceName(services, requested);
    if (selected) return selected;
    const siblings = services.filter((service) => service.role === "service");
    throw new Error(
      requested?.trim()
        ? `No unique sibling sandbox service matches '${requested}'. Available services: ${services.map((service) => `${service.name} (${service.status})`).join(", ")}`
        : `sandbox_service_control requires service because ${siblings.length} sibling services are available: ${siblings
            .map((service) => `${service.name} (${service.status})`)
            .join(", ")}`,
    );
  }

  private async inspectSandboxServiceStatus(service: string): Promise<string> {
    const result = await this.dockerOutput(
      ["inspect", "--format", "{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}}", service],
      5_000,
      256 * 1024,
    );
    return result.stdout.trim();
  }

  private async recreateSandboxService(project: string, service: string, timeoutMs?: number): Promise<string> {
    const result = await this.dockerOutput(
      [
        "inspect",
        "--format",
        "{{json .Config.Labels}}",
        service,
      ],
      5_000,
      512 * 1024,
    );
    const labels = JSON.parse(result.stdout.trim()) as Record<string, string | undefined>;
    const composeService = labels["com.docker.compose.service"]?.trim();
    const workingDir = labels["com.docker.compose.project.working_dir"]?.trim();
    const configFiles = labels["com.docker.compose.project.config_files"]
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!composeService || !workingDir || !configFiles?.length) {
      throw new Error(
        `Cannot recreate service '${service}' because its Docker Compose provenance labels are incomplete. ` +
          "Use logs/snapshot and repair the service without recreation.",
      );
    }
    const composeArgs = ["compose", "-p", project, "--project-directory", workingDir];
    for (const configFile of configFiles) composeArgs.push("-f", configFile);
    composeArgs.push("up", "-d", "--force-recreate", "--no-deps", composeService);
    await this.dockerOutput(composeArgs, timeoutMs ?? 120_000, 5 * 1024 * 1024);
    return this.resolveSandboxServiceName(project, composeService);
  }

  private async inspectSandboxServiceState(service: string): Promise<{ status: string; health: string; exitCode: number; error: string }> {
    const result = await this.dockerOutput(
      ["inspect", "--format", "{{json .State}}", service],
      5_000,
      512 * 1024,
    );
    const state = JSON.parse(result.stdout.trim()) as {
      Status?: string;
      ExitCode?: number;
      Error?: string;
      Health?: { Status?: string };
    };
    return {
      status: state.Status ?? "unknown",
      health: state.Health?.Status ?? "none",
      exitCode: state.ExitCode ?? 0,
      error: state.Error ?? "",
    };
  }

  private async waitForSandboxServiceReady(
    service: string,
    probeCommand?: string,
    timeoutMs?: number,
    intervalMs?: number,
  ): Promise<unknown> {
    if (this.config?.runtime.serviceSupervisor.enabled === false) {
      throw new Error("Service readiness supervision is disabled by runtime.serviceSupervisor.enabled=false");
    }
    const timeout = timeoutMs ?? this.config?.runtime.serviceSupervisor.readinessTimeoutMs ?? 30_000;
    const interval = Math.max(100, intervalMs ?? 500);
    const deadline = Date.now() + timeout;
    let attempts = 0;
    let lastProbe = "";
    let lastAutoRecovery = "";
    let lastState = await this.inspectSandboxServiceState(service);
    const stableForMs = this.config?.runtime.serviceSupervisor.minimumStableMs ?? 1_500;
    let runningSince: number | undefined;
    while (Date.now() <= deadline) {
      attempts += 1;
      lastState = await this.inspectSandboxServiceState(service);
      const lifecycle = classifyServiceLifecycle(lastState);
      if (lastState.status === "running") runningSince ??= Date.now();
      else runningSince = undefined;
      if (lifecycle === "crashed" || lifecycle === "unhealthy") {
        const logs = await this.dockerOutput(["logs", "--tail", "120", service], 10_000, 2 * 1024 * 1024, { allowNonZero: true });
        const recovery = await this.tryAutomaticSandboxServiceRecovery(
          service,
          lifecycle,
          [logs.stdout, logs.stderr].filter(Boolean).join("\n"),
          timeout,
        );
        if (recovery) {
          lastAutoRecovery = recovery;
          await new Promise((resolve) => setTimeout(resolve, interval));
          continue;
        }
        throw new Error(
          `Service '${service}' readiness failed: lifecycle=${lifecycle}, status=${lastState.status}, health=${lastState.health}, exit=${lastState.exitCode}. ` +
            `${lastAutoRecovery ? `Automatic recovery already attempted: ${lastAutoRecovery}. ` : ""}` +
            `Recent logs:\n${[logs.stdout, logs.stderr].filter(Boolean).join("\n").slice(-8000)}`,
        );
      }
      if (lifecycle === "configured" || lifecycle === "stopped") {
        const recovery = await this.tryAutomaticSandboxServiceRecovery(service, lifecycle, "", timeout);
        if (recovery) {
          lastAutoRecovery = recovery;
          await new Promise((resolve) => setTimeout(resolve, interval));
          continue;
        }
      }
      if (probeCommand?.trim()) {
        const probeContainer = process.env.REAPER_TBENCH_CONTAINER_NAME?.trim() || service;
        const probe = await this.dockerOutput(["exec", probeContainer, "bash", "-lc", probeCommand], Math.min(interval * 2, 10_000), 1024 * 1024, {
          allowNonZero: true,
        });
        lastProbe = [probe.stdout, probe.stderr].filter(Boolean).join("\n").slice(-4000);
        if (probe.exitCode === 0) {
          return {
            service,
            lifecycle: "ready",
            status: lastState.status,
            health: lastState.health,
            probeCommand,
            probeFrom: probeContainer,
            attempts,
            elapsedMs: timeout - Math.max(0, deadline - Date.now()),
            output: lastProbe,
            ...(lastAutoRecovery ? { autoRecovery: lastAutoRecovery } : {}),
          };
        }
      } else if (
        lastState.status === "running" &&
        (lastState.health === "healthy" || (lastState.health === "none" && runningSince !== undefined && Date.now() - runningSince >= stableForMs))
      ) {
        return {
          service,
          lifecycle: "ready",
          status: lastState.status,
          health: lastState.health,
          attempts,
          elapsedMs: timeout - Math.max(0, deadline - Date.now()),
          ...(lastAutoRecovery ? { autoRecovery: lastAutoRecovery } : {}),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    const logs = await this.dockerOutput(["logs", "--tail", "120", service], 10_000, 2 * 1024 * 1024, { allowNonZero: true });
    throw new Error(
      `Service '${service}' did not become ready within ${timeout}ms after ${attempts} probe(s). ` +
        `Last state: status=${lastState.status}, health=${lastState.health}, lifecycle=${classifyServiceLifecycle(lastState)}. ` +
        `${lastAutoRecovery ? `Automatic recovery attempted: ${lastAutoRecovery}. ` : ""}` +
        `${lastProbe ? `Last probe output:\n${lastProbe}\n` : ""}Recent logs:\n${[logs.stdout, logs.stderr].filter(Boolean).join("\n").slice(-8000)}`,
    );
  }

  private async tryAutomaticSandboxServiceRecovery(
    service: string,
    lifecycle: ServiceLifecycleState,
    logs: string,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const supervisor = this.config?.runtime.serviceSupervisor;
    if (supervisor?.enabled === false || supervisor?.autoRecover === false) return undefined;
    const limit = supervisor?.maxAutoRecoveriesPerService ?? 1;
    const count = this.serviceAutoRecoveryCounts.get(service) ?? 0;
    if (count >= limit) return undefined;

    let action: "start" | "restart" | "recreate" | undefined;
    if (lifecycle === "configured" || lifecycle === "stopped") {
      action = "start";
    } else if (lifecycle === "crashed" && isConclusiveServiceMountOrEntrypointFailure(logs)) {
      action = "recreate";
    } else if (lifecycle === "crashed" || lifecycle === "unhealthy") {
      action = "restart";
    }
    if (!action) return undefined;

    this.assertServiceRecoveryAttemptAllowed(service, action);
    this.serviceAutoRecoveryCounts.set(service, count + 1);
    if (action === "recreate") {
      const project = await this.resolveSandboxComposeProject();
      await this.recreateSandboxService(project, service, Math.min(timeoutMs, 120_000));
    } else {
      await this.dockerOutput([action, service], Math.min(timeoutMs, 60_000), 1024 * 1024, { allowNonZero: true });
    }
    return `${action} ${count + 1}/${limit} after lifecycle=${lifecycle}`;
  }

  private async snapshotSandboxService(service: string): Promise<{ service: string; path: string; inventory: string }> {
    const safeName = sanitizeSandboxServiceName(service);
    const appRoot = path.join(this.options.workspaceRoot, ".reaper", "sandbox-services", safeName, "app");
    await rm(appRoot, { recursive: true, force: true });
    await mkdir(appRoot, { recursive: true });
    await this.dockerOutput(["cp", `${service}:/app/.`, appRoot], 15_000, 1024 * 1024);
    const inventory = await this.buildSandboxSnapshotInventory(appRoot);
    return { service, path: appRoot, inventory };
  }

  private async inspectSandboxServiceImage(service: string): Promise<{
    service: string;
    provenance: "provided_dependency";
    mountedPath: string;
    imagePath: string;
    mountedInventory: string;
    imageInventory: string;
    pathTypeMismatches: ServicePathTypeMismatch[];
  }> {
    const mounted = await this.snapshotSandboxService(service);
    const image = await this.snapshotSandboxServiceImage(service);
    return {
      service,
      provenance: "provided_dependency",
      mountedPath: mounted.path,
      imagePath: image.path,
      mountedInventory: mounted.inventory,
      imageInventory: image.inventory,
      pathTypeMismatches: await compareServiceSnapshotPathTypes(mounted.path, image.path),
    };
  }

  private async snapshotSandboxServiceImage(service: string): Promise<{ path: string; inventory: string }> {
    const cached = this.serviceImageSnapshots.get(service);
    if (cached && (await stat(cached.path).catch(() => undefined))?.isDirectory()) return cached;
    const image = (await this.dockerOutput(["inspect", "--format", "{{.Image}}", service], 5_000, 256 * 1024)).stdout.trim();
    if (!image) throw new Error(`Cannot inspect image for service '${service}'`);
    const tempName = `reaper-image-inspect-${sanitizeSandboxServiceName(service)}-${randomUUID().slice(0, 8)}`;
    const safeName = sanitizeSandboxServiceName(service);
    const appRoot = path.join(this.options.workspaceRoot, ".reaper", "sandbox-services", safeName, "image-app");
    await rm(appRoot, { recursive: true, force: true });
    await mkdir(appRoot, { recursive: true });
    try {
      await this.dockerOutput(["create", "--name", tempName, "--entrypoint", "/bin/sh", image, "-c", "true"], 30_000, 1024 * 1024);
      await this.dockerOutput(["cp", `${tempName}:/app/.`, appRoot], 30_000, 5 * 1024 * 1024, { allowNonZero: true });
    } finally {
      await this.dockerOutput(["rm", "-f", tempName], 10_000, 1024 * 1024, { allowNonZero: true });
    }
    const snapshot = { path: appRoot, inventory: await this.buildSandboxSnapshotInventory(appRoot) };
    this.serviceImageSnapshots.set(service, snapshot);
    return snapshot;
  }

  private async restoreSandboxServiceFileFromImage(service: string, targetPath: string): Promise<unknown> {
    const image = await this.snapshotSandboxServiceImage(service);
    const relative = targetPath.replace(/^\/app\/?/, "");
    const imageSource = path.join(image.path, relative);
    const sourceState = await stat(imageSource).catch(() => undefined);
    if (!sourceState?.isFile()) {
      throw new Error(`Refusing restore: image-provided '${targetPath}' is not a regular file.`);
    }
    const mounts = await this.inspectSandboxServiceMounts(service);
    const bindSource = selectExactBindMountFileRepairSource(mounts, targetPath);
    if (bindSource) {
      const current = await stat(bindSource).catch(() => undefined);
      if (current?.isDirectory()) {
        const entries = await readdir(bindSource);
        if (entries.length > 0) throw new Error(`Refusing to replace non-empty bind-mount directory '${bindSource}'.`);
        await rm(bindSource, { recursive: false });
      }
      await mkdir(path.dirname(bindSource), { recursive: true });
      await copyFile(imageSource, bindSource);
    } else {
      await this.dockerOutput(["cp", imageSource, `${service}:${targetPath}`], 30_000, 5 * 1024 * 1024);
    }
    return { service, targetPath, restoredFrom: "provided_dependency_image", imagePath: imageSource };
  }

  private async assertServicePathIsNotImageProvided(service: string, targetPath: string): Promise<void> {
    const image = await this.snapshotSandboxServiceImage(service);
    const imageTarget = path.join(image.path, targetPath.replace(/^\/app\/?/, ""));
    const imageState = await stat(imageTarget).catch(() => undefined);
    if (!imageState) return;
    throw new Error(
      `Refusing to fabricate or overwrite provided dependency path '${targetPath}'. ` +
        "Use sandbox_service_control inspect_image to compare layers, then restore_from_image if the mounted path is shadowed or damaged.",
    );
  }

  private async inspectSandboxServiceMounts(service: string): Promise<Array<{ Type?: string; Source?: string; Destination?: string }>> {
    const result = await this.dockerOutput(["inspect", "--format", "{{json .Mounts}}", service], 5_000, 1024 * 1024);
    return JSON.parse(result.stdout.trim()) as Array<{ Type?: string; Source?: string; Destination?: string }>;
  }

  private assertServiceRecoveryAttemptAllowed(service: string, action: "start" | "restart" | "recreate"): void {
    const limit = this.config?.runtime.serviceSupervisor.crashLoopThreshold ?? 2;
    const count = this.serviceRecoveryAttempts.get(service) ?? 0;
    if (count >= limit) {
      throw new Error(
        `Service '${service}' is crash-looping after ${count} recovery attempts. ` +
          "Blind start/restart/recreate is blocked. Inspect logs and inspect_image, restore the provided dependency from its image when appropriate, or classify this as infrastructure failure.",
      );
    }
    this.serviceRecoveryAttempts.set(service, count + 1);
  }

  private async buildSandboxSnapshotInventory(appRoot: string): Promise<string> {
    const result = await execFileAsync(
      "bash",
      [
        "-lc",
        [
          `cd ${shellQuote(appRoot)}`,
          "find . -maxdepth 4 \\( -type f -o -type d \\) -printf '%y %p %s bytes\\n' | sort | sed -n '1,120p'",
        ].join(" && "),
      ],
      { timeout: 5_000, maxBuffer: 512 * 1024 },
    ).catch(() => ({ stdout: "" }));
    return String(result.stdout).slice(0, 12_000);
  }

  private async runReadOnlySandboxSnapshotCommand(
    command: string,
    snapshotRoot: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const rewritten = rewriteServiceAppPathsForSnapshot(command, snapshotRoot);
    try {
      const result = await execFileAsync("bash", ["-lc", rewritten], {
        cwd: snapshotRoot,
        timeout: Math.min(timeoutMs, 30_000),
        maxBuffer: 5 * 1024 * 1024,
      });
      return { stdout: String(result.stdout), stderr: String(result.stderr), exitCode: 0 };
    } catch (error) {
      const err = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number | string; killed?: boolean };
      const timeoutNote = err.killed ? `snapshot inspection timed out after ${Math.min(timeoutMs, 30_000)}ms\n` : "";
      return {
        stdout: String(err.stdout ?? ""),
        stderr: `${timeoutNote}${String(err.stderr ?? "")}`,
        exitCode: typeof err.code === "number" ? err.code : 1,
      };
    }
  }

  private async writeFileIntoSandboxService(service: string, targetPath: string, content: string, toolCallId: string): Promise<void> {
    if (await this.tryWriteExactBindMountFile(service, targetPath, content)) return;
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "reaper-service-write-"));
    try {
      const tmpFile = path.join(tmpDir, `${sanitizeSandboxServiceName(toolCallId)}.payload`);
      await writeFile(tmpFile, content, "utf8");
      await this.ensureServiceParentDirectory(service, targetPath);
      await this.dockerOutput(["cp", tmpFile, `${service}:${targetPath}`], 30_000, 1024 * 1024);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  private async copyWorkspacePathIntoSandboxService(service: string, sourcePath: string, targetPath: string, toolCallId: string): Promise<string> {
    const absoluteSource = normalizeWorkspacePath(this.options.workspaceRoot, sourcePath);
    const snapshot = await stat(absoluteSource);
    await this.ensureServiceParentDirectory(service, targetPath);
    if (snapshot.isFile() && this.recoverySession) {
      const relativeSource = relativeWorkspacePath(this.options.workspaceRoot, absoluteSource);
      try {
        const stagedText = await this.recoverySession.wal.readText(relativeSource);
        const tmpDir = await mkdtemp(path.join(os.tmpdir(), "reaper-service-copy-"));
        try {
          const tmpFile = path.join(tmpDir, `${sanitizeSandboxServiceName(toolCallId)}.payload`);
          await writeFile(tmpFile, stagedText, "utf8");
          await this.dockerOutput(["cp", tmpFile, `${service}:${targetPath}`], 30_000, 1024 * 1024);
          return relativeSource;
        } finally {
          await rm(tmpDir, { recursive: true, force: true });
        }
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    }
    await this.dockerOutput(["cp", absoluteSource, `${service}:${targetPath}`], 30_000, 1024 * 1024);
    return relativeWorkspacePath(this.options.workspaceRoot, absoluteSource);
  }

  private async ensureServiceParentDirectory(service: string, targetPath: string): Promise<void> {
    const parent = path.posix.dirname(targetPath);
    await this.dockerOutput(["exec", "-u", "0", service, "bash", "-lc", `mkdir -p ${shellQuote(parent)}`], 30_000, 1024 * 1024);
  }

  private async tryWriteExactBindMountFile(service: string, targetPath: string, content: string): Promise<boolean> {
    const mounts = await this.inspectSandboxServiceMounts(service);
    const source = selectExactBindMountFileRepairSource(mounts, targetPath);
    if (!source) return false;
    const sourceState = await stat(source).catch((error: unknown) => {
      if (isMissingFileError(error)) return undefined;
      throw error;
    });
    if (sourceState?.isDirectory()) {
      const entries = await readdir(source);
      if (entries.length > 0) {
        throw new Error(
          `Refusing to replace non-empty bind-mount directory '${source}' for service target '${targetPath}'. Inspect and repair it explicitly.`,
        );
      }
      await rm(source, { recursive: false });
    } else if (sourceState && !sourceState.isFile()) {
      throw new Error(`Refusing to replace non-file bind-mount source '${source}' for service target '${targetPath}'.`);
    }
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, content, "utf8");
    return true;
  }

  private async dockerOutput(
    args: string[],
    timeoutMs: number,
    maxBuffer: number,
    options?: { allowNonZero?: boolean },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const result = await execFileAsync("docker", args, { timeout: timeoutMs, maxBuffer });
      return { stdout: String(result.stdout), stderr: String(result.stderr), exitCode: 0 };
    } catch (error) {
      const err = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number | string; killed?: boolean };
      const stdout = String(err.stdout ?? "");
      const stderr = String(err.stderr ?? "");
      const exitCode = typeof err.code === "number" ? err.code : 1;
      if (options?.allowNonZero) return { stdout, stderr, exitCode };
      throw new Error(
        [
          err.killed ? `docker ${args[0] ?? ""} timed out after ${timeoutMs}ms` : err.message,
          `docker ${args.join(" ")}`,
          `stdout: ${stdout.trim() || "<empty>"}`,
          `stderr: ${stderr.trim() || "<empty>"}`,
        ].join("\n"),
      );
    }
  }

  private getComputerBrowserController(): ComputerBrowserController {
    if (!this.computerBrowserController) {
      this.computerBrowserController = new ComputerBrowserController();
    }
    return this.computerBrowserController;
  }

  private getNativeComputerController(): NativeComputerController {
    if (!this.nativeComputerController) {
      this.nativeComputerController = new NativeComputerController();
    }
    return this.nativeComputerController;
  }

  private toolRuntimeMetadata(toolCallId: string) {
    return {
      runId: this.options.runId,
      artifactDir: this.options.artifactsDir ?? path.join(getReaperScratchpadPaths(this.options.workspaceRoot).runs, this.options.runId, "artifacts"),
      toolCallId,
    };
  }

  private async assertSafeEditGuard(
    targetPath: string,
    editArgs?: { startLine?: number; endLine?: number; oldString?: string; edits?: Array<{ oldString: string; newString: string }> },
  ): Promise<void> {
    const lineCount = await countFileLines(this.options.workspaceRoot, targetPath, this.recoverySession);
    const absolutePath = normalizeWorkspacePath(this.options.workspaceRoot, targetPath);
    if (lineCount <= 500 || this.fullReadPaths.has(targetPath) || this.readFileState.has(absolutePath)) {
      return;
    }
    if (editArgs && "startLine" in editArgs && typeof editArgs.startLine === "number" && typeof editArgs.endLine === "number") {
      return;
    }

    throw new Error(
      "File exceeds safe-edit threshold. Use read_file to load the target region first, or use replace_symbol for AST-aware replacement.",
    );
  }

  private async recordReadState(targetPath: string, fullyRead: boolean): Promise<void> {
    const absolutePath = normalizeWorkspacePath(this.options.workspaceRoot, targetPath);
    const snapshot = await this.getFreshnessSnapshot(targetPath, absolutePath);
    this.readFileState.set(absolutePath, { ...snapshot, fullyRead });
  }

  private makeReadOutputCacheKey(
    absolutePath: string,
    args: { startLine?: number | undefined; endLine?: number | undefined },
  ): string {
    return JSON.stringify({
      path: absolutePath,
      startLine: args.startLine ?? null,
      endLine: args.endLine ?? null,
    });
  }

  private withReadCacheNote(output: unknown, hits: number): unknown {
    if (!output || typeof output !== "object" || Array.isArray(output)) return output;
    const record = output as Record<string, unknown>;
    const note = typeof record.note === "string" ? `${record.note} ` : "";
    return {
      ...record,
      note: `${note}Read cache hit ${hits}; file hash and mtime are unchanged, so this is the cached observation. Use a different line range or search target if more context is needed.`,
    };
  }
  private async assertSafeFullFileOverwrite(targetPath: string, nextContent: string): Promise<void> {
    if (!isSourceLikeWritePath(targetPath)) return;
    const absolutePath = normalizeWorkspacePath(this.options.workspaceRoot, targetPath);
    const currentSnapshot = await this.getFreshnessSnapshot(targetPath, absolutePath);
    if (currentSnapshot.sha256 === null) return;

    const currentContent = this.recoverySession
      ? await this.recoverySession.wal.readText(targetPath)
      : await readFile(absolutePath, "utf8");
    if (currentContent === nextContent) return;

    const currentLines = countLogicalLines(currentContent);
    const nextLines = countLogicalLines(nextContent);
    const currentBytes = Buffer.byteLength(currentContent, "utf8");
    const nextBytes = Buffer.byteLength(nextContent, "utf8");
    if (currentLines < 8 && currentBytes < 400) return;

    const prior = this.readFileState.get(absolutePath);
    const currentWasFullyRead = prior?.fullyRead === true && prior.sha256 === currentSnapshot.sha256;
    const severeContraction =
      (currentLines >= 12 && nextLines <= Math.max(3, Math.floor(currentLines * 0.35))) ||
      (currentBytes >= 400 && nextBytes <= Math.max(160, Math.floor(currentBytes * 0.35)));

    if (!currentWasFullyRead || severeContraction) {
      const reason = [
        `write_file refused a risky full-file overwrite of existing source file '${targetPath}' (${currentLines} line(s), ${currentBytes} byte(s)) with ${nextLines} line(s), ${nextBytes} byte(s).`,
        currentWasFullyRead
          ? "The replacement is a severe contraction and is likely a partial or corrupted patch."
          : "The current file was not fully read immediately before the overwrite.",
        "Use replace_in_file/edit_file for the smallest affected region, or read the whole file and provide a complete full-file replacement of comparable scope.",
      ].join(" ");
      const error = new Error(reason) as Error & { code?: string };
      error.code = "unsafe_full_file_overwrite";
      throw error;
    }
  }

  private async buildReplaceCandidateContent(args: ReplaceInFileCandidateArgs): Promise<string> {
    const currentContent = await this.readCurrentWorkspaceText(args.path);
    if ("startLine" in args) {
      return replaceLineRange(currentContent, args.startLine, args.endLine, args.content, args.path).next;
    }
    return replaceExactString(currentContent, args.oldString, args.newString, args.allowMultiple ?? false, args.path).next;
  }

  private async buildEditCandidateContent(args: EditFileCandidateArgs): Promise<string> {
    const currentContent = await this.readCurrentWorkspaceText(args.path);
    return applyEditFileContent(currentContent, args).content;
  }

  private async readCurrentWorkspaceText(targetPath: string): Promise<string> {
    if (this.recoverySession) {
      return this.recoverySession.wal.readText(targetPath);
    }
    return readFile(normalizeWorkspacePath(this.options.workspaceRoot, targetPath), "utf8");
  }

  private async assertEditorGuard(_targetPath: string, _nextContent: string, _operation: string): Promise<void> {
    // Editor guard removed: Reaper should let
    // the model edit, then verify with explicit tool/test results instead of
    // pre-blocking candidate source changes.
    return;
  }

  private async recordStagedWriteState(targetPath: string): Promise<void> {
    const absolutePath = normalizeWorkspacePath(this.options.workspaceRoot, targetPath);
    const snapshot = await this.getFreshnessSnapshot(targetPath, absolutePath);
    if (snapshot.sha256 !== null) {
      this.readFileState.set(absolutePath, { ...snapshot, fullyRead: true });
    }
  }

  private async getFreshnessSnapshot(targetPath: string, absolutePath = normalizeWorkspacePath(this.options.workspaceRoot, targetPath)): Promise<{ sha256: string | null; mtimeMs: number | null }> {
    if (this.recoverySession) {
      try {
        const content = await this.recoverySession.wal.readText(targetPath);
        return snapshotText(content);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          return { sha256: null, mtimeMs: null };
        }
        if (error instanceof Error && /staged for deletion/i.test(error.message)) {
          return { sha256: null, mtimeMs: null };
        }
        throw error;
      }
    }
    return getFileSnapshot(absolutePath);
  }

  private async snapshotBeforeMutation(targetPath: string, operation: string): Promise<void> {
    const absolutePath = normalizeWorkspacePath(this.options.workspaceRoot, targetPath);
    const current = await getFileSnapshot(absolutePath);
    if (current.sha256 === null) return;

    const scratchpad = getReaperScratchpadPaths(this.options.workspaceRoot);
    const relative = relativeWorkspacePath(this.options.workspaceRoot, absolutePath);
    const snapshotId = `${Date.now()}-${randomUUID()}`;
    const snapshotPath = path.join(scratchpad.artifacts, "file-snapshots", snapshotId, relative);
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await copyFile(absolutePath, snapshotPath);
    await writeFile(
      `${snapshotPath}.meta.json`,
      JSON.stringify(
        {
          operation,
          originalPath: absolutePath,
          relativePath: relative,
          sha256: current.sha256,
          mtimeMs: current.mtimeMs,
          capturedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  private async maybeStoreArtifact(toolName: string, output: unknown): Promise<unknown> {
    if (toolName !== "bash") {
      return output;
    }

    const stdout = typeof output === "object" && output && "stdout" in output && typeof output.stdout === "string" ? output.stdout : undefined;
    const stderr = typeof output === "object" && output && "stderr" in output && typeof output.stderr === "string" ? output.stderr : undefined;
    const combined = `${stdout ?? ""}${stderr ?? ""}`;
    if (Buffer.byteLength(combined, "utf8") <= 1024 * 1024) {
      return output;
    }

    const artifact = await this.artifactStore.put("tool_output", combined);
    return {
      ...(typeof output === "object" && output ? output : {}),
      stdout: (stdout ?? "").slice(0, 1024 * 1024),
      stderr: stderr ?? "",
      artifactId: artifact.artifactId,
      artifactBytes: artifact.bytes,
      artifactSha256: artifact.sha256,
      truncated: true,
    };
  }

  private async persistProcessManifest(): Promise<void> {
    await this.backgroundProcessManager.persistManifest();
  }
}

function requireServiceAppPath(targetPath: string | undefined, action: string): string {
  if (!targetPath?.trim()) throw new Error(`sandbox_service_control ${action} requires targetPath`);
  const normalized = path.posix.normalize(targetPath.replace(/\\/g, "/"));
  if (!normalized.startsWith("/app/") && normalized !== "/app") {
    throw new Error(`sandbox_service_control ${action} targetPath must be inside /app, got '${targetPath}'`);
  }
  return normalized;
}

function sanitizeSandboxServiceName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

function assertCompleteSourceWrite(filePath: string, content: string): void {
  if (!isSourceLikeWritePath(filePath)) return;
  const trimmed = content.trimEnd();
  if (!trimmed) return;
  const maxSourceWriteBytes = getMaxSourceWriteBytes();
  if (Buffer.byteLength(trimmed, "utf8") > maxSourceWriteBytes) {
    const reason = [
      `write_file payload for '${filePath}' is too large for one reliable source write (${Buffer.byteLength(trimmed, "utf8")} bytes > ${maxSourceWriteBytes} bytes).`,
      "Create the smallest complete compiling/runnable scaffold first, then extend it with focused replace_in_file/edit_file chunks and narrow checks.",
      "This prevents truncated structured responses and makes failures attributable.",
    ].join(" ");
    const error = new Error(reason) as Error & { code?: string };
    error.code = "incomplete_source_write";
    throw error;
  }
  const lineCount = trimmed.split(/\r?\n/).length;
  const looksLikePartialText =
    /(?:=\s*|return\s+|=>\s*|,\s*|\(\s*|\[\s*|\{\s*|["'`])$/.test(trimmed) ||
    /(?:fopen|open|write|print|printf|fprintf|console\.log|JSON\.stringify)\s*\([^)]*$/.test(trimmed);
  const lastMeaningfulLine = trimmed.split(/\r?\n/).reverse().find((line) => line.trim() && !line.trim().startsWith("//"))?.trim() ?? "";
  const balance = getCodeBalance(trimmed);
  const hasOpenDelimiter = balance.brace > 0 || balance.paren > 0 || balance.bracket > 0;
  const danglingFinalLine =
    lastMeaningfulLine.length > 0 &&
    !/[;})\]>"'`]$/.test(lastMeaningfulLine) &&
    !/^\s*(?:else|try|do)\s*$/.test(lastMeaningfulLine);
  const suspiciouslyIncomplete =
    balance.inString ||
    balance.unclosedTemplate ||
    balance.brace < 0 ||
    balance.paren < 0 ||
    balance.bracket < 0 ||
    (lineCount >= 8 && hasOpenDelimiter && (looksLikePartialText || danglingFinalLine));
  if (!suspiciouslyIncomplete) return;

  const reason = [
    `write_file payload for '${filePath}' appears truncated or syntactically incomplete.`,
    "Do not accept partial full-file writes as progress.",
    "Retry with a smaller complete file, split implementation across smaller edits, or write a minimal compilable skeleton and then extend it.",
  ].join(" ");
  const error = new Error(reason) as Error & { code?: string };
  error.code = "incomplete_source_write";
  throw error;
}

function getMaxSourceWriteBytes(): number {
  const raw = Number(process.env.REAPER_MAX_SOURCE_WRITE_BYTES ?? 8000);
  return Number.isFinite(raw) && raw >= 2000 ? raw : 8000;
}

function countLogicalLines(content: string): number {
  if (!content) return 0;
  return content.replace(/\n$/, "").split(/\r?\n/).length;
}

function isSourceLikeWritePath(filePath: string): boolean {
  return /\.(?:c|cc|cpp|cxx|h|hpp|hh|m|mm|java|kt|kts|go|rs|py|rb|php|js|jsx|ts|tsx|mjs|cjs|vue|svelte|swift|scala|cs)$/i.test(
    filePath.replace(/\\/g, "/"),
  );
}

function isAllocatedScratchWorkspace(workspaceRoot: string): boolean {
  const normalized = path.resolve(workspaceRoot).replace(/\\/g, "/");
  return (
    /\/reaper_eval\/workspaces\/[^/]+\/[^/]+(?:\/|$)/.test(normalized) ||
    /\/(?:tmp|var\/tmp)\/reaper(?:-|_|\/)/i.test(normalized) ||
    /\/\.reaper\/scratchpad(?:\/|$)/.test(normalized)
  );
}

function getCodeBalance(content: string): {
  brace: number;
  paren: number;
  bracket: number;
  inString: boolean;
  unclosedTemplate: boolean;
} {
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]!;
    const next = content[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") brace += 1;
    else if (ch === "}") brace -= 1;
    else if (ch === "(") paren += 1;
    else if (ch === ")") paren -= 1;
    else if (ch === "[") bracket += 1;
    else if (ch === "]") bracket -= 1;
  }

  return { brace, paren, bracket, inString: quote === '"' || quote === "'", unclosedTemplate: quote === "`" };
}


function readdirWithFileTypes(targetPath: string) {
  return readdir(targetPath, { withFileTypes: true });
}

async function getFileSnapshot(absolutePath: string): Promise<{ sha256: string | null; mtimeMs: number | null }> {
  try {
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) return { sha256: null, mtimeMs: null };
    const content = await readFile(absolutePath);
    return { sha256: createHash("sha256").update(content).digest("hex"), mtimeMs: metadata.mtimeMs };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { sha256: null, mtimeMs: null };
    }
    throw error;
  }
}

function snapshotText(content: string): { sha256: string; mtimeMs: null } {
  return { sha256: createHash("sha256").update(content).digest("hex"), mtimeMs: null };
}

function rewriteWorkspaceRootInShellCommand(command: string, workspaceRoot: string, replacementRoot: string): string {
  const normalizedWorkspace = path.resolve(workspaceRoot);
  const normalizedReplacement = path.resolve(replacementRoot);
  if (normalizedWorkspace === normalizedReplacement || !command.includes(normalizedWorkspace)) {
    return command;
  }
  return command.split(normalizedWorkspace).join(normalizedReplacement);
}

function isStoppedContainerExecResult(result: { stdout: string; stderr: string; exitCode: number }): boolean {
  return result.exitCode !== 0 && /container\s+[a-f0-9]+\s+is\s+not\s+running/i.test(`${result.stdout}\n${result.stderr}`);
}

export function isConclusiveServiceMountOrEntrypointFailure(logs: string): boolean {
  return /(?:is a directory|not a directory|executable file not found|exec format error|permission denied|can't open file|cannot open file|no such file or directory|failed to create task|mount.*(?:failed|error)|entrypoint.*(?:failed|error))/i.test(
    logs,
  );
}

export function selectExactBindMountFileRepairSource(
  mounts: Array<{ Type?: string; Source?: string; Destination?: string }>,
  targetPath: string,
): string | undefined {
  if (!targetPath.startsWith("/app/") || targetPath.endsWith("/")) return undefined;
  const exact = mounts.filter(
    (mount) => mount.Type === "bind" && mount.Destination === targetPath && typeof mount.Source === "string" && path.isAbsolute(mount.Source),
  );
  return exact.length === 1 ? exact[0]!.Source : undefined;
}

export interface ServicePathTypeMismatch {
  path: string;
  mountedType: "file" | "directory" | "other" | "missing";
  imageType: "file" | "directory" | "other" | "missing";
  diagnosis: "mount_shadow_or_damage";
}

export function detectServicePathTypeMismatches(
  mounted: Record<string, "file" | "directory" | "other">,
  image: Record<string, "file" | "directory" | "other">,
): ServicePathTypeMismatch[] {
  const paths = new Set([...Object.keys(mounted), ...Object.keys(image)]);
  return [...paths]
    .filter((item) => (mounted[item] ?? "missing") !== (image[item] ?? "missing"))
    .map((item) => ({
      path: `/app/${item}`.replace(/\/+$/, ""),
      mountedType: mounted[item] ?? "missing",
      imageType: image[item] ?? "missing",
      diagnosis: "mount_shadow_or_damage" as const,
    }));
}

export function selectSandboxServiceName(
  services: Array<{ name: string; role: "client" | "service" }>,
  requested?: string,
): string | undefined {
  const siblings = services.filter((service) => service.role === "service");
  if (!requested?.trim()) return siblings.length === 1 ? siblings[0]!.name : undefined;
  const needle = requested.trim();
  const exactSibling = siblings.find((service) => service.name === needle);
  if (exactSibling) return exactSibling.name;
  const partialSiblings = siblings.filter((service) => service.name.includes(needle));
  if (partialSiblings.length === 1) return partialSiblings[0]!.name;
  return undefined;
}

function rewriteServiceAppPathsForSnapshot(command: string, snapshotRoot: string): string {
  return command.replace(/\/app(?=\/|[\s'"]|$)/g, shellQuote(snapshotRoot));
}

async function compareServiceSnapshotPathTypes(mountedRoot: string, imageRoot: string): Promise<ServicePathTypeMismatch[]> {
  const [mounted, image] = await Promise.all([collectPathTypes(mountedRoot), collectPathTypes(imageRoot)]);
  return detectServicePathTypeMismatches(mounted, image);
}

async function collectPathTypes(root: string): Promise<Record<string, "file" | "directory" | "other">> {
  const output: Record<string, "file" | "directory" | "other"> = {};
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      output[relative] = entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other";
      if (entry.isDirectory()) await visit(absolute, depth + 1);
    }
  };
  await visit(root, 0);
  return output;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isHostOnlyReaperArtifactInspectionCommand(command: string, workspaceRoot: string): boolean {
  const normalizedRoot = path.resolve(workspaceRoot).replace(/\\/g, "/");
  const normalizedCommand = command.replace(/\\/g, "/");
  return normalizedCommand.includes(`${normalizedRoot}/.reaper/`) && isReadOnlyInspectionShellCommand(command);
}

function isReadOnlyInspectionShellCommand(command: string): boolean {
  const normalized = command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 4_000) return false;
  if (/(?:^|[;&|]\s*)(?:rm|rmdir|mv|cp|install|touch|mkdir|chmod|chown|truncate|tee|dd|patch|git\s+(?:apply|checkout|reset|clean|mv|rm)|python(?:3)?|node|npm|pnpm|yarn|bun|pip|conda|make|cmake|ninja|gcc|g\+\+|clang|go|cargo|pytest)\b/i.test(normalized)) {
    return false;
  }
  if (/(?:^|[;&|]\s*)sed\b[^;&|]*\s-i\b/i.test(normalized) || /(?:^|[;&|]\s*)perl\b[^;&|]*\s-[^\s]*i/i.test(normalized)) {
    return false;
  }
  if (/(?:^|[^0-9])>{1,2}\s*(?!\/dev\/null\b|&[12]\b)/.test(normalized)) {
    return false;
  }

  const allowed = new Set([
    "bash",
    "cat",
    "cd",
    "cut",
    "dirname",
    "du",
    "echo",
    "file",
    "find",
    "grep",
    "head",
    "ls",
    "printf",
    "pwd",
    "readlink",
    "realpath",
    "rg",
    "sed",
    "sort",
    "stat",
    "tail",
    "test",
    "uniq",
    "wc",
  ]);

  const commandParts = normalized.split(/&&|\|\||[;|]/);
  for (const rawPart of commandParts) {
    const part = rawPart
      .trim()
      .replace(/^\(+\s*/, "")
      .replace(/\s*\)+$/, "")
      .replace(/\s*(?:1|2)>\s*\/dev\/null\b/g, "")
      .replace(/\s*(?:1|2)>&[12]\b/g, "")
      .trim();
    if (!part) continue;
    const match = part.match(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:sudo\s+)?([A-Za-z0-9_./+-]+)/);
    if (!match) return false;
    const executable = path.posix.basename(match[1]!.replace(/\\/g, "/"));
    if (!allowed.has(executable)) return false;
    if (executable === "find" && /\s-delete\b/i.test(part)) return false;
    if (executable === "find" && /\s-exec\b/i.test(part) && !findExecUsesOnlyReadOnlyCommands(part)) return false;
    if (executable === "bash" && !/\bbash\s+-lc\s+['"]?(?:cd|ls|find|cat|sed|head|tail|wc|stat|file|pwd|du|echo|printf|grep|rg|sort|uniq|cut|test|realpath|readlink)\b/i.test(part)) {
      return false;
    }
  }
  return true;
}

function findExecUsesOnlyReadOnlyCommands(part: string): boolean {
  const allowed = new Set(["cat", "cut", "du", "file", "grep", "head", "readlink", "realpath", "rg", "sed", "sort", "stat", "tail", "uniq", "wc"]);
  const matches = Array.from(part.matchAll(/\s-exec(?:dir)?\s+([A-Za-z0-9_./+-]+)/gi));
  if (matches.length === 0) return true;
  return matches.every((match) => allowed.has(path.posix.basename(String(match[1] ?? "").replace(/\\/g, "/"))));
}

function hasSandboxServiceContext(): boolean {
  return Boolean(process.env.REAPER_TBENCH_CONTAINER_NAME?.trim() || process.env.REAPER_TBENCH_COMPOSE_PROJECT?.trim());
}

function isDockerCliCommand(command: string): boolean {
  const stripped = command.replace(/\\\n/g, " ").trim();
  return /(?:^|[;&|]\s*)(?:sudo\s+)?docker(?:\s|$)/i.test(stripped);
}
