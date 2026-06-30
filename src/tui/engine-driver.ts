/**
 * engine-driver — bridges the SessionStore to RuntimeEngine. One
 * instance per TUI session. The driver:
 *
 *   1. Owns a single `Hooks` adapter and a single `ConfiguredModelGateway`.
 *   2. Subscribes the adapter to tool-card mutations on the SessionStore.
 *   3. Exposes `runPrompt(prompt, signal)` which builds a per-turn envelope
 *      with `metadata.yolo: true` and routes the engine's final result
 *      back into the store.
 *
 * The engine already emits `PreToolUse` / `PostToolUse` / `PostToolUseFailure`
 * around every dispatched tool call. We listen for those to begin and
 * finish tool cards without modifying the engine. We also call
 * `Hooks.emit("SessionStart")` and `("SessionEnd")` around each turn so
 * extensions + skills can observe per-turn lifecycle.
 *
 * Notes on streaming: RuntimeEngine.run() is non-streaming for the model
 * token stream — it returns the final assistant string in one chunk. We
 * flip the store to `phase: "streaming"` immediately on submit and to
 * `phase: "done"` once the engine resolves. Per-tool events arrive
 * incrementally in between, which is the liveness signal the TUI leans on.
 */

import { RuntimeEngine } from "../runtime/engine.js";
import { ConfiguredModelGateway, type ProviderModelClient } from "../model/gateway.js";
import { ProviderMultiplexerClient } from "../model/providers/provider-client.js";
import { Hooks } from "../adaptive/hooks.js";
import { buildConfig } from "../adaptive/exec-runner.js";
import { globalLlmQueue } from "../model/concurrency.js";
import { saveSession } from "./sessions-store.js";
import type { SessionStore } from "./state/session-store.js";
import type { HookEvent } from "../adaptive/types.js";

export interface EngineDriverOptions {
  workspaceRoot: string;
  model: string;
  provider: "anthropic" | "openai" | "minimax" | "deepseek" | "nuralwatt";
  store: SessionStore;
}

export interface EngineDriver {
  /** Run one prompt through the engine. Pushes assistant message +
   *  tool cards onto the store when done. */
  runPrompt(prompt: string, signal: AbortSignal): Promise<void>;
  /** Dispose the underlying model gateway. Safe to call multiple times. */
  dispose(): Promise<void>;
  /** Switch the active model. Takes effect on the next `runPrompt`. */
  setActiveModel(model: string): void;
}

