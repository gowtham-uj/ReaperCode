import { useEffect, useMemo, useRef, useState } from "react";
import type { BrowserSurface } from "@reaper/web-shared";
import type { BackgroundProcess, BackgroundState } from "./background.js";
import { DiffView } from "./Transcript.jsx";
import { LiveBrowser } from "./LiveBrowser.jsx";

export type WorkbenchMode = "files" | "diff" | "output" | "preview" | "browser";
interface TreeEntry { name: string; path: string; type: "file" | "directory" }

const WORKBENCH_MODES: WorkbenchMode[] = ["files", "diff", "output", "preview", "browser"];

/** Arrow/Home/End navigation between tabs, as the tablist pattern expects. */
function moveTabFocus(event: React.KeyboardEvent<HTMLButtonElement>, current: WorkbenchMode, setMode: (mode: WorkbenchMode) => void): void {
  const index = WORKBENCH_MODES.indexOf(current);
  const next = event.key === "ArrowRight" ? (index + 1) % WORKBENCH_MODES.length
    : event.key === "ArrowLeft" ? (index - 1 + WORKBENCH_MODES.length) % WORKBENCH_MODES.length
    : event.key === "Home" ? 0
    : event.key === "End" ? WORKBENCH_MODES.length - 1
    : -1;
  if (next < 0) return;
  event.preventDefault();
  setMode(WORKBENCH_MODES[next]!);
  const target = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#workbench-tab-${WORKBENCH_MODES[next]!}`);
  target?.focus();
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    const code = await response.json().then((body: unknown) => (body as { error?: string }).error).catch(() => undefined);
    throw new Error(code ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function useRemote<T>(key: string | undefined, load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ value?: T; error?: Error; loading: boolean }>({ loading: false });
  useEffect(() => {
    if (!key) { setState({ loading: false }); return; }
    const controller = new AbortController();
    setState((current) => current.value === undefined
      ? { loading: true }
      : { value: current.value, loading: true });
    void load(controller.signal).then(
      (value) => setState({ value, loading: false }),
      (cause: unknown) => { if (!controller.signal.aborted) setState({ error: cause instanceof Error ? cause : new Error(String(cause)), loading: false }); },
    );
    return () => controller.abort();
  }, [key]);
  return state;
}

export function Workbench({ baseUrl, threadId, lastEditedPath, workspaceRevision, background, browser, mode: controlledMode, onModeChange }: {
  baseUrl: string;
  threadId: string | undefined;
  lastEditedPath: string | undefined;
  workspaceRevision: number;
  background: BackgroundState;
  browser: BrowserSurface | undefined;
  mode?: WorkbenchMode;
  onModeChange?(mode: WorkbenchMode): void;
}) {
  const [localMode, setLocalMode] = useState<WorkbenchMode>("files");
  const mode = controlledMode ?? localMode;
  const setMode = (next: WorkbenchMode): void => { setLocalMode(next); onModeChange?.(next); };
  const [follow, setFollow] = useState(true);
  const [dir, setDir] = useState(".");
  const [selected, setSelected] = useState<string>();
  const [uploads, setUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string>();
  // An upload writes to disk behind the tree's cache, exactly like the agent's
  // own edits do, so it has to invalidate the same way — otherwise the file the
  // user just dropped in stays invisible until something else bumps the count.
  const revision = workspaceRevision + uploads;

  // `revision` is the number of file changes the transcript has recorded. It is
  // part of every cache key because none of these responses change when the
  // *request* changes — the agent writes to disk behind them. Without it the
  // tree kept serving the listing fetched when the thread was opened, so a file
  // the agent had just created stayed invisible for the rest of the session.
  const entries = useRemote(
    threadId ? `${threadId}:${revision}:${dir}` : undefined,
    (signal) => fetchJson<{ entries: TreeEntry[] }>(`${baseUrl}/api/files?threadId=${encodeURIComponent(threadId!)}&path=${encodeURIComponent(dir)}`, signal).then((result) => result.entries),
  );
  const file = useRemote(
    threadId && selected ? `${threadId}:${revision}:${selected}` : undefined,
    (signal) => fetchJson<{ contents: string; truncated: boolean }>(`${baseUrl}/api/file?threadId=${encodeURIComponent(threadId!)}&path=${encodeURIComponent(selected!)}`, signal),
  );
  const diff = useRemote(
    threadId && mode === "diff" ? `${threadId}:${revision}:${mode}:${selected ?? ""}` : undefined,
    (signal) => fetchJson<{ diff: string }>(`${baseUrl}/api/git/diff?threadId=${encodeURIComponent(threadId!)}${selected ? `&path=${encodeURIComponent(selected)}` : ""}`, signal).then((result) => result.diff),
  );

  useEffect(() => { setDir("."); setSelected(undefined); setUploadError(undefined); }, [threadId]);
  useEffect(() => {
    if (!follow || !lastEditedPath) return;
    setSelected(lastEditedPath);
    setMode("files");
  }, [follow, lastEditedPath]);

  return (
    <section className="workbench" aria-label="Thread workspace">
      <div className="workbench-tabs" role="tablist" aria-label="Workspace views">
        {WORKBENCH_MODES.map((entry) => (
          <button
            className="workbench-tab"
            role="tab"
            id={`workbench-tab-${entry}`}
            aria-controls="workbench-panel"
            aria-selected={mode === entry}
            // Roving tabindex: a tablist is one tab stop, then arrow keys move
            // between tabs. Leaving every tab focusable made the workbench cost
            // five tab presses to walk past.
            tabIndex={mode === entry ? 0 : -1}
            key={entry}
            onClick={() => setMode(entry)}
            onKeyDown={(event) => moveTabFocus(event, entry, setMode)}
          >
            {entry[0]!.toUpperCase() + entry.slice(1)}
            {entry === "output" && background.processes.length > 0 ? <span className="tab-count">{background.processes.length}</span> : null}
            {entry === "browser" && browser ? <span className="tab-presence" role="img" aria-label="Browser data available" /> : null}
          </button>
        ))}
        <label className="follow-toggle"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.currentTarget.checked)} />Follow edits</label>
      </div>
      <div className="workbench-body" id="workbench-panel" role="tabpanel" aria-labelledby={`workbench-tab-${mode}`} tabIndex={-1} data-mode={mode}>
        {mode === "files" && (
          selected ? (
            <div className="file-view">
              <button className="back-button" onClick={() => setSelected(undefined)}><span className="tree-icon"><BackIcon /></span><span>Back to files</span></button>
              <div className="file-path">{selected}</div>
              {file.loading ? <p className="empty">Loading file…</p> : <pre className="file-contents" data-read>{file.value?.contents ?? ""}</pre>}
              {file.value?.truncated && <p className="empty">File truncated at 2 MB.</p>}
            </div>
          ) : (
            <div className="file-tree">
              <div className="file-tree-location">
                <span className="file-tree-path">{dir === "." ? "Workspace" : dir}</span>
                <UploadControl
                  threadId={threadId}
                  baseUrl={baseUrl}
                  dir={dir}
                  onUploaded={() => setUploads((count) => count + 1)}
                  onError={setUploadError}
                />
              </div>
              {uploadError && <p className="empty" role="alert">{uploadError}</p>}
              {dir !== "." && <button className="tree-entry" onClick={() => setDir(parentOf(dir))}><span className="tree-icon"><UpIcon /></span><span>Parent folder</span></button>}
              {entries.error && <p className="empty" role="alert">{entries.error.message === "workspace_missing" ? "This thread's folder no longer exists." : "Could not read this thread's files."}</p>}
              {entries.loading && <p className="empty">Loading files…</p>}
              {!entries.loading && !entries.error && (entries.value?.length ?? 0) === 0 && <p className="empty">Empty directory</p>}
              {entries.value?.map((entry) => (
                <button className="tree-entry" key={entry.path} onClick={() => entry.type === "directory" ? setDir(entry.path) : setSelected(entry.path)}>
                  <span className="tree-icon">{entry.type === "directory" ? <TreeFolderIcon /> : <TreeFileIcon />}</span><span>{entry.name}</span>
                </button>
              ))}
            </div>
          )
        )}
        {mode === "diff" && (diff.loading ? <p className="empty">Loading diff…</p> : diff.value ? <DiffView diff={diff.value} /> : <p className="empty">No uncommitted changes.</p>)}
        {mode === "output" && <OutputPane background={background} />}
        {mode === "preview" && <PreviewPane baseUrl={baseUrl} background={background} />}
        {mode === "browser" && <LiveBrowser baseUrl={baseUrl} threadId={threadId} surface={browser} />}
      </div>
    </section>
  );
}

