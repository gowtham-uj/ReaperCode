import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { AppThread, JsonRpcClient } from "@reaper/web-shared";
import { EffortPicker } from "./EffortPicker.jsx";
import { ModelPicker } from "./ModelPicker.jsx";
import { useModelMetadata, type ModelCatalog } from "./models.js";
import { PERMISSION_MODES, type PermissionMode } from "./settings.js";
import { CloseIcon } from "./icons.jsx";

export interface ThreadTool {
  name: string;
  label: string;
  summary: string;
  loadMode: "core" | "discoverable";
  capabilityTier: "read" | "write" | "exec";
  family: string;
}

/**
 * The gateway's HTTP origin, for links the browser fetches itself.
 *
 * The same expression `AppProvider` uses, repeated here rather than imported:
 * this is a leaf component and `AppProvider` is the root of the tree, so
 * importing it would make a module cycle for one string. `VITE_BFF_URL` is the
 * same build-time value in both places, so they cannot disagree.
 */
const BFF_HTTP = import.meta.env.VITE_BFF_URL ?? window.location.origin;

/**
 * Per-thread agent configuration.
 *
 * Everything here is scoped to one thread and written through the app-server,
 * so it applies to the agent's next turn — including from the middle of a
 * conversation, which is the case that matters: a thread that has drifted is
 * exactly the thread whose instructions need changing, and requiring a new
 * thread would discard the transcript that explains why.
 *
 * The built-in agent prompt is not editable here and is not replaceable by the
 * textarea below. It is the contract the tool schemas, verification loop, and
 * stopping rules are written against, and a field that could substitute for it
 * would let a thread opt out of all of them without saying so. The server
 * appends whatever is written here after it, and the copy says so.
 */
