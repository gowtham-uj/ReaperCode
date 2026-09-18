import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import type { AppThreadItem, AppTurn, ApprovalRequest } from "@reaper/web-shared";
import { ApprovalCard, StickyApprovalBar } from "./Approvals.jsx";
import { ContextMeter } from "./ContextMeter.jsx";
import { DeepSeekComposer } from "./DeepSeekComposer.jsx";
import { EffortPicker } from "./EffortPicker.jsx";
import { ModelPicker } from "./ModelPicker.jsx";
import { useModelMetadata } from "./models.js";
import { PlanChecklist } from "./PlanChecklist.jsx";
import { PolicyEditor } from "./PolicyEditor.jsx";
import { QueueModePicker, type QueueMode } from "./QueueModePicker.jsx";
import { AppProvider, BFF_HTTP, useApp } from "./app/AppProvider.jsx";
import { AppearanceSettings, ProvidersSettings, ModelsSettings, PermissionsSettings, SettingsLayout } from "./Settings.jsx";
import { ThreadList, threadLabel, threadWorkspaceLabel } from "./ThreadList.jsx";
import { ThreadSettingsDialog } from "./ThreadSettings.jsx";
import { TranscriptGallery } from "./dev/TranscriptGallery.jsx";
import { TuneIcon } from "./icons.jsx";
import { parseSkillsCommand, skillInvocationSuffix } from "./skills-command.js";
import { SkillsOverlay } from "./SkillsOverlay.jsx";
import { Transcript } from "./Transcript.jsx";
import { VerificationPanel } from "./VerificationPanel.jsx";
import { Workbench, type WorkbenchMode } from "./Workbench.jsx";
import { WorkspaceInventory } from "./WorkspaceInventory.jsx";

