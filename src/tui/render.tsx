/**
 * renderTui — the Ink entry point. Constructs the store, history,
 * abort slot, and engine driver; mounts Ink; blocks on the Ink
 * instance; returns when the user exits.
 *
 * Phase 5 wires session persistence:
 *   - On TUI exit, persist HistoryBuffer.snapshot() to
 *     `<workspaceRoot>/.reaper/tui-history.json`.
 *   - On TUI start, hydrate HistoryBuffer from the same file.
 *   - Slash commands: /sessions, /resume <id>, /history [id].
 *     /history with no args shows the current session's graph.
 *     /history <id> opens the graph for a previous session.
 *
 * Slash commands stay host-side; `TuiHost` pushes lines into the
 * store instead of writing to stdout.
 */

import React from "react";
import { render as inkRender } from "ink";
import { existsSync, readFileSync } from "node:fs";

import { App } from "./app.js";
import { createSessionStore, type SessionStore } from "./state/session-store.js";
import { HistoryBuffer } from "./state/history.js";
import { makeAbortSlot, type AbortSlot } from "./state/abort.js";
import { createEngineDriver, type EngineDriver } from "./engine-driver.js";
import type { SlashCommandRegistry } from "../extensions/slash-command-registry.js";
import { listSessions, loadSession, saveSession, readSessionHistory } from "./sessions-store.js";
import { buildSessionGraph } from "./session-graph.js";
import { saveOnboarding, clearOnboarding, type OnboardingState } from "./provider-onboarding.js";

export interface RenderTuiOptions {
  workspaceRoot: string;
  model: string;
  provider: "anthropic" | "openai" | "minimax" | "deepseek";
  slashRegistry: SlashCommandRegistry;
  /** Optional session id to resume on startup. */
  resumeSessionId?: string | undefined;
  /** When true, App mounts the OnboardingView instead of the main UI. */
  needsOnboarding?: boolean;
  /**
   * Internal: updated after onboarding completes so subsequent driver
   * construction picks up the chosen model. Not part of the public API.
   */
  // (model is mutated by handleOnboardingComplete via opts.model.)
}

export interface RenderTuiHandle {
  store: SessionStore;
  history: HistoryBuffer;
  abortSlot: AbortSlot;
  /** Lazily-constructed engine driver. `null` until the first prompt. */
  driver: EngineDriver | null;
  /** Resolves when the TUI exits. */
  done: Promise<void>;
}

const HISTORY_FILENAME = ".reaper/tui-history.json";