export function ThreadSettingsDialog({ open, onClose, client, thread, threadId, catalog, disabledProviders, onError, onSaved, onOpenPermissions }: {
  open: boolean;
  onClose(): void;
  client: JsonRpcClient | undefined;
  thread: AppThread | undefined;
  threadId: string | undefined;
  catalog: ModelCatalog;
  /** Providers switched off in Settings; withheld from the model picker here too. */
  disabledProviders?: readonly string[] | undefined;
  onError(message: string): void;
  onSaved(): void;
  onOpenPermissions(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(() => new Set());
  const [tools, setTools] = useState<ThreadTool[]>([]);
  const [toolsError, setToolsError] = useState<string>();
  const [toolsLoading, setToolsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sandbox, setSandbox] = useState(true);
  const [sandboxSaving, setSandboxSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<"agent" | "tools">("agent");
  const [toolQuery, setToolQuery] = useState("");
  const model = useModelMetadata(catalog, client, thread?.modelProvider, thread?.model);
  // A thread with any turn behind it has a journal at its workspace path, so
  // the directory is part of its identity from then on.
  const hasHistory = thread?.hasTurns === true;

  /*
   * Re-seed the draft whenever the dialog opens, and whenever the thread's own
   * values change underneath it (another tab saving, or a notification landing
   * while this one is open). Without the second case a stale draft would be
   * saved back over a change the user never saw.
   */
  const seed = useCallback(() => {
    setName(thread?.name ?? "");
    setPrompt(thread?.systemPrompt ?? "");
    setWorkspace(thread?.cwd ?? "");
    setDisabled(new Set(thread?.disabledTools ?? []));
    setSandbox(thread?.filesystemSandbox !== false);
  }, [thread?.name, thread?.systemPrompt, thread?.cwd, thread?.disabledTools, thread?.filesystemSandbox]);

  useEffect(() => {
    if (open) seed();
  }, [open, seed]);

  // `<dialog>` supplies the modal semantics the app would otherwise have to
  // reimplement: focus trapping, Escape, inertness of the page behind it, and
  // the top-layer stacking that keeps it above the workbench.
  useEffect(() => {
    const element = dialogRef.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  // The tool list comes from the server's registry, so the switches can never
  // name a tool that does not exist. Loaded once per open, not per render.
  useEffect(() => {
    if (!open || !client) return;
    let cancelled = false;
    setToolsLoading(true);
    setToolsError(undefined);
    void client.call<{ data: ThreadTool[] }>("tools/list", {})
      .then(
        (result) => { if (!cancelled) setTools(result.data ?? []); },
        (cause: unknown) => {
          if (cancelled) return;
          setToolsError(cause instanceof Error ? cause.message : "Could not load the tool list");
        },
      )
      .finally(() => { if (!cancelled) setToolsLoading(false); });
    return () => { cancelled = true; };
  }, [open, client]);

  /*
   * The sandbox writes on toggle rather than on Save.
   *
   * Every other field here changes what the agent does on its next turn, so
   * batching them behind one button is honest. This one changes where the
   * agent's next *command* can reach, and the reason to reach for it is a
   * thread that is doing something now. A confinement that waits for a dialog
   * to be dismissed is not a confinement you would use in that moment.
   */
  const toggleSandbox = async (next: boolean): Promise<void> => {
    if (!client || !threadId) return;
    setSandbox(next);
    setSandboxSaving(true);
    try {
      await client.call("thread/config/set", { threadId, filesystemSandbox: next });
    } catch (cause) {
      setSandbox(!next);
      onError(cause instanceof Error ? cause.message : "Could not change the workspace sandbox");
    } finally {
      setSandboxSaving(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!client || !threadId) return;
    setSaving(true);
    try {
      const trimmedName = name.trim();
      // The name has its own RPC (and its own validation), so it is only sent
      // when it actually changed — sending it unconditionally would make a
      // prompt-only save fail on a thread whose name the user never touched.
      if (trimmedName && trimmedName !== thread?.name) {
        await client.call("thread/name/set", { threadId, name: trimmedName });
      }
      await client.call("thread/config/set", {
        threadId,
        // `null` clears; `""` would store an empty string that reads as unset
        // but compares as set. The server trims too, so whitespace-only input
        // clears rather than storing a prompt of spaces.
        systemPrompt: prompt.trim() ? prompt : null,
        disabledTools: [...disabled],
      });
      // Sent separately because it is the one field the server can refuse: a
      // thread that has run a turn keeps its workspace, and the reason comes
      // back as an error rather than being pre-empted by a disabled field.
      const trimmedWorkspace = workspace.trim();
      if (trimmedWorkspace && trimmedWorkspace !== thread?.cwd) {
        await client.call("thread/workspace/set", { threadId, workspaceRoot: trimmedWorkspace });
      }
      onSaved();
      onClose();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not save the thread settings");
    } finally {
      setSaving(false);
    }
  };

  const filtered = useMemo(() => {
    const query = toolQuery.trim().toLowerCase();
    if (!query) return tools;
    return tools.filter((tool) =>
      tool.name.toLowerCase().includes(query)
      || tool.label.toLowerCase().includes(query)
      || tool.summary.toLowerCase().includes(query));
  }, [tools, toolQuery]);

  const coreTools = filtered.filter((tool) => tool.loadMode === "core");
  const optionalTools = filtered.filter((tool) => tool.loadMode !== "core");

  const toggle = (toolName: string): void => {
    setDisabled((current) => {
      const next = new Set(current);
      if (next.has(toolName)) next.delete(toolName);
      else next.add(toolName);
      return next;
    });
  };

  return (
    <dialog
      className="thread-settings-dialog"
      ref={dialogRef}
      aria-labelledby={titleId}
      /*
       * `close` fires for Escape as well as for the close button and the
       * browser's own dismissal, so routing it back through `onClose` keeps
       * React's `open` prop and the element's state from disagreeing — a
       * dialog closed with Escape but still `open` in state cannot be
       * reopened, because setting `open` true again would be a no-op.
       */
      onClose={onClose}
      onClick={(event) => { if (event.target === dialogRef.current) onClose(); }}
    >
      <div className="thread-settings-panel">
        <header className="thread-settings-header">
          <div>
            <h2 id={titleId}>Thread settings</h2>
            <p>Applies to this thread only, starting with its next turn.</p>
          </div>
          <button className="icon-button" type="button" aria-label="Close thread settings" onClick={onClose}><CloseIcon /></button>
        </header>

        <div className="thread-settings-tabs" role="tablist" aria-label="Thread settings sections">
          <TabButton id="agent" active={activeTab} onSelect={setActiveTab}>Agent</TabButton>
          <TabButton id="tools" active={activeTab} onSelect={setActiveTab}>Tools</TabButton>
        </div>

        <div className="thread-settings-body">
          {activeTab === "agent" ? (
            <div className="thread-settings-section" role="tabpanel" aria-label="Agent" id="thread-settings-agent">
              <label className="field">
                <span>Thread name</span>
                <input value={name} maxLength={500} placeholder="What this thread is for" onChange={(event) => setName(event.currentTarget.value)} />
              </label>

              {/*
                The workspace lives here rather than in the create form. It is
                the directory every tool call resolves against, so it belongs
                with the rest of the thread's configuration — and asking for it
                up front put a path field in the way of "start a chat". Only an
                unused thread can be repointed; the server refuses the rest and
                the reason is stated rather than left to a failed call.
              */}
              <label className="field">
                <span>Workspace</span>
                {hasHistory ? (
                  <>
                    <input value={workspace} readOnly disabled />
                    <small>
                      This thread has run a turn, so its workspace is fixed — the transcript and every file
                      the agent opened live there. Start a new thread for a different directory.
                    </small>
                  </>
                ) : (
                  <>
                    <input
                      value={workspace}
                      disabled={saving}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={thread?.cwd ?? "This thread's own folder"}
                      onChange={(event) => setWorkspace(event.currentTarget.value)}
                    />
                    <small>
                      Leave as-is to keep this thread&apos;s own folder, or enter a project directory for the
                      agent to work in directly. Set before the first turn; fixed afterwards.
                    </small>
                  </>
                )}
              </label>

              <div className="field">
                <span>Model</span>
                <ModelPicker
                  catalog={catalog}
                  client={client}
                  threadId={threadId}
                  provider={thread?.modelProvider}
                  model={thread?.model}
                  turnActive={false}
                  disabledProviders={disabledProviders}
                  onSetup={() => onError("Add a provider in Settings before choosing a model.")}
                  onError={onError}
                />
              </div>

              {model?.supportsReasoning && (
                <div className="field">
                  <span>Reasoning effort</span>
                  <EffortPicker
                    client={client}
                    threadId={threadId}
                    metadata={model}
                    effort={thread?.reasoningEffort}
                    turnActive={false}
                    onError={onError}
                    labelled
                  />
                </div>
              )}

              <label className="field">
                <span>Thread instructions</span>
                <textarea
                  className="thread-settings-prompt"
                  value={prompt}
                  maxLength={20_000}
                  rows={9}
                  placeholder="Extra instructions for this thread, for example which conventions to follow or what the deliverable is."
                  onChange={(event) => setPrompt(event.currentTarget.value)}
                />
                <small>
                  Added after Reaper&apos;s built-in instructions, which stay in place — this narrows what the agent does,
                  it does not replace the agent. Applied from the thread&apos;s next turn, so a turn already running is not affected.
                </small>
                <small className="thread-settings-count">{prompt.length.toLocaleString()} / 20,000 characters</small>
              </label>

              <div className="field">
                <span>Workspace sandbox</span>
                <label className="thread-settings-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={sandbox}
                    disabled={sandboxSaving || !threadId}
                    onChange={(event) => void toggleSandbox(event.currentTarget.checked)}
                  />
                  <span>{sandbox ? "Confined to this thread's workspace" : "Full filesystem access"}</span>
                </label>
                <small>
                  Commands run in a sandbox that contains this thread&apos;s workspace and the read-only system
                  directories, and nothing else, so a path outside the workspace does not exist for them to reach.
                  Network access is unchanged. Applies to the next command, including during a turn already running.
                </small>
              </div>

              {/*
                The thread's transcript, as a file.
                *
                * It is the whole conversation: every user message, every model
                * response including its thinking, and every tool call with its
                * result. Reading it is how a person audits what an agent did,
                * and it lives in the thread's own `.reaper/sessions` directory,
                * which the file pane deliberately does not list. A download is
                * the difference between having that record and having to open a
                * shell on the server to fetch it.
                *
                * A plain link, not a fetch-and-blob: the browser's own download
                * handling gets the filename from the response header, and a
                * multi-megabyte journal never has to pass through JavaScript.
              */}
              <div className="field">
                <span>Session transcript</span>
                <a
                  className="button"
                  data-variant="ghost"
                  href={threadId ? `${BFF_HTTP}/api/transcript?threadId=${encodeURIComponent(threadId)}` : undefined}
                  download
                  aria-disabled={threadId === undefined || !hasHistory}
                  data-disabled={threadId === undefined || !hasHistory || undefined}
                  onClick={(event) => {
                    // Nothing to download without a thread, or before it has run.
                    if (threadId === undefined || !hasHistory) event.preventDefault();
                  }}
                >
                  Download session JSONL
                </a>
                <small>
                  {hasHistory
                    ? "Every message, thinking block and tool result for this thread, as newline-delimited JSON."
                    : "This thread has not run yet, so there is nothing recorded."}
                </small>
              </div>

              <PermissionNote mode={thread?.approvalPolicy} onOpenPermissions={onOpenPermissions} />
            </div>
          ) : (
            <div className="thread-settings-section" role="tabpanel" aria-label="Tools" id="thread-settings-tools">
              <p className="settings-note">
                Turn a tool off to keep this thread&apos;s agent from calling it. The tool is removed from what the
                model is offered and refused if it asks anyway, including from a transcript that predates the change.
              </p>
              {/*
                `.settings-search` *is* the input — it carries the border and
                fill — so it must not be put on a wrapper, which would paint a
                second border around a field still wearing the UA default.
              */}
              <input
                className="settings-search thread-settings-search"
                type="search"
                aria-label="Search tools"
                value={toolQuery}
                placeholder="Search tools"
                onChange={(event) => setToolQuery(event.currentTarget.value)}
              />
              {toolsError && <p className="field-error" role="alert">{toolsError}</p>}
              {toolsLoading && tools.length === 0 && <p className="settings-note">Loading tools…</p>}
              {disabled.size > 0 && (
                <p className="thread-settings-summary" role="status">
                  {disabled.size} {disabled.size === 1 ? "tool" : "tools"} disabled for this thread
                  <button className="button" data-variant="ghost" type="button" onClick={() => setDisabled(new Set())}>Enable all</button>
                </p>
              )}
              <ToolGroup title="Always available" tools={coreTools} disabled={disabled} onToggle={toggle} />
              <ToolGroup title="Available on request" tools={optionalTools} disabled={disabled} onToggle={toggle} />
              {!toolsLoading && !toolsError && filtered.length === 0 && <p className="settings-note">No tool matches “{toolQuery}”.</p>}
            </div>
          )}
        </div>

        <footer className="thread-settings-footer">
          <button className="button" data-variant="ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="button" data-variant="primary" type="button" disabled={saving || !threadId} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </dialog>
  );
}

function TabButton({ id, active, onSelect, children }: {
  id: "agent" | "tools";
  active: string;
  onSelect(id: "agent" | "tools"): void;
  children: string;
}) {
  return (
    <button
      className="thread-settings-tab"
      type="button"
      role="tab"
      id={`thread-settings-tab-${id}`}
      aria-selected={active === id}
      aria-controls={`thread-settings-${id}`}
      tabIndex={active === id ? 0 : -1}
      data-active={active === id || undefined}
      onClick={() => onSelect(id)}
      // Arrow keys move between tabs, per the tablist pattern; a tablist whose
      // tabs are only reachable by Tab is a menu the keyboard cannot traverse.
      onKeyDown={(event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        event.preventDefault();
        const next = id === "agent" ? "tools" : "agent";
        onSelect(next);
        document.getElementById(`thread-settings-tab-${next}`)?.focus();
      }}
    >
      {children}
    </button>
  );
}

function ToolGroup({ title, tools, disabled, onToggle }: {
  title: string;
  tools: ThreadTool[];
  disabled: ReadonlySet<string>;
  onToggle(name: string): void;
}) {
  if (tools.length === 0) return null;
  return (
    <section className="thread-settings-toolgroup" aria-label={title}>
      <h3>{title}</h3>
      <ul>
        {tools.map((tool) => {
          const off = disabled.has(tool.name);
          return (
            <li className="thread-settings-tool" key={tool.name} data-disabled={off || undefined}>
              <label>
                <input type="checkbox" checked={!off} onChange={() => onToggle(tool.name)} />
                <span className="thread-settings-tool-text">
                  <span className="thread-settings-tool-name">
                    {tool.label}
                    {tool.capabilityTier !== "read" && <span className="thread-settings-tool-badge">{tool.capabilityTier}</span>}
                    {/*
                      The unchecked box and the dimmed row already say "off",
                      but both are easy to misread at a glance and neither
                      survives a screenshot being described aloud. An explicit
                      word is the state that actually matters — this tool is
                      withheld from the model.
                    */}
                    {off && <span className="thread-settings-tool-off">Off</span>}
                  </span>
                  <small>{tool.summary}</small>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Permission mode is shown, not set, here.
 *
 * It is a safety-relevant control that already has a home in Settings, and
 * putting a second copy in a modal that also carries a free-text prompt field
 * makes an accidental downgrade one misclick away from a save the user thinks
 * only changed wording.
 */
function PermissionNote({ mode, onOpenPermissions }: {
  mode: string | undefined;
  onOpenPermissions: () => void;
}) {
  const entry = PERMISSION_MODES.find((candidate) => candidate.mode === (mode as PermissionMode));
  if (!entry) return null;
  return (
    <p className="thread-settings-note">
      <strong>Permissions: {entry.label}</strong> — {entry.description}{" "}
      <button className="link-button" type="button" onClick={onOpenPermissions}>Change in Settings</button>
    </p>
  );
}