/**
 * Put files from the user's machine into a thread's folder.
 *
 * Two controls rather than one, because the browser will not tell a folder
 * picker which files it chose, and a file picker cannot choose a folder. Both
 * end at the same place: each chosen file is one POST to `/api/upload` carrying
 * its own path relative to the folder being uploaded into, which is what
 * recreates a picked directory's structure on the other side.
 *
 * Uploads land where the user is currently looking — the open directory — and
 * never overwrite silently behind the tree: the count that comes back is what
 * tells the pane to re-read the listing.
 */
function UploadControl({ threadId, baseUrl, dir, onUploaded, onError }: {
  threadId: string | undefined;
  baseUrl: string;
  dir: string;
  onUploaded(count: number): void;
  onError(message: string | undefined): void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const send = async (relativePath: string, blob: Blob): Promise<void> => {
    const response = await fetch(
      `${baseUrl}/api/upload?threadId=${encodeURIComponent(threadId!)}&path=${encodeURIComponent(relativePath)}`,
      { method: "POST", body: blob },
    );
    if (!response.ok) {
      const code = await response.json().then((body: unknown) => (body as { error?: string }).error).catch(() => undefined);
      throw new Error(code ?? `Upload failed: ${response.status}`);
    }
  };

  const upload = async (files: FileList | null): Promise<void> => {
    if (!threadId || !files || files.length === 0) return;
    setBusy(true);
    onError(undefined);
    // Sequential on purpose. A folder upload is one request per file, and
    // firing a thousand of them at once would open a thousand sockets for
    // bytes the server writes one file at a time anyway; in order also means
    // the first failure names a file the user can act on.
    let done = 0;
    try {
      for (const file of Array.from(files)) {
        // `webkitRelativePath` is set by the folder picker and empty otherwise.
        // Joined to the open directory so a folder picked while browsing a
        // subdirectory lands inside it, which is where the user is looking.
        const nested = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const relativePath = dir && dir !== "." ? `${dir}/${nested}` : nested;
        await send(relativePath, file);
        done += 1;
      }
    } catch (cause) {
      onError(`Uploaded ${done} of ${files.length}. ${cause instanceof Error ? cause.message : "Upload failed"}`);
    } finally {
      setBusy(false);
      onUploaded(done);
      // Clearing the inputs is what lets the same file be picked twice — a
      // `change` event only fires when the value differs from last time.
      if (fileRef.current) fileRef.current.value = "";
      if (folderRef.current) folderRef.current.value = "";
    }
  };

  return (
    <span className="upload-control">
      <input
        ref={fileRef}
        className="sr-only"
        type="file"
        multiple
        aria-label="Upload files"
        onChange={(event) => void upload(event.currentTarget.files)}
      />
      <input
        ref={folderRef}
        className="sr-only"
        type="file"
        multiple
        aria-label="Upload a folder"
        // React does not know this attribute, so it is set as written. Without
        // it the picker chooses files and the directory structure is lost.
        {...{ webkitdirectory: "" }}
        onChange={(event) => void upload(event.currentTarget.files)}
      />
      <button className="button" data-variant="ghost" type="button" disabled={!threadId || busy} onClick={() => fileRef.current?.click()}>
        {busy ? "Uploading…" : "Upload"}
      </button>
      <button className="button" data-variant="ghost" type="button" disabled={!threadId || busy} onClick={() => folderRef.current?.click()}>
        Folder
      </button>
    </span>
  );
}

function OutputPane({ background }: { background: BackgroundState }) {
  if (background.processes.length === 0) return <p className="empty">No background processes. Commands started with <code>run_in_background</code> stream here.</p>;
  return <>{background.processes.map((process) => <ProcessOutput process={process} key={process.pid} />)}</>;
}

function ProcessOutput({ process }: { process: BackgroundProcess }) {
  const element = useRef<HTMLPreElement>(null);
  /*
   * Same fix as the transcript's, for the same reason: deciding "am I at the
   * bottom?" when content changes cannot survive a jump larger than the
   * threshold, and a process's first burst of output is exactly that. Tracking
   * it from scroll events means only the user's own scrolling turns following
   * off. See the longer note in App.tsx.
   */
  const follow = useRef(true);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const onScroll = (): void => {
      follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    if (!follow.current) return;
    queueMicrotask(() => { node.scrollTop = node.scrollHeight; });
  }, [process.lines.length]);
  return (
    <section className="process">
      <header className="process-head"><span className="tool-detail">{process.cmd}</span><span className="tool-meta">pid {process.pid} · {process.exited ? "exited" : "running"}</span></header>
      <pre className="output" data-terminal ref={element}>{process.lines.join("\n")}</pre>
    </section>
  );
}

