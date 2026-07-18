import { z } from "zod";

import { ApplyPatchArgsSchema } from "./apply-patch.js";
import { GlobArgsSchema } from "./glob.js";
import { EvalArgsSchema } from "./eval.js";
import { JobArgsSchema } from "./job.js";
import { DiagnosticsArgsSchema } from "./diagnostics.js";
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
import {
  FileEditArgsSchema,
  FileFindArgsSchema,
  FileScrollArgsSchema,
  FileViewArgsSchema,
} from "./viewer/types.js";

export const SearchToolsArgsSchema = z.object({
  query: z.string().min(1).describe("Keywords describing the capability you need, or select:tool_name for direct selection (e.g. 'background process', 'web search', 'symbol rename', 'select:read_background_output')"),
}).strict();

export const SearchMemoryArgsSchema = z.object({
  query: z.string().describe("Natural-language query to match against prior session summaries."),
  max_hits: z.number().int().positive().optional().describe("Cap on number of results (default 20)."),
  include_body: z.boolean().optional().describe("Include the summary body in the response, not just metadata (default true)."),
  session_id: z.string().optional().describe("Limit to summaries from this named session."),
  since: z.string().optional().describe("Limit to summaries at or after this ISO-8601 timestamp."),
}).strict();

export const ScratchpadArgsSchema = z
  .object({
    action: z
      .enum(["append", "read", "clear"])
      .describe("append a note, read the scratch file, or clear it"),
    note: z
      .string()
      .min(1)
      .optional()
      .describe("Note text to append (required for action=append)"),
    label: z
      .string()
      .min(1)
      .optional()
      .describe("Optional short label for the appended note heading"),
  })
  .strict();



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

export const BashArgsSchema = z
  .object({
    cmd: z.string().min(1).describe("Shell command to run in the workspace"),
    description: z.string().min(1).optional().describe("Short human-readable intent"),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .describe("Optional command timeout in SECONDS (1-3600); defaults to 60"),
    run_in_background: z
      .boolean()
      .optional()
      .describe("Run as a tracked background task"),
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
  z.object({ id: z.string().min(1), name: z.literal("file_view"), args: FileViewArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("file_scroll"), args: FileScrollArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("file_find"), args: FileFindArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("file_edit"), args: FileEditArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("replace_in_file"), args: ReplaceInFileArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("edit_file"), args: EditFileArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("delete_file"), args: DeleteFileArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("bash"), args: BashArgsSchema }).strict(),
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
  z.object({ id: z.string().min(1), name: z.literal("web_fetch"), args: WebFetchArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("search_tools"), args: SearchToolsArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("search_memory"), args: SearchMemoryArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("scratchpad"), args: ScratchpadArgsSchema }).strict(),
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
  z.object({ id: z.string().min(1), name: z.literal("apply_patch_edit"), args: ApplyPatchArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("glob"), args: GlobArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("eval"), args: EvalArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("job"), args: JobArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("diagnostics"), args: DiagnosticsArgsSchema }).strict(),
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

/**
 * Per-tool resource keys used by the parallel scheduler's island partitioner.
 *
 * Shape expected by the partitioner:
 * - `declared`: whether the tool declared any non-default resources. If false
 *   (e.g. an unknown tool or a no-default-static tool), the partitioner
 *   treats the call as barrier-only (sequential) to be safe.
 * - `keys`: the union of all resource keys the tool touches (read, write,
 *   and lock). Two calls with overlapping keys cannot run in parallel
 *   in the same batch.
 */
export interface ResourceKeys {
  declared?: boolean;
  keys?: readonly string[];
}

export const EMPTY_RESOURCE_KEYS: ResourceKeys = Object.freeze({});
export type BrowserControlArgs = z.infer<typeof BrowserControlArgsSchema>;
export type ComputerControlArgs = z.infer<typeof ComputerControlArgsSchema>;
