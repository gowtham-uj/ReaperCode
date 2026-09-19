import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { hydrateFromTurns, type JsonRpcClient } from "@reaper/web-shared";

import { connect, type Connection } from "./connection.js";
import type { TranscriptStore } from "./store.js";

export type SessionStatus = "connecting" | "open" | "reconnecting" | "closed";
const THREAD_KEY = "reaper.threadId";
const RETRY_DELAYS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

export interface SessionHandlers {
  onApproval: Parameters<typeof connect>[1]["onApproval"];
  onApprovalResolved: Parameters<typeof connect>[1]["onApprovalResolved"];
  onError(message: string | undefined): void;
  onNotification?(method: string, params: Record<string, unknown>): boolean;
}

/**
 * Both `thread/start` and `thread/resume` answer with the thread's metadata — the
 * only place the app learns its model — plus a page of its most recent turns and
 * optionally a replay cursor.
 *
 * `hasOlderTurns` says the page was bounded. It is the one field that keeps a
 * partial load from reading as a short conversation.
 */
interface ResumeResult {
  thread?: { id?: string };
  replay?: { truncated?: boolean };
  hasOlderTurns?: boolean;
  /**
   * The thread's newest turns, which is the transcript's actual content.
   *
   * This was fetched on every resume and read by nothing. `seedThread` folds the
   * reply's `thread` object in, and `mergeThreadMetadata` handles metadata only,
   * so the turns arrived, were parsed, and were dropped. The transcript then
   * rendered whatever the replay stream happened to deliver.
   *
   * That was survivable while resume replayed every event, and the bounded resume
   * made it visible: a live mission's journal held 101 turns and the UI showed 4,
   * because only the replayed ones had anywhere to come from.
   */
  initialTurnsPage?: Array<Record<string, unknown>>;
}

export interface Session {
  status: SessionStatus;
  threadId: string | undefined;
  client: JsonRpcClient | undefined;
  catchingUp: boolean;
  recovered: boolean;
  retryNow(): void;
  createThread(input?: { workspaceRoot?: string; title?: string }): Promise<string>;
  switchThread(id: string): Promise<void>;
  /**
   * Pull in the turns older than the ones already held.
   *
   * The counterpart to a bounded resume. Returns what it did so a caller can
   * stop offering the control once the thread's start is reached, rather than
   * presenting a button that does nothing.
   */
  loadOlderTurns(): Promise<{ loaded: number; exhausted: boolean }>;
  /** True once the initial page was bounded, i.e. there is older history. */
  hasOlderTurns: boolean;
  /** Forget the open thread, leaving no thread selected. */
  clearThread(): void;
  close(): void;
}

/**
 * WebSocket/thread lifecycle as a React hook. The replay buffer, connection,
 * retry timer, and latest ids live in refs because callbacks can arrive long
 * after the render that opened the socket.
 */
