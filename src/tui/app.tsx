/**
 * App — the root Ink component. Wires the SessionStore, HistoryBuffer,
 * slash registry, abort controller, reverse-search popover, and
 * session graph view together. Renders:
 *   - Help overlay (? or Ctrl-?)
 *   - Session graph view (when /history is invoked)
 *   - Message list (scrollable viewport, Phase 5 polish)
 *   - Slash popover (above the input when /... is typed)
 *   - Reverse-search popover (above the input on Ctrl-R)
 *   - Input prompt
 *   - Status bar (footer)
 *
 * Phase 5 additions:
 *   - Session graph view (Pi-style) on /history
 *   - /sessions and /resume slash commands
 *   - Bracketed paste via stdin data listener
 *   - Double Ctrl-C exit (1.5s window)
 *
 * Submit flow:
 *   user types → Enter
 *     → if slash command: SlashCommandRegistry.handle(line, { host })
 *     → else: store.appendUser + driver.runPrompt()
 *
 * The App intercepts two synthetic error-message strings emitted by
 * the /history and /resume slash commands:
 *   - "__GRAPH_OPEN__ <id> <nodes> <turns>"  → opens GraphView
 *   - "__SESSION_RESUME__ <id>"              → hydrates the store
 * These are ugly but the SlashHost interface has no other channel
 * for delivering structured events to the UI.
 */

import React from "react";
import { Box, Text, useApp, useInput } from "ink";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { theme } from "./theme.js";
import type { SlashCommandRegistry } from "../extensions/slash-command-registry.js";
import type { SessionStore } from "./state/session-store.js";
import { HistoryBuffer } from "./state/history.js";
import { useSession } from "./hooks/use-session.js";
import { usePaste } from "./hooks/use-paste.js";
import { useInputKeys } from "./hooks/use-input-keys.js";
import { StatusBar } from "./components/status-bar.js";
import { MessageList } from "./components/message-list.js";
import { SlashPopover, type SlashEntry } from "./components/slash-popover.js";
import { ReverseSearchPopover } from "./components/reverse-search-popover.js";
import { InputPrompt } from "./components/input-prompt.js";
import { HelpOverlay } from "./components/help-overlay.js";
import { GraphView } from "./components/graph-view.js";
import { TuiHost } from "./host/tui-host.js";
import { ToolCard } from "./components/tool-card.js";
import { OnboardingView } from "./components/onboarding-view.js";
import type { AbortSlot } from "./state/abort.js";
import { buildSessionGraph } from "./session-graph.js";
import type { OnboardingState } from "./provider-onboarding.js";

export interface AppProps {
  store: SessionStore;
  history: HistoryBuffer;
  slashRegistry: SlashCommandRegistry;
  workspaceRoot: string;
  onUserPrompt: (prompt: string, signal: AbortSignal) => void;
  abortSlot: AbortSlot;
  maxLines?: number;
  /** Session id to inspect on startup via /history. */
  initialGraphSessionId?: string | undefined;
  /** True if first-run onboarding should run instead of the main UI. */
  needsOnboarding?: boolean;
  /** Called when the user completes the onboarding flow. */
  onOnboardingComplete?: (state: Omit<OnboardingState, "savedAt">) => void;
  /** Called when the user aborts onboarding (Ctrl-C twice). */
  onOnboardingAbort?: () => void;
}

function registryEntries(reg: SlashCommandRegistry, partial: string): SlashEntry[] {
  const all = reg.list({ includeHidden: false });
  const names = reg.complete(partial);
  if (!partial.startsWith("/")) {
    partial = "/" + partial;
  }
  const byName = new Map<string, { description: string }>();
  for (const cmd of all) {
    byName.set(cmd.name.toLowerCase(), { description: cmd.description ?? "" });
  }
  return names.map((name) => {
    const meta = byName.get(name.toLowerCase()) ?? { description: "" };
    return { name, description: meta.description || `/${name}` };
  });
}

const DOUBLE_CTRL_C_WINDOW_MS = 1500;

