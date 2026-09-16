import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ApprovalRequest, AppThread, AppThreadItem, AppTurn, JsonRpcClient } from "@reaper/web-shared";

import { useBackgroundState, type BackgroundState } from "../background.js";
import { useModelCatalog, type ModelCatalog } from "../models.js";
import { useSession, type Session } from "../session.js";
import { useSettingsStore, type SettingsStore } from "../settings.js";
import { createTranscriptStore, useTranscriptState, type TranscriptStore } from "../store.js";
import type { ThreadSummary } from "../ThreadList.jsx";

export const BFF_HTTP = import.meta.env.VITE_BFF_URL ?? window.location.origin;
export const BFF_WS = BFF_HTTP.replace(/^http/, "ws") + "/ws";

/**
 * When a queued message is handed to the agent.
 *
 *  - `next-step` steers the running turn: the agent reads the message after the
 *    tool call it is on, so it can course-correct mid-work.
 *  - `after-turn` waits: the message starts a fresh turn only once the agent has
 *    finished everything for the current prompt, so it is a follow-up rather
 *    than an interruption.
 *
 * Both are user-visible and user-choosable per message, because the right one
 * depends on what the message is: "stop, wrong file" wants `next-step`, "now do
 * X as well" wants `after-turn`.
 */
export type QueueMode = "next-step" | "after-turn";

export interface QueuedMessage {
  id: string;
  text: string;
  sent: boolean;
  mode: QueueMode;
}