export function App() {
  /*
   * A fixture transcript, reachable only on the dev server.
   *
   * The transcript's correctness is visual, and checking it against a live
   * model costs a provider round trip per look and returns different content
   * every time, so two screenshots are never comparable and a spacing change
   * cannot be told apart from a different answer. This renders the real
   * components against fixed items. `import.meta.env.DEV` is replaced with
   * `false` at build time, so the branch and the module with it are dropped
   * from a production bundle.
   */
  if (import.meta.env.DEV && window.location.pathname === "/__gallery") {
    return <TranscriptGallery />;
  }
  return (
    <AppProvider>
      <Routes>
        <Route path="/" element={<WorkspacePage />} />
        <Route path="/settings" element={<SettingsBoundary />}>
          <Route index element={<Navigate to="providers" replace />} />
          <Route path="providers" element={<ProvidersRoute />} />
          <Route path="models" element={<ModelsRoute />} />
          <Route path="permissions" element={<PermissionsRoute />} />
          <Route path="policy" element={<PolicyRoute />} />
          <Route path="capabilities" element={<CapabilitiesRouteElement />} />
          <Route path="appearance" element={<AppearanceSettings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppProvider>
  );
}

/**
 * Scroll a transcript to the bottom, animated only if the reader allows motion.
 *
 * `behavior: "smooth"` over a long thread is a full-viewport slide, which is
 * the exact motion `prefers-reduced-motion` exists to suppress, and CSS cannot
 * suppress it: the setting is honoured by `scroll-behavior` in a stylesheet,
 * not by a `behavior` passed to `scrollTo`, which wins outright. So the check
 * has to happen here.
 */
function scrollToLatest(element: HTMLElement | null): void {
  if (element === null) return;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollTo({ top: element.scrollHeight, behavior: still ? "auto" : "smooth" });
}

function SettingsBoundary() {
  const { settings, client } = useApp();
  return <SettingsLayout settings={settings} client={client} />;
}
function ProvidersRoute() { const { catalog, settings, client } = useApp(); return <ProvidersSettings catalog={catalog} settings={settings} client={client} />; }
function ModelsRoute() { const { settings, catalog, client } = useApp(); return <ModelsSettings settings={settings} catalog={catalog} client={client} />; }
function PermissionsRoute() { const { settings, client } = useApp(); return <PermissionsSettings settings={settings} client={client} />; }
function PolicyRoute() { const { settings, client } = useApp(); return <PolicyEditor store={settings} client={client} />; }
function CapabilitiesRouteElement() { const { settings, client } = useApp(); return <WorkspaceInventory store={settings} client={client} />; }

function WorkspacePage() {
  const app = useApp();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [threadCreationRequest, setThreadCreationRequest] = useState(0);
  /*
   * The workspace panel starts closed.
   *
   * It held the file tree, diffs, terminal, preview and browser, which is a lot
   * of chrome beside a transcript and it competed with it for attention on every
   * turn. The user's call is to hide it for now and decide later how those
   * surfaces are shown, so the default is closed and the toggle still opens it.
   *
   * Closed rather than removed: every mode still works, the toggle is still in
   * the header, and re-enabling is one boolean rather than restoring what was
   * deleted.
   */
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsWidth, setDetailsWidth] = useState(520);
  const [draft, setDraft] = useState("");
  /*
   * How the next message is delivered while the agent works.
   *
   * Held here, not on the queued card, because the choice has to be made before
   * the message is queued. A `next-step` entry is steered at the agent's next
   * tool boundary, so a card came back already delivered and its mode radios
   * disabled: a reader who wanted "after the agent finishes" had no way to say
   * so. It is per thread for the same reason the draft is, so a mode chosen for
   * one conversation is not silently in force in another.
   */
  const [queueMode, setQueueMode] = useState<QueueMode>("next-step");
  /*
   * A draft belongs to the thread it was typed in.
   *
   * The composer kept its text across a switch, so a sentence written in one
   * conversation was still sitting in the box after opening another, one Enter
   * away from being sent to the wrong thread. The draft is cleared when the
   * thread changes rather than stored per thread: a half-written message is
   * about the conversation on screen, and keeping invisible copies of it would
   * make "why is this box empty" as surprising as the original leak.
   *
   * Keyed on the thread id and not on the summary object, which changes
   * identity on every refresh while the thread stays the same.
   */
  const draftThreadId = app.threadId;
  const draftThreadRef = useRef<string | undefined>(draftThreadId);
  useEffect(() => {
    if (draftThreadRef.current === draftThreadId) return;
    draftThreadRef.current = draftThreadId;
    setDraft("");
    // The delivery mode is a preference about the message being written, so it
    // resets with the draft rather than following the reader across threads.
    setQueueMode("next-step");
  }, [draftThreadId]);
  const [workbenchMode, setWorkbenchMode] = useState<WorkbenchMode>("files");
  const [threadSettingsOpen, setThreadSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsFilter, setSkillsFilter] = useState<string>();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [approvalVisible, setApprovalVisible] = useState(true);
  const pendingApproval = app.approvals[0];
  const activeSummary = app.threads.find((entry) => entry.id === app.threadId);
  const projectCrumb = threadWorkspaceLabel(activeSummary?.cwd);
  // Reasoning controls follow the selected model's catalog metadata.
  const selectedModel = useModelMetadata(app.catalog, app.client, app.thread?.modelProvider, app.thread?.model);

  /**
   * Whether the transcript should follow new output.
   *
   * A ref, not a computation, and that is the whole fix. This used to decide
   * "am I at the bottom?" *at the moment content changed*, with a threshold:
   *
   *   const atBottom = scrollHeight - scrollTop - clientHeight < 80
   *   if (atBottom) scrollTo(bottom)
   *
   * The transcript never followed the stream, and that line is why. The
   * container starts with the hero, which fits exactly, so the gap is 0. The
   * first reply then overflows the viewport in a single frame — measured at
   * 131px, because the composer seat is inside this same scroll container —
   * and 131 is not less than 80. So `atBottom` was false on the very first
   * update, the scroll was skipped, and `scrollTop` stayed 0 for the rest of
   * the turn while the content grew to 1377px in a 464px viewport. The
   * threshold can never be satisfied by a jump larger than itself.
   *
   * Tracking it from scroll events instead asks a question that has a stable
   * answer. The flag changes only when the user actually scrolls: up past the
   * threshold and it stops following, back within it and following resumes.
   * Content arriving is not a scroll, so it cannot turn following off by
   * surprising the threshold — which is exactly the case that was broken.
   */
  const followTranscript = useRef(true);
  /*
   * The same fact as `followTranscript`, as state, so the jump button can
   * render. It is a second copy rather than a replacement because the ref is
   * read inside a scroll handler and on every content change, and making that
   * a state read would put a re-render on the scrolling path. This one is only
   * written when the answer *changes*, which is a handful of times per session
   * rather than once per scroll event.
   */
  const [detached, setDetached] = useState(false);

  useEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    const onScroll = (): void => {
      const following = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      followTranscript.current = following;
      setDetached((previous) => (previous === !following ? previous : !following));
    };
    // Passive: this listener only reads, and saying so keeps it off the
    // scrolling critical path.
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    if (!followTranscript.current) return;
    // Written after layout, so `scrollHeight` is the height the browser just
    // computed rather than the previous frame's. A microtask runs before paint
    // but after React's commit, which is the window where the new content is in
    // the DOM and its height is known.
    queueMicrotask(() => {
      element.scrollTop = element.scrollHeight;
    });
  }, [app.turns, app.queued, app.approvals]);

  /*
   * Deliberately not opening the workspace panel on an edit any more.
   *
   * This forced the panel open every time the agent wrote a file, so a turn
   * that edited anything pushed the transcript narrower mid-read. With the panel
   * closed by default that would have made the default meaningless: the first
   * edit of every turn would undo it.
   *
   * The mode is still switched, so opening the panel by hand later lands on the
   * file it just changed.
   */
  useEffect(() => {
    if (app.lastEditedPath) setWorkbenchMode("files");
  }, [app.lastEditedPath]);

  /**
   * Skills and settings are only known once a Settings page has been visited,
   * since nothing else loads them. Both are needed *outside* Settings now — the
   * composer's `/name` hint and the overlay's list come from `skills`, and the
   * always-on state comes from `settings.pinnedSkills` — so they are fetched
   * once per session here rather than being something the user has to trigger.
   *
   * Loading skills but not settings is the specific bug this replaced: pins
   * were written to disk correctly and then rendered as absent after a reload,
   * which reads as "the switch forgot" when in fact nothing had asked.
   */
  useEffect(() => {
    void app.settings.refreshSkills(app.client);
    void app.settings.refreshSettings(app.client);
  }, [app.client, app.settings.refreshSkills, app.settings.refreshSettings]);

  /**
   * A `/skills` command never leaves the composer.
   *
   * `send` is the one funnel from the composer to the model, so the guard lives
   * there rather than only on Enter — otherwise clicking the send button would
   * ship `/skills pin codemode` to the model as a prompt, which is the kind of
   * bug that looks like the model ignoring you.
   */
  const send = (): void => {
    const text = draft.trim();
    if (!text) return;
    const command = parseSkillsCommand(text);
    if (command) {
      if (command.kind === "overlay") {
        setSkillsFilter(command.filter);
        setSkillsOpen(true);
      } else {
        // `pin`/`unpin`/`show` typed directly open the overlay pre-filtered to
        // the named skill, where the toggle is visible and reversible. Doing
        // the write silently from a typed command would leave the user with no
        // confirmation and no way back.
        setSkillsFilter(command.name);
        setSkillsOpen(true);
      }
      setDraft("");
      return;
    }
    /*
     * The mode is read here rather than passed from the picker's own click so
     * that Enter and the send button honour the same choice. When no turn is
     * running the picker is unmounted and the mode is irrelevant: the message is
     * sent immediately either way, and `flushOne` treats an idle thread as
     * "start a turn" regardless.
     */
    app.sendMessage(draft, app.activeTurn ? queueMode : "next-step");
    setDraft("");
  };

  const invoked = skillInvocationSuffix(draft, app.settings.skills);

  const requestThreadCreation = (): void => {
    setSidebarCollapsed(false);
    setThreadCreationRequest((request) => request + 1);
  };

  /**
   * One line above the composer.
   *
   * It has exactly two jobs and never both at once. When the user has started a
   * `/name`, it says which skill that is — without it, loading a skill is
   * invisible, because the body is injected server-side and the only evidence
   * would be the model behaving differently. A typo would be silent. Otherwise
   * it is the quiet way in to the skill list, which is also the only place the
   * `/skills` vocabulary is taught.
   *
   * Deliberately one line of low-contrast text rather than a toolbar: this
   * strip sits against the composer, where a row of controls would compete
   * with the thing the user is actually typing into.
   */
  const skillsCommand = parseSkillsCommand(draft);
  const pinnedCount = app.settings.settings?.pinnedSkills?.length ?? 0;
  const skillStrip = (
    <div className="composer-skills">
      {invoked ? (
        <span className="composer-skill-hint" data-active>
          <span className="composer-skill-chip">/{invoked.skill.name}</span>
          <span className="composer-skill-note">
            loads “{invoked.skill.description}” into this turn
          </span>
          <button
            type="button"
            className="composer-skill-clear"
            aria-label={`Remove the /${invoked.skill.name} skill from this message`}
            onClick={() => setDraft(invoked.suffix.replace(/^\s+/, ""))}
          >
            Remove
          </button>
        </span>
      ) : skillsCommand ? (
        <span className="composer-skill-note" role="status">
          Press <kbd>Enter</kbd> to open skills
        </span>
      ) : (
        <button
          className="composer-skills-button"
          type="button"
          onClick={() => { setSkillsFilter(undefined); setSkillsOpen(true); }}
        >
          Skills
          {app.settings.skills.length > 0 && <span className="composer-skills-count">{app.settings.skills.length}</span>}
          {/*
            * The always-on count is stated separately and in words, because it
            * is the only number here with an ongoing cost: those bodies are in
            * every turn whether or not anyone remembers pinning them. Folding
            * it into the same badge as the installed count would make one
            * number mean two things depending on state.
            */}
          {pinnedCount > 0 && <span className="composer-skills-pinned">{pinnedCount} always on</span>}
        </button>
      )}
    </div>
  );

  const composer = (
    <>
      {skillStrip}
      <DeepSeekComposer
        value={draft}
        placeholder={app.activeTurn ? "Add a message for the next step…" : "Send a message to Reaper"}
        running={Boolean(app.activeTurn)}
        disabled={app.session.status !== "open"}
        onChange={setDraft}
        onSubmit={send}
        onStop={app.interrupt}
        modelControl={(
          <ModelPicker
            catalog={app.catalog}
            client={app.client}
            threadId={app.threadId}
            provider={app.thread?.modelProvider}
            model={app.thread?.model}
            turnActive={Boolean(app.activeTurn)}
            disabledProviders={app.settings.settings?.disabledProviders}
            onSetup={() => navigate("/settings/providers")}
            onError={(message) => app.setError(message)}
          />
        )}
        effortControl={(
          <EffortPicker
            client={app.client}
            threadId={app.threadId}
            metadata={selectedModel}
            effort={app.thread?.reasoningEffort}
            turnActive={Boolean(app.activeTurn)}
            onError={(message) => app.setError(message)}
          />
        )}
        contextControl={<ContextMeter usage={app.thread?.tokenUsage} />}
        sendModeControl={(
          <QueueModePicker
            mode={queueMode}
            running={Boolean(app.activeTurn)}
            disabled={app.session.status !== "open"}
            onMode={setQueueMode}
          />
        )}
      />
    </>
  );

  const hero = app.turns.length === 0 && !app.activeTurn && app.approvals.length === 0;

  return (
    <div
      className="app-frame"
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={!detailsOpen || undefined}
      style={{ gridTemplateColumns: `${sidebarCollapsed ? 56 : 272}px minmax(0, 1fr) ${detailsOpen ? detailsWidth : 0}px` }}
    >
      <aside className="sidebar-column">
        <div className="sidebar-root" data-collapsed={sidebarCollapsed || undefined}>
          <div className="sidebar-logo-row">
            {!sidebarCollapsed && <button className="brand-button" type="button" aria-label="Create a new thread" onClick={requestThreadCreation}><ReaperMark /><span>Reaper</span></button>}
            <button className="sidebar-icon-button sidebar-toggle" type="button" aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => setSidebarCollapsed((value) => !value)}>
              {sidebarCollapsed ? <ReaperMark /> : <PanelIcon />}
            </button>
          </div>
          <ThreadList
            client={app.client}
            activeThreadId={app.threadId}
            threads={app.threads}
            loading={app.threadsLoading}
            onRefresh={app.refreshThreads}
            onCreate={app.createThread}
            onSwitch={app.switchThread}
            onDelete={app.deleteThread}
            collapsed={sidebarCollapsed}
            creationRequest={threadCreationRequest}
            onRequestCreate={requestThreadCreation}
          />
          <div className="sidebar-footer">
            <button className="sidebar-settings" type="button" onClick={() => navigate("/settings/providers")}><SettingsIcon />{!sidebarCollapsed && <span>Settings</span>}</button>
            {!sidebarCollapsed && <div className="sidebar-connection"><span className="connection-dot" data-status={app.session.catchingUp ? "connecting" : app.session.status} /><span aria-live="polite">{app.connectionLabel}</span>{app.session.status === "reconnecting" && !app.session.catchingUp && <button onClick={app.session.retryNow}>Retry</button>}</div>}
          </div>
        </div>
      </aside>

      <main className="conversation-root" data-phase={app.turns.length > 0 ? "active" : "blank"}>
        <header className={`conversation-header${hero ? " conversation-header-hidden" : ""}`}>
          <div className="conversation-title-cluster">
            {/*
             * Only a thread pointed at a real project earns a crumb. A
             * thread-scoped workspace path ends in the thread's own UUID, and
             * printing that told the user nothing while leaking an internal id
             * into the chrome.
             */}
            {projectCrumb && <><span className="workspace-crumb">{projectCrumb}</span><span className="crumb-separator" aria-hidden="true">/</span></>}
            <strong className="conversation-title">{threadLabel(activeSummary, app.threadId)}</strong>
          </div>
          <div className="conversation-header-actions">
            {app.threadId && (
              <button
                className="icon-button thread-settings-trigger"
                type="button"
                aria-label="Thread settings"
                title="Thread settings"
                onClick={() => setThreadSettingsOpen(true)}
              >
                <TuneIcon />
                {/*
                 * A quiet dot when the thread carries its own configuration.
                 * Without it the only way to know whether a thread has extra
                 * instructions is to open the dialog and look, and a thread
                 * that silently has them reads exactly like one that does not.
                 */}
                {(app.thread?.systemPrompt || app.thread?.disabledTools?.length) && <span className="thread-settings-dot" aria-hidden="true" />}
              </button>
            )}
            <button className="icon-button details-toggle" aria-label={detailsOpen ? "Close workspace panel" : "Open workspace panel"} aria-pressed={detailsOpen} onClick={() => setDetailsOpen((value) => !value)}><DetailsIcon /></button>
          </div>
        </header>

        {app.session.recovered && <p className="recovery-banner" role="status">Reconnected after a replay gap. Earlier messages were restored from the session log.</p>}
        <div className="conversation-body">
          <div className="conversation-scroll" data-conversation-scroll ref={transcriptRef} data-phase={hero ? "hero" : "active"}>
            {hero ? (
              <div className="dsh-hero-root">
                <div className="dsh-hero-stack">
                  <EmptyHero connected={app.session.status === "open"} />
                  {/*
                    * The header is hidden in this state, which is where thread
                    * settings normally lives — so a brand-new thread, the one
                    * whose instructions most need setting, had no way to reach
                    * it. The chips carry both thread-scoped controls until the
                    * first message puts the header back.
                    */}
                  <div className="dsh-hero-chips">
                    {activeSummary?.cwd && (
                      <button
                        className="dsh-workspace-chip"
                        type="button"
                        onClick={() => { setDetailsOpen(true); setWorkbenchMode("files"); }}
                      >
                        <FolderIcon /><span>{projectCrumb ?? "This thread's workspace"}</span>
                      </button>
                    )}
                    <button
                      className="dsh-workspace-chip dsh-thread-settings-chip"
                      type="button"
                      onClick={() => setThreadSettingsOpen(true)}
                    >
                      <TuneIcon /><span>Thread settings</span>
                      {(app.thread?.systemPrompt || app.thread?.disabledTools?.length) && <span className="thread-settings-dot" aria-hidden="true" />}
                    </button>
                  </div>
                  {composer}
                </div>
              </div>
            ) : (
              <>
                <div className="chat-column">
                  <PlanChecklist plan={app.thread?.plan} todo={app.thread?.todo} />
                  <VerificationPanel verification={app.thread?.verification} />
                  {app.error && <p className="chat-error" role="alert">{app.error}</p>}
                  {/*
                    The active turn id, so the transcript can render thinking
                    live for the turn that is running and collapse it for every
                    turn that is finished.
                  */}
                  <Transcript turns={app.turns} {...(app.activeTurn ? { activeTurnId: app.activeTurn.id } : {})} />
                  {app.queued.map((entry) => <QueuedMessage key={entry.id} entry={entry} onCancel={() => app.dropQueued(entry.id)} onMode={(mode) => app.setQueuedMode(entry.id, mode)} />)}
                  {app.approvals.map((request) => <ApprovalVisibility key={request.approvalId} onVisibilityChange={setApprovalVisible}><ApprovalCard request={request} onDecide={app.decide} /></ApprovalVisibility>)}
                  {app.activeTurn && <WorkingIndicator turn={app.activeTurn} />}
                </div>
                <div className="dsh-composer-seat" data-composer-seat>
                  {/*
                    Shown only while a turn is running and the reader has
                    scrolled away from the bottom. Those two conditions together
                    are what make it a useful control rather than clutter: a
                    finished thread the reader is scrolling back through has
                    nothing below to jump to, and a reader already at the bottom
                    is being followed automatically.
                  */}
                  {detached && app.activeTurn && (
                    <button
                      className="jump-latest"
                      onClick={() => scrollToLatest(transcriptRef.current)}
                    >
                      <span aria-hidden="true">↓</span> Jump to latest
                    </button>
                  )}
                  {pendingApproval && !approvalVisible && <StickyApprovalBar request={pendingApproval} onDecide={app.decide} onReveal={() => scrollToLatest(transcriptRef.current)} />}
                  {composer}
                </div>
              </>
            )}
          </div>
        </div>
      </main>

      {/*
        * `inert` rather than `aria-hidden`: the closed column is laid out at 0px
        * but its buttons and inputs stayed in the tab order, so keyboard users
        * tabbed into controls they could not see. `inert` removes them from
        * both the tab order and the accessibility tree.
        */}
      <aside className="details-column" inert={!detailsOpen}>
        <Workbench baseUrl={BFF_HTTP} threadId={app.threadId} lastEditedPath={app.lastEditedPath} workspaceRevision={app.workspaceRevision} background={app.background} browser={app.thread?.browser} mode={workbenchMode} onModeChange={setWorkbenchMode} />
      </aside>
      {detailsOpen && <DetailsResizeHandle width={detailsWidth} onResize={setDetailsWidth} />}

      <ThreadSettingsDialog
        open={threadSettingsOpen}
        onClose={() => setThreadSettingsOpen(false)}
        client={app.client}
        thread={app.thread}
        threadId={app.threadId}
        catalog={app.catalog}
        disabledProviders={app.settings.settings?.disabledProviders}
        onError={(message) => app.setError(message)}
        /*
         * The dialog shows the permission mode but deliberately does not offer
         * to change it — a safety-relevant control one misclick away from a
         * save the user thinks only changed wording. Sending them to the page
         * that does own it is the difference between a pointer and a dead end.
         */
        onOpenPermissions={() => {
          setThreadSettingsOpen(false);
          navigate("/settings/permissions");
        }}
        /*
         * The dialog reads its draft off `app.thread`, which is state the
         * transcript store owns. Refreshing on save is what makes a thread
         * opened later in the session show the values saved here rather than
         * whatever the list captured when it was last fetched.
         */
        onSaved={app.refreshThreads}
      />

      {skillsOpen && (
        <SkillsOverlay
          store={app.settings}
          client={app.client}
          initialFilter={skillsFilter}
          onClose={() => setSkillsOpen(false)}
          /*
           * "Use" writes the skill invocation into the composer rather than
           * sending it. Loading a skill is a prefix on a message, never a
           * message of its own, so sending `/codemode` alone would spend a turn
           * to say nothing.
           */
          onUse={(name) => {
            setSkillsOpen(false);
            setDraft(`/${name} `);
          }}
          onError={app.setError}
        />
      )}
    </div>
  );
}

