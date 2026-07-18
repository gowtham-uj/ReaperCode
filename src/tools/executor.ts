import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ForegroundShellResult } from "./global/bash.js";
import treeKill from "tree-kill";

import { AuditLogger } from "../logging/audit.js";
import { TrajectoryLogger } from "../logging/trajectory.js";
import { loadLocalRules } from "../policy/local-rules.js";
import { PathPolicyError } from "../policy/paths.js";
import { evaluateCommandPolicy, type SafetyProfile } from "../policy/rules.js";
import { PermissionClassifier, type PermissionMode, type PermissionClassification } from "../policy/classifier.js";
import { resolveEffectivePermissionMode } from "../policy/mode.js";
import type { RecoverySession } from "../recovery/session.js";
import { classifyToolCall } from "../execution/planner.js";
import { ArtifactStore } from "../artifacts/store.js";
import { executeBashCommand, bashCommandToModelOutput, isBackgroundBashResult, toForegroundShellResult } from "./bash/index.js";
import type { BashExecutionResult } from "./bash/index.js";
import { normalizeToolCall } from "./normalize.js";
import { grepSearchTool } from "./read/grep-search.js";
import { getToolOutputTool } from "./read/get-tool-output.js";
import { listDirectoryTool } from "./read/list-directory.js";
import { readFileTool, type ReadFileToolResult } from "./read/read-file.js";
import { skimFileTool } from "./read/skim-file.js";
import { inspectEnvironmentTool } from "./read/inspect-env.js";
import { activateSkillTool } from "./read/activate-skill.js";
import { webSearchTool, type WebSearchArgs } from "./read/web-search.js";
import { ComputerBrowserController } from "./browser/computer-browser.js";
import { NativeComputerController, type NativeComputerToolName } from "./computer/native-computer.js";
import { toolRegistry } from "./registry.js";
import { deleteFileTool } from "./write/delete-file.js";
import { editFileTool } from "./write/edit-file.js";
import { replaceInFileTool } from "./write/replace-in-file.js";
import { writeFileTool } from "./write/write-file.js";
import { executeSearchTools } from "./write/search-tools.js";
import { executeApplyPatch } from "./apply-patch.js";
import { executeGlob } from "./glob.js";
import { executeEval } from "./eval.js";
import { executeJob } from "./job.js";
import { executeDiagnostics } from "./diagnostics.js";
import { webFetchTool } from "./read/web-fetch.js";
import { executeScratchpad } from "./memory/scratchpad.js";
import type { Hooks } from "../adaptive/hooks.js";
import { ToolCallSchema, type ToolCall, type ToolResult } from "./types.js";
import { countFileLines } from "../workspace/roots.js";
import type { ReaperConfig } from "../config/model-config.js";
import type { MergedToolRegistry } from "./mcp/registry.js";
import { ensureReaperScratchpad, getReaperScratchpadPaths } from "../workspace/scratchpad.js";
import { normalizeWorkspacePath, relativeWorkspacePath } from "../policy/paths.js";
import { BackgroundProcessManager } from "./background-process-manager.js";
import { createCheckpoint, restoreCheckpoint } from "../runtime/checkpoints.js";
import { getGitDiffState, getGitStatusState, summarizeGitDiffState } from "../runtime/diff-state.js";

/**
 * Workflow 3 structured error types. The outer `catch` block in
 * `execute()` switches on `code` to surface a stable error envelope
 * to the model. Anything not in this set falls through to the
 * existing generic `tool_error` path.
 */
