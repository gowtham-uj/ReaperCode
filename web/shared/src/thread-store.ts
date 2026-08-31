/**
 * Client-side fold of app-server notifications into thread state.
 *
 * Mirrors `SessionProjection` on the server, but consumes the *projected*
 * notifications rather than raw RuntimeEvents. The server remains the source
 * of truth; this is a local replica so the UI can render without round-trips.
 *
 * This module imports no UI framework, and must not. It is consumed by the test
 * fixture, the BFF, and the browser app — the app-server's protocol is
 * frontend-agnostic and this layer inherits that, so a second surface reuses
 * the fold instead of reimplementing it and drifting from the server.
 *
 * Every function here is pure and returns new objects along the mutated path
 * (structural sharing). Reference equality is the contract: it lets a consumer
 * decide whether a subtree changed without deep comparison. Mutating in place
 * would make a token delta for one item indistinguishable from any other.
 */

import type {
  AppStep,
  AppThread,
  AppThreadItem,
  AppThreadStatus,
  AppTurn,
  AppTurnStatus,
  TokenUsage,
} from "./types.js";

export type ThreadsState = Readonly<Record<string, AppThread>>;

/**
 * Mirrors the server-side cap in `session-projection.ts`. The server caps the
 * item it stores, but live `outputDelta` notifications are uncapped by design —
 * without this, a long build would grow the browser's copy without bound.
 */
const MAX_AGGREGATED_OUTPUT_CHARS = 256 * 1024;
const OUTPUT_TRUNCATION_MARKER = "[... earlier output truncated ...]\n";

function capOutput(text: string): string {
  if (text.length <= MAX_AGGREGATED_OUTPUT_CHARS) return text;
  const tail = text.slice(-(MAX_AGGREGATED_OUTPUT_CHARS - OUTPUT_TRUNCATION_MARKER.length));
  return `${OUTPUT_TRUNCATION_MARKER}${tail}`;
}

