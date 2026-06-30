/**
 * Swarm types — model-driven subagent runtime.
 *
 * A subagent is a *single* delegated agent spawned by the main agent
 * through a tool call. It has its own conversation context, tool
 * allowlist, and model. The result is a compact text summary returned
 * to the main agent. The main agent never sees the subagent's full
 * context — only the final summary.
 *
 * Subagents cannot spawn other subagents by default. The Agent tool is
 * excluded from the subagent's allowlist unless explicitly re-added.
 */

export type SubagentStatus =
  | "idle"
  | "running_foreground"
  | "running_background"
  | "completed"
  | "failed"
  | "killed";

/** Tool policy for a subagent. */
export type ToolPolicyMode = "inherit" | "allowlist";

export interface ToolPolicy {
  mode: ToolPolicyMode;
  /** When mode is `allowlist`, the names of the tools the subagent may
   *  call. When `inherit`, the subagent uses the parent's tool set
   *  minus the entries in `excludeTools`. */
  tools: string[];
  /** Tools to *remove* from the inherited set. Used in conjunction with
   *  `inherit` mode (e.g. to forbid the subagent from spawning more
   *  subagents). */
  excludeTools: string[];
}

/** Definition of a built-in subagent type. Loaded from YAML at boot. */
export interface AgentTypeDefinition {
  /** Type id, e.g. "coder", "explore", "plan". */
  name: string;
  /** One-line description (used in the Agent tool's schema). */
  description: string;
  /** Free-form, longer description of when to use this type. */
  whenToUse: string;
  /** Default model alias; null means inherit parent's model. */
  defaultModel: string | null;
  /** Tool policy. */
  toolPolicy: ToolPolicy;
  /** Whether this type supports background execution. */
  supportsBackground: boolean;
  /** System prompt fragment injected as `ROLE_ADDITIONAL`. */
  systemPromptAddition: string;
  /** Path to the YAML file the type was loaded from (for diagnostics). */
  sourcePath: string;
}

/** Per-instance launch spec. */
export interface AgentLaunchSpec {
  agentId: string;
  subagentType: string;
  modelOverride: string | null;
  effectiveModel: string | null;
  createdAt: string;
}

/** Per-instance record. */
export interface AgentInstanceRecord {
  agentId: string;
  subagentType: string;
  status: SubagentStatus;
  description: string;
  createdAt: string;
  updatedAt: string;
  lastTaskId: string | null;
  launchSpec: AgentLaunchSpec;
}

/** Output of a single foreground subagent run. */
export interface SubagentResult {
  agentId: string;
  actualSubagentType: string;
  requestedSubagentType: string;
  resumed: boolean;
  status: "completed" | "failed" | "killed";
  /** Final summary text (only visible to main agent). Empty on failure. */
  summary: string;
  /** Error message if failed. */
  error?: string | undefined;
  /** Wall time in ms. */
  durationMs: number;
  /** Number of model turns the subagent took. */
  turns: number;
  /** Number of tool calls. */
  toolCalls: number;
  /** Tokens used. */
  tokensUsed: number;
  /** Path to the per-instance output transcript. */
  outputPath: string;
}

/** Input to a foreground run. */
export interface ForegroundRunRequest {
  description: string;
  prompt: string;
  requestedType: string;
  model: string | null;
  resume: string | null;
  /** Max wall time in seconds. null = no timeout. */
  timeout: number | null;
}

/** Lightweight log event for the per-instance wire file. */
export type WireEvent =
  | { kind: "stage"; name: string; at: string }
  | { kind: "tool_call"; name: string; at: string }
  | { kind: "tool_result"; status: "ok" | "error"; brief: string; at: string }
  | { kind: "text"; text: string; at: string }
  | { kind: "summary"; text: string; at: string }
  | { kind: "error"; message: string; at: string };