export function App(props: AppProps): React.ReactElement {
  const { store, history, slashRegistry, workspaceRoot, onUserPrompt, abortSlot, maxLines = 200, initialGraphSessionId, needsOnboarding: initialNeedsOnboarding, onOnboardingComplete, onOnboardingAbort } = props;
  const { exit } = useApp();
  const snapshot = useSession(store);
  const [inputValue, setInputValue] = React.useState("");
  const [slashEntries, setSlashEntries] = React.useState<SlashEntry[]>([]);
  const [slashSelected, setSlashSelected] = React.useState(0);
  const [helpVisible, setHelpVisible] = React.useState(false);
  const [reverseSearchOpen, setReverseSearchOpen] = React.useState(false);
  const [exitHint, setExitHint] = React.useState<string | undefined>(undefined);
  const [graphSessionId, setGraphSessionId] = React.useState<string | undefined>(initialGraphSessionId);
  const [graphSelected, setGraphSelected] = React.useState(0);
  const [onboarding, setOnboarding] = React.useState<boolean>(initialNeedsOnboarding === true);
  const lastCtrlC = React.useRef<number>(0);

  // Bracketed paste: insert the pasted block as a single chunk into
  // the input value, preserving newlines for multi-line prompts.
  usePaste((text) => {
    setInputValue((v) => v + text);
  });

  // Watch for synthetic __GRAPH_OPEN__, __SESSION_RESUME__, and
  // __REOPEN_ONBOARDING__ messages emitted by /history, /resume, and
  // /provider slash commands. The SlashHost pushes them through
  // printError; we scan the latest error message and toggle the
  // appropriate UI state.
  //
  // We use `lastErr?.text` as the dependency, NOT the whole
  // `snapshot.messages` array — otherwise this effect would re-fire
  // on every chat update, and `setOnboarding(true)` would be called
  // repeatedly while the user is mid-onboarding.
  const lastErr = [...snapshot.messages].reverse().find((m) => m.kind === "error");
  const lastErrText = lastErr?.text ?? "";
  React.useEffect(() => {
    if (!lastErr) return;
    if (lastErrText.startsWith("__GRAPH_OPEN__ ")) {
      const parts = lastErrText.split(/\s+/);
      const id = parts[1] ?? "";
      setGraphSessionId(id);
      setGraphSelected(0);
      return;
    }
    if (lastErrText.startsWith("__SESSION_RESUME__ ")) {
      const id = lastErrText.split(/\s+/)[1] ?? "";
      store.appendSystem(`(resumed session ${id} — re-run prompts to continue)`);
      return;
    }
    if (lastErrText === "__REOPEN_ONBOARDING__") {
      setOnboarding(true);
      setGraphSessionId(undefined);
      setReverseSearchOpen(false);
      setHelpVisible(false);
      return;
    }
  }, [lastErrText, store]);

  // Recompute slash completions whenever the input changes.
  React.useEffect(() => {
    if (!inputValue.startsWith("/")) {
      setSlashEntries([]);
      return;
    }
    const entries = registryEntries(slashRegistry, inputValue);
    setSlashEntries(entries);
    setSlashSelected(0);
  }, [inputValue, slashRegistry]);

  // Auto-clear the double-Ctrl-C hint after 1.5s.
  React.useEffect(() => {
    if (!exitHint) return;
    const t = setTimeout(() => setExitHint(undefined), DOUBLE_CTRL_C_WINDOW_MS);
    return () => clearTimeout(t);
  }, [exitHint]);

  // Global keybinds.
  useInput((input, key) => {
    if (graphSessionId) return; // GraphView owns the keys when open.
    if (key.ctrl && input === "r") {
      setReverseSearchOpen(true);
      return;
    }
    if (key.ctrl && input === "l") {
      store.clear();
      return;
    }
    if ((key.ctrl && input === "?") || input === "?") {
      setHelpVisible((v) => !v);
      return;
    }
    if (key.ctrl && input === "c") {
      const now = Date.now();
      if (now - lastCtrlC.current < DOUBLE_CTRL_C_WINDOW_MS) {
        exit();
        return;
      }
      lastCtrlC.current = now;
      setExitHint("press Ctrl-C again within 1.5s to exit");
      return;
    }
  });

  // View-preference keybinds (Ctrl+T toggle thinking, Ctrl+E toggle
  // tool-card default expansion). Wired through a dedicated hook so
  // the keybind surface area lives in one file.
  useInputKeys({ store, isActive: !graphSessionId && !onboarding });

  const handleSubmit = React.useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (trimmed.startsWith("/")) {
        const host = new TuiHost(store);
        void slashRegistry.handle(trimmed, { host }).then((result) => {
          if (!result.ok && result.error) {
            store.appendError(`/${result.error}`);
          }
        });
        return;
      }
      store.appendUser(trimmed);
      history.push(trimmed);
      onUserPrompt(trimmed, abortSlot.signal);
    },
    [store, slashRegistry, onUserPrompt, abortSlot.signal, history],
  );

  const handleSlashCommit = React.useCallback(
    (full: string) => {
      handleSubmit(full);
    },
    [handleSubmit],
  );

  const handleReverseCommit = React.useCallback(
    (text: string) => {
      setReverseSearchOpen(false);
      setInputValue(text);
    },
    [],
  );

  const handleReverseCancel = React.useCallback(() => {
    setReverseSearchOpen(false);
  }, []);

  const statusWithHint = exitHint
    ? { ...snapshot.status, hint: exitHint }
    : snapshot.status;
  const debugMode = statusWithHint.debugMode;

  // Onboarding overlay — runs before any other UI when first invoked
  // (or re-mounted via the /provider slash command).
  if (onboarding) {
    return (
      <Box flexDirection="column" height="100%" alignItems="center" justifyContent="center">
        <OnboardingView
          onComplete={(state) => {
            onOnboardingComplete?.(state);
            setOnboarding(false);
          }}
          onAbort={() => {
            onOnboardingAbort?.();
            setOnboarding(false);
          }}
        />
      </Box>
    );
  }

  // Graph view overlay.
  if (graphSessionId) {
    const graph = buildGraphForSession(workspaceRoot, graphSessionId);
    if (!graph) {
      return (
        <Box flexDirection="column">
          <Text>{"(graph) session not found: " + graphSessionId}</Text>
          <Text>{"press q to close"}</Text>
          <GraphCloseButton onClose={() => setGraphSessionId(undefined)} />
        </Box>
      );
    }
    return (
      <Box flexDirection="column" height="100%">
        <Box flexDirection="column" flexGrow={1}>
          <GraphView
            graph={graph}
            selected={graphSelected}
            windowStart={0}
            windowSize={Math.max(5, (snapshot.status as { lines?: number }).lines ?? 30)}
            onSelect={setGraphSelected}
            onClose={() => setGraphSessionId(undefined)}
          />
        </Box>
        <StatusBar status={statusWithHint} />
      </Box>
    );
  }

  // Filter out the synthetic __GRAPH_OPEN__ / __SESSION_RESUME__ /
  // __REOPEN_ONBOARDING__ error messages from the visible list.
  const visibleMessages = snapshot.messages.filter(
    (m) => {
      if (m.kind === "error" && (m.text.startsWith("__GRAPH_OPEN__ ") || m.text.startsWith("__SESSION_RESUME__ ") || m.text === "__REOPEN_ONBOARDING__")) {
        return false;
      }
      if (!debugMode && m.kind === "system") return false;
      return true;
    },
  );

  const toolCards = snapshot.toolCards;
  const completedTools = toolCards.filter((c) => c.ok).length;
  const failedTools = toolCards.filter((c) => Boolean(c.error)).length;
  const runningTools = toolCards.filter((c) => !c.ok && !c.error).length;
  const totalToolDurationMs = toolCards.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);

  return (
    <Box flexDirection="column" height="100%">
      <HelpOverlay visible={helpVisible} />
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <MessageList
          messages={visibleMessages}
          maxLines={maxLines}
          debugMode={debugMode}
          store={store}
        />
        {debugMode ? (
          snapshot.toolCards.map((c) => (
            <ToolCardWithRoot key={c.id} cardId={c.id} workspaceRoot={workspaceRoot} store={store} />
          ))
        ) : toolCards.length > 0 ? (
          <Box flexDirection="column" paddingX={1}>
            <Text>{theme.muted(`tools ${toolCards.length} · ${completedTools} ok · ${failedTools} failed · ${runningTools} running · ${Math.round(totalToolDurationMs / 1000)}s · /logs`)}</Text>
          </Box>
        ) : null}
      </Box>
      <Box flexDirection="column">
        <ReverseSearchPopover
          history={history}
          visible={reverseSearchOpen}
          onCommit={handleReverseCommit}
          onCancel={handleReverseCancel}
        />
        <SlashPopover
          entries={slashEntries}
          selected={slashSelected}
          visible={slashEntries.length > 0 && !reverseSearchOpen}
        />
        <InputPrompt
          history={history}
          slashEntries={slashEntries}
          slashSelected={slashSelected}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          onSlashSelectionChange={setSlashSelected}
          onSlashCommit={handleSlashCommit}
          onAbort={() => abortSlot.abort()}
          onRequestExit={() => exit()}
          isActive={!reverseSearchOpen}
        />
      </Box>
      <StatusBar status={statusWithHint} />
    </Box>
  );
}

function buildGraphForSession(workspaceRoot: string, sessionId: string) {
  const meta = ((): { trajectoryPath?: string } | null => {
    try {
      const file = path.join(workspaceRoot, ".reaper/sessions", `${sessionId}.json`);
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, "utf8"));
    } catch { return null; }
  })();
  if (!meta || !meta.trajectoryPath) return null;
  return buildSessionGraph(meta.trajectoryPath);
}

/** Tiny component that listens for q/Esc and calls onClose.
 *  Used when the requested graph can't be built. */
function GraphCloseButton({ onClose }: { onClose: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === "q") onClose();
  }, { isActive: true });
  return <Text> </Text>;
}

function ToolCardWithRoot({
  cardId,
  workspaceRoot,
  store,
}: {
  cardId: string;
  workspaceRoot: string;
  store: SessionStore;
}): React.ReactElement | null {
  useSession(store);
  const card = store.snapshot().toolCards.find((c) => c.id === cardId);
  if (!card) return null;
  return <ToolCard card={card} workspaceRoot={workspaceRoot} store={store} />;
}
