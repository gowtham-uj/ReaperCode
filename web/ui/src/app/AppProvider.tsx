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

export interface QueuedMessage { id: string; text: string; sent: boolean }

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
  sendMessage(text: string): void;
  dropQueued(id: string): void;
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

  const flushOne = useCallback(async (entry: Pick<QueuedMessage, "id" | "text">): Promise<boolean> => {
    const active = clientRef.current;
    const id = threadIdRef.current;
    if (!active || !id) return false;
    const running = activeTurnRef.current;
    if (running) {
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
    }
    await active.call("turn/start", { threadId: id, prompt: entry.text });
    return true;
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      for (;;) {
        const next = queuedRef.current.find((entry) => !entry.sent);
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
      }
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
    const landedText = new Set<string>();
    for (const turn of turns) {
      for (const item of turn.items) {
        if (item.type !== "userMessage") continue;
        for (const part of item.content) if (part.type === "text") landedText.add(part.text.trim());
      }
    }
    const landedIds = held.filter((entry) => landedText.has(entry.text.trim())).map((entry) => entry.id);
    if (landedIds.length > 0) setQueued((entries) => entries.filter((entry) => !landedIds.includes(entry.id)));
  }, [queued, turns]);

  const sendMessage = useCallback((raw: string): void => {
    const text = raw.trim();
    if (!text || !clientRef.current || !threadIdRef.current) return;
    setError(undefined);
    queueSeq.current += 1;
    setQueued((entries) => [...entries, { id: `q-${queueSeq.current}`, text, sent: false }]);
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
    interrupt,
  }), [
    transcriptStore, session, client, threadId, thread, turns, activeTurn,
    lastEditedPath, workspaceRevision, connectionLabel, error, approvals, decide, background,
    catalog, settings, threads, threadsLoading, refreshThreads, createThread,
    switchThread, queued, sendMessage, dropQueued, interrupt,
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