export interface AppContextValue {
  transcriptStore: TranscriptStore;
  session: Session;
  client: JsonRpcClient | undefined;
  threadId: string | undefined;
  thread: AppThread | undefined;
  turns: AppTurn[];
  activeTurn: AppTurn | undefined;
  lastEditedPath: string | undefined;
  /** Bumped per file change; part of the workbench cache key so it refetches. */
  workspaceRevision: number;
  connectionLabel: string;
  error: string | undefined;
  setError(message: string | undefined): void;
  approvals: ApprovalRequest[];
  decide(approvalId: string, decision: string): void;
  background: BackgroundState;
  catalog: ModelCatalog;
  settings: SettingsStore;
  threads: ThreadSummary[];
  threadsLoading: boolean;
  refreshThreads(): void;
  createThread(input: { workspaceRoot?: string; title?: string }): Promise<void>;
  switchThread(id: string): Promise<void>;
  queued: QueuedMessage[];
  /** Queue a message. Defaults to `next-step` when no mode is given. */
  sendMessage(text: string, mode?: QueueMode): void;
  dropQueued(id: string): void;
  /** Change when a queued message is handed to the agent. */
  setQueuedMode(id: string, mode: QueueMode): void;
  interrupt(): void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }): ReactNode {
  const transcriptStore = useMemo(() => createTranscriptStore(), []);
  const threadsState = useTranscriptState(transcriptStore);
  const background = useBackgroundState();
  const catalog = useModelCatalog();
  const settings = useSettingsStore();
  const [error, setError] = useState<string>();
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);

  const onApproval = useCallback((request: ApprovalRequest): void => {
    setApprovals((current) => current.some((entry) => entry.approvalId === request.approvalId)
      ? current
      : [...current, request]);
  }, []);
  const onApprovalResolved = useCallback((approvalId: string): void => {
    setApprovals((current) => current.filter((entry) => entry.approvalId !== approvalId));
  }, []);

  const session = useSession(BFF_WS, transcriptStore, {
    onApproval,
    onApprovalResolved,
    onError: setError,
    onNotification: background.ingest,
  });
  const client = session.client;
  const threadId = session.threadId;
  const thread = threadId ? threadsState[threadId] : undefined;
  const turns = thread?.turns ?? [];
  const activeTurn = turns.find((turn) => turn.status === "inProgress");

  /**
   * Number of file changes the transcript has recorded for this thread.
   *
   * The workbench caches by request key, and a directory listing's key is
   * `<threadId>:<path>` — which does not change when the agent writes a file.
   * Without a change signal the tree kept serving the listing it fetched when
   * the thread was opened, so a file the agent had just created stayed
   * invisible until a page reload. Folding this counter into the key makes the
   * tree and an open file refetch whenever the agent edits anything, including
   * repeat edits to the same path.
   */
  const workspaceRevision = useMemo(() => {
    let changes = 0;
    for (const turn of turns) {
      for (const item of turn.items) {
        if (item.type === "fileChange") changes += item.changes.length;
      }
    }
    return changes;
  }, [turns]);

  const lastEditedPath = useMemo(() => {
    let edited: string | undefined;
    for (const turn of turns) {
      for (const item of turn.items) {
        if (item.type === "fileChange" && item.changes.length > 0) {
          edited = item.changes[item.changes.length - 1]!.path;
        }
      }
    }
    return edited;
    // Scoped to the thread: this is a key that triggers a fetch, and
    // `useRemote` keeps its previous `value` while a new key loads. Carrying a
    // path across a thread switch would briefly serve one thread's file
    // contents under another thread's id before the reload resolved.
  }, [turns, threadId]);

  const connectionLabel = session.catchingUp
    ? "catching up…"
    : session.status === "open"
      ? "connected"
      : session.status === "connecting"
        ? "connecting…"
        : session.status === "reconnecting"
          ? "reconnecting…"
          : "disconnected";

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const refreshThreads = useCallback((): void => {
    if (!client) return;
    setThreadsLoading(true);
    void client.call<{ data?: ThreadSummary[] }>("thread/list", { limit: 100 })
      .then((result) => setThreads(result.data ?? []))
      .catch(() => undefined)
      .finally(() => setThreadsLoading(false));
  }, [client]);

  useEffect(() => {
    if (!client) return;
    refreshThreads();
    void catalog.refresh(client);
  }, [client]); // Catalog object changes when data changes; refresh only on connection identity.

  const createThread = useCallback(async (input: { workspaceRoot?: string; title?: string }): Promise<void> => {
    await session.createThread(input);
    refreshThreads();
  }, [refreshThreads, session]);
  const switchThread = useCallback(async (id: string): Promise<void> => {
    await session.switchThread(id);
    refreshThreads();
  }, [refreshThreads, session]);

  const decide = useCallback((approvalId: string, decision: string): void => {
    client?.notify("approval/respond", { approvalId, decision });
    setApprovals((current) => current.filter((entry) => entry.approvalId !== approvalId));
  }, [client]);

  const interrupt = useCallback((): void => {
    if (threadId) client?.notify("turn/interrupt", { threadId });
  }, [client, threadId]);

  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const queueSeq = useRef(0);
  const flushing = useRef(false);
  const queuedRef = useRef(queued);
  queuedRef.current = queued;
  const activeTurnRef = useRef(activeTurn);
  activeTurnRef.current = activeTurn;
  const clientRef = useRef(client);
  clientRef.current = client;
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const dropQueued = useCallback((id: string): void => {
    setQueued((entries) => entries.filter((entry) => entry.id !== id));
  }, []);

  /**
   * Deliver one queued message, honoring its mode.
   *
   * Returns false when the message is not eligible *yet* — a `next-step`
   * message with no turn to steer, or an `after-turn` message while a turn is
   * still running. Ineligible is not an error: the entry stays queued and the
   * effect below re-runs it when the turn state changes, which is what makes
   * "after the model finishes" mean what it says instead of firing early.
   */
  const flushOne = useCallback(async (entry: QueuedMessage): Promise<boolean> => {
    const active = clientRef.current;
    const id = threadIdRef.current;
    if (!active || !id) return false;
    const running = activeTurnRef.current;
    if (entry.mode === "next-step" && running) {
      /*
       * Steer the running turn: the agent reads this after the tool call it is
       * on. Acceptance here means "queued server-side", not "in the model's
       * context yet" — the server publishes it as a user message at the drain
       * point, and the transcript shows it then.
       */
      const result = await active.call<{ accepted?: boolean; reason?: string }>("turn/steer", {
        threadId: id,
        turnId: running.id,
        message: entry.text,
      });
      if (result.accepted) return true;
      if (result.reason !== "closed") {
        setError(result.reason === "queue_full"
          ? "The agent's message queue is full. Wait for it to catch up."
          : `Message not accepted: ${result.reason ?? "unknown"}`);
        return false;
      }
      // The turn closed between the check and the call; fall through to start.
    }
    // `after-turn` waits for the running turn to end before it is sent.
    if (entry.mode === "after-turn" && running) return false;
    await active.call("turn/start", { threadId: id, prompt: entry.text });
    return true;
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      /*
       * One message per pass. Delivering a second would race the first: a
       * `turn/start` does not update `activeTurnRef` synchronously, so the loop
       * would see "no turn running" and start another, and the thread would
       * have two turns in flight. Marking the first sent changes `queued`, which
       * re-runs the effect, which runs the next eligible message — so the queue
       * still drains, one turn at a time.
       */
      const running = activeTurnRef.current;
      const next = queuedRef.current.find(
        (entry) => !entry.sent && (entry.mode === "next-step" || !running),
      );
      if (!next) return;
      let delivered = false;
      try { delivered = await flushOne(next); }
      catch (cause) {
        setError(cause instanceof Error ? cause.message : "Message could not be delivered");
        return;
      }
      if (!delivered) return;
      setQueued((entries) => entries.map((entry) => entry.id === next.id ? { ...entry, sent: true } : entry));
      queuedRef.current = queuedRef.current.map((entry) => entry.id === next.id ? { ...entry, sent: true } : entry);
    } finally {
      flushing.current = false;
    }
  }, [flushOne]);

  useEffect(() => {
    if (queued.some((entry) => !entry.sent)) void flush();
  }, [activeTurn?.id, activeTurn?.status, queued, flush]);

  useEffect(() => {
    const held = queued.filter((entry) => entry.sent);
    if (held.length === 0) return;
    /*
     * Count occurrences, not membership.
     *
     * A Set of landed texts says "somewhere in the transcript there is a message
     * with this text" — and re-sending the same words the user sent before (a
     * repeated "continue", or a retry after a failure) matched an *earlier*
     * turn, so the queued card vanished while it was still pending. Counting
     * lets each queued entry claim a distinct landed occurrence: the nth queued
     * "continue" is removed by the nth landed "continue", not the first.
     */
    const landedCounts = new Map<string, number>();
    for (const turn of turns) {
      for (const item of turn.items) {
        if (item.type !== "userMessage") continue;
        for (const part of item.content) {
          if (part.type !== "text") continue;
          const key = part.text.trim();
          landedCounts.set(key, (landedCounts.get(key) ?? 0) + 1);
        }
      }
    }
    const consume = [...held].sort((a, b) => a.id.localeCompare(b.id));
    const landedIds: string[] = [];
    for (const entry of consume) {
      const key = entry.text.trim();
      const left = landedCounts.get(key) ?? 0;
      if (left <= 0) continue;
      landedCounts.set(key, left - 1);
      landedIds.push(entry.id);
    }
    if (landedIds.length > 0) setQueued((entries) => entries.filter((entry) => !landedIds.includes(entry.id)));
  }, [queued, turns]);

  const sendMessage = useCallback((raw: string, mode: QueueMode = "next-step"): void => {
    const text = raw.trim();
    if (!text || !clientRef.current || !threadIdRef.current) return;
    setError(undefined);
    queueSeq.current += 1;
    setQueued((entries) => [...entries, { id: `q-${queueSeq.current}`, text, sent: false, mode }]);
  }, []);

  const setQueuedMode = useCallback((id: string, mode: QueueMode): void => {
    // An already-delivered message cannot be re-routed; only pending ones can.
    setQueued((entries) => entries.map((entry) => (entry.id === id && !entry.sent ? { ...entry, mode } : entry)));
    queuedRef.current = queuedRef.current.map((entry) => (entry.id === id && !entry.sent ? { ...entry, mode } : entry));
  }, []);

  const value = useMemo<AppContextValue>(() => ({
    transcriptStore,
    session,
    client,
    threadId,
    thread,
    turns,
    activeTurn,
    lastEditedPath,
    workspaceRevision,
    connectionLabel,
    error,
    setError,
    approvals,
    decide,
    background,
    catalog,
    settings,
    threads,
    threadsLoading,
    refreshThreads,
    createThread,
    switchThread,
    queued,
    sendMessage,
    dropQueued,
    setQueuedMode,
    interrupt,
  }), [
    transcriptStore, session, client, threadId, thread, turns, activeTurn,
    lastEditedPath, workspaceRevision, connectionLabel, error, approvals, decide, background,
    catalog, settings, threads, threadsLoading, refreshThreads, createThread,
    switchThread, queued, sendMessage, dropQueued, setQueuedMode, interrupt,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}

export function latestFileChange(items: AppThreadItem[]): string | undefined {
  let value: string | undefined;
  for (const item of items) {
    if (item.type === "fileChange" && item.changes.length > 0) value = item.changes.at(-1)?.path;
  }
  return value;
}
