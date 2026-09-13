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
 * Both `thread/start` and `thread/resume` answer with the full thread — the
 * only place the app learns a thread's model — and optionally a replay cursor.
 */
interface ResumeResult {
  thread?: { id?: string };
  replay?: { truncated?: boolean };
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

  const backfill = useCallback(async (active: JsonRpcClient, id: string): Promise<void> => {
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await active.call<{ data?: unknown[]; nextCursor?: unknown }>("thread/turns/list", {
        threadId: id,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const turns = (result.data ?? []).filter(
        (raw): raw is Record<string, unknown> => Boolean(raw) && typeof raw === "object",
      );
      if (turns.length > 0) {
        store.hydrate(hydrateFromTurns(store.snapshot(), id, turns));
      }
      if (typeof result.nextCursor !== "string" || !result.nextCursor) return;
      cursor = result.nextCursor;
    }
  }, [store]);

  /**
   * The most recent thread that has never run a turn, or `undefined`.
   *
   * Read from the server rather than from `threads` so it does not depend on
   * the sidebar having finished its own fetch — `attach` runs on connect, and
   * the list may not have landed yet. A failure here is not worth surfacing:
   * the caller simply creates a thread instead.
   */
  const findUnusedThread = useCallback(async (active: JsonRpcClient): Promise<string | undefined> => {
    try {
      const result = await active.call<{ data?: Array<Record<string, unknown>> }>("thread/list", { limit: 100 });
      const entries = result.data ?? [];
      // The list arrives newest-first, so the first match is the most recent
      // scratch thread — which is the one the user most likely meant.
      const entry = entries.find((candidate) => candidate.hasTurns === false && candidate.ephemeral !== true);
      const id = entry?.id;
      return typeof id === "string" && id ? id : undefined;
    } catch {
      return undefined;
    }
  }, []);

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
        const resumed = await active.call<ResumeResult>("thread/resume", {
          threadId: remembered,
          subscribe: true,
          afterSequence: store.snapshot()[remembered]?.latestSequence ?? 0,
        });
        store.seedThread(resumed.thread ?? {});
        setThreadId(remembered);
        rememberThread(remembered);
        if (resumed.replay?.truncated) {
          setRecovered(true);
          await backfill(active, remembered);
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
     * Nothing to resume, so this is a first visit or a discarded thread. An
     * unused scratch thread from an earlier visit is reused rather than
     * creating another: every load used to mint one, so the sidebar filled with
     * a column of identically named rows and no way to tell which was which.
     * A thread only counts as unused if no turn ever ran in it — one with turns
     * is somebody's conversation, and opening it uninvited would be worse than
     * a duplicate row.
     */
    const reusable = await findUnusedThread(active);
    if (reusable) {
      try {
        const resumed = await active.call<ResumeResult>("thread/resume", {
          threadId: reusable,
          subscribe: true,
          afterSequence: 0,
        });
        store.seedThread(resumed.thread ?? {});
        setThreadId(reusable);
        rememberThread(reusable);
        return;
      } catch {
        // Fall through and start a fresh one; a thread that cannot be resumed
        // is exactly the case where creating is the right answer.
      }
    }
    // Auto-attach has no user-supplied name, and a thread with no title falls
    // through to "Untitled thread" in the sidebar. Name it for what it is so
    // the list stays readable; the user can still rename it.
    await startFresh(active, { title: "New chat" });
  }, [backfill, drain, findUnusedThread, setThreadId, startFresh, store]);

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
    store.hydrate({});
    try {
      const resumed = await active.call<ResumeResult>("thread/resume", {
        threadId: id,
        subscribe: true,
        afterSequence: 0,
      });
      store.seedThread(resumed.thread ?? {});
      setThreadId(id);
      rememberThread(id);
      if (resumed.replay?.truncated) {
        setRecovered(true);
        await backfill(active, id);
      }
    } finally {
      drain();
      setCatchingUp(false);
    }
  }, [backfill, drain, setThreadId, store]);

  return useMemo(() => ({
    status,
    threadId,
    client,
    catchingUp,
    recovered,
    retryNow,
    createThread,
    switchThread,
    close,
  }), [status, threadId, client, catchingUp, recovered, retryNow, createThread, switchThread, close]);
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