function PreviewPane({ baseUrl, background }: { baseUrl: string; background: BackgroundState }) {
  const [manualPort, setManualPort] = useState("");
  const [chosen, setChosen] = useState<number>();
  const [nonce, setNonce] = useState(0);
  const activePort = chosen ?? background.servers[0]?.port;
  const src = activePort ? `${baseUrl}/preview/${activePort}/?r=${nonce}` : undefined;
  return (
    <div className="preview">
      <div className="preview-bar">
        {background.servers.map((server) => <button className="button" data-variant={server.port === activePort ? "primary" : "ghost"} key={server.url} onClick={() => setChosen(server.port)}>:{server.port}</button>)}
        <form className="preview-manual" onSubmit={(event) => { event.preventDefault(); const port = Number(manualPort); if (Number.isInteger(port) && port >= 1024 && port <= 65_535) setChosen(port); }}>
          <label className="sr-only" htmlFor="preview-port">Preview port</label>
          <input id="preview-port" type="number" min="1024" max="65535" placeholder="Port" value={manualPort} onChange={(event) => setManualPort(event.currentTarget.value)} />
          <button className="button" data-variant="ghost">Open</button>
        </form>
        {activePort && <button className="button preview-reload" data-variant="ghost" onClick={() => setNonce((value) => value + 1)}>Reload</button>}
      </div>
      {src ? <iframe className="preview-frame" title="Live preview" src={src} sandbox="allow-scripts allow-forms allow-same-origin allow-popups" /> : <p className="empty">No dev server detected. Start one in the background or enter its port.</p>}
    </div>
  );
}

function parentOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/") || ".";
}

function UpIcon() { return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="M8 12.5V3.9M4.2 7.4 8 3.5l3.8 3.9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function BackIcon() { return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="M12.5 8H3.9M7.4 3.9 3.5 8l3.9 4.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function TreeFolderIcon() { return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="M1.9 4.3a1.1 1.1 0 0 1 1.1-1.1h2.3c.3 0 .58.12.79.33l1.07 1.07h5.94a1.1 1.1 0 0 1 1.1 1.1v6.1a1.1 1.1 0 0 1-1.1 1.1H3a1.1 1.1 0 0 1-1.1-1.1V4.3Z" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/></svg>; }
function TreeFileIcon() { return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="M3.6 2.6h5L12.4 6v7.4a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/><path d="M8.5 2.7V6h3.6" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/></svg>; }
