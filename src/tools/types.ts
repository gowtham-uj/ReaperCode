import { z } from "zod";

import { AgentArgsSchema } from "./agent.types.js";
import { AgentSwarmArgsSchema } from "./agent-swarm.types.js";
import {
  CreateSkillArgsSchema,
  TestSkillArgsSchema,
  ApproveSkillArgsSchema,
  UninstallSkillArgsSchema,
  ReloadSkillsArgsSchema,
} from "./types/skill-tools.schema.js";
import {
  CreateExtensionArgsSchema,
  ValidateExtensionArgsSchema,
  EnableExtensionArgsSchema,
  TrustExtensionArgsSchema,
  UninstallExtensionArgsSchema,
  ReloadExtensionsArgsSchema,
} from "./types/extension-tools.schema.js";
import {
  CreateHookArgsSchema,
  ListHooksArgsSchema,
  UpdateHookArgsSchema,
  ApproveHookArgsSchema,
  UninstallHookArgsSchema,
  ReloadHooksArgsSchema,
} from "./types/hook-tools.schema.js";

export const SearchToolsArgsSchema = z.object({
  query: z.string().min(1).describe("Keywords describing the capability you need, or select:tool_name for direct selection (e.g. 'background process', 'web search', 'symbol rename', 'select:read_background_output')"),
}).strict();

export const ReadFileArgsSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  })
  .strict();

export const ViewFileArgsSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict();

export const ListDirectoryArgsSchema = z
  .object({
    path: z.string().min(1),
    includeHidden: z.boolean().optional(),
  })
  .strict();

export const GrepSearchArgsSchema = z
  .object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    include: z.string().min(1).optional(),
  })
  .strict();

export const SkimFileArgsSchema = z
  .object({
    path: z.string().min(1),
    goalHint: z.string().min(1),
  })
  .strict();

export const InspectEnvironmentArgsSchema = z.object({}).strict();

export const UpdatePlanArgsSchema = z
  .object({
    markdown: z.string().min(1).optional(),
    activePlanMarkdown: z.string().min(1).optional(),
    candidate: z.boolean().optional(),
    /**
     * Optional typed plan steps. When supplied, these replace the
     * existing `state.steps` and become the canonical plan. The
     * markdown field is still rendered as the human-readable fallback.
     */
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1),
            title: z.string().min(1),
            status: z.enum(["pending", "in_progress", "completed", "blocked"]).optional(),
            detail: z.string().optional(),
            evidence: z.string().optional(),
            acceptanceCriteria: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const UpdateTodoArgsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().min(1),
            content: z.string().min(1),
            /** @deprecated use `status` instead. */
            done: z.boolean().optional(),
            status: z.enum(["pending", "in_progress", "completed", "blocked"]).optional(),
            priority: z.enum(["low", "medium", "high"]).optional(),
            evidence: z.string().optional(),
          })
          .strict(),
      ),
    append: z.boolean().optional(),
  })
  .strict();

export const CallSubagentArgsSchema = z
  .object({
    type: z.enum(["planner", "reviewer", "repair", "tester", "researcher"]),
    task: z.string().min(1),
    context: z.string().min(1).optional(),
    mode: z.enum(["blocking", "background"]).optional(),
    allowedFiles: z.array(z.string().min(1)).optional(),
    forbiddenFiles: z.array(z.string().min(1)).optional(),
    timeoutMs: z.number().int().positive().optional(),
    outputSchema: z.enum(["plan", "review", "repair", "test_strategy", "freeform"]).optional(),
  })
  .strict();

export const PollSubagentArgsSchema = z
  .object({
    jobId: z.string().min(1),
  })
  .strict();

