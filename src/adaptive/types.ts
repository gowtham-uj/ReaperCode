/**
 * Adaptive Intelligence + Swarm types.
 *
 * Every type here is generic across languages, frameworks, and task
 * families. The runtime uses these as the contract for:
 *  - skills (reusable procedural knowledge)
 *  - persistent memory (project / user / machine / transient / secret)
 *  - visual artifacts (screenshots, videos)
 *  - hooks (in-process event observation and gating)
 *
 * Cross-cutting rules:
 *  - All records carry provenance (`source`, `createdBy`, `createdAt`).
 *  - All records are JSON-serializable. No Date objects, no Buffers.
 *  - Optional fields use `| undefined` to satisfy strict mode.
 */

export type SkillScope = "project" | "user" | "builtin";
export type SkillType = "prompt" | "workflow" | "checklist" | "tool-guide";

export interface SkillValidationSpec {
  commands: { id: string; command: string; cwd?: string }[];
}

export interface SkillMemoryPolicy {
  mayReadProjectMemory: boolean;
  mayWriteProjectMemory: boolean;
  mayReadUserMemory: boolean;
  mayWriteUserMemory: boolean;
}

export interface SkillReference {
  name: string;
  path: string;
  kind: "text" | "code" | "data" | "binary";
}

export interface ReaperSkill {
  name: string;
  description: string;
  type: SkillType;
  scope: SkillScope;
  whenToUse: string;
  disableAutoInvocation: boolean;
  /**
   * When true, the skill body is never returned from `activate_skill`
   * even if the skill is in the registry. This is the canonical
   * field; `disableAutoInvocation` is the legacy alias. The
   * activate_skill tool checks both.
   */
  disableModelInvocation?: boolean;
  arguments: string[];
  allowedTools: string[];
  validation?: SkillValidationSpec | undefined;
  memoryPolicy: SkillMemoryPolicy;
  body: string;
  references: SkillReference[];
  sourcePath: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Path to the directory the skill lives in, used for $REAPER_SKILL_DIR analog. */
  skillDir: string;
}

export type SkillUsageMode = "manual" | "auto" | "workflow" | "subagent";
export type SkillOutcome = "success" | "failed" | "partial" | "skipped";

export interface SkillUsageRecord {
  skillName: string;
  scope: SkillScope;
  runId: string;
  taskId?: string | undefined;
  invokedAt: string;
  invocationMode: SkillUsageMode;
  outcome: SkillOutcome;
  evidence: string[];
  validationCommandsRun: string[];
}

export interface SkillHealth {
  skillName: string;
  successCount: number;
  failureCount: number;
  lastUsedAt?: string | undefined;
  lastValidatedAt?: string | undefined;
  disabledReason?: string | undefined;
  confidence: number;
}

export type MemoryScope = "transient" | "project" | "user" | "machine" | "secret";
export type MemoryKind =
  | "project_fact"
  | "user_preference"
  | "workflow_recipe"
  | "debugging_lesson"
  | "command_recipe"
  | "dependency_note"
  | "architecture_note"
  | "pitfall"
  | "environment_fact";

export type MemorySource =
  | "user_explicit"
  | "agent_inferred"
  | "successful_validation"
  | "failed_attempt"
  | "imported_skill"
  | "screenshot_analysis";

export interface MemoryEvidence {
  runId?: string | undefined;
  command?: string | undefined;
  file?: string | undefined;
  screenshot?: string | undefined;
  excerpt: string;
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  evidence: MemoryEvidence[];
  confidence: number;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | undefined;
  tags: string[];
  sensitive: boolean;
  editable: boolean;
}

export type MemoryDecisionAction = "store" | "skip" | "ask" | "redact_then_store";

export interface Redaction {
  original: string;
  redacted: string;
  reason: string;
}

export interface MemoryDecision {
  action: MemoryDecisionAction;
  scope?: MemoryScope | undefined;
  reason: string;
  redactions?: Redaction[] | undefined;
}

/* -------------------------------------------------------------------------- */
/*                              Visual                                         */
/* -------------------------------------------------------------------------- */

export type VisualArtifactSource =
  | "user_upload"
  | "browser_capture"
  | "app_capture"
  | "test_artifact"
  | "workflow";

export interface VisualArtifact {
  id: string;
  path: string;
  mimeType: string;
  source: VisualArtifactSource;
  createdAt: string;
  hash: string;
  width?: number | undefined;
  height?: number | undefined;
  frameCount?: number | undefined;
  relatedRunId?: string | undefined;
}

export type UIElementKind =
  | "button" | "input" | "modal" | "toast" | "menu" | "table" | "card" | "unknown";

export interface UIElement {
  kind: UIElementKind;
  label?: string | undefined;
  bbox?: [number, number, number, number] | undefined;
  confidence: number;
}

export type VisualErrorKind =
  | "console_error" | "stack_trace" | "http_error" | "layout_break"
  | "blank_screen" | "crash_dialog" | "test_failure" | "unknown";

export interface VisualErrorSignal {
  kind: VisualErrorKind;
  text?: string | undefined;
  bbox?: [number, number, number, number] | undefined;
  confidence: number;
}

export interface LayoutFinding {
  description: string;
  affectedElements: string[];
  severity: "low" | "medium" | "high";
}

export interface ActionableFinding {
  description: string;
  suggestedAction: string;
  confidence: number;
}

export interface VisualEvidence {
  method: "vlm" | "ocr" | "metadata";
  excerpt: string;
  confidence: number;
}

export interface VisualAnalysisResult {
  artifactId: string;
  summary: string;
  detectedText: string[];
  uiElements: UIElement[];
  errors: VisualErrorSignal[];
  layoutFindings: LayoutFinding[];
  actionableFindings: ActionableFinding[];
  confidence: number;
  modelUsed?: string | undefined;
  evidence: VisualEvidence[];
}

