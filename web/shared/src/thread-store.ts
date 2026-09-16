/**
 * Client-side fold of app-server notifications into thread state.
 *
 * Mirrors `SessionProjection` on the server, but consumes the *projected*
 * notifications rather than raw RuntimeEvents. The server remains the source
 * of truth; this is a local replica so the UI can render without round-trips.
 *
 * This module imports no UI framework, and must not. It is consumed by the test
 * fixture, the app-server's browser gateway, and the browser app — the
 * app-server's protocol is frontend-agnostic and this layer inherits that, so
 * a second surface reuses the fold instead of reimplementing it and drifting
 * from the server.
 *
 * Every function here is pure and returns new objects along the mutated path
 * (structural sharing). Reference equality is the contract: it lets a consumer
 * decide whether a subtree changed without deep comparison. Mutating in place
 * would make a token delta for one item indistinguishable from any other.
 */

import {
  BROWSER_SURFACE_TOOL,
  type BrowserInteractiveElement,
  type BrowserSurface,
  type PlanStep,
  type TodoItem,
  type VerificationSurface,
} from "./types.js";
import type {
  AppStep,
  AppThread,
  AppThreadItem,
  AppThreadStatus,
  AppTurn,
  AppTurnStatus,
  CodeModeLiveLine,
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

/**
 * Ceiling on the parked live stream for one Code Mode call.
 *
 * The server already bounds what it reports, so this is the second line of the
 * same defence: a script is untrusted, it can print in a loop, and the browser
 * is the one place where an unbounded buffer is not recoverable by opening a
 * new tab. Kept well above what a person will read, so the cut is never seen in
 * practice — the collapsed row only ever shows the tail.
 */
const LIVE_OUTPUT_MAX_LINES = 400;

function capOutput(text: string): string {
  if (text.length <= MAX_AGGREGATED_OUTPUT_CHARS) return text;
  const tail = text.slice(-(MAX_AGGREGATED_OUTPUT_CHARS - OUTPUT_TRUNCATION_MARKER.length));
  return `${OUTPUT_TRUNCATION_MARKER}${tail}`;
}

/**
 * Timestamp a tool call as the client sees it start.
 *
 * Kept off the wire on purpose. The server has a duration too, and it is the
 * more precise one — but it is the *tool's* duration, which is not what a
 * person watching a transcript is waiting for. What they wait for includes the
 * queue, the transport, and the model's own turn latency, and only a clock on
 * this side can measure that.
 */
function withClientStart<T extends AppThreadItem>(item: T): T {
  /*
   * Context management is stamped too, because one of its techniques is a model
   * call that can run for many seconds. Without a start time the row can only
   * say "working"; with it the row can say how long, which is the difference
   * between a UI that looks stuck and one that looks busy.
   */
  if (item.type !== "dynamicToolCall" && item.type !== "contextManagement") {
    // A context row that arrives already finished (a cheap technique the
    // server collapsed into one event) still wants a start time so the row can
    // report a duration; it just gets it at completion instead.
    return item;
  }
  return { ...item, startedAt: Date.now() } as T;
}

const LINE_KINDS: ReadonlySet<string> = new Set(["log", "info", "warn", "error", "debug", "tool"]);

/** Narrow an incoming line kind, defaulting to `log` rather than trusting it. */
function readLineKind(raw: unknown): CodeModeLiveLine["kind"] {
  return typeof raw === "string" && LINE_KINDS.has(raw) ? (raw as CodeModeLiveLine["kind"]) : "log";
}

/** Stamp a finishing item with how long the client watched it run. */
function withClientDuration<T extends AppThreadItem>(item: T, previous: AppThreadItem | undefined): T {
  if (item.type === "contextManagement") {
    // Carries `startedAt` forward rather than a duration: the row is rendered
    // from the same component whether it is running or done, so it needs the
    // clock's origin either way.
    const startedAt = previous?.type === "contextManagement" ? previous.startedAt : undefined;
    if (startedAt === undefined) return item;
    return { ...item, startedAt } as T;
  }
  if (item.type !== "dynamicToolCall") return item;
  const startedAt = previous?.type === "dynamicToolCall" ? previous.startedAt : undefined;
  if (startedAt === undefined) return item;
  return { ...item, durationMs: Math.max(0, Date.now() - startedAt) } as T;
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
    case "thread/model/updated":
      return withThread(state, {
        ...thread,
        modelProvider: (params.provider as string | null | undefined) ?? null,
        model: (params.model as string | null | undefined) ?? null,
      });
    case "thread/effort/updated":
      return withThread(state, {
        ...thread,
        reasoningEffort: params.reasoningEffort as "low" | "medium" | "high",
      });
    case "thread/permission/updated":
      return withThread(state, {
        ...thread,
        approvalPolicy: String(params.permissionMode ?? thread.approvalPolicy ?? ""),
      });
    /*
     * The server always states both fields, using `null`/`[]` for "cleared"
     * rather than omitting them, because an omitted key would be
     * indistinguishable from "this call changed only the other field".
     */
    case "thread/config/updated": {
      const next: AppThread = { ...thread };
      if (typeof params.systemPrompt === "string" && params.systemPrompt.length > 0) {
        next.systemPrompt = params.systemPrompt;
      } else {
        delete next.systemPrompt;
      }
      const disabled = Array.isArray(params.disabledTools)
        ? params.disabledTools.filter((name): name is string => typeof name === "string")
        : [];
      if (disabled.length > 0) next.disabledTools = disabled;
      else delete next.disabledTools;
      if (typeof params.filesystemSandbox === "boolean") {
        next.filesystemSandbox = params.filesystemSandbox;
      }
      return withThread(state, next);
    }
    case "thread/closed":
      return withThread(state, { ...thread, status: "notLoaded" });
    case "thread/tokenUsage/updated":
      return withThread(state, { ...thread, tokenUsage: params.tokenUsage as TokenUsage });

    case "plan/updated": {
      const steps = foldPlanSteps(params.steps);
      // An empty step list means the plan was cleared, not "unknown".
      return withThread(state, { ...thread, plan: steps });
    }
    case "todo/updated": {
      const items = foldTodoItems(params.items);
      return withThread(state, { ...thread, todo: items });
    }

    case "item/verification/updated": {
      const raw = asRecord(params.verification);
      // `verification.started` has no verdict; only fold a completion. A
      // started event that carried stale shape must not clobber a verdict.
      if (!raw || typeof raw.ok !== "boolean") return withThread(state, thread);
      return withThread(state, { ...thread, verification: foldVerification(raw) });
    }

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

    case "item/started": {
      if (!turnId) return withThread(state, thread);
      const raw = asRecord(params.item);
      if (!raw || typeof raw.id !== "string" || typeof raw.type !== "string") {
        return withThread(state, thread);
      }
      const turn = ensureTurn(thread, turnId);
      const item = withClientStart(raw as unknown as AppThreadItem);
      return withThread(state, withTurn(thread, withItem(turn, item)));
    }

    case "item/completed": {
      if (!turnId) return withThread(state, thread);
      const raw = asRecord(params.item);
      if (!raw || typeof raw.id !== "string" || typeof raw.type !== "string") {
        return withThread(state, thread);
      }
      const turn = ensureTurn(thread, turnId);
      const completed = raw as unknown as AppThreadItem;
      const previous = findItem(turn, completed.id);
      const item = withClientDuration(completed, previous);
      let next = withTurn(thread, withItem(turn, item));
      // A completed browser action is the surfacing signal: the reducer lifts
      // its `describePage` output into `thread.browser` so the UI renders a
      // screenshot + clickable overlay without ever learning which tool made it.
      const surface = browserSurfaceFromItem(item);
      if (surface) next = { ...next, browser: surface };
      return withThread(state, next);
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

    /**
     * Live sandbox output, held apart from the tool row it belongs to.
     *
     * A `eval` call emits its output on the same `command.output.delta` channel
     * a shell command uses, and the fold above would have merged it into a
     * `commandExecution` item — which is the wrong shape twice over. It would
     * invent an item for a call that is not a command execution, and it would
     * then be thrown away, because the completed `eval` result replaces that
     * item wholesale a moment later. So the delta is parked here, next to the
     * tool call, and cleared the instant the real report arrives.
     */
    case "turn/codeMode/delta": {
      if (!turnId) return withThread(state, thread);
      const itemId = String(params.itemId ?? "");
      if (!itemId) return withThread(state, thread);
      const turn = ensureTurn(thread, turnId);
      const existing = findItem(turn, itemId);
      if (!existing) return withThread(state, thread);
      const base: Extract<AppThreadItem, { type: "dynamicToolCall" }> =
        existing.type === "dynamicToolCall"
          ? existing
          : { type: "dynamicToolCall", id: itemId, tool: String(params.tool ?? "eval"), arguments: {}, status: "inProgress" };
      const lines = [...(base.liveOutput ?? [])];
      // A stream is text, not lines: `console.log` may arrive in pieces. Fold
      // onto the trailing entry when the chunk has no newline of its own, which
      // is the same rule a terminal applies.
      const text = String(params.text ?? "");
      const kind = readLineKind(params.kind);
      const last = lines[lines.length - 1];
      if (last && last.kind === kind && !last.text.endsWith("\n")) {
        lines[lines.length - 1] = { kind, text: capOutput(`${last.text}${text}`) };
      } else {
        lines.push({ kind, text: capOutput(text) });
      }
      // Bound the parked stream the way the server bounds its own copy: this is
      // untrusted output from a model-written script, and an unbounded one in
      // browser memory is the same hazard it is anywhere else.
      const bounded = lines.length > LIVE_OUTPUT_MAX_LINES ? lines.slice(-LIVE_OUTPUT_MAX_LINES) : lines;
      return withThread(state, withTurn(thread, withItem(turn, { ...base, liveOutput: bounded })));
    }

    default:
      // Unknown methods still advance latestSequence so the reconnect cursor
      // stays correct as the protocol grows.
      return withThread(state, thread);
  }
}

/**
 * Fold a raw `plan.updated` payload into typed plan steps. Anything malformed
 * is dropped so a bad step never crashes the checklist render.
 */
function foldPlanSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry!.id === "string" && typeof entry!.title === "string",
    )
    .map((entry) => ({
      id: entry!.id as string,
      title: entry!.title as string,
      status: asStepStatus(entry!.status),
      ...(typeof entry.detail === "string" ? { detail: entry.detail } : {}),
      ...(typeof entry.evidence === "string" ? { evidence: entry.evidence } : {}),
      ...(typeof entry.acceptanceCriteria === "string" ? { acceptanceCriteria: entry.acceptanceCriteria } : {}),
      ...(typeof entry.updatedAt === "number" ? { updatedAt: entry.updatedAt } : {}),
    }));
}