export function createEngineDriver(opts: EngineDriverOptions): EngineDriver {
  const { workspaceRoot, model: initialModel, provider, store } = opts;
  let activeModel = initialModel;

  // Build the yolo config. Throws if the auth token is missing — the
  // caller can decide whether to surface that as a system message or
  // a hard error. We rebuild it per-turn so `setActiveModel` takes
  // effect on the next prompt.
  function buildCurrentConfig(): unknown {
    return buildConfig({
      workspaceRoot,
      prompt: "", // overridden per-turn; buildConfig only needs shape
      model: activeModel,
      provider,
    } as Parameters<typeof buildConfig>[0]);
  }
  let config = buildCurrentConfig();

  // Use the multiplexer so we can route to deepseek / minimax /
  // anthropic based on the active model name. The driver receives
  // a "provider" hint at construction time but the actual call path
  // is decided per-request by the multiplexer.
  const client: ProviderModelClient = new ProviderMultiplexerClient();
  let gateway = new ConfiguredModelGateway(config, client);

  // Hooks → SessionStore bridge. The engine emits PreToolUse with
  // `{ toolName, args }`, PostToolUse with `{ toolName, args, output }`,
  // PostToolUseFailure with `{ toolName, args, error }`. We translate
  // each to a tool-card transition.
  const hooks = new Hooks({ securityFailClosed: true });

  // Tracks how many assistant bubbles existed before the current
  // turn started. Final turn completion only appends a new assistant
  // message when the count stays unchanged, which prevents stale
  // duplicate replies from being replayed after tool calls.
  let turnAssistantCountAtStart = 0;

  hooks.on("PreToolUse", (evt: HookEvent) => {
    const p = evt.payload as { toolName?: string; args?: unknown };
    const name = String(p.toolName ?? "unknown");
    const args = p.args ?? {};
    // callId isn't available from PreToolUse alone; we synthesize one
    // from the toolName + args fingerprint. The PostToolUse will look
    // up the most recent open card for this toolName and patch it.
    const syntheticId = `${name}:${Date.now().toString(36)}`;
    store.beginToolCard({ callId: syntheticId, name, args });
    store.setPhase("tool-running");
    return { allow: true };
  });

  hooks.on("PostToolUse", (evt: HookEvent) => {
    const p = evt.payload as { toolName?: string; args?: unknown; output?: unknown };
    const name = String(p.toolName ?? "unknown");
    // Find the most recent open card for this toolName and close it.
    const open = [...store.snapshot().toolCards].reverse().find(
      (c) => c.name === name && !c.ok,
    );
    if (open) {
      store.finishToolCard(open.callId, {
        result: p.output,
        ok: true,
        durationMs: Date.now() - open.ts,
      });
    }
    store.setPhase("streaming");
    return { allow: true };
  });

  hooks.on("PostToolUseFailure", (evt: HookEvent) => {
    const p = evt.payload as { toolName?: string; args?: unknown; error?: unknown };
    const name = String(p.toolName ?? "unknown");
    const open = [...store.snapshot().toolCards].reverse().find(
      (c) => c.name === name && !c.ok,
    );
    if (open) {
      store.finishToolCard(open.callId, {
        result: { error: p.error },
        ok: false,
        durationMs: Date.now() - open.ts,
      });
    }
    store.setPhase("streaming");
    return { allow: true };
  });

  // Streaming assistant text. The engine emits one
  // AssistantMessageDelta per turn followed by an AssistantMessageComplete.
  // We mutate the streaming buffer in the store so the TUI sees text
  // appear incrementally. The final `store.appendAssistant` in
  // `runPrompt` is a no-op when the streaming path already produced
  // the same content (we compare by text content, not id).

  hooks.on("ReasoningDelta", (evt: HookEvent) => {
    const p = evt.payload as { text?: string; role?: string; done?: boolean };
    const text = String(p.text ?? "");
    if (text) store.appendReasoningDelta(text);
    return { allow: true };
  });

  hooks.on("ReasoningComplete", (evt: HookEvent) => {
    // Fold the reasoning buffer onto the streaming / most recent
    // assistant message. The store's completeReasoning() drops the
    // accumulator on a no-op, so calling it after a non-reasoning
    // turn is safe.
    store.completeReasoning();
    return { allow: true };
  });

  hooks.on("AssistantMessageDelta", (evt: HookEvent) => {
    const p = evt.payload as { text?: string; role?: string; done?: boolean };
    const text = String(p.text ?? "");
    if (text) store.appendAssistantDelta(text);
    store.setPhase("streaming");
    return { allow: true };
  });

  hooks.on("AssistantMessageComplete", (evt: HookEvent) => {
    // Commit the streaming buffer. Mirrors AssistantStreamComplete
    // for the rendering-layer event family.
    store.completeAssistant();
    return { allow: true };
  });

  /**
   * Engine-level turn-completion signal. The engine fires this when
   * a model turn ends with a non-empty assistant message and zero
   * tool calls (implicit completion) OR when a `complete_task` signal
   * produces a successful assistant_message via the normal `summarize`
   * path. Subscribing here lets the TUI transition cleanly to
   * `phase="done"` without waiting for the next prompt-submit cycle
   * — the runPrompt catch/finally also sets the phase, but for the
   * common case (no tool calls) the run resolves much later and the
   * user is staring at a stale "streaming" spinner until then.
   *
   * The handler is fail-open: a missing store mutation must not
   * abort the hook chain.
   */
  hooks.on("EngineTurnComplete", (evt: HookEvent) => {
    try {
      const p = evt.payload as { assistantMessage?: string; implicit?: boolean; toolResults?: Array<{ name: string; ok: boolean }> };
      const msg = typeof p.assistantMessage === "string" ? p.assistantMessage : "";
      const assistantCount = store.snapshot().messages.filter((m) => m.kind === "assistant").length;
      if (msg && assistantCount === turnAssistantCountAtStart) {
        // Engine finished with a message we never streamed — push
        // it onto the store so the chat bubble appears.
        try { store.appendAssistant(msg); } catch { /* fail-open */ }
      }
      // The TUI's "done" phase is also set by runPrompt's tail. We
      // set it here as a fail-open fast path so single-turn
      // completions flip the spinner immediately.
      try { store.setPhase("done"); } catch { /* fail-open */ }
    } catch {
      /* fail-open */
    }
    return { allow: true };
  });

  let disposed = false;
  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    try {
      await gateway.dispose();
    } catch {
      /* swallow */
    }
  }

  function setActiveModel(next: string): void {
    if (next === activeModel) return;
    activeModel = next;
    // Rebuild the config + gateway against the new model so subsequent
    // prompts pick it up. We dispose the old gateway first.
    void gateway.dispose().catch(() => undefined);
    config = buildCurrentConfig();
    gateway = new ConfiguredModelGateway(config, client);
  }

  async function runPrompt(prompt: string, signal: AbortSignal): Promise<void> {
    store.setPhase("streaming");
    store.setStatus({ tokens: 0, ctxPct: 0 });

    // Latency fix: a slow background subagent call earlier in the
    // session can latch the AdaptiveConcurrencyQueue at
    // concurrency=1, which would serialize every subsequent prompt.
    // Restore max concurrency on each interactive prompt so the
    // queue never poisons the TUI's response path. This is a no-op
    // when the queue was never degraded.
    try {
      globalLlmQueue.reset();
    } catch {
      /* fail-open — never block a prompt on queue reset */
    }

    // Build a per-turn envelope. The engine consumes `payload.prompt` as
    // the user prompt. We carry the same yolo marker that the exec
    // runner uses so policy stays consistent.
    //
    // Session continuity: `payload.priorTurns` carries the full
    // conversation history from this session in chronological order
    // (user/assistant text only). The engine prepends it to its
    // model-call messages so each new turn sees the prior context.
    // On `/resume <id>` the TUI pre-hydrates the store from the
    // persisted trajectory, so this list naturally reflects the
    // resumed session.
    const ts = new Date().toISOString();
    const sessionId = store.getStatus().sessionId;
    const turnId = `${sessionId}-t${Date.now()}`;
    const priorTurns: Array<{ role: "user" | "assistant"; content: string }> = store
      .snapshot()
      .messages
      .filter((m) => m.kind === "user" || m.kind === "assistant")
      .map((m) => ({ role: m.kind as "user" | "assistant", content: m.text }));
    turnAssistantCountAtStart = priorTurns.filter((turn) => turn.role === "assistant").length;
    const requestEnvelope = {
      connection_id: "tui-cli",
      session_id: sessionId,
      turn_id: turnId,
      request_id: `${turnId}-r0`,
      message_type: "user_prompt" as const,
      timestamp: ts,
      trace_id: sessionId,
      metadata: { transport: "http_json", yolo: true },
      payload: { prompt, priorTurns },
    };

    const engine = new RuntimeEngine({
      config,
      workspaceRoot,
      requestEnvelope,
      modelGateway: gateway,
      hooks,
      abortSignal: signal,
    });

    let aborted = false;
    const onAbort = () => { aborted = true; };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await engine.run();
      const assistantMessage = String(result.assistantMessage ?? "");
      if (assistantMessage) {
        const assistantCount = store.snapshot().messages.filter((m) => m.kind === "assistant").length;
        if (assistantCount === turnAssistantCountAtStart) {
          store.appendAssistant(assistantMessage);
        }
      }
      const verification = result.verification;
      if (verification && !verification.ok) {
        const reason = verification.feedback?.[0] ?? "verification did not converge";
        store.appendSystem(`(verification: ${reason})`);
      }
      const events = result.events?.length ?? 0;
      store.appendSystem(`(done — ${events} events, trajectory ${result.trajectoryPath})`);
      // Session isolation: persist this session's metadata under its
      // own sessionId so /sessions lists it and /resume <id> can hydrate
      // it. Each session owns its own .reaper/sessions/<sessionId>.json
      // and its own trajectory directory — no cross-session sharing.
      try {
        saveSession(workspaceRoot, {
          id: store.getStatus().sessionId,
          startedAt: store.startedAtIso(),
          model: store.getStatus().model,
          provider: store.getStatus().provider,
          promptCount: store.promptCount(),
          messageCount: store.messageCount(),
          trajectoryPath: result.trajectoryPath,
          ...(store.firstPrompt() !== undefined ? { firstPrompt: store.firstPrompt() } : {}),
        });
      } catch {
        /* best-effort — never fail a turn on metadata write */
      }
      // Latency: setPhase("done") BEFORE the fs write so the TUI's
      // spinner disappears the instant the engine resolves, not the
      // instant the metadata file flushes. The fs write is best-effort
      // and doesn't gate user-visible state.
      store.setPhase("done");
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      store.appendError(msg);
      store.setPhase("done");
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (aborted) store.appendSystem("(aborted)");
    }
  }

  return { runPrompt, dispose, setActiveModel };
}