export const CancelSubagentArgsSchema = z
  .object({
    jobId: z.string().min(1),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const CreateCheckpointArgsSchema = z
  .object({
    reason: z.string().min(1),
    toolCallIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const RestoreCheckpointArgsSchema = z
  .object({
    checkpointId: z.string().regex(/^cp-[A-Za-z0-9_-]+$/),
  })
  .strict();

export const GitStatusArgsSchema = z.object({}).strict();

export const GitDiffArgsSchema = z
  .object({
    staged: z.boolean().optional(),
    path: z.string().min(1).optional(),
    maxBytes: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict();

export const WebSearchArgsSchema = z
  .object({
    query: z.string().min(1),
    engine: z.enum(["duckduckgo", "brave", "auto"]).optional(),
    maxResults: z.number().int().min(10).max(20).optional(),
    scrapePages: z.number().int().min(10).max(20).optional(),
  })
  .strict();

export const WriteFileArgsSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
  })
  .strict();

export const ReplaceInFileArgsSchema = z
  .union([
    z
      .object({
        path: z.string().min(1),
        oldString: z.string(),
        newString: z.string(),
        allowMultiple: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        path: z.string().min(1),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        content: z.string(),
      })
      .strict(),
  ]);

export const EditFileArgsSchema = z
  .object({
    path: z.string().min(1),
    edits: z.array(
      z.object({
        oldString: z.string().describe("The exact block of text to replace"),
        newString: z.string().describe("The new block of text to insert"),
      })
    ).min(1),
  })
  .strict();

export const DeleteFileArgsSchema = z
  .object({
    path: z.string().min(1),
  })
  .strict();

export const ReplaceSymbolArgsSchema = z
  .object({
    path: z.string().min(1),
    symbolName: z.string().min(1),
    newCode: z.string(),
  })
  .strict();

export const RunShellCommandArgsSchema = z
  .object({
    cmd: z.string().min(1),
    summary: z.string().min(1).optional(),
    barrier: z.boolean().optional(),
    forceNonBarrier: z.boolean().optional(),
    isBackground: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    idleTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const SandboxServiceControlArgsSchema = z
  .object({
    action: z.enum([
      "list",
      "logs",
      "snapshot",
      "inspect_image",
      "restore_from_image",
      "exec",
      "write_file",
      "copy_to_service",
      "restart",
      "recreate",
      "start",
      "stop",
      "wait_ready",
    ]),
    service: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    sourcePath: z.string().min(1).optional(),
    targetPath: z.string().min(1).optional(),
    content: z.string().optional(),
    tail: z.number().int().positive().max(500).optional(),
    intervalMs: z.number().int().positive().max(10_000).optional(),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
  })
  .strict();

export const BrowserControlArgsSchema = z
  .object({
    action: z.enum(["navigate", "snapshot", "screenshot", "click", "type", "press", "select", "scroll", "close"]),
    url: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    ref: z.string().regex(/^e\d+$/).optional(),
    text: z.string().optional(),
    key: z.string().min(1).optional(),
    value: z.string().optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    deltaX: z.number().finite().optional(),
    deltaY: z.number().finite().optional(),
    button: z.enum(["left", "right", "middle"]).optional(),
    clear: z.boolean().optional(),
    submit: z.boolean().optional(),
    humanize: z.boolean().optional(),
    headless: z.boolean().optional(),
    width: z.number().int().positive().max(10000).optional(),
    height: z.number().int().positive().max(10000).optional(),
    screenshot: z.boolean().optional(),
    fullPage: z.boolean().optional(),
    maxTextChars: z.number().int().positive().max(100000).optional(),
    maxInteractive: z.number().int().positive().max(500).optional(),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const ComputerControlArgsSchema = z
  .object({
    action: z.enum(["screenshot", "move", "click", "double_click", "drag", "type", "press", "scroll"]),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    endX: z.number().finite().optional(),
    endY: z.number().finite().optional(),
    steps: z.number().int().positive().max(100).optional(),
    text: z.string().optional(),
    key: z.string().min(1).optional(),
    deltaX: z.number().finite().optional(),
    deltaY: z.number().finite().optional(),
    button: z.enum(["left", "right", "middle"]).optional(),
    humanize: z.boolean().optional(),
    headless: z.boolean().optional(),
    width: z.number().int().positive().max(10000).optional(),
    height: z.number().int().positive().max(10000).optional(),
    fullPage: z.boolean().optional(),
  })
  .strict();

const ScreenRegionSchema = z.union([
  z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().positive(), z.number().int().positive()]),
  z
    .object({
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .strict(),
]);

export const MouseMoveArgsSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    duration: z.number().nonnegative().max(30).optional(),
  })
  .strict();

export const MouseClickArgsSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    button: z.enum(["left", "right", "middle"]).optional(),
    clicks: z.number().int().positive().max(5).optional(),
    duration: z.number().nonnegative().max(30).optional(),
    jitterPx: z.number().nonnegative().max(50).optional(),
  })
  .strict();

export const MouseScrollArgsSchema = z
  .object({
    deltaX: z.number().int().optional(),
    deltaY: z.number().int().optional(),
    inertia: z.boolean().optional(),
  })
  .strict();

export const KeyboardTypeArgsSchema = z
  .object({
    text: z.string(),
    minDelay: z.number().nonnegative().max(10).optional(),
    maxDelay: z.number().nonnegative().max(10).optional(),
    typoProbability: z.number().min(0).max(0.15).optional(),
  })
  .strict();

export const KeyboardPressArgsSchema = z
  .object({
    keys: z.array(z.string().min(1)).min(1).max(8),
    duration: z.number().nonnegative().max(30).optional(),
    authorized: z.boolean().optional(),
  })
  .strict();

export const ScreenshotArgsSchema = z
  .object({
    region: ScreenRegionSchema.optional(),
    returnFormat: z.enum(["base64", "path"]).optional(),
  })
  .strict();

export const EmptyArgsSchema = z.object({}).strict();

export const WaitArgsSchema = z
  .object({
    seconds: z.number().nonnegative().max(300),
    jitter: z.number().nonnegative().max(60).optional(),
  })
  .strict();

export const StartLiveViewArgsSchema = z
  .object({
    host: z.string().min(1).optional(),
    port: z.number().int().positive().max(65535).optional(),
    fps: z.number().int().positive().max(20).optional(),
  })
  .strict();

export const RequestHumanApprovalArgsSchema = z
  .object({
    reason: z.string().min(1),
    contextScreenshot: z.string().optional(),
    timeoutSeconds: z.number().positive().max(3600).optional(),
    timeoutMs: z.number().positive().max(3_600_000).optional(),
  })
  .strict();

export const ReadBackgroundOutputArgsSchema = z
  .object({
    pid: z.number().int().positive(),
    lines: z.number().int().positive().optional(),
    waitForMatch: z.string().optional(),
    minWaitMs: z.number().int().positive().optional(),
  })
  .strict();

export const SignalProcessArgsSchema = z
  .object({
    pid: z.number().int().positive(),
    signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP"]),
  })
  .strict();

export const WriteToProcessArgsSchema = z
  .object({
    pid: z.number().int().positive(),
    input: z.string(),
  })
  .strict();

export const ActivateSkillArgsSchema = z
  .object({
    name: z.string().min(1),
  })
  .strict();

export const WebFetchArgsSchema = z
  .object({
    url: z.string().min(1),
    extractText: z.boolean().optional(),
  })
  .strict();

export const TaskCreateArgsSchema = z
  .object({
    subject: z.string().min(1),
    description: z.string().min(1),
    status: z.enum(["pending", "in_progress", "completed"]).default("pending"),
  })
  .strict();

export const TaskUpdateArgsSchema = z
  .object({
    taskId: z.string().min(1),
    status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional(),
    subject: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  .strict();

export const TaskListArgsSchema = z
  .object({
    status: z.enum(["pending", "in_progress", "completed"]).optional(),
  })
  .strict();

export const CompleteTaskArgsSchema = z
  .object({
    summary: z.string().min(1),
    verificationContract: z
      .object({
        intent: z.string().min(1).optional(),
        commands: z
          .array(
            z
              .object({
                id: z.string().min(1).optional(),
                command: z.string().min(1),
                purpose: z.string().min(1).optional(),
                required: z.boolean().optional(),
              })
              .strict(),
          )
          .optional(),
        expectedArtifacts: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    objectives: z
      .array(
        z
          .object({
            id: z.string().min(1),
            status: z.enum(["done", "pending", "blocked", "wont_do"]),
            note: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const AdvanceStepArgsSchema = z
  .object({
    summary: z.string().min(1),
    stepId: z.string().min(1).optional(),
    evidence: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const RequestPatchArgsSchema = z
  .object({
    reasonPatchNeeded: z.string().min(1).optional(),
    blockedStep: z
      .object({
        id: z.string().min(1),
        title: z.string().min(1),
        instruction: z.string().min(1),
      })
      .strict()
      .optional(),
    evidence: z
      .object({
        failingCommand: z.string().min(1).optional(),
        failingTest: z.string().min(1).optional(),
        errorLogs: z.string().min(1).optional(),
        stackTrace: z.string().min(1).optional(),
        observedBehavior: z.string().min(1).optional(),
        expectedBehavior: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    filesHint: z.array(z.string().min(1)).optional(),
    acceptanceCriteria: z.array(z.string().min(1)).min(1).optional(),
    resumeFromStepId: z.string().min(1).optional(),
  })
  .strict();

export const GetToolOutputArgsSchema = z
  .object({
    artifactId: z.string().min(1),
    /** Optional 1-indexed inclusive line range, e.g. { startLine: 100, endLine: 200 }. */
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    /**
     * Optional regex to search across the artifact. When set, the returned
     * content is the list of matching lines (no body), plus totalMatches.
     */
    pattern: z.string().min(1).optional(),
    /**
     * Optional dot/bracket JSON path. When set, the artifact content is parsed
     * as JSON and only the selected node is returned.
     */
    jsonPath: z.string().min(1).optional(),
    /** Cap the number of bytes returned; default 50KB to keep prompts bounded. */
    maxBytes: z.number().int().positive().optional(),
  })
  .strict();

export const DelegateSubTaskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    prompt: z.string().min(1),
    verificationCommand: z.string().min(1),
    dependsOn: z.array(z.string().min(1)).optional(),
    files: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const DelegateToPlanArgsSchema = z
  .object({
    mode: z.enum(["initial", "replan", "update_todo"]),
    current_step_id: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const ToolCallSchema = z.discriminatedUnion("name", [
  z.object({ id: z.string().min(1), name: z.literal("read_file"), args: ReadFileArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("view_file"), args: ViewFileArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("list_directory"), args: ListDirectoryArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("grep_search"), args: GrepSearchArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("skim_file"), args: SkimFileArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("inspect_environment"), args: InspectEnvironmentArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("create_checkpoint"), args: CreateCheckpointArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("restore_checkpoint"), args: RestoreCheckpointArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("git_status"), args: GitStatusArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("git_diff"), args: GitDiffArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("web_search"), args: WebSearchArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("write_file"), args: WriteFileArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("replace_in_file"), args: ReplaceInFileArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("edit_file"), args: EditFileArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("replace_symbol"), args: ReplaceSymbolArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("delete_file"), args: DeleteFileArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("run_shell_command"), args: RunShellCommandArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("sandbox_service_control"), args: SandboxServiceControlArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("browser_control"), args: BrowserControlArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("computer_control"), args: ComputerControlArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("mouse_move"), args: MouseMoveArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("mouse_click"), args: MouseClickArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("mouse_scroll"), args: MouseScrollArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("keyboard_type"), args: KeyboardTypeArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("keyboard_press"), args: KeyboardPressArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("screenshot"), args: ScreenshotArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("get_screen_size"), args: EmptyArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("get_mouse_position"), args: EmptyArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("wait"), args: WaitArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("start_live_view"), args: StartLiveViewArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("stop_live_view"), args: EmptyArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("request_human_approval"), args: RequestHumanApprovalArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("is_human_intervening"), args: EmptyArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("read_background_output"), args: ReadBackgroundOutputArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("signal_process"), args: SignalProcessArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("write_to_process"), args: WriteToProcessArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("activate_skill"), args: ActivateSkillArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("get_tool_output"), args: GetToolOutputArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("advance_step"), args: AdvanceStepArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("request_patch"), args: RequestPatchArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("complete_task"), args: CompleteTaskArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("delegate_to_plan"), args: DelegateToPlanArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("web_fetch"), args: WebFetchArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("task_create"), args: TaskCreateArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("task_update"), args: TaskUpdateArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("task_list"), args: TaskListArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("update_plan"), args: UpdatePlanArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("update_todo"), args: UpdateTodoArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("call_subagent"), args: CallSubagentArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("poll_subagent"), args: PollSubagentArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("cancel_subagent"), args: CancelSubagentArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("search_tools"), args: SearchToolsArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("agent"), args: AgentArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("agent_swarm"), args: AgentSwarmArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("create_skill"), args: CreateSkillArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("test_skill"), args: TestSkillArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("approve_skill"), args: ApproveSkillArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("uninstall_skill"), args: UninstallSkillArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("reload_skills"), args: ReloadSkillsArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("create_extension"), args: CreateExtensionArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("validate_extension"), args: ValidateExtensionArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("enable_extension"), args: EnableExtensionArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("trust_extension"), args: TrustExtensionArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("uninstall_extension"), args: UninstallExtensionArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("reload_extensions"), args: ReloadExtensionsArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("create_hook"), args: CreateHookArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("list_hooks"), args: ListHooksArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("update_hook"), args: UpdateHookArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("approve_hook"), args: ApproveHookArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("uninstall_hook"), args: UninstallHookArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("reload_hooks"), args: ReloadHooksArgsSchema }).strict(),
]);

export const ToolResultSchema = z
  .object({
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    ok: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    args: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type CallSubagentArgs = z.infer<typeof CallSubagentArgsSchema>;
export type PollSubagentArgs = z.infer<typeof PollSubagentArgsSchema>;
export type CancelSubagentArgs = z.infer<typeof CancelSubagentArgsSchema>;
export type BrowserControlArgs = z.infer<typeof BrowserControlArgsSchema>;
export type ComputerControlArgs = z.infer<typeof ComputerControlArgsSchema>;
