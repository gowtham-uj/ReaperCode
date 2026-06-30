import { randomUUID } from "node:crypto";
import { saveSession } from "../sessions-store.js";

/**
 * SessionStore — the single source of truth for the TUI. Components
 * subscribe via the `subscribe` method (React-friendly via
 * useSyncExternalStore). All mutations go through the store.
 *
 * Threading model: the store is mutated from inside the engine's
 * tool dispatch (Hook events) and from inside the input prompt's
 * submit handler. Node is single-threaded, so a simple subscribe-
 * notify list is sufficient.
 */

import type {
  TuiAssistantMessage,
  TuiErrorMessage,
  TuiMessage,
  TuiSnapshot,
  TuiStatus,
  TuiSystemMessage,
  TuiToolCard,
  TuiUserMessage,
} from "../types.js";

export type SessionStoreListener = () => void;

const INITIAL_STATUS: TuiStatus = {
  phase: "idle",
  model: "claude-opus-4-8",
  provider: "anthropic",
  sessionId: "ses_local",
  tokens: 0,
  ctxPct: 0,
  hideThinkingBlock: true,
  debugMode: false,
};

let _idCounter = 0;
function nextId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idCounter.toString(36)}`;
}

export class SessionStore {
  private messages: TuiMessage[] = [];
  private toolCards: TuiToolCard[] = [];
  private status: TuiStatus = { ...INITIAL_STATUS };
  private readonly listeners = new Set<SessionStoreListener>();
  private readonly startedAt: string = new Date().toISOString();

  /**
   * View preferences. The TUI's rendering layer reads these on every
   * snapshot to decide whether to show the collapsible reasoning
   * block above assistant chat bubbles and to choose the default
   * expansion state for new tool cards. Defaults match Pi's "less
   * noisy" baseline: thinking hidden, tool cards collapsed.
   *
   * Persistence: when `localStorage` is available (browser builds) we
   * read/write the preference on construction / mutation. The Node
   * TUI uses an in-memory flag only — persistence is not required
   * there.
   */
  private viewPrefs: { hideThinkingBlock: boolean; toolCardsDefaultExpanded: boolean } = {
    hideThinkingBlock: true,
    toolCardsDefaultExpanded: false,
  };

  constructor() {
    // Hydrate from localStorage when available. The helper swallows
    // every error so a corrupt preference file can never crash the
    // TUI; the in-memory defaults are the fallback.
    const persisted = loadViewPrefs();
    this.viewPrefs = persisted;
    this.status = { ...this.status, hideThinkingBlock: persisted.hideThinkingBlock };
  }

  /**
   * Streaming buffer: a single assistant message that is mutated
   * in place as AssistantStreamDelta events arrive. When the buffer
   * is empty, the next delta opens a fresh message; when completeAssistantStream
   * is called, the buffer is committed and stays in `messages` for the
   * final snapshot. The non-streaming `appendAssistant(...)` path is
   * idempotent against this: if a message with the same id already
   * exists, the caller is responsible for not double-appending.
   */
  private streamingBuffer: TuiAssistantMessage | null = null;

  /**
   * Reasoning buffer: a single reasoning text accumulator that is
   * mutated in place as ReasoningDelta events arrive. When the buffer
   * is empty, the next delta opens a fresh accumulator; when
   * `completeReasoning` is called, the accumulator is folded into the
   * current streaming assistant message (or, if no streaming message
   * is open, dropped — the TUI omits the reasoning block when there
   * is no chat text to attach it to).
   */
  private reasoningBuffer: string | null = null;

  /**
   * Cached snapshot — re-used across `snapshot()` calls so that
   * `useSyncExternalStore` doesn't see a new reference on every
   * React render. We rebuild it on every `notify()` and hand out
   * the same object until the next mutation. This is the React-
   * recommended pattern: stable identity between notifications,
   * new identity on notification.
   */
  private cachedSnapshot: TuiSnapshot | null = null;

  /* ------------------------------------------------------------------ */
  /* Subscribe                                                            */
  /* ------------------------------------------------------------------ */

  subscribe(listener: SessionStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* ------------------------------------------------------------------ */
  /* View preferences                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Whether the rendering layer should suppress the reasoning block
   * above assistant chat bubbles. Toggled by the global `Ctrl+T`
   * keybind in `app.tsx`. Default is `true` (hidden) — Pi's "less
   * noisy" baseline.
   */
  isThinkingHidden(): boolean {
    return this.viewPrefs.hideThinkingBlock;
  }

  /**
   * Flip the hideThinkingBlock preference and notify listeners. The
   * caller (App) wires the `Ctrl+T` keybind to this method.
   */
  toggleThinkingBlock(): void {
    const next = !this.viewPrefs.hideThinkingBlock;
    this.viewPrefs = { ...this.viewPrefs, hideThinkingBlock: next };
    this.status = { ...this.status, hideThinkingBlock: next };
    persistViewPrefs(this.viewPrefs);
    this.notify();
  }

  isDebugMode(): boolean {
    return this.status.debugMode;
  }

  setDebugMode(value: boolean): void {
    if (this.status.debugMode === value) return;
    this.status = { ...this.status, debugMode: value };
    this.notify();
  }

  toggleDebugMode(): void {
    this.setDebugMode(!this.status.debugMode);
  }

  /**
   * Whether new tool cards should default to the expanded view. Pi's
   * default is `false` (collapsed). Exposed so future keybinds can
   * flip it; the engine-driver does NOT need to know about this flag
   * because new cards store their own `expanded` field at creation
   * time and stay independent after that.
   */
  isToolCardsDefaultExpanded(): boolean {
    return this.viewPrefs.toolCardsDefaultExpanded;
  }

  /**
   * Set the default tool-card expansion preference. Wired to the
   * global `Ctrl+E` keybind in `useInputKeys`. Only affects FUTURE
   * cards (cards snapshot the preference at creation time).
   */
  toggleToolCardsDefaultExpanded(value: boolean): void {
    this.viewPrefs = { ...this.viewPrefs, toolCardsDefaultExpanded: value };
    persistViewPrefs(this.viewPrefs);
    this.notify();
  }

  /**
   * Expand a tool card. Idempotent — calling on an already-expanded
   * card is a no-op (still notifies so the snapshot reference is
   * updated, which is harmless). The default of `card.collapsed`
   * stays whatever it was at creation time.
   */
  expandToolCard(cardId: string): void {
    const card = this.toolCards.find((c) => c.id === cardId);
    if (!card) return;
    if (!card.collapsed) return;
    card.collapsed = false;
    this.notify();
  }

  /**
   * Collapse a tool card. Mirrors `expandToolCard`. Idempotent on
   * already-collapsed cards.
   */
  collapseToolCard(cardId: string): void {
    const card = this.toolCards.find((c) => c.id === cardId);
    if (!card) return;
    if (card.collapsed) return;
    card.collapsed = true;
    this.notify();
  }

  private notify(): void {
    // Drop the cached snapshot so the next `snapshot()` call
    // allocates a fresh one. Done BEFORE notifying so that any
    // listener which calls `snapshot()` during the notification
    // sees the new state.
    this.cachedSnapshot = null;
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* swallow — listeners must not throw */
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Snapshot                                                             */
  /* ------------------------------------------------------------------ */

  snapshot(): TuiSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    this.cachedSnapshot = {
      messages: [...this.messages],
      toolCards: [...this.toolCards],
      status: { ...this.status },
    };
    return this.cachedSnapshot;
  }

  /**
   * Internal: set the hideThinkingBlock flag and mirror it onto the
   * status object so the snapshot picks it up. Called by the
   * constructor when hydrating from localStorage and by the toggle
   * method.
   */
  private setHideThinkingBlock(value: boolean): void {
    this.viewPrefs = { ...this.viewPrefs, hideThinkingBlock: value };
    this.status = { ...this.status, hideThinkingBlock: value };
  }

  /* ------------------------------------------------------------------ */
  /* Message ops                                                          */
  /* ------------------------------------------------------------------ */

  appendUser(text: string): TuiUserMessage {
    const msg: TuiUserMessage = { kind: "user", id: nextId("u"), text, ts: Date.now() };
    this.messages.push(msg);
    this.notify();
    return msg;
  }

  appendAssistant(text: string): TuiAssistantMessage {
    const msg: TuiAssistantMessage = { kind: "assistant", id: nextId("a"), text, ts: Date.now() };
    this.messages.push(msg);
    this.notify();
    return msg;
  }

  appendSystem(text: string): TuiSystemMessage {
    const msg: TuiSystemMessage = { kind: "system", id: nextId("s"), text, ts: Date.now() };
    this.messages.push(msg);
    this.notify();
    return msg;
  }

  appendError(text: string): TuiErrorMessage {
    const msg: TuiErrorMessage = { kind: "error", id: nextId("e"), text, ts: Date.now() };
    this.messages.push(msg);
    this.notify();
    return msg;
  }

  clear(): void {
    this.messages.length = 0;
    this.toolCards.length = 0;
    this.streamingBuffer = null;
    this.notify();
  }

  /**
   * Append a delta to the streaming assistant message. Opens a new
   * streaming buffer on first call; subsequent calls mutate the
   * buffer's `text` in place and notify listeners. Empty deltas are
   * no-ops so consumers don't have to filter.
   */
  appendAssistantStream(delta: string): TuiAssistantMessage {
    if (!delta) return this.streamingBuffer ?? this.appendAssistant("");
    if (!this.streamingBuffer) {
      const msg: TuiAssistantMessage = { kind: "assistant", id: nextId("a"), text: delta, ts: Date.now() };
      this.streamingBuffer = msg;
      this.messages.push(msg);
    } else {
      this.streamingBuffer = { ...this.streamingBuffer, text: this.streamingBuffer.text + delta };
      const idx = this.messages.findIndex((m) => m.id === this.streamingBuffer!.id);
      if (idx >= 0) this.messages[idx] = this.streamingBuffer;
    }
    this.notify();
    return this.streamingBuffer;
  }

  /**
   * Commit the streaming buffer. After this, the buffer is locked in
   * `messages` and any subsequent `appendAssistantStream` opens a new
   * one. Calling this with no buffer open is a no-op.
   */
  completeAssistantStream(): void {
    this.streamingBuffer = null;
    // No notify() needed — the buffer was already flushed by the last
    // delta. notify() here would force a redundant re-render.
  }

  /* ------------------------------------------------------------------ */
  /* Rendering-layer streaming (AssistantMessageDelta / Complete and    */
  /* ReasoningDelta / Complete). Same shape as the legacy stream API    */
  /* but pinned to the new event names from the rendering layer design. */
  /* ------------------------------------------------------------------ */

  /**
   * Append a delta to the streaming assistant message driven by the
   * rendering-layer `AssistantMessageDelta` event. Same behavior as
   * `appendAssistantStream` — opens a buffer on first call, mutates
   * it in place, notifies listeners. The split exists so the TUI can
   * later route the two event families differently (e.g. show the
   * new event names in a different visual style) without touching
   * the legacy stream code path.
   */
  appendAssistantDelta(delta: string): TuiAssistantMessage {
    return this.appendAssistantStream(delta);
  }

  /**
   * Commit the rendering-layer assistant stream. Same as
   * `completeAssistantStream`; the TUI can call either and the
   * streaming buffer is reset.
   */
  completeAssistant(): void {
    this.completeAssistantStream();
  }

  /**
   * Append a delta to the rendering-layer reasoning buffer driven by
   * the `ReasoningDelta` event. Opens a fresh accumulator on the
   * first call; subsequent calls extend the same accumulator. Empty
   * deltas are no-ops so consumers don't have to filter. The
   * accumulator stays in `reasoningBuffer` (not in `messages`) until
   * `completeReasoning` folds it onto the current streaming message.
   */
  appendReasoningDelta(delta: string): void {
    if (!delta) return;
    if (this.reasoningBuffer === null) {
      this.reasoningBuffer = delta;
    } else {
      this.reasoningBuffer = this.reasoningBuffer + delta;
    }
    // No notify() yet — reasoning folds onto the message on completion
    // so the TUI sees a single coherent message update.
  }

  /**
   * Commit the reasoning buffer. Folds the accumulated reasoning text
   * onto the current streaming assistant message (or the most recent
   * assistant message if no streaming buffer is open). Drops the
   * accumulator and notifies listeners exactly once. Calling this
   * with no buffer open is a no-op.
   */
  completeReasoning(): void {
    if (this.reasoningBuffer === null) return;
    const reasoning = this.reasoningBuffer;
    this.reasoningBuffer = null;
    if (this.streamingBuffer) {
      this.streamingBuffer = { ...this.streamingBuffer, reasoning };
      const idx = this.messages.findIndex((m) => m.id === this.streamingBuffer!.id);
      if (idx >= 0) this.messages[idx] = this.streamingBuffer;
      this.notify();
      return;
    }
    // No live streaming buffer — try to fold onto the most recent
    // assistant message in `messages` so the TUI still shows the
    // reasoning block next to the chat text it was emitted with.
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i];
      if (m && m.kind === "assistant") {
        this.messages[i] = { ...m, reasoning };
        this.notify();
        return;
      }
    }
    // No assistant message to attach to. The reasoning is dropped —
    // the TUI omits the reasoning block when there is no chat text.
  }

  /* ------------------------------------------------------------------ */
  /* Tool card ops                                                        */
  /* ------------------------------------------------------------------ */

  beginToolCard(input: {
    callId: string;
    name: string;
    args: unknown;
    ts?: number;
  }): TuiToolCard {
    const card: TuiToolCard = {
      id: nextId("t"),
      callId: input.callId,
      name: input.name,
      args: input.args,
      result: undefined,
      ok: false,
      durationMs: 0,
      ts: input.ts ?? Date.now(),
      diffMode: "inline",
      // Default collapse honors the user's view preference; the
      // preference is read at creation time so flipping the default
      // mid-session only affects new cards.
      collapsed: !this.viewPrefs.toolCardsDefaultExpanded,
    };
    this.toolCards.push(card);
    this.notify();
    return card;
  }

  finishToolCard(callId: string, patch: Partial<TuiToolCard>): void {
    const card = this.toolCards.find((c) => c.callId === callId);
    if (!card) return;
    Object.assign(card, patch);
    this.notify();
  }

  toggleToolCard(cardId: string): void {
    const card = this.toolCards.find((c) => c.id === cardId);
    if (!card) return;
    card.collapsed = !card.collapsed;
    this.notify();
  }

  toggleDiffMode(cardId: string): void {
    const card = this.toolCards.find((c) => c.id === cardId);
    if (!card) return;
    card.diffMode = card.diffMode === "inline" ? "side-by-side" : "inline";
    this.notify();
  }

  /* ------------------------------------------------------------------ */
  /* Status                                                               */
  /* ------------------------------------------------------------------ */

  setStatus(patch: Partial<TuiStatus>): void {
    this.status = { ...this.status, ...patch };
    this.notify();
  }

  getStatus(): TuiStatus {
    return { ...this.status };
  }

  setPhase(phase: TuiStatus["phase"]): void {
    this.setStatus({ phase });
  }

  /* ------------------------------------------------------------------ */
  /* Counts (for session metadata + /sessions list)                      */
  /* ------------------------------------------------------------------ */

  promptCount(): number {
    return this.messages.filter((m) => m.kind === "user").length;
  }

  messageCount(): number {
    return this.messages.length;
  }

  /** First user prompt — for /sessions list display. */
  firstPrompt(): string | undefined {
    const first = this.messages.find((m) => m.kind === "user");
    return first && first.kind === "user" ? first.text : undefined;
  }

  startedAtIso(): string {
    return this.startedAt;
  }
}

/**
 * Build a SessionStore seeded with sensible defaults: a fresh
 * session id, the configured model/provider, and a "ready" system
 * message in the buffer.
 *
 * Session isolation: every store gets a unique collision-free id
 * derived from `crypto.randomUUID()`. The store exposes
 * `persistSessionMetadata(workspaceRoot, trajectoryPath, …)` so the
 * host can write `<workspaceRoot>/.reaper/sessions/<sessionId>.json`
 * for `/sessions` and `/resume`. The id is also surfaced in
 * `RuntimeEngine.run()` via `requestEnvelope.session_id`, which is
 * the runId the engine's `runDir` is derived from — so each TUI
 * session lands in its own `.reaper/runs/<runId>/` directory and
 * never collides with another session's trajectory, audit log, or
 * recovery state.
 */
export function createSessionStore(opts: {
  model: string;
  provider: string;
  sessionId?: string;
}): SessionStore {
  const store = new SessionStore();
  const sessionId = opts.sessionId ?? `ses_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  store.setStatus({
    phase: "idle",
    model: opts.model,
    provider: opts.provider,
    sessionId,
    tokens: 0,
    ctxPct: 0,
    debugMode: false,
  });
  store.appendSystem("Reaper TUI ready. Type a prompt and press Enter. /help for commands.");
  return store;
}