function foldTodoItems(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry!.id === "string" && typeof entry!.content === "string",
    )
    .map((entry) => ({
      id: entry!.id as string,
      content: entry!.content as string,
      status: asStepStatus(entry!.status),
      ...(entry.priority === "low" || entry.priority === "medium" || entry.priority === "high"
        ? { priority: entry.priority as TodoItem["priority"] }
        : {}),
      ...(typeof entry.evidence === "string" ? { evidence: entry.evidence } : {}),
      ...(typeof entry.updatedAt === "number" ? { updatedAt: entry.updatedAt } : {}),
    }));
}

function asStepStatus(value: unknown): PlanStep["status"] {
  return value === "in_progress" || value === "completed" || value === "blocked" ? value : "pending";
}

/** Fold a `verification.completed` payload into a typed verdict. */
function foldVerification(raw: Record<string, unknown>): VerificationSurface {
  const signal = asRecord(raw.groundedSignal);
  const surface: VerificationSurface = {
    ok: raw.ok === true,
    // `verified` is authoritative when present; a legacy event that only
    // carried `ok` can still be *verified* if a grounded signal says so.
    verified: raw.verified === true
      || (raw.ok === true && Boolean(signal?.grounded === true)),
  };
  if (typeof raw.command === "string") surface.command = raw.command;
  if (typeof raw.summary === "string") surface.summary = raw.summary;
  if (signal && typeof signal.kind === "string" && typeof signal.command === "string") {
    surface.groundedSignal = {
      kind: signal.kind,
      command: signal.command,
      grounded: signal.grounded === true,
    };
  }
  if (Array.isArray(raw.failureClasses)) {
    surface.failureClasses = raw.failureClasses.filter((item): item is string => typeof item === "string");
  }
  if (Array.isArray(raw.feedback)) {
    surface.feedback = raw.feedback.filter((item): item is string => typeof item === "string");
  }
  if (typeof raw.attemptCount === "number") surface.attemptCount = raw.attemptCount;
  if (typeof raw.selfDebugExplanation === "string") surface.selfDebugExplanation = raw.selfDebugExplanation;
  if (typeof raw.diffReviewExplanation === "string") surface.diffReviewExplanation = raw.diffReviewExplanation;
  return surface;
}