export function renderTui(opts: RenderTuiOptions): RenderTuiHandle {
  const store = createSessionStore({
    model: opts.model,
    provider: opts.provider,
  });
  const history = new HistoryBuffer();
  const abortSlot = makeAbortSlot();

  // Hydrate history from disk.
  try {
    const path = `${opts.workspaceRoot}/${HISTORY_FILENAME}`;
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      const items = JSON.parse(raw) as string[];
      if (Array.isArray(items)) history.hydrate(items);
    }
  } catch {
    /* ignore — history hydration is best-effort */
  }

  // Defer engine construction until either auth is available or the
  // user completes onboarding. Calling buildConfig without a token
  // throws — we don't want that to fire during the onboarding picker.
  let driver: EngineDriver | null = null;
  function ensureDriver(): EngineDriver {
    if (driver) return driver;
    driver = createEngineDriver({
      workspaceRoot: opts.workspaceRoot,
      model: opts.model,
      provider: opts.provider,
      store,
    });
    return driver;
  }

  // Register /history slash command — opens the session-graph view.
  // The command emits a special message that App intercepts to toggle
  // the GraphView overlay. We avoid using TuiHost.print here because
  // the graph view needs a full-screen overlay, not a transient bubble.
  opts.slashRegistry.register({
    name: "history",
    description: "Show session graph (current session or /history <id>)",
    args: [{ name: "id", required: false, description: "Optional session id to inspect" }],
    source: "builtin",
    run: async (args, ctx) => {
      const requestedId = args[0];
      const sessions = listSessions(opts.workspaceRoot, 50);
      let target = requestedId;
      if (!target) {
        target = store.getStatus().sessionId;
      }
      const meta = sessions.find((s) => s.id === target) ?? loadSession(opts.workspaceRoot, target);
      if (!meta) {
        ctx.host.print(`(history) no session found for id "${target}"`);
        ctx.host.print(`(history) recent sessions:`);
        for (const s of sessions.slice(0, 10)) {
          ctx.host.print(`  ${s.id}  ${s.startedAt}  ${(s.firstPrompt ?? "").slice(0, 50)}`);
        }
        return { ok: true, output: "" };
      }
      const graph = buildSessionGraph(meta.trajectoryPath);
      if (!graph) {
        ctx.host.printError(`(history) session "${target}" has no readable trajectory at ${meta.trajectoryPath}`);
        return { ok: false, output: "", error: "no trajectory" };
      }
      // Emit a structured signal so App opens the GraphView.
      ctx.host.printError(`__GRAPH_OPEN__ ${target} ${graph.totalNodes} ${graph.turnCount}`);
      return { ok: true, output: "" };
    },
  });

  // Register /sessions as a host-side list command.
  opts.slashRegistry.register({
    name: "sessions",
    description: "List recent sessions",
    source: "builtin",
    run: async (_args, ctx) => {
      const items = listSessions(opts.workspaceRoot, 20);
      if (items.length === 0) {
        ctx.host.print("(sessions) none yet — start a conversation to create one");
        return { ok: true, output: "" };
      }
      ctx.host.print(`(sessions) ${items.length} recent session${items.length === 1 ? "" : "s"}:`);
      for (const s of items) {
        const fp = (s.firstPrompt ?? "").slice(0, 60).replace(/\n/g, " ");
        ctx.host.print(`  ${s.id}  ${s.startedAt}  prompts=${s.promptCount}  msgs=${s.messageCount}  ${fp}`);
      }
      return { ok: true, output: "" };
    },
  });

  // Register /resume — load a session's messages and continue.
  // Hydrates the SessionStore from the persisted trajectory so the
  // next prompt carries the full conversation history via the
  // engine-driver's priorTurns payload.
  opts.slashRegistry.register({
    name: "resume",
    description: "Resume a previous session by id",
    args: [{ name: "id", required: true, description: "Session id to resume" }],
    source: "builtin",
    run: async (args, ctx) => {
      const id = args[0];
      if (!id) {
        ctx.host.printError("(resume) usage: /resume <sessionId>");
        return { ok: false, output: "", error: "missing sessionId" };
      }
      const meta = loadSession(opts.workspaceRoot, id);
      if (!meta) {
        ctx.host.printError(`(resume) no session found for id "${id}"`);
        return { ok: false, output: "", error: "not found" };
      }
      const history = readSessionHistory(meta.trajectoryPath);
      if (!history || history.length === 0) {
        ctx.host.printError(`(resume) session "${id}" has no readable trajectory at ${meta.trajectoryPath}`);
        return { ok: false, output: "", error: "no trajectory" };
      }
      // Clear the current store and replay the persisted turns in
      // order. The store's `appendUser` / `appendAssistant` set the
      // right ts / id for each message and the priorTurns extractor
      // in engine-driver picks them up automatically on the next
      // prompt.
      store.clear();
      let userCount = 0;
      let assistantCount = 0;
      for (const turn of history) {
        if (turn.role === "user") {
          store.appendUser(turn.content);
          userCount += 1;
        } else {
          store.appendAssistant(turn.content);
          assistantCount += 1;
        }
      }
      ctx.host.print(
        `(resume) loaded session ${id} — model=${meta.model} prompts=${meta.promptCount} msgs=${history.length} (${userCount}u/${assistantCount}a)`,
      );
      // Emit a structured signal so App can update its UI state
      // (clear reverse-search / graph overlays, reset input).
      ctx.host.printError(`__SESSION_RESUME__ ${id}`);
      return { ok: true, output: "" };
    },
  });

  // Register /provider — re-run the provider/key/model picker. Useful
  // when the user wants to switch providers or rotate their API key.
  // The slash command clears the saved state and emits a synthetic
  // signal that App intercepts to re-mount the OnboardingView.
  opts.slashRegistry.register({
    name: "provider",
    description: "Re-run the provider + API key + model picker",
    source: "builtin",
    run: async (_args, ctx) => {
      clearOnboarding();
      ctx.host.print("(provider) cleared saved credentials — re-running picker…");
      ctx.host.printError("__REOPEN_ONBOARDING__");
      return { ok: true, output: "" };
    },
  });

  opts.slashRegistry.register({
    name: "debug",
    description: "Toggle debug logging in the TUI",
    args: [{ name: "mode", required: false, description: "on, off, or toggle" }],
    source: "builtin",
    run: async (args, ctx) => {
      const mode = (args[0] ?? "toggle").toLowerCase();
      const next = mode === "on"
        ? true
        : mode === "off"
          ? false
          : !store.isDebugMode();
      store.setDebugMode(next);
      store.setStatus({ hint: `debug ${next ? "on" : "off"}` });
      ctx.host.print(`(debug) ${next ? "enabled" : "disabled"}`);
      return { ok: true, output: "" };
    },
  });

  opts.slashRegistry.register({
    name: "logs",
    description: "Show internal logs and tool details",
    source: "builtin",
    run: async (_args, ctx) => {
      store.setDebugMode(true);
      store.setStatus({ hint: "debug logs visible" });
      ctx.host.print("(logs) debug mode enabled");
      return { ok: true, output: "" };
    },
  });

  const handleOnboardingComplete = (state: Omit<OnboardingState, "savedAt">): void => {
    saveOnboarding(state);
    // The first driver call will construct the engine with the
    // saved model. Update the model hint we pass to ensureDriver.
    opts.model = state.model;
    try {
      ensureDriver().setActiveModel(state.model);
    } catch { /* setActiveModel is best-effort */ }
    // Also surface a system note so the user knows it's saved.
    store.appendSystem(
      `(provider) saved ${state.provider} (model=${state.model}) to ~/.reaper/onboarding.json`,
    );
  };

  const app = inkRender(
    React.createElement(App, {
      store,
      history,
      slashRegistry: opts.slashRegistry,
      workspaceRoot: opts.workspaceRoot,
      onUserPrompt: (text, signal) => {
        let d: EngineDriver;
        try {
          d = ensureDriver();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          store.appendError(msg);
          store.setPhase("done");
          return;
        }
        void d.runPrompt(text, signal).finally(() => {
          abortSlot.reset();
        });
      },
      abortSlot,
      ...(opts.resumeSessionId !== undefined ? { initialGraphSessionId: opts.resumeSessionId } : {}),
      ...(opts.needsOnboarding === true ? { needsOnboarding: true as const } : {}),
      onOnboardingComplete: handleOnboardingComplete,
      onOnboardingAbort: () => {
        // Honour the abort: exit cleanly with code 130 (POSIX).
        store.appendSystem("(provider) onboarding aborted — no credentials saved");
        process.exit(130);
      },
    }),
    { exitOnCtrlC: false },
  );

  // Auto-hydrate on startup when a resumeSessionId is supplied. Same
  // flow as the /resume slash command but fires before the user
  // types anything so the message list is populated immediately.
  // Best-effort: failures fall back to a fresh empty session.
  if (opts.resumeSessionId) {
    try {
      const meta = loadSession(opts.workspaceRoot, opts.resumeSessionId);
      if (meta) {
        const history = readSessionHistory(meta.trajectoryPath);
        if (history && history.length > 0) {
          store.clear();
          for (const turn of history) {
            if (turn.role === "user") store.appendUser(turn.content);
            else store.appendAssistant(turn.content);
          }
          store.appendSystem(
            `(resume) auto-loaded session ${opts.resumeSessionId} — ${history.length} message${history.length === 1 ? "" : "s"} (model=${meta.model})`,
          );
        }
      }
    } catch {
      /* best-effort */
    }
  }

  app.waitUntilExit().finally(async () => {
    // Persist history on exit.
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const dir = path.join(opts.workspaceRoot, ".reaper");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "tui-history.json"),
        JSON.stringify(history.snapshot(), null, 2),
        "utf8",
      );
    } catch {
      /* best-effort */
    }
    // Final session-metadata write on TUI exit. This catches the
    // edge case where the user opens the TUI, types nothing, and
    // exits — we still want a sessions/<id>.json so /sessions lists
    // it as "no prompts". The driver already wrote intermediate
    // snapshots after every prompt; this is the closing write.
    try {
      saveSession(opts.workspaceRoot, {
        id: store.getStatus().sessionId,
        startedAt: store.startedAtIso(),
        model: store.getStatus().model,
        provider: store.getStatus().provider,
        promptCount: store.promptCount(),
        messageCount: store.messageCount(),
        trajectoryPath: "",
        ...(store.firstPrompt() !== undefined ? { firstPrompt: store.firstPrompt() } : {}),
      });
    } catch {
      /* best-effort */
    }
    if (driver) {
      void driver.dispose();
    }
  });

  return {
    store,
    history,
    abortSlot,
    get driver(): EngineDriver | null { return driver; },
    done: app.waitUntilExit().then(() => undefined),
  };
}