function EmptyHero({ connected }: { connected: boolean }) {
  return (
    <div className="dsh-hero-headline" role="status" aria-live="polite">
      <span className="dsh-hero-mark"><ReaperMark size={34} /></span>
      <span>{connected ? "What can I help you build?" : "Connecting to Reaper…"}</span>
    </div>
  );
}

/**
 * What shows while a turn is running and nothing has been said yet.
 *
 * This used to be the static string "Reaper is working…", which answered
 * neither of the two questions a person waiting actually has: is this moving,
 * and how long has it been going. On the provider this was measured against,
 * the first token arrives at 45-60 seconds, so a static label sat there for a
 * minute looking exactly like a request that had hung.
 *
 * Two changes. An elapsed timer, so the wait has a number attached and a
 * counting clock is self-evidently alive. And it disappears the moment there is
 * anything to read — once thinking or answer text is on screen, a line saying
 * "working" beneath it is noise competing with the content.
 *
 * The clock starts when the component mounts, which is when the turn became
 * active, which is close enough to when the model call started that the number
 * means what a person thinks it means.
 */
/**
 * The line that says the agent is still going.
 *
 * Its rule is "has the agent finished", not "has the agent said anything yet",
 * and the difference is what made a continued thread look dead. The previous
 * version hid the indicator as soon as the turn contained any agent text or
 * reasoning, and a turn carries its own whole history: the moment a thread had
 * one earlier reply, every later turn suppressed the indicator immediately and
 * the transcript showed nothing at all while the model worked. The stop button
 * was the only sign anything was happening, and it is easy to miss.
 *
 * A turn that has stopped talking without finishing is also worth showing,
 * which is why a trailing tool call still counts as working: the agent waiting
 * on a shell command has not answered yet.
 */