export function useSession(url: string, store: TranscriptStore, handlers: SessionHandlers): Session {
  const [status, setStatusState] = useState<SessionStatus>("connecting");
  const [threadId, setThreadIdState] = useState<string>();
  const [client, setClientState] = useState<JsonRpcClient>();
  const [catchingUp, setCatchingUp] = useState(false);
  const [recovered, setRecovered] = useState(false);

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const threadIdRef = useRef<string | undefined>(undefined);
  const clientRef = useRef<JsonRpcClient | undefined>(undefined);
  const connectionRef = useRef<Connection | undefined>(undefined);
  const disposedRef = useRef(false);
  const attemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bufferRef = useRef<Array<[string, Record<string, unknown>]> | undefined>(undefined);
  const openRef = useRef<() => Promise<void>>(async () => undefined);

  const setThreadId = useCallback((id: string | undefined): void => {
    threadIdRef.current = id;
    setThreadIdState(id);
  }, []);
  const setClient = useCallback((next: JsonRpcClient | undefined): void => {
    clientRef.current = next;
    setClientState(next);
  }, []);

  const apply = useCallback((method: string, params: Record<string, unknown>): void => {
    if (handlersRef.current.onNotification?.(method, params)) return;
    store.ingest(method, params);
  }, [store]);

  const ingest = useCallback((method: string, params: Record<string, unknown>): void => {
    if (bufferRef.current) bufferRef.current.push([method, params]);
    else apply(method, params);
  }, [apply]);

  const drain = useCallback((): void => {
    const held = bufferRef.current ?? [];
    bufferRef.current = undefined;
    for (const [method, params] of held) apply(method, params);
  }, [apply]);

  /*
   * How many turns a page of history is, and it is deliberately larger than the
   * initial one. A reader who asks for older history is scrolling back, so they
   * will keep going for a while: fetching 30 at a time would spend a round trip
   * per flick of the wheel. The initial page is small because it is on the
   * critical path; these are not.
   */
  const HISTORY_PAGE = 100;

  /**
   * Walk back through a thread's history one page per call.
   *
   * This replaced an eager loop that fetched up to 10,000 turns on open. Nothing
   * asked for them: the turns a reader looks at are the newest, and a thread's
   * older turns are only wanted when someone scrolls up to find them. Paying for
   * the whole history to render the current turn is what made opening a long
   * conversation slow, and the cost grew with the conversation's length while the
   * visible work stayed constant.
   *
   * The cursor lives in a ref rather than state because it is bookkeeping for the
   * next call, not something the UI renders. It is cleared whenever the thread
   * changes, so a page fetched for one thread can never be folded into another.
   */
  const olderCursorRef = useRef<string | undefined>(undefined);
  const exhaustedRef = useRef(false);
  const [hasOlderTurns, setHasOlderTurns] = useState(false);

  /**
   * Forget the paging position, because the thread it belonged to is gone.
   *
   * A stale cursor would fold one thread's turns into another's, which is the
   * same class of leak as the composer draft and the queue: state that outlives
   * the conversation it was about.
   */
  const resetHistoryWindow = useCallback((): void => {
    olderCursorRef.current = undefined;
    exhaustedRef.current = false;
    setHasOlderTurns(false);
  }, []);

  const loadOlderTurns = useCallback(async (): Promise<{ loaded: number; exhausted: boolean }> => {
    const active = clientRef.current;
    const id = threadIdRef.current;
    if (!active || !id) return { loaded: 0, exhausted: true };
    if (exhaustedRef.current) return { loaded: 0, exhausted: true };
    /*
     * `sortDirection: "desc"` and the cursor walk the thread backwards from the
     * newest turn, which is what makes the first page the turns immediately
     * before the ones already on screen. Ascending order would page from the
     * thread's start, so "load older" would fetch the oldest turns in the
     * conversation rather than the ones adjacent to what the reader is looking
     * at.
     */
    const result = await active.call<{ data?: unknown[]; nextCursor?: unknown }>("thread/turns/list", {
      threadId: id,
      limit: HISTORY_PAGE,
      sortDirection: "desc",
      ...(olderCursorRef.current ? { cursor: olderCursorRef.current } : {}),
    });
    const turns = (result.data ?? []).filter(
      (raw): raw is Record<string, unknown> => Boolean(raw) && typeof raw === "object",
    );
    if (turns.length > 0) {
      store.hydrate(hydrateFromTurns(store.snapshot(), id, turns));
    }
    const cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0
      ? result.nextCursor
      : undefined;
    olderCursorRef.current = cursor;
    if (cursor === undefined) exhaustedRef.current = true;
    return { loaded: turns.length, exhausted: cursor === undefined };
  }, [store]);

  const startFresh = useCallback(async (
    active: JsonRpcClient,
    input: { workspaceRoot?: string; title?: string },
  ): Promise<string> => {
    // no-op note: seeding below folds the reply's thread metadata into the
    // store so the composer shows the thread's model without a second round trip.
    const started = await active.call<{ thread?: { id?: string } }>("thread/start", {
      subscribe: true,
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : { newWorkspace: true }),
      ...(input.title ? { title: input.title } : {}),
    });
    const id = started.thread?.id;
    if (!id) throw new Error("The server started a thread without an id");
    store.seedThread(started.thread ?? {});
    setThreadId(id);
    rememberThread(id);
    return id;
  }, [setThreadId, store]);

  const attach = useCallback(async (active: JsonRpcClient): Promise<void> => {
    const remembered = threadIdRef.current ?? readRememberedThread();
    if (remembered) {
      bufferRef.current = [];
      setCatchingUp(true);
      try {
        resetHistoryWindow();
        const resumed = await active.call<ResumeResult>("thread/resume", {
          threadId: remembered,
          subscribe: true,
          afterSequence: store.snapshot()[remembered]?.latestSequence ?? 0,
        });
        store.seedThread(resumed.thread ?? {});
        /*
         * The page fills in a fresh load, and only a fresh load.
         *
         * `attach` also runs on a reconnect, where the store already holds the
         * turns the reader has — possibly including older ones they paged in. The
         * server's page is the newest thirty, so replacing there would throw away
         * history the reader had deliberately loaded. An empty store is the case
         * that needs the page: a reload, or a first visit to a remembered thread,
         * where the replay stream alone was leaving the transcript short.
         */
        if (Array.isArray(resumed.initialTurnsPage) && (store.thread(remembered)?.turns.length ?? 0) === 0) {
          store.replaceTurns(remembered, resumed.initialTurnsPage);
        }
        setThreadId(remembered);
        rememberThread(remembered);
        setHasOlderTurns(resumed.hasOlderTurns === true);
        /*
         * A truncated replay is the one case that still pages eagerly, and it is
         * a different problem from the one this changed: a replay buffer carries
         * the events since a cursor, so a gap there means the client's view has
         * genuinely outrun what it holds. That is a correctness repair, not a
         * history browse, so it is worth the round trips.
         */
        if (resumed.replay?.truncated) {
          setRecovered(true);
          await loadOlderTurns();
        }
        return;
      } catch {
        forgetThread();
        setThreadId(undefined);
        store.hydrate({});
      } finally {
        drain();
        setCatchingUp(false);
      }
    }
    /*
     * Nothing to resume, and nothing is created.
     *
     * This used to reuse an unused scratch thread and, failing that, mint one
     * named "New chat". Both were wrong for the same reason: a thread is a
     * conversation, and a conversation starts when somebody says something. The
     * eager versions meant every page load and every deleted thread produced a
     * row the user never asked for, so the sidebar filled with empty chats and
     * deleting one appeared to spawn another.
     *
     * So a session with no thread to resume simply has none, and the UI shows
     * the empty state. The first message is what creates a thread, in
     * `sendFirstMessage` below.
     */
    setThreadId(undefined);
    store.hydrate({});
  }, [store]);

  const scheduleRetry = useCallback((): void => {
    if (disposedRef.current || retryTimerRef.current !== undefined) return;
    const delay = RETRY_DELAYS[Math.min(attemptRef.current, RETRY_DELAYS.length - 1)]!;
    attemptRef.current += 1;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = undefined;
      void openRef.current();
    }, delay);
  }, []);

  const open = useCallback(async (): Promise<void> => {
    if (disposedRef.current) return;
    setStatusState(threadIdRef.current ? "reconnecting" : "connecting");
    try {
      const active = await connect(url, {
        onNotification: ingest,
        onApproval: (request) => handlersRef.current.onApproval(request),
        onApprovalResolved: (approvalId) => handlersRef.current.onApprovalResolved(approvalId),
        onStatusChange: (next) => {
          if (next !== "closed") return;
          setClient(undefined);
          if (disposedRef.current) return;
          setStatusState("reconnecting");
          scheduleRetry();
        },
      });
      if (disposedRef.current) {
        active.close();
        return;
      }
      connectionRef.current = active;
      setClient(active.client);
      setStatusState("open");
      attemptRef.current = 0;
      await attach(active.client);
      handlersRef.current.onError(undefined);
    } catch (cause) {
      bufferRef.current = undefined;
      setCatchingUp(false);
      setClient(undefined);
      handlersRef.current.onError(cause instanceof Error ? cause.message : "Could not reach the agent");
      if (disposedRef.current) return;
      setStatusState("reconnecting");
      scheduleRetry();
    }
  }, [attach, ingest, scheduleRetry, setClient, url]);
  openRef.current = open;

  const close = useCallback((): void => {
    disposedRef.current = true;
    if (retryTimerRef.current !== undefined) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = undefined;
    connectionRef.current?.close();
    connectionRef.current = undefined;
    setStatusState("closed");
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    void openRef.current();
    return close;
  }, [close, url]);

  const retryNow = useCallback((): void => {
    if (retryTimerRef.current !== undefined) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = undefined;
    attemptRef.current = 0;
    void openRef.current();
  }, []);

  const createThread = useCallback(async (
    input: { workspaceRoot?: string; title?: string } = {},
  ): Promise<string> => {
    const active = clientRef.current;
    if (!active) throw new Error("Not connected");
    store.hydrate({});
    setRecovered(false);
    return startFresh(active, input);
  }, [startFresh, store]);

  const switchThread = useCallback(async (id: string): Promise<void> => {
    const active = clientRef.current;
    if (!active) throw new Error("Not connected");
    if (id === threadIdRef.current) return;
    bufferRef.current = [];
    setCatchingUp(true);
    setRecovered(false);
    /*
     * The store is cleared before the fetch, so the previous conversation cannot
     * be mistaken for this one while it loads, and the paging position is
     * cleared with it.
     */
    store.hydrate({});
    resetHistoryWindow();
    try {
      /*
       * One call, and it returns the newest turns rather than all of them.
       *
       * This is the whole of the speed change: opening a thread used to transfer
       * its entire history before anything could be drawn, so the wait grew with
       * the conversation while the visible work stayed the same. The server now
       * answers with a bounded tail and says whether more exists, and the rest
       * arrives only if the reader scrolls back to want it.
       *
       * `afterSequence: 0` is still right here: the replay buffer is empty for a
       * freshly opened thread, so the events it needs are all of them, and that
       * stream is separate from the turn history.
       */
      const resumed = await active.call<ResumeResult>("thread/resume", {
        threadId: id,
        subscribe: true,
        afterSequence: 0,
      });
      store.seedThread(resumed.thread ?? {});
      /*
       * The turns the resume actually carried, which is the transcript.
       *
       * Without this the page was fetched and discarded: `seedThread` merges the
       * reply's metadata only, so the turn list came from the replay stream
       * alone. That was survivable while a resume replayed every event, and the
       * bounded resume made it plain: a completed mission's journal held 101
       * turns and the UI rendered 4, because only the replayed ones had anywhere
       * to come from.
       *
       * Replaced rather than merged, because the server's page is what the thread
       * is: a merge would keep a ghost of any turn the server no longer has.
       */
      if (Array.isArray(resumed.initialTurnsPage)) {
        store.replaceTurns(id, resumed.initialTurnsPage);
      }
      setThreadId(id);
      rememberThread(id);
      setHasOlderTurns(resumed.hasOlderTurns === true);
      if (resumed.replay?.truncated) {
        setRecovered(true);
        await loadOlderTurns();
      }
    } finally {
      drain();
      setCatchingUp(false);
    }
  }, [drain, loadOlderTurns, resetHistoryWindow, setThreadId, store]);

  /**
   * Drop the open thread without opening another.
   *
   * Used when the thread that was open is deleted: the session has no thread,
   * the UI shows the empty state, and the next message starts a new one. Doing
   * nothing here would leave `threadId` pointing at a record that no longer
   * exists, so the composer would send into a thread the server has forgotten.
   */
  const clearThread = useCallback((): void => {
    forgetThread();
    setThreadId(undefined);
    store.hydrate({});
    /*
     * The paging cursor is cleared with the thread.
     *
     * It is a position in one conversation. Left behind, the next thread opened
     * would page from a cursor that means nothing in it, so "load earlier" would
     * fetch a slice of somebody else's history or nothing at all. Same rule as
     * the composer draft and the queue: state about a conversation does not
     * outlive it.
     */
    resetHistoryWindow();
  }, [resetHistoryWindow, setThreadId, store]);

  return useMemo(() => ({
    status,
    threadId,
    clearThread,
    client,
    catchingUp,
    recovered,
    hasOlderTurns,
    loadOlderTurns,
    retryNow,
    createThread,
    switchThread,
    close,
  }), [status, threadId, client, catchingUp, recovered, hasOlderTurns, loadOlderTurns, retryNow, createThread, switchThread, clearThread, close]);
}

function readRememberedThread(): string | undefined {
  try { return window.localStorage.getItem(THREAD_KEY) ?? undefined; }
  catch { return undefined; }
}
function rememberThread(id: string): void {
  try { window.localStorage.setItem(THREAD_KEY, id); }
  catch { /* The session still works; it simply will not survive a reload. */ }
}
function forgetThread(): void {
  try { window.localStorage.removeItem(THREAD_KEY); }
  catch { /* Convenience only. */ }
}
