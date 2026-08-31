/**
 * Application shell: connection, thread lifecycle, composer, and the
 * scroll-tracking that decides whether the sticky approval bar is needed.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";

import type { ApprovalRequest, AppThreadItem } from "@reaper/web-shared";

import { ApprovalCard, StickyApprovalBar } from "./Approvals.jsx";
import { connect, type Connection, type ConnectionStatus } from "./connection.js";
import { createApprovalQueue, createTranscriptStore } from "./store.js";
import { Transcript } from "./Transcript.jsx";
import { Workbench } from "./Workbench.jsx";

// Same-origin by default: the dev server and the production build both proxy
// /ws and /api to the BFF, so the BFF never needs a reachable address of its
// own. That keeps exactly one origin published.
const BFF_HTTP = import.meta.env.VITE_BFF_URL ?? window.location.origin;
const BFF_WS = BFF_HTTP.replace(/^http/, "ws") + "/ws";

export function App(): JSX.Element {
  const store = createTranscriptStore();
  const approvals = createApprovalQueue();
  const [status, setStatus] = createSignal<ConnectionStatus>("connecting");
  const [connection, setConnection] = createSignal<Connection>();
  const [threadId, setThreadId] = createSignal<string>();
  const [draft, setDraft] = createSignal("");
  const [error, setError] = createSignal<string>();

  let transcriptEl: HTMLDivElement | undefined;
  const [approvalVisible, setApprovalVisible] = createSignal(true);

  void (async () => {
    try {
      const active = await connect(BFF_WS, {
        onNotification: (method, params) => store.ingest(method, params),
        onApproval: (request) => approvals.add(request),
        onApprovalResolved: (approvalId) => approvals.remove(approvalId),
        onStatusChange: setStatus,
      });
      setConnection(active);

      const started = await active.client.call<{ thread?: { id?: string } }>("thread/start", {
        permissionMode: "auto",
        subscribe: true,
      });
      setThreadId(started.thread?.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect");
      setStatus("closed");
    }
  })();

  onCleanup(() => connection()?.close());

  const turns = createMemo(() => {
    const id = threadId();
    return id ? (store.threads[id]?.turns ?? []) : [];
  });

  // Follow Mode's input: the path of the most recent file change.
  const lastEditedPath = createMemo(() => {
    let path: string | undefined;
    for (const turn of turns()) {
      for (const item of turn.items) {
        if (item.type === "fileChange" && item.changes.length > 0) {
          path = item.changes[item.changes.length - 1]!.path;
        }
      }
    }
    return path;
  });

  const pendingApproval = createMemo(() => approvals.pending()[0]);

  // Auto-scroll only when the user is already at the bottom. Yanking the view
  // back while they are reading history is the most common way live
  // transcripts become unusable.
  createEffect(() => {
    void turns();
    const element = transcriptEl;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    if (atBottom) queueMicrotask(() => element.scrollTo({ top: element.scrollHeight }));
  });

  // The turn the agent is currently running, if any. `turn/start` resolves as
  // soon as the turn is accepted, not when it finishes, so the transcript — not
  // the await — is what tells us whether the agent is still working.
  const activeTurn = createMemo(() => turns().find((turn) => turn.status === "inProgress"));

  /**
   * Messages typed while a turn is in flight.
   *
   * The app-server advertises `steeringGranularity: "model_loop_boundary"`, so a
   * steered message is picked up by the *next* model request — after the tool
   * calls already in flight finish, never mid-tool. That is exactly the queue
   * semantics users expect: keep typing, and your message lands at the next
   * natural seam instead of interrupting.
   *
   * An entry stays here until the message actually appears in the transcript,
   * not merely until the server accepts it. `turn/steer` resolves the instant
   * the message is enqueued, but the agent does not pick it up until the next
   * model request — dropping the card at accept-time would leave the message
   * invisible in between, which reads as "my message vanished".
   *
   * `sent` marks an entry the server has taken. It stays on screen but can no
   * longer be cancelled, because the server already owns it.
   */
  const [queued, setQueued] = createSignal<Array<{ id: string; text: string; sent: boolean }>>([]);
  let queueSeq = 0;

  const dropQueued = (id: string): void => {
    setQueued((entries) => entries.filter((entry) => entry.id !== id));
  };

  const markSent = (id: string): void => {
    setQueued((entries) => entries.map((entry) => entry.id === id ? { ...entry, sent: true } : entry));
  };

  /** Hand one queued message to the server, as a steer or as a fresh turn. */
  const flushOne = async (entry: { id: string; text: string }): Promise<boolean> => {
    const active = connection();
    const id = threadId();
    if (!active || !id) return false;

    const turn = activeTurn();
    if (turn) {
      const result = await active.client.call<{ accepted?: boolean; reason?: string }>("turn/steer", {
        threadId: id,
        turnId: turn.id,
        message: entry.text,
      });
      if (result.accepted) return true;
      // "closed" means the turn ended between our check and the call. Anything
      // else (queue_full) is real backpressure — leave it queued and surface it.
      if (result.reason !== "closed") {
        setError(result.reason === "queue_full"
          ? "The agent's message queue is full. Wait for it to catch up."
          : `Message not accepted: ${result.reason ?? "unknown"}`);
        return false;
      }
    }

    await active.client.call("turn/start", { threadId: id, prompt: entry.text });
    return true;
  };

  const flushing = { active: false };
  /**
   * Drain the queue oldest-first, one at a time. Serialized because two
   * concurrent `turn/start` calls race — the app-server rejects the second with
   * `turn_in_progress` and the message would be silently lost.
   */
  const flush = async (): Promise<void> => {
    if (flushing.active) return;
    flushing.active = true;
    try {
      for (;;) {
        const next = queued().find((entry) => !entry.sent);
        if (!next) return;
        let delivered = false;
        try {
          delivered = await flushOne(next);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Message could not be delivered");
          return;
        }
        if (!delivered) return;
        // Held, not dropped: the transcript reconciler below clears it once the
        // agent actually picks the message up.
        markSent(next.id);
      }
    } finally {
      flushing.active = false;
    }
  };

  // Retry the queue whenever the turn state changes: a turn finishing is what
  // unblocks a message that could not be steered into it.
  createEffect(() => {
    void activeTurn()?.id;
    void activeTurn()?.status;
    void queued().length;
    if (queued().some((entry) => !entry.sent)) void flush();
  });

  /**
   * Retire a held card once its text shows up as a `userMessage` in the
   * transcript — the moment the agent has actually taken the message. Matching
   * on text means a duplicate send retires one card per transcript item, which
   * is what the user sees anyway.
   */
  createEffect(() => {
    const held = queued().filter((entry) => entry.sent);
    if (held.length === 0) return;
    const pending = new Set<string>();
    for (const turn of turns()) {
      for (const item of turn.items) {
        if (item.type !== "userMessage") continue;
        for (const part of item.content) {
          if (part.type === "text") pending.add(part.text.trim());
        }
      }
    }
    const landed = held.filter((entry) => pending.has(entry.text.trim())).map((entry) => entry.id);
    if (landed.length > 0) setQueued((entries) => entries.filter((entry) => !landed.includes(entry.id)));
  });

  const send = (): void => {
    const text = draft().trim();
    if (!text || !connection() || !threadId()) return;
    setError(undefined);
    setDraft("");
    queueSeq += 1;
    setQueued((entries) => [...entries, { id: `q-${queueSeq}`, text, sent: false }]);
    void flush();
  };

  const decide = (approvalId: string, decision: string): void => {
    connection()?.client.notify("approval/respond", { approvalId, decision });
    approvals.remove(approvalId);
  };

  const interrupt = (): void => {
    const id = threadId();
    if (id) connection()?.client.notify("turn/interrupt", { threadId: id });
  };

  return (
    <div class="app">
      <header class="app-header">
        <span class="app-title">Reaper</span>
        <span class="status-dot" data-status={status()} />
        <span class="status-label">
          {status() === "open" ? "connected" : status() === "connecting" ? "connecting…" : "disconnected"}
        </span>
        {/* Gated on a running turn, not on the thread: a thread exists for the
            whole session, so gating on it left Interrupt offered permanently —
            a control that stops nothing, and that reads as "still working"
            after the agent has finished. */}
        <Show when={activeTurn()}>
          <span class="status-label" style={{ "margin-left": "auto" }}>
            <button class="btn" onClick={interrupt}>Interrupt</button>
          </span>
        </Show>
      </header>

      <div class="app-body">
        <div class="chat-pane">
          <div class="transcript" ref={transcriptEl}>
            <Show when={error()}>
              {(message) => <p class="empty" role="alert">{message()}</p>}
            </Show>

            <Show when={turns().length > 0} fallback={
              <p class="empty">
                {status() === "open" ? "Ask the agent to do something." : "Waiting for the agent…"}
              </p>
            }>
              <Transcript turns={turns()} />
            </Show>

            {/* Messages waiting for the next model-loop boundary. Shown in the
                transcript, in order, so the queue reads as part of the
                conversation rather than as a separate holding tank. */}
            <For each={queued()}>
              {(entry) => (
                <div class="queued-message" data-sent={entry.sent ? "true" : undefined}>
                  <div class="queued-body">{entry.text}</div>
                  <div class="queued-meta">
                    <span>
                      {entry.sent
                        ? "Handed to the agent — sends after the current step"
                        : "Queued — sends after the current step"}
                    </span>
                    {/* Cancelling stops being honest once the server has the
                        message: it would clear the card while the agent still
                        delivers it. So the button only exists before that. */}
                    <Show when={!entry.sent}>
                      <button
                        class="btn"
                        data-variant="ghost"
                        aria-label={`Cancel queued message: ${entry.text}`}
                        onClick={() => dropQueued(entry.id)}
                      >
                        Cancel
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>

            {/* Inline approval, at the point in the transcript where it happened. */}
            <For each={approvals.pending()}>
              {(request) => (
                <ApprovalVisibility onVisibilityChange={setApprovalVisible}>
                  <ApprovalCard request={request} onDecide={decide} />
                </ApprovalVisibility>
              )}
            </For>
          </div>

          {/* Sticky bar only when the inline card scrolled away. */}
          <Show when={pendingApproval() && !approvalVisible()}>
            <StickyApprovalBar
              request={pendingApproval() as ApprovalRequest}
              onDecide={decide}
              onReveal={() => transcriptEl?.scrollTo({ top: transcriptEl.scrollHeight })}
            />
          </Show>

          <div class="composer">
            <textarea
              value={draft()}
              // Never disabled while connected. Typing during a turn is the
              // point: the message queues rather than being refused.
              placeholder={activeTurn() ? "Add a message — sends after the current step…" : "Ask the agent to do something…"}
              disabled={status() !== "open"}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <button
              class="btn"
              data-variant="primary"
              disabled={!draft().trim() || status() !== "open"}
              onClick={send}
            >
              {activeTurn() ? "Queue" : "Send"}
            </button>
          </div>
        </div>

        <Workbench baseUrl={BFF_HTTP} lastEditedPath={lastEditedPath()} />
      </div>
    </div>
  );
}

/**
 * Reports whether its child is on screen, so the sticky bar appears only when
 * the inline approval is not visible. Uses IntersectionObserver rather than
 * scroll math so it stays correct through layout changes.
 */
function ApprovalVisibility(props: {
  children: JSX.Element;
  onVisibilityChange: (visible: boolean) => void;
}): JSX.Element {
  let element: HTMLDivElement | undefined;

  createEffect(() => {
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => props.onVisibilityChange(entries[0]?.isIntersecting ?? true),
      { threshold: 0.1 },
    );
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });

  return <div ref={element}>{props.children}</div>;
}