function WorkingIndicator({ turn }: { turn: AppTurn }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => clearInterval(timer);
  }, []);

  /*
   * What the agent is doing right now, from the last thing it did.
   *
   * Read off the tail rather than the whole turn: a turn's items accumulate, so
   * only the final one says what is happening at this moment.
   */
  const activity = useMemo(() => {
    const items = turn.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.type === "userMessage") continue;
      if (item.type === "agentMessage") return item.text.trim().length > 0 ? "Writing a reply" : "Thinking";
      if (item.type === "reasoning") return "Thinking";
      if (item.type === "commandExecution") return "Running a command";
      if (item.type === "fileChange") return "Editing files";
      if (item.type === "dynamicToolCall") return "Using a tool";
      if (item.type === "contextManagement") return "Managing context";
    }
    return "Thinking";
  }, [turn.items]);

  const isRunning = turn.status === "inProgress";
  if (!isRunning) return null;

  return (
    <div className="turn-status" role="status" aria-live="polite">
      Reaper is working… <span className="turn-elapsed">{activity} · {Math.floor(elapsed / 1000)}s</span>
    </div>
  );
}

/**
 * A message the user typed while the agent was working.
 *
 * It stays in the transcript, not a toast, so the user can see it is held and
 * open it to decide when it lands. Clicking the card reveals the one setting
 * that matters: hand it over after the agent's next tool call, or wait until the
 * agent has finished everything for the current prompt. A message typed during a
 * turn used to disappear the instant it was steered, which read as "my message
 * was eaten" — this keeps it visible with an explicit state until the server
 * confirms it is in the transcript.
 */
