import { z } from "zod";

import { ApplyPatchArgsSchema } from "./apply-patch.js";
import { GlobArgsSchema } from "./glob.js";
import { JobArgsSchema } from "./job.js";
import { DiagnosticsArgsSchema } from "./diagnostics.js";
import { EvalArgsSchema } from "./eval.js";
import {
  CreateSkillArgsSchema,
  TestSkillArgsSchema,
  ApproveSkillArgsSchema,
  UninstallSkillArgsSchema,
  SkillManagerArgsSchema,
} from "./types/skill-tools.schema.js";
import {
  CreateExtensionArgsSchema,
  ValidateExtensionArgsSchema,
  EnableExtensionArgsSchema,
  TrustExtensionArgsSchema,
  UninstallExtensionArgsSchema,
  ExtensionManagerArgsSchema,
} from "./types/extension-tools.schema.js";
import {
  CreateHookArgsSchema,
  ListHooksArgsSchema,
  UpdateHookArgsSchema,
  ApproveHookArgsSchema,
  UninstallHookArgsSchema,
  HookManagerArgsSchema,
} from "./types/hook-tools.schema.js";
import {
  FileEditArgsSchema,
  FileFindArgsSchema,
  FileViewArgsSchema,
} from "./viewer/types.js";

export const SearchToolsArgsSchema = z.object({
  query: z.string().min(1).describe("Keywords describing the capability you need, or select:tool_name for direct selection (e.g. 'background process', 'web search', 'symbol rename', 'select:job')"),
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

// ── Control-plane tool schemas ───────────────────────────────────────────
// `advance_step` / `update_plan` / `update_todo` are advisory control
// signals, NOT registry tools. They are intentionally absent from
// `toolRegistry` / `CORE_TOOL_NAMES` (so they never reach the default
// model-facing wire surface), but they MUST be present in
// `ToolCallSchema` so that when the model emits them (per system-prompt
// guidance) the calls survive `ToolCallSchema.safeParse` and reach
// `splitControlToolCalls` instead of being dropped as schema rejections.
// The arg objects are non-strict on purpose: control calls are advisory,
// and unknown/extra keys are stripped rather than rejecting the whole call.

export const AdvanceStepArgsSchema = z.object({
  summary: z.string().optional(),
  stepId: z.string().optional(),
  evidence: z.union([z.string(), z.array(z.string())]).optional(),
});

export const UpdatePlanArgsSchema = z.object({
  markdown: z.string().optional(),
  activePlanMarkdown: z.string().optional(),
  candidate: z.boolean().optional(),
  steps: z.array(z.unknown()).optional(),
});

export const UpdateTodoArgsSchema = z.object({
  append: z.boolean().optional(),
  items: z.array(
    z.object({
      id: z.string().min(1),
      content: z.string().min(1),
      status: z.string().optional(),
      priority: z.string().optional(),
      evidence: z.string().optional(),
      done: z.boolean().optional(),
    }),
  ),
});

export const ToolCallSchema = z.discriminatedUnion("name", [
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
  z.object({ id: z.string().min(1), name: z.literal("file_find"), args: FileFindArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("file_edit"), args: FileEditArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("edit_file"), args: EditFileArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("delete_file"), args: DeleteFileArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("bash"), args: BashArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("browser_control"), args: BrowserControlArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("activate_skill"), args: ActivateSkillArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("web_fetch"), args: WebFetchArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("search_tools"), args: SearchToolsArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("search_memory"), args: SearchMemoryArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("scratchpad"), args: ScratchpadArgsSchema }).strict(),
  // Authoring: one entry per family, each dispatching on `action`.
  z.object({ id: z.string().min(1), name: z.literal("skill_manager"), args: SkillManagerArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("extension_manager"), args: ExtensionManagerArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("hook_manager"), args: HookManagerArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("apply_patch_edit"), args: ApplyPatchArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("glob"), args: GlobArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("job"), args: JobArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("diagnostics"), args: DiagnosticsArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("eval"), args: EvalArgsSchema }).strict(),
  // Control-plane signals (advisory; see schemas above).
  z.object({ id: z.string().min(1), name: z.literal("advance_step"), args: AdvanceStepArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("update_plan"), args: UpdatePlanArgsSchema }).strict(),
  z.object({ id: z.string().min(1), name: z.literal("update_todo"), args: UpdateTodoArgsSchema }).strict(),
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
 * Pi-parity: per-tool streaming vocabulary. The runtime emits these as
 * an `AsyncIterable` so callers (live loops, trajectory sinks, UI
 * dashboards) can react to a tool call in real time instead of waiting
 * for the full buffered result.
 *
 *   - `tool_execution_start`   — dispatch has begun
 *   - `tool_execution_delta`   — partial output chunk. Part of the
 *                                vocabulary, but nothing emits it today:
 *                                `executeStream` yields start, then the
 *                                complete or failed event, with no
 *                                interim chunks for any tool.
 *   - `tool_execution_complete` — the final buffered `ToolResult`
 *   - `tool_execution_failed`  — a non-recoverable error surfaced from
 *                                the executor; the loop should stop
 *                                dispatching further tools for this batch.
 */
export type ExecutionEvent =
  | { type: "tool_execution_start"; data: { toolCallId: string; name: string; args: Record<string, unknown> } }
  | { type: "tool_execution_delta"; data: { toolCallId: string; delta: string } }
  | { type: "tool_execution_complete"; data: { toolCallId: string; result: ToolResult } }
  | { type: "tool_execution_failed"; data: { toolCallId: string; error: { code: string; message: string } } };

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