export class PermissionDeniedError extends Error {
  readonly code = "permission_denied";
  constructor(readonly ruleId: string, message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export class ApprovalRequiredError extends Error {
  readonly code = "approval_required";
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}

export class HookBlockedError extends Error {
  readonly code = "hook_blocked";
  constructor(readonly hookReason: string, message: string) {
    super(message);
    this.name = "HookBlockedError";
  }
}


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
  runDir?: string;
  artifactsDir?: string;
  shellRunner?: ShellRunner;
  /**
   * Workflow 3: optional allowlist forwarded to the child-env builder
   * for any Reaper-spawned child (foreground bash, background bash,
   * JavaScript eval, Python eval). Names on this list survive even
   * when the sensitive-name classifier would otherwise strip them.
   * Default `[]`. Use only when a command intentionally needs a
   * specific sensitive variable; never enable by default.
   */
  childEnvAllowlist?: ReadonlyArray<string>;
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


interface FileFreshnessMetadata {
  sha256: string;
  mtimeMs: number | null;
}

type FreshReadFileResult = ReadFileToolResult & FileFreshnessMetadata;
type FreshnessSnapshot = { sha256: string | null; mtimeMs: number | null };

function isTruncatedTextRead(result: ReadFileToolResult): boolean {
  return result.kind === "text" && result.truncated;
}

function isStableSnapshot(before: FreshnessSnapshot, after: FreshnessSnapshot): before is FileFreshnessMetadata {
  return before.sha256 !== null && before.sha256 === after.sha256 && before.mtimeMs === after.mtimeMs;
}

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


import {
  FileViewerRegistry,
  LinterRegistry,
  dispatchViewerTool,
} from "./viewer/index.js";

export class ToolExecutor {
  private readonly trajectoryLogger: TrajectoryLogger;
  private readonly auditLogger: AuditLogger;
  private readonly recoverySession: RecoverySession | undefined;
  private readonly fullReadPaths = new Set<string>();
  private readonly artifactStore: ArtifactStore;
  private readonly config: ReaperConfig | undefined;
  private readonly mcpRegistry: MergedToolRegistry | undefined;
  private readonly authoringTools: AuthoringToolDeps | undefined;
  private readonly permissionClassifier: PermissionClassifier;
  private readonly readFileState = new Map<string, { sha256: string | null; mtimeMs: number | null; fullyRead: boolean }>();
  private readonly readOutputCache = new Map<string, FileFreshnessMetadata & { output: FreshReadFileResult; hits: number }>();
  // Phase 3 — viewer state. Lives on the executor so it shares lifetime
  // with the run. Cleared at run end (see `resetViewerState`).
  private readonly viewerRegistry = new FileViewerRegistry();
  private readonly linterRegistry = new LinterRegistry();
  private viewerDirtyPaths = new Set<string>();
  private readonly fileWriteCounts = new Map<string, number>();
  private localRulesHash?: string;
  private readonly backgroundProcessManager: BackgroundProcessManager;
  private computerBrowserController: ComputerBrowserController | undefined;
  private nativeComputerController: NativeComputerController | undefined;
  private currentWorkingDirectory: string;
  private consecutiveUnknownTools = 0;
  private lastUnknownToolName?: string;
  /** Workflow 3: permission mode and child-env allowlist (typed enum,
   *  not arbitrary string). Used by the classifier enforcement and the
   *  sanitized child environment builder. */
  private readonly permissionMode: PermissionMode;
  private readonly childEnvAllowlist: ReadonlyArray<string>;

  constructor(private readonly options: ToolExecutorOptions) {
    void ensureReaperScratchpad(options.workspaceRoot);
    this.trajectoryLogger = options.trajectoryLogger ?? new TrajectoryLogger(options.workspaceRoot);
    this.auditLogger = options.auditLogger ?? new AuditLogger(options.workspaceRoot, { runId: options.runId });
    this.recoverySession = options.recoverySession;
    this.artifactStore = new ArtifactStore(options.workspaceRoot);
    this.config = options.config;
    this.mcpRegistry = options.mcpRegistry;
    this.authoringTools = options.authoringTools;
    const resolvedMode = resolveEffectivePermissionMode(options.permissionMode ?? "yolo");
    this.permissionMode = resolvedMode;
    this.permissionClassifier = new PermissionClassifier(resolvedMode);
    this.childEnvAllowlist = options.childEnvAllowlist ?? [];
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
    const decisionId = normalizedCall.id || call.id || randomUUID();

    // Unknown-tool loop guard
    const isKnownTool = normalizedCall.name in toolRegistry || (this.mcpRegistry?.isMcpTool(normalizedCall.name) ?? false);
    if (!isKnownTool) {
      this.consecutiveUnknownTools++;
      this.lastUnknownToolName = normalizedCall.name;
      const discovery = executeSearchTools(normalizedCall.name, this.options.runId);
      const suggestionText = discovery.matches.length
        ? ` Closest discoverable tools: ${discovery.matches.map((item) => `${item.name} (${item.description})`).join("; ")}. Use search_tools with 'select:${discovery.matches.map((item) => item.name).join(",")}' if one of these is intended.`
        : " No close tool match was found; call search_tools with capability keywords before retrying.";
      const error = {
        message: this.consecutiveUnknownTools >= 3
          ? `Unknown tool '${call.name}' called ${this.consecutiveUnknownTools} times in a row.${suggestionText} Available core tools: ${Object.keys(toolRegistry).join(", ")}. Please use only registered tools.`
          : `Unknown tool '${call.name}'.${suggestionText} Available core tools: ${Object.keys(toolRegistry).join(", ")}.`,
        code: this.consecutiveUnknownTools >= 3 ? "UNKNOWN_TOOL_LOOP" : "UNKNOWN_TOOL",
      };
      await this.trajectoryLogger.write({
        event_id: randomUUID(),
        run_id: this.options.runId,
        session_id: this.options.sessionId,
        trace_id: this.options.traceId,
        timestamp: new Date(start).toISOString(),
        log_schema_version: 1,
        kind: "tool_call",
        level: this.options.logLevel,
        tool_name: normalizedCall.name,
        decision_id: decisionId,
        status: "failed",
        args: normalizedCall.args,
        error,
      });
      return {
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: Date.now() - start,
        args: call.args,
        error,
      };
    }
    this.consecutiveUnknownTools = 0;

    // ---- Phase 3 viewer tools.
    //    Keep these as first-class model-facing tools. Do NOT alias legacy
    //    read_file/replace_in_file into viewer calls — the model should see,
    //    choose, and learn the viewer names directly from their descriptions.
    const callNameRaw = (call.name ?? "") as string;
    if (
      callNameRaw === "file_view" ||
      callNameRaw === "file_scroll" ||
      callNameRaw === "file_find" ||
      callNameRaw === "file_edit"
    ) {
      const callAnyBypass = {
        id: call.id,
        name: callNameRaw,
        args: (call.args ?? {}) as Record<string, unknown>,
      };
      const dirForViewer = await this.resolveExistingPathCase(
        (callAnyBypass.args as { path?: string }).path ?? "",
      );
      if (callAnyBypass.name === "file_edit") {
        await this.snapshotBeforeMutation(dirForViewer, "file_edit");
        this.fileWriteCounts.set(
          dirForViewer,
          (this.fileWriteCounts.get(dirForViewer) ?? 0) + 1,
        );
      }
      await this.trajectoryLogger.write({
        event_id: randomUUID(),
        run_id: this.options.runId,
        session_id: this.options.sessionId,
        trace_id: this.options.traceId,
        timestamp: new Date(start).toISOString(),
        log_schema_version: 1,
        kind: "tool_call",
        level: this.options.logLevel,
        tool_name: callNameRaw,
        decision_id: decisionId,
        status: "started",
        args: callAnyBypass.args,
      });
      const r = await dispatchViewerTool(callAnyBypass, {
        workspaceRoot: this.options.workspaceRoot,
        viewerRegistry: this.viewerRegistry,
        linterRegistry: this.linterRegistry,
      });
      const result: ToolResult = {
        toolCallId: call.id,
        name: callNameRaw,
        ok: r.ok,
        durationMs: r.durationMs,
        args: callAnyBypass.args,
        output: r.output,
        ...(r.error ? { error: r.error } : {}),
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
        tool_name: callNameRaw,
        decision_id: decisionId,
        status: r.ok ? "completed" : "failed",
        args: callAnyBypass.args,
        output: r.output,
        ...(r.error ? { error: r.error } : {}),
      });
      return result;
    }

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
      // Permission classifier — runs in every mode. In yolo the
      // fast-path returns `safe` for almost everything, but the hard-
      // deny patterns still trip and surface a real
      // permission_denied result so the model can see why. In other
      // modes we follow the classifier's verdict: `dangerous` is a
      // hard denial, `needs_confirmation` is an explicit
      // approval_required result (the model is expected to ask the
      // user via the existing approval channel).
      const classification = this.permissionClassifier.classifyToolCall(parsedCall);
      if (classification.outcome === "dangerous") {
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
          policy_id: classification.ruleMatch ?? "classifier_dangerous",
          outcome: "deny",
        });
        throw new PermissionDeniedError(
          classification.ruleMatch ?? "classifier_dangerous",
          `Permission classifier refused tool '${parsedCall.name}': ${classification.reasoning}`,
        );
      }
      if (classification.outcome === "needs_confirmation" && this.permissionMode !== "yolo") {
        // Strict / auto / accept_edits demand a real approval for
        // anything not in the fast-path safe list. We surface an
        // approval_required result instead of executing, so the
        // model can route to whatever real approval path exists
        // (CLI prompt, human_intervention tool, etc.). We do NOT
        // invent an approval path or silently downgrade.
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
          policy_id: "classifier_needs_confirmation",
          outcome: "approval_required",
        });
        throw new ApprovalRequiredError(
          "classifier",
          `Tool '${parsedCall.name}' requires explicit user approval in mode '${this.permissionMode}': ${classification.reasoning}`,
        );
      }

      // PreToolUse hook envelope. A handler returning { allow: false }
      // blocks the dispatch with the hook's reason. The hook
      // engine's own exception is non-blocking (preserved historical
      // policy) but an actual negative decision is a hard block.
      const hooks = this.options.hooks;
      let preHookMessage: string | undefined;
      if (hooks) {
        try {
          const preHookResult = await hooks.emit({
            name: "PreToolUse",
            payload: { toolName: parsedCall.name, args: parsedCall.args },
            blockable: true,
          });
          if (preHookResult.allow === false) {
            const hookReason = preHookResult.reason ?? preHookResult.message ?? "hook blocked";
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
              policy_id: "pre_tool_use_hook",
              outcome: "deny",
            });
            throw new HookBlockedError(hookReason, `PreToolUse hook blocked '${parsedCall.name}': ${hookReason}`);
          }
          preHookMessage = preHookResult.message;
        } catch (error) {
          if (error instanceof HookBlockedError) throw error;
          // Hook engine exceptions remain non-blocking (existing
          // established policy) — the tool still dispatches.
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
    // ---- Phase 3: viewer tool interception (BEFORE the typed switch).
    //    The ToolCallSchema discriminated union doesn't include the four
    //    viewer names; widening it would bust the type-narrowing budget
    //    in 13+ files. So we intercept via a string compare at runtime,
    //    delegate to the viewer's own dispatcher, and return early.
    const callAny = call as unknown as { id: string; name: string; args: unknown };
    if (
      callAny.name === "file_view" ||
      callAny.name === "file_scroll" ||
      callAny.name === "file_find" ||
      callAny.name === "file_edit"
    ) {
      const dirForViewer = await this.resolveExistingPathCase(
        (callAny.args as { path?: string } | null)?.path ?? "",
      );
      if (callAny.name === "file_edit") {
        await this.snapshotBeforeMutation(dirForViewer, "file_edit");
        this.fileWriteCounts.set(
          dirForViewer,
          (this.fileWriteCounts.get(dirForViewer) ?? 0) + 1,
        );
      }
      const r = await dispatchViewerTool(callAny, {
        workspaceRoot: this.options.workspaceRoot,
        viewerRegistry: this.viewerRegistry,
        linterRegistry: this.linterRegistry,
      });
      // Wrap the viewer's ToolResult-like into the executor's envelope.
      return {
        toolCallId: call.id,
        name: callAny.name,
        ok: r.ok,
        durationMs: r.durationMs,
        output: r.output,
        args: callAny.args,
        ...(r.error ? { error: r.error } : {}),
      };
    }

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
            cached.sha256 === beforeReadSnapshot.sha256 &&
            cached.mtimeMs === beforeReadSnapshot.mtimeMs
          ) {
            cached.hits += 1;
            await this.recordReadState(args.path, unboundedRead && !isTruncatedTextRead(cached.output), beforeReadSnapshot);
            return this.withReadCacheNote(cached.output, cached.hits);
          }
          const result = await readFileTool(this.options.workspaceRoot, {
            path: args.path,
            ...(args.startLine !== undefined ? { startLine: args.startLine } : {}),
            ...(args.endLine !== undefined ? { endLine: args.endLine } : {}),
          });
          if (unboundedRead && isTruncatedTextRead(result)) {
            this.fullReadPaths.delete(args.path);
          }
          const afterReadSnapshot = await this.getFreshnessSnapshot(args.path, absolutePath);
          await this.recordReadState(args.path, unboundedRead && !isTruncatedTextRead(result), afterReadSnapshot);
          if (!isStableSnapshot(beforeReadSnapshot, afterReadSnapshot)) {
            return result;
          }
          const observedResult: FreshReadFileResult = {
            ...result,
            sha256: beforeReadSnapshot.sha256,
            mtimeMs: beforeReadSnapshot.mtimeMs,
          };
          this.readOutputCache.set(cacheKey, { ...beforeReadSnapshot, output: observedResult, hits: 0 });
          return observedResult;
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
            return `<activated_skill status="advisory_note" reason="${(pre.reason ?? pre.message ?? "hook advised").replace(/"/g, "&quot;")}" />`;
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
          await this.snapshotBeforeMutation(args.path, "write_file");
          this.fileWriteCounts.set(args.path, (this.fileWriteCounts.get(args.path) ?? 0) + 1);
          return writeFileTool(this.options.workspaceRoot, args);
        }
      case "replace_in_file":
        {
          const parsedArgs = toolRegistry.replace_in_file.argsSchema.parse(call.args);
          const args = { ...parsedArgs, path: await this.resolveExistingPathCase(parsedArgs.path) } as typeof parsedArgs;
          await this.snapshotBeforeMutation(args.path, "replace_in_file");
          this.fileWriteCounts.set(args.path, (this.fileWriteCounts.get(args.path) ?? 0) + 1);
          return replaceInFileTool(this.options.workspaceRoot, args);
        }
      case "edit_file":
        {
          const parsedArgs = toolRegistry.edit_file.argsSchema.parse(call.args);
          const args = { ...parsedArgs, path: await this.resolveExistingPathCase(parsedArgs.path) };
          await this.snapshotBeforeMutation(args.path, "edit_file");
          this.fileWriteCounts.set(args.path, (this.fileWriteCounts.get(args.path) ?? 0) + 1);
          return editFileTool(this.options.workspaceRoot, args);
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
        const args = toolRegistry.bash.argsSchema.parse(call.args);
        const effectiveCommand = args.cmd.trim();
        const effectiveTimeoutSeconds = args.timeout;
        const effectiveIsBackground = args.run_in_background ?? false;
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
          ...(args.description ? { description: args.description } : {}),
          timeout: effectiveTimeoutSeconds,
          ...(effectiveIsBackground ? { run_in_background: true } : {}),
        };

        const decision = evaluateCommandPolicy(effectiveCommand, this.options.safetyProfile, localRules ? { localRules } : undefined);

        if (decision.outcome === "deny") {
          // Hard-deny + local-deny path. The command MUST NOT execute.
          // Audit + trajectory record the refusal; we throw a structured
          // PermissionDeniedError that the outer try/catch converts to a
          // tool-result error with a stable `permission_denied` code.
          await this.auditLogger.write({
            event_id: randomUUID(),
            run_id: this.options.runId,
            session_id: this.options.sessionId,
            trace_id: this.options.traceId,
            timestamp: new Date().toISOString(),
            log_schema_version: 1,
            kind: "policy_block",
            severity: "error",
            rule_id: decision.ruleId,
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
            outcome: "deny",
          });
          throw new PermissionDeniedError(decision.ruleId, decision.message);
        }

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
          ...(this.childEnvAllowlist.length > 0 ? { childEnvAllowlist: this.childEnvAllowlist } : {}),
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
                  // The shellRunner indirection uses millisecond
                  // timeouts (legacy API). Convert from the
                  // model-facing seconds value.
                  ...(effectiveTimeoutSeconds !== undefined ? { timeoutMs: effectiveTimeoutSeconds * 1000 } : {}),
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
      case "search_tools": {
        const searchArgs = toolRegistry.search_tools.argsSchema.parse(call.args);
        return executeSearchTools(searchArgs.query, this.options.runId);
      }
      case "scratchpad": {
        const scratchArgs = toolRegistry.scratchpad.argsSchema.parse(call.args);
        const normalized: {
          action: "append" | "read" | "clear";
          note?: string;
          label?: string;
        } = { action: scratchArgs.action };
        if (typeof scratchArgs.note === "string") normalized.note = scratchArgs.note;
        if (typeof scratchArgs.label === "string") normalized.label = scratchArgs.label;
        return executeScratchpad(normalized, { workspaceRoot: this.options.workspaceRoot });
      }
      case "search_memory": {
        const memArgs = toolRegistry.search_memory.argsSchema.parse(call.args);
        const { executeSearchMemory } = await import("./memory-search-tool.js");
        return executeSearchMemory(memArgs, { workspaceRoot: this.options.workspaceRoot });
      }
      case "apply_patch_edit": {
        const patchArgs = toolRegistry.apply_patch_edit.argsSchema.parse(call.args);
        return executeApplyPatch(patchArgs.patch, this.options.workspaceRoot, patchArgs.dry_run ?? false);
      }
      case "glob": {
        const globArgs = toolRegistry.glob.argsSchema.parse(call.args);
        return executeGlob(globArgs.pattern, this.options.workspaceRoot, globArgs.path);
      }
      case "eval": {
        const evalArgs = toolRegistry.eval.argsSchema.parse(call.args);
        return executeEval(evalArgs.code, evalArgs.language, evalArgs.timeout, {
          workspaceRoot: this.options.workspaceRoot,
          ...(this.childEnvAllowlist.length > 0 ? { allowlist: this.childEnvAllowlist } : {}),
        });
      }
      case "job": {
        const jobArgs = toolRegistry.job.argsSchema.parse(call.args);
        return executeJob(jobArgs, {
          workspaceRoot: this.options.workspaceRoot,
          runId: this.options.runId,
          processManager: this.backgroundProcessManager,
        });
      }
      case "diagnostics": {
        const diagArgs = toolRegistry.diagnostics.argsSchema.parse(call.args);
        return executeDiagnostics(diagArgs.path, this.options.workspaceRoot, diagArgs.kind);
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

  private async recordReadState(
    targetPath: string,
    fullyRead: boolean,
    knownSnapshot?: FreshnessSnapshot,
  ): Promise<void> {
    const absolutePath = normalizeWorkspacePath(this.options.workspaceRoot, targetPath);
    const snapshot = knownSnapshot ?? await this.getFreshnessSnapshot(targetPath, absolutePath);
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

