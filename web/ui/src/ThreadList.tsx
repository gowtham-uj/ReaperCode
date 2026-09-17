import { useEffect, useRef, useState } from "react";
import type { JsonRpcClient } from "@reaper/web-shared";

import { TrashIcon } from "./icons.jsx";

export interface ThreadSummary {
  id: string;
  name?: string;
  preview?: string;
  cwd?: string;
  status?: string;
  updatedAt?: string;
}

export function threadLabel(entry: ThreadSummary | undefined, fallbackId?: string): string {
  if (entry?.name) return entry.name;
  const preview = entry?.preview?.trim();
  if (preview) return preview.length > 60 ? `${preview.slice(0, 60)}…` : preview;
  return entry?.id || fallbackId ? "Untitled thread" : "No thread";
}

const ISOLATED_WORKSPACE = /[\\/]\.reaper[\\/]workspaces[\\/][0-9a-f-]{8,}\/?$/i;

/**
 * The secondary line under a thread name. A thread-scoped workspace path ends
 * in the thread's own UUID, which tells the user nothing; and since it is the
 * default for every thread, printing it on every row is pure repetition. Those
 * rows get no second line at all. A thread pointed at a real project is the
 * exception worth calling out, and shows that project's folder rather than a
 * full absolute path.
 */
export function threadWorkspaceLabel(cwd: string | undefined): string | undefined {
  const trimmed = cwd?.trim();
  if (!trimmed) return undefined;
  if (ISOLATED_WORKSPACE.test(trimmed)) return undefined;
  const segments = trimmed.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  const leaf = segments.at(-1);
  if (!leaf) return trimmed;
  const parent = segments.at(-2);
  return parent ? `${parent}/${leaf}` : leaf;
}

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/**
 * A relative age for the thread row's second line.
 *
 * Most threads sit in a thread-scoped workspace, so `threadWorkspaceLabel`
 * returns nothing for them and the row collapses to a bare title. Since the
 * default title is the same for every such thread, the list rendered as a
 * column of identical "New chat" rows with nothing to tell them apart. Age is
 * the one thing that always differs, and it is already on the wire.
 */