function QueuedMessage({ entry, onCancel, onMode }: {
  entry: { id: string; text: string; sent: boolean; mode: "next-step" | "after-turn" };
  onCancel(): void;
  onMode(mode: "next-step" | "after-turn"): void;
}) {
  const [open, setOpen] = useState(false);
  const nextStep = entry.mode === "next-step";
  const status = entry.sent
    ? (nextStep ? "Handed to the agent — it will read this after the current tool call" : "Held — it will send once the agent finishes this prompt")
    : (nextStep ? "Queued for the agent's next tool call" : "Queued for after the agent finishes");
  return (
    <div className="queued-message" data-sent={entry.sent || undefined} data-open={open || undefined}>
      <button className="queued-message-text" type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{entry.text}</button>
      <footer>
        <span className="queued-message-status">{status}</span>
        {!entry.sent && <button type="button" onClick={onCancel}>Cancel</button>}
      </footer>
      {open && (
        <fieldset className="queued-message-mode">
          <legend>Send this message…</legend>
          <label data-selected={nextStep || undefined}>
            <input type="radio" name={`queuemode-${entry.id}`} checked={nextStep} disabled={entry.sent} onChange={() => onMode("next-step")} />
            <span><strong>After the next tool call</strong><small>Steer the running turn — useful to correct course mid-work.</small></span>
          </label>
          <label data-selected={!nextStep || undefined}>
            <input type="radio" name={`queuemode-${entry.id}`} checked={!nextStep} disabled={entry.sent} onChange={() => onMode("after-turn")} />
            <span><strong>After the agent finishes</strong><small>Wait for the current prompt to complete, then send this as a new turn.</small></span>
          </label>
        </fieldset>
      )}
    </div>
  );
}