/**
 * Lift the browser surface out of a completed `browser_use` item.
 *
 * The tool returns a `surface` alongside the prose the model reads: the page's
 * url, title and viewport, so the pane shows the same step the model was
 * looking at rather than a second reading taken later.
 *
 * The old shape carried an `interactive` list of `ref`/`x`/`y` overlays, which
 * is gone with the tool that produced it. A ref was a position in a snapshot
 * rather than an identity, so the overlay could point at a different element
 * after a re-render without anything saying so. The pane shows the page and its
 * stats now, and anything that needs an element addresses it by locator.
 */
function browserSurfaceFromItem(item: AppThreadItem): BrowserSurface | undefined {
  // Only a completed call is a trustworthy page state; a failed one may carry a
  // stale or partial result, and surfacing it would mislead.
  if (item.type !== "dynamicToolCall" || item.tool !== BROWSER_SURFACE_TOOL || item.status !== "completed") {
    return undefined;
  }
  const result = asRecord(item.result);
  const surface = asRecord(result?.surface) ?? result;
  if (!surface || typeof surface.url !== "string") return undefined;

  const viewport = asRecord(surface.viewport);
  /*
   * The interactive boxes are read from the result rather than dropped.
   *
   * They were hardcoded to an empty array here, with a comment saying the
   * coordinates were gone with the refs they belonged to. That was true of the
   * producer at the time and it left the pane structurally unable to draw its
   * overlay: the type said the field existed, the renderer drew it, and this
   * line guaranteed it was always empty. The tool reports them again now, so
   * they are read, and anything malformed is filtered rather than trusted.
   */
  const interactive = Array.isArray(surface.interactive)
    ? surface.interactive.flatMap((entry, position) => {
        const box = asRecord(entry);
        if (!box) return [];
        const nums = [box.x, box.y, box.width, box.height];
        if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return [];
        return [{
          ref: typeof box.ref === "string" ? box.ref : "",
          // The producer numbers them; the position is the honest fallback,
          // because the pane only ever reads them as an identity for React keys
          // and a label in the list.
          index: typeof box.index === "number" ? box.index : position + 1,
          tag: typeof box.tag === "string" ? box.tag : "",
          text: typeof box.text === "string" ? box.text : "",
          x: box.x as number,
          y: box.y as number,
          width: box.width as number,
          height: box.height as number,
          ...(typeof box.role === "string" ? { role: box.role } : {}),
          ...(typeof box.type === "string" ? { type: box.type } : {}),
        }];
      })
    : [];
  return {
    url: surface.url,
    title: typeof surface.title === "string" ? surface.title : "",
    interactive,
    ...(typeof surface.screenshotPath === "string" ? { screenshotPath: surface.screenshotPath } : {}),
    ...(viewport && typeof viewport.width === "number" && typeof viewport.height === "number"
      ? { viewport: { width: viewport.width, height: viewport.height } }
      : {}),
  };
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
  const reasoningEffort = raw.reasoningEffort ?? envelope?.reasoningEffort;
  if (reasoningEffort === "low" || reasoningEffort === "medium" || reasoningEffort === "high") {
    next.reasoningEffort = reasoningEffort;
  }
  /*
   * Absence means cleared, not "unchanged". All three ways this function is
   * reached — `thread/started`, the `thread/start`/`thread/resume` replies via
   * `seedThread`, and `thread/config/updated` — carry these two fields as part
   * of a full projection, so a missing key is the server saying the thread has
   * no extra instructions or no disabled tools. Folding only present keys
   * would make clearing impossible without a reload.
   *
   * The one way that reasoning breaks is a snapshot older than the state it is
   * folded into. A resume seeds the reply and *then* drains the notifications
   * buffered while it was in flight, so a replayed `thread/started` recorded
   * before a settings change lands afterwards and would clear what the newer
   * reply just set. `updatedAt` is the tiebreak: a snapshot that is older than
   * the thread it is being folded into may not clear these two fields, though
   * it still contributes everything else it carries. Setting them is always
   * allowed — a snapshot can only ever add information it has.
   */
  const incomingUpdatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : undefined;
  const stale = incomingUpdatedAt !== undefined && thread.updatedAt !== undefined
    && incomingUpdatedAt < thread.updatedAt;
  if (typeof raw.systemPrompt === "string") next.systemPrompt = raw.systemPrompt;
  else if (!stale) delete next.systemPrompt;
  if (Array.isArray(raw.disabledTools)) {
    next.disabledTools = raw.disabledTools.filter((name): name is string => typeof name === "string");
  } else if (!stale) delete next.disabledTools;
  if (typeof raw.filesystemSandbox === "boolean") next.filesystemSandbox = raw.filesystemSandbox;
  if (typeof raw.hasTurns === "boolean") next.hasTurns = raw.hasTurns;
  if (typeof raw.createdAt === "string") next.createdAt = raw.createdAt;
  if (typeof raw.updatedAt === "string") next.updatedAt = raw.updatedAt;
  if (typeof raw.name === "string") next.name = raw.name;
  if (raw.status !== undefined) next.status = raw.status as AppThreadStatus;
  const approvalPolicy = raw.approvalPolicy ?? envelope?.approvalPolicy;
  if (approvalPolicy !== undefined) next.approvalPolicy = String(approvalPolicy);
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
  // A steered user message lands at a model-loop boundary too — the next model
  // request sees it — so it opens a step the same way an agent message does.
  const isModelTurn = (item: AppThreadItem): boolean =>
    item.type === "agentMessage" || item.type === "reasoning" || item.type === "userMessage";

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
  "file_find",
  "skim_file",
  "list_directory",
  "grep_search",
  "glob",
  "git_status",
  "git_diff",
  "search_memory",
  "search_tools",
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