export function threadAgeLabel(updatedAt: string | undefined, now: number): string | undefined {
  if (!updatedAt) return undefined;
  const stamp = Date.parse(updatedAt);
  if (Number.isNaN(stamp)) return undefined;
  const elapsed = now - stamp;
  if (elapsed < MINUTE) return "Just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  return new Date(stamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ThreadList({ client, activeThreadId, threads, loading, onRefresh, onCreate, onSwitch, onDelete, collapsed = false, creationRequest = 0, onRequestCreate }: {
  client: JsonRpcClient | undefined;
  activeThreadId: string | undefined;
  threads: ThreadSummary[];
  loading: boolean;
  onRefresh(): void;
  onCreate(input: { workspaceRoot?: string; title?: string }): Promise<string>;
  onSwitch(id: string): Promise<void>;
  /** Remove a thread, its workspace and its browser pages. */
  onDelete?(id: string): Promise<void>;
  collapsed?: boolean;
  creationRequest?: number;
  onRequestCreate?(): void;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const titleRef = useRef<HTMLInputElement>(null);

  // "3m ago" that never becomes "4m ago" is worse than no timestamp; tick once
  // a minute, which is the finest granularity the labels actually render.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (creationRequest > 0) setCreating(true);
  }, [creationRequest]);

  useEffect(() => {
    if (creating) queueMicrotask(() => titleRef.current?.focus());
  }, [creating]);

  const create = async (): Promise<void> => {
    const nextTitle = title.trim();
    if (!nextTitle) {
      setFailure("Give this thread a name before creating it.");
      titleRef.current?.focus();
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      // No workspace argument: the server gives every web thread its own empty
      // folder, and a thread pointed at a real project is repointed from that
      // thread's settings rather than decided before it exists.
      await onCreate({ title: nextTitle });
      setTitle("");
      setCreating(false);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Could not create the thread");
    } finally {
      setBusy(false);
    }
  };

  const pick = async (id: string): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    try { await onSwitch(id); }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : "Could not open that thread"); }
    finally { setBusy(false); }
  };

  if (collapsed) {
    return (
      <div className="thread-rail" aria-label="Threads">
        <button
          className="sidebar-icon-button rail-new-thread"
          type="button"
          aria-label="New thread"
          disabled={!client || busy}
          onClick={() => onRequestCreate?.()}
        ><PlusIcon /></button>
        {threads.slice(0, 6).map((entry) => (
          <button
            className="thread-rail-entry"
            data-active={entry.id === activeThreadId || undefined}
            aria-label={threadLabel(entry, entry.id)}
            aria-current={entry.id === activeThreadId ? "page" : undefined}
            key={entry.id}
            onClick={() => void pick(entry.id)}
          >
            {threadLabel(entry, entry.id).slice(0, 1).toUpperCase()}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="sidebar-threads">
      <div className="sidebar-section-head">
        <span>Threads</span>
        <button className="sidebar-icon-button" type="button" aria-label="Refresh threads" disabled={!client || busy} onClick={onRefresh}><RefreshIcon spinning={busy} /></button>
      </div>
      {creating && (
        <form className="thread-create" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <label className="field">
            <span>Name</span>
            <input
              ref={titleRef}
              value={title}
              disabled={busy}
              required
              maxLength={500}
              autoComplete="off"
              placeholder="What is this thread for?"
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </label>
          {/*
            Name only. Choosing a workspace is a rare, more involved decision
            than "start a chat", and asking for it here put a directory picker
            in the way of the one action this form exists to perform. The
            default is a fresh folder per thread; a thread that needs a real
            project gets one from its own settings, which is where every other
            per-thread choice already lives.
          */}
          <div className="form-actions">
            <button className="button" data-variant="primary" disabled={busy || !title.trim()}>{busy ? "Creating…" : "Create"}</button>
            <button className="button" data-variant="ghost" type="button" disabled={busy} onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
      )}
      {failure && <p className="field-error" role="alert">{failure}</p>}
      <div className="thread-list-scroll">
        {threads.length === 0 ? (
          <p className="sidebar-empty">{loading ? "Loading threads…" : "No threads yet."}</p>
        ) : (
          <ul className="thread-list">
            {threads.map((entry) => (
              <li key={entry.id} className="thread-row">
                {/*
                  The row is a div rather than a button, because it holds two
                  buttons now and a button inside a button is invalid HTML that
                  browsers resolve by dropping one of them. The click target is
                  the larger of the two, so the row still behaves like the single
                  control it mostly is.
                */}
                <button
                  className="thread-entry"
                  type="button"
                  data-active={entry.id === activeThreadId || undefined}
                  aria-current={entry.id === activeThreadId ? "page" : undefined}
                  disabled={busy}
                  onClick={() => void pick(entry.id)}
                >
                  <span className="thread-entry-name">{threadLabel(entry, entry.id)}</span>
                  <ThreadEntryMeta entry={entry} now={now} />
                </button>
                {/*
                  Delete, at the trailing edge of the card.
                  *
                  * Always present rather than revealed on hover: a control that
                  * exists only under the pointer cannot be reached with a
                  * keyboard and cannot be found by anyone who does not already
                  * know it is there. `Delete` asks once and then removes the
                  * thread, its workspace and its browser pages.
                */}
                <button
                  className="thread-delete"
                  type="button"
                  disabled={busy}
                  aria-label={`Delete ${threadLabel(entry, entry.id)}`}
                  title="Delete this thread"
                  onClick={(event) => {
                    event.stopPropagation();
                    void onDelete?.(entry.id);
                  }}
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {/*
        The form opens at the top of the panel, above the list, because that is
        where the thread it creates will appear. Leaving this button at the
        bottom while the form is open would leave two creation affordances in
        one panel, and the one the user just clicked still labeled "New thread"
        would read as the thing that did nothing.
      */}
      {!creating && (
        <button className="new-thread-button" type="button" disabled={!client || busy} onClick={() => setCreating(true)}>
          <PlusIcon /><span>New thread</span>
        </button>
      )}
    </div>
  );
}

function ThreadEntryMeta({ entry, now }: { entry: ThreadSummary; now: number }) {
  const project = threadWorkspaceLabel(entry.cwd);
  const age = threadAgeLabel(entry.updatedAt, now);
  if (!project && !age) return null;
  return (
    <span className="thread-entry-path">
      {project && <span className="thread-entry-project" title={entry.cwd}>{project}</span>}
      {project && age && <span aria-hidden="true">·</span>}
      {age && <span>{age}</span>}
    </span>
  );
}

function PlusIcon() { return <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>; }
function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg className="refresh-icon" data-spinning={spinning || undefined} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M13.2 8a5.2 5.2 0 1 1-1.53-3.68" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M13.4 2.2v3.1h-3.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