function ApprovalVisibility({ children, onVisibilityChange }: { children: ReactNode; onVisibilityChange(visible: boolean): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => onVisibilityChange(entries[0]?.isIntersecting ?? true), { threshold: 0.1 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onVisibilityChange]);
  return <div ref={ref}>{children}</div>;
}

function DetailsResizeHandle({ width, onResize }: { width: number; onResize(width: number): void }) {
  const origin = useRef(0);
  const base = useRef(width);
  return <div className="details-resize-handle" style={{ right: width - 4 }} onPointerDown={(event) => { origin.current = event.clientX; base.current = width; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) onResize(Math.max(320, Math.min(820, base.current + origin.current - event.clientX))); }} onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />;
}

function FolderIcon() { return <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" focusable="false"><path d="M2.75 5.5a1.5 1.5 0 0 1 1.5-1.5h2.9c.4 0 .78.16 1.06.44L9.5 5.75h6.25a1.5 1.5 0 0 1 1.5 1.5v7.25a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5V5.5Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>; }
function ReaperMark({ size = 24 }: { size?: number }) { return <span className="reaper-mark" style={{ width: size, height: size }} aria-hidden="true"><svg viewBox="0 0 24 24" width={size} height={size}><path d="M4 5.5h9.2a5.3 5.3 0 0 1 0 10.6H8.8V20H4V5.5Zm4.8 4v2.9h4.1a1.45 1.45 0 1 0 0-2.9H8.8Z" fill="currentColor"/><path d="m14.5 15.2 5.5 4.3h-6.1l-3.6-3.4 4.2-.9Z" fill="currentColor" opacity=".65"/></svg></span>; }
function PanelIcon() { return <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="3" fill="none" stroke="currentColor"/><path d="M7 3v14" stroke="currentColor"/></svg>; }
function DetailsIcon() { return <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="3" fill="none" stroke="currentColor"/><path d="M13 3v14" stroke="currentColor"/></svg>; }
function SettingsIcon() { return <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="3" fill="none" stroke="currentColor"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" stroke="currentColor" strokeLinecap="round"/></svg>; }