export function emptyThreads(): ThreadsState {
  return {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function ensureThread(state: ThreadsState, threadId: string): AppThread {
  return (
    state[threadId] ?? {
      id: threadId,
      turns: [],
      latestSequence: 0,
    }
  );
}

function withThread(state: ThreadsState, thread: AppThread): ThreadsState {
  return { ...state, [thread.id]: thread };
}

function ensureTurn(thread: AppThread, turnId: string): AppTurn {
  return thread.turns.find((turn) => turn.id === turnId) ?? { id: turnId, status: "inProgress", items: [] };
}

function withTurn(thread: AppThread, turn: AppTurn): AppThread {
  const index = thread.turns.findIndex((existing) => existing.id === turn.id);
  const turns = index >= 0
    ? [...thread.turns.slice(0, index), turn, ...thread.turns.slice(index + 1)]
    : [...thread.turns, turn];
  return { ...thread, turns };
}

function withItem(turn: AppTurn, item: AppThreadItem): AppTurn {
  const index = turn.items.findIndex((existing) => existing.id === item.id);
  const items = index >= 0
    ? [...turn.items.slice(0, index), item, ...turn.items.slice(index + 1)]
    : [...turn.items, item];
  return { ...turn, items };
}

function findItem(turn: AppTurn, itemId: string): AppThreadItem | undefined {
  return turn.items.find((item) => item.id === itemId);
}

/**
 * Apply one notification. Returns the same state object when nothing changed
 * so callers can skip a notify().
 */
export function applyNotification(
  state: ThreadsState,
  method: string,
  params: Record<string, unknown>,
): ThreadsState {
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  const turnId = typeof params.turnId === "string" ? params.turnId : undefined;

  if (!threadId) return state;

  let thread = ensureThread(state, threadId);
  if (typeof params.sequence === "number" && params.sequence > thread.latestSequence) {
    thread = { ...thread, latestSequence: params.sequence };
  }

  switch (method) {
    case "thread/started": {
      const raw = asRecord(params.thread);
      return withThread(state, raw ? mergeThreadMetadata(thread, raw) : thread);
    }
    case "thread/status/changed":
      return withThread(
        state,
        params.status === undefined
          ? thread
          : { ...thread, status: params.status as AppThreadStatus },
      );
    case "thread/name/updated":
      return withThread(state, { ...thread, name: String(params.threadName ?? "") });
    case "thread/closed":
      return withThread(state, { ...thread, status: "notLoaded" });
    case "thread/tokenUsage/updated":
      return withThread(state, { ...thread, tokenUsage: params.tokenUsage as TokenUsage });

    case "turn/queued":
    case "turn/interruptRequested": {
      if (!turnId) return withThread(state, thread);
      return withThread(state, withTurn(thread, ensureTurn(thread, turnId)));
    }

    case "turn/started":
    case "turn/completed": {
      const raw = asRecord(params.turn);
      if (!raw || typeof raw.id !== "string") {
        return turnId ? withThread(state, withTurn(thread, ensureTurn(thread, turnId))) : withThread(state, thread);
      }
      return withThread(state, withTurn(thread, normalizeTurn(raw, ensureTurn(thread, raw.id))));
    }

    case "item/started":
    case "item/completed": {
      if (!turnId) return withThread(state, thread);
      const raw = asRecord(params.item);
      if (!raw || typeof raw.id !== "string" || typeof raw.type !== "string") {
        return withThread(state, thread);
      }
      const turn = ensureTurn(thread, turnId);
      return withThread(state, withTurn(thread, withItem(turn, raw as unknown as AppThreadItem)));
    }

    case "item/agentMessage/delta": {
      if (!turnId) return withThread(state, thread);
      const itemId = String(params.itemId ?? "");
      const turn = ensureTurn(thread, turnId);
      const existing = findItem(turn, itemId);
      const base: Extract<AppThreadItem, { type: "agentMessage" }> =
        existing?.type === "agentMessage"
          ? existing
          : { type: "agentMessage", id: itemId, text: "", phase: "final_answer" };
      const next = { ...base, text: `${base.text}${String(params.delta ?? "")}` };
      return withThread(state, withTurn(thread, withItem(turn, next)));
    }

    case "item/reasoning/textDelta": {
      if (!turnId) return withThread(state, thread);
      const itemId = String(params.itemId ?? "");
      const turn = ensureTurn(thread, turnId);
      const existing = findItem(turn, itemId);
      const base: Extract<AppThreadItem, { type: "reasoning" }> =
        existing?.type === "reasoning" ? existing : { type: "reasoning", id: itemId, summary: [], content: [] };
      const next = { ...base, content: [...base.content, String(params.delta ?? "")] };
      return withThread(state, withTurn(thread, withItem(turn, next)));
    }

    case "item/commandExecution/outputDelta": {
      if (!turnId) return withThread(state, thread);
      const itemId = String(params.itemId ?? "");
      const turn = ensureTurn(thread, turnId);
      const existing = findItem(turn, itemId);
      const base: Extract<AppThreadItem, { type: "commandExecution" }> =
        existing?.type === "commandExecution"
          ? existing
          : { type: "commandExecution", id: itemId, command: "", status: "inProgress" };
      const next = {
        ...base,
        aggregatedOutput: capOutput(`${base.aggregatedOutput ?? ""}${String(params.delta ?? "")}`),
      };
      return withThread(state, withTurn(thread, withItem(turn, next)));
    }

    default:
      // Unknown methods still advance latestSequence so the reconnect cursor
      // stays correct as the protocol grows.
      return withThread(state, thread);
  }
}

/**
 * Fold a `thread` object — from a `thread/started` notification or a
 * `thread/start`/`thread/resume` RPC result — into thread state.
 *
 * `envelope` is the surrounding RPC result, which carries `cwd`,
 * `modelProvider`, `model`, and `approvalPolicy` alongside (not inside) the
 * thread object. Notifications have no envelope.
 */
export function mergeThreadMetadata(
  thread: AppThread,
  raw: Record<string, unknown>,
  envelope?: Record<string, unknown>,
): AppThread {
  const next: AppThread = { ...thread };
  if (typeof raw.sessionId === "string") next.sessionId = raw.sessionId;
  if (typeof raw.preview === "string") next.preview = raw.preview;
  if (typeof raw.ephemeral === "boolean") next.ephemeral = raw.ephemeral;
  const cwd = raw.cwd ?? envelope?.cwd;
  if (typeof cwd === "string") next.cwd = cwd;
  const modelProvider = raw.modelProvider ?? envelope?.modelProvider;
  if (typeof modelProvider === "string" || modelProvider === null) {
    next.modelProvider = modelProvider;
  }
  const model = raw.model ?? envelope?.model;
  if (typeof model === "string" || model === null) next.model = model;
  if (typeof raw.createdAt === "string") next.createdAt = raw.createdAt;
  if (typeof raw.updatedAt === "string") next.updatedAt = raw.updatedAt;
  if (typeof raw.name === "string") next.name = raw.name;
  if (raw.status !== undefined) next.status = raw.status as AppThreadStatus;
  if (envelope?.approvalPolicy !== undefined) next.approvalPolicy = String(envelope.approvalPolicy);
  if (Array.isArray(raw.turns)) {
    next.turns = (raw.turns as Array<Record<string, unknown>>)
      .filter((turn) => typeof turn.id === "string")
      .map((turn) => normalizeTurn(turn, { id: String(turn.id), status: "inProgress", items: [] }));
  }
  return next;
}

/** Fold a thread object into `state`, creating the thread if needed. */
export function seedThread(
  state: ThreadsState,
  raw: Record<string, unknown>,
  envelope?: Record<string, unknown>,
): ThreadsState {
  const threadId = String(raw.id ?? "");
  if (!threadId) return state;
  return withThread(state, mergeThreadMetadata(ensureThread(state, threadId), raw, envelope));
}

/**
 * Replace a thread's turns wholesale — the authoritative-snapshot path
 * (`thread/resume` initial page). Distinct from `hydrateFromTurns`, which
 * merges an older page *behind* live turns.
 */
export function replaceTurns(
  state: ThreadsState,
  threadId: string,
  turns: Array<Record<string, unknown>>,
): ThreadsState {
  const thread = ensureThread(state, threadId);
  const next = turns
    .filter((raw) => raw.id !== undefined)
    .map((raw) => normalizeTurn(raw, { id: String(raw.id), status: "inProgress", items: [] }));
  return withThread(state, { ...thread, turns: next });
}

function normalizeTurn(raw: Record<string, unknown>, fallback: AppTurn): AppTurn {
  const turn: AppTurn = {
    id: String(raw.id ?? fallback.id),
    status: (raw.status as AppTurnStatus) ?? fallback.status,
    items: fallback.items,
  };
  const error = asRecord(raw.error);
  if (error) {
    turn.error = {
      message: String(error.message ?? ""),
      ...(typeof error.additionalDetails === "string"
        ? { additionalDetails: error.additionalDetails }
        : {}),
    };
  }
  if (Array.isArray(raw.items)) {
    turn.items = (raw.items as unknown[])
      .map(asRecord)
      .filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item!.id === "string" && typeof item!.type === "string",
      )
      .map((item) => item as unknown as AppThreadItem);
  }
  return turn;
}

/**
 * Merge paginated history into a thread without disturbing live turns.
 * Mirrors `SessionProjection.hydrate` — history is *prepended*, and a turn
 * already present live wins over its journal copy.
 */
export function hydrateFromTurns(
  state: ThreadsState,
  threadId: string,
  turns: Array<Record<string, unknown>>,
): ThreadsState {
  const thread = ensureThread(state, threadId);
  const liveIds = new Set(thread.turns.map((turn) => turn.id));
  const prepend = turns
    .filter((raw) => typeof raw.id === "string" && !liveIds.has(String(raw.id)))
    .map((raw) => normalizeTurn(raw, { id: String(raw.id), status: "inProgress", items: [] }));
  if (prepend.length === 0) return state;
  return withThread(state, { ...thread, turns: [...prepend, ...thread.turns] });
}

/**
 * Group a turn's flat item list into steps — one model request plus the tools
 * it called. A step boundary is an agentMessage or reasoning item that follows
 * a tool item, which is exactly where the model regained control.
 *
 * Derived here rather than sent over the wire: the protocol has no step
 * concept, and inferring it client-side needs no server change.
 */
export function deriveSteps(turn: AppTurn): AppStep[] {
  const steps: AppStep[] = [];
  let current: AppThreadItem[] = [];
  let sawTool = false;

  const isTool = (item: AppThreadItem): boolean =>
    item.type === "commandExecution" || item.type === "fileChange" || item.type === "dynamicToolCall";
  const isModelTurn = (item: AppThreadItem): boolean =>
    item.type === "agentMessage" || item.type === "reasoning";

  for (const item of turn.items) {
    if (isModelTurn(item) && sawTool && current.length > 0) {
      steps.push({ id: `${turn.id}:step-${steps.length}`, items: current });
      current = [];
      sawTool = false;
    }
    current.push(item);
    if (isTool(item)) sawTool = true;
  }
  if (current.length > 0) {
    steps.push({ id: `${turn.id}:step-${steps.length}`, items: current });
  }
  return steps;
}

/**
 * Read-only inspection tools, from `src/tools/registry.ts`. A step made only
 * of these changed nothing, so it collapses by default — the transcript should
 * spend its vertical space on edits, commands, and failures.
 *
 * Anything absent from this set is treated as consequential and stays visible.
 * That is the safe direction to be wrong in: a new mutating tool renders
 * prominently until someone classifies it, rather than hiding silently.
 */
const EXPLORATION_TOOLS: ReadonlySet<string> = new Set([
  "file_view",
  "file_scroll",
  "file_find",
  "view_file",
  "skim_file",
  "list_directory",
  "grep_search",
  "glob",
  "git_status",
  "git_diff",
  "search_memory",
  "search_tools",
  "get_tool_output",
  "read_background_output",
  "inspect_environment",
  "diagnostics",
]);

/** True when this item only inspected state and changed nothing. */
export function isExplorationItem(item: AppThreadItem): boolean {
  return item.type === "dynamicToolCall" && EXPLORATION_TOOLS.has(item.tool);
}

/**
 * A step is collapsible when every item in it is exploration. One edit, one
 * command, or one agent message is enough to keep the whole step expanded.
 */
export function isExplorationStep(step: AppStep): boolean {
  return step.items.length > 0 && step.items.every(isExplorationItem);
}