export interface VisualContextBridgeOutput {
  observations: { kind: "error" | "ui_state" | "layout" | "trace"; text: string }[];
  suggestedSearches: string[];
  suspectedFiles: string[];
  suspectedCommands: string[];
  validationIdeas: string[];
  memoryCandidates: MemoryRecord[];
}

/* -------------------------------------------------------------------------- */
/*                              Hooks                                           */
/* -------------------------------------------------------------------------- */

export type HookEventName =
  | "SessionStart" | "SessionEnd" | "UserPromptSubmit" | "Stop"
  | "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
  | "PreSkillInvoke" | "PostSkillInvoke" | "SkillCreated" | "SkillSelected"
  | "MemoryCandidate" | "MemoryWritten" | "MemoryRejected"
  | "VisualArtifactAdded" | "VisualAnalysisCompleted"
  | "PreCompact" | "PostCompact"
  | "FileChanged"
  | "AssistantStreamDelta" | "AssistantStreamComplete"
  | "AssistantMessageDelta" | "AssistantMessageComplete"
  | "ReasoningDelta" | "ReasoningComplete"
  | "EngineTurnComplete";

export interface HookEvent {
  name: HookEventName;
  payload: Record<string, unknown>;
  /** When true, the hook may block the main flow. */
  blockable: boolean;
}

export interface HookResult {
  /** Allow the operation to proceed. */
  allow: boolean;
  /** Optional text to append to the model context. */
  message?: string | undefined;
  /** Optional block reason (used when allow=false). */
  reason?: string | undefined;
}

export type HookHandler = (event: HookEvent) => HookResult | Promise<HookResult>;

/**
 * Typed payload shapes for the streaming-reasoning events consumed by
 * the TUI rendering layer. The engine emits these alongside
 * `AssistantStreamDelta` / `AssistantStreamComplete`; the TUI uses them
 * to render the chat bubble + collapsible reasoning block in
 * `MessageCard`. Names are kept as separate event kinds (rather than
 * discriminated union entries on the existing stream events) so the
 * engine can fan out reasoning tokens to multiple subscribers without
 * re-shaping the existing stream payload.
 */
export interface AssistantMessageDeltaPayload {
  /** Increment of assistant text to append to the streaming bubble. */
  text: string;
  /** Always "assistant" for this event kind. */
  role: "assistant";
  /** Always false for the *Delta variant. */
  done: false;
}

export interface AssistantMessageCompletePayload {
  /** Full assistant text emitted in this turn. */
  text: string;
  /** Always "assistant" for this event kind. */
  role: "assistant";
  /** Always true for the *Complete variant. */
  done: true;
}

export interface ReasoningDeltaPayload {
  /** Increment of reasoning text to append to the reasoning block. */
  text: string;
  /** Always "assistant" for this event kind — reasoning is the
   *  model's own internal trace, not a user-visible message. */
  role: "assistant";
  /** Always false for the *Delta variant. */
  done: false;
}

export interface ReasoningCompletePayload {
  /** Full reasoning text emitted in this turn. May be empty if the
   *  model produced no reasoning for this turn. */
  text: string;
  /** Always "assistant" for this event kind. */
  role: "assistant";
  /** Always true for the *Complete variant. */
  done: true;
}

/**
 * Typed payload for the engine-level turn-completion signal. The
 * engine emits this event when a model turn ends with a non-empty
 * assistant message and zero tool calls — i.e. the model is saying
 * "task complete" without explicitly emitting `complete_task`. The
 * TUI uses this event to transition cleanly to phase="done" without
 * waiting for the next prompt-submit cycle.
 *
 * This event is also fired when a `complete_task` signal produces a
 * successful `assistant_message` via the normal `summarize` path,
 * so TUI consumers do not need to subscribe to both surfaces.
 */
export interface EngineTurnCompletePayload {
  /** Final assistant message for this turn (may be empty when the
   *  model emitted only a `complete_task` signal). */
  assistantMessage: string;
  /** Tool results accumulated up to the end of this turn. May be
   *  empty for `needs_model` runs that return without any tool
   *  execution. */
  toolResults: Array<{ name: string; ok: boolean }>;
  /** True when the turn ended because the model emitted a non-empty
   *  assistant message with zero tool calls (implicit completion).
   *  False when the turn ended via an explicit `complete_task`
   *  signal from the model or via an explicit_tools request. */
  implicit: boolean;
}

/* -------------------------------------------------------------------------- */
/*                              Model Capabilities                             */
/* -------------------------------------------------------------------------- */

/**
 * Feature set that the configured model may or may not support. The
 * runtime probes the model on first use and caches the result. Visual
 * features (screenshot analysis, image-aware subagents) are *opt-in*:
 * if the model does not support them, the visual subsystem no-ops.
 */
export interface ModelCapabilities {
  /** The model can accept image inputs in its request payload. */
  imageInput: boolean;
  /** The model can accept video inputs (frame sequences). */
  videoInput: boolean;
  /** The model can call tools (function calling). */
  toolUse: boolean;
  /** The model can stream responses. */
  streaming: boolean;
  /** The model can call multiple tools in parallel in a single turn. */
  parallelToolUse: boolean;
  /** Max prompt window in tokens (informational, for budget planning). */
  maxInputTokens?: number;
  /** Max output window in tokens (informational). */
  maxOutputTokens?: number;
  /** Capability flavor hints for telemetry. */
  detectedAt: string;
  source: "explicit" | "probe" | "default";
}

export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  imageInput: false,
  videoInput: false,
  toolUse: true,
  streaming: true,
  parallelToolUse: true,
  detectedAt: new Date(0).toISOString(),
  source: "default",
};