/* -------------------------------------------------------------------------- */
/*  View-preference persistence                                                */
/*                                                                            */
/*  The `hideThinkingBlock` and `toolCardsDefaultExpanded` flags survive       */
/*  across TUI restarts via `localStorage` when available (browser builds)   */
/*  and via a small JSON file under `~/.reaper/tui-prefs.json` for the Node  */
/*  TUI. The two paths are best-effort — every helper is wrapped in a       */
/*  try/catch so a missing or malformed preference file falls back to the    */
/*  in-memory defaults. Persistence is fail-open, not fail-closed.          */
/* -------------------------------------------------------------------------- */

const VIEW_PREFS_DEFAULTS = {
  hideThinkingBlock: true,
  toolCardsDefaultExpanded: false,
};

interface ViewPrefs {
  hideThinkingBlock: boolean;
  toolCardsDefaultExpanded: boolean;
}

/** Resolve the global object the way both browser and Node TUI builds can. */
function getGlobalThis_(): { localStorage?: Storage } | null {
  try {
    if (typeof globalThis !== "undefined") {
      return globalThis as { localStorage?: Storage };
    }
  } catch {
    /* swallow */
  }
  return null;
}

/** Load the persisted view prefs; returns the defaults on any error. */
function loadViewPrefs(): ViewPrefs {
  try {
    const g = getGlobalThis_();
    if (g && g.localStorage) {
      const raw = g.localStorage.getItem("reaper.tui.viewPrefs");
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ViewPrefs>;
        if (typeof parsed.hideThinkingBlock === "boolean" &&
            typeof parsed.toolCardsDefaultExpanded === "boolean") {
          return {
            hideThinkingBlock: parsed.hideThinkingBlock,
            toolCardsDefaultExpanded: parsed.toolCardsDefaultExpanded,
          };
        }
      }
      return { ...VIEW_PREFS_DEFAULTS };
    }
    // Node fallback — read the JSON file at ~/.reaper/tui-prefs.json.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const os = require("node:os") as typeof import("node:os");
    const file = path.join(os.homedir(), ".reaper", "tui-prefs.json");
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as Partial<ViewPrefs>;
      if (typeof parsed.hideThinkingBlock === "boolean" &&
          typeof parsed.toolCardsDefaultExpanded === "boolean") {
        return {
          hideThinkingBlock: parsed.hideThinkingBlock,
          toolCardsDefaultExpanded: parsed.toolCardsDefaultExpanded,
        };
      }
    }
  } catch {
    /* swallow — fall through to defaults */
  }
  return { ...VIEW_PREFS_DEFAULTS };
}

/** Persist the view prefs. No-op on any error so a write failure
 *  can never crash the TUI. */
function persistViewPrefs(prefs: ViewPrefs): void {
  try {
    const g = getGlobalThis_();
    if (g && g.localStorage) {
      g.localStorage.setItem("reaper.tui.viewPrefs", JSON.stringify(prefs));
      return;
    }
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const os = require("node:os") as typeof import("node:os");
    const file = path.join(os.homedir(), ".reaper", "tui-prefs.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(prefs, null, 2));
  } catch {
    /* swallow */
  }
}
