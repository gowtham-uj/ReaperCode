/**
 * The transcript: an indented step tree.
 *
 * A step is one model request plus the tools it called (derived client-side by
 * `deriveSteps` — the protocol has no step concept). Tool calls indent beneath
 * the model message that caused them, so a 40-tool-call turn reads as a
 * sequence of decisions rather than an undifferentiated wall.
 *
 * Rendering rules, in priority order:
 *  - Edits, commands, and failures are always visible. They changed something.
 *  - Pure-exploration steps collapse to one line. They did not.
 *  - Reasoning collapses by default but is never hidden outright.
 *
 * `<For>` keys by item identity, so appending an item does not rebuild the
 * preceding rows, and a text delta updates one text node.
 */

import { createMemo, createSignal, For, Show, type JSX } from "solid-js";

import {
  deriveSteps,
  isExplorationStep,
  summarizeExplorationStep,
  summarizeItem,
  type AppStep,
  type AppThreadItem,
  type AppTurn,
} from "@reaper/web-shared";

export function Transcript(props: { turns: AppTurn[] }): JSX.Element {
  return (
    <For each={props.turns}>
      {(turn) => <TurnView turn={turn} />}
    </For>
  );
}

function TurnView(props: { turn: AppTurn }): JSX.Element {
  const steps = createMemo(() => deriveSteps(props.turn));
  return (
    <section class="turn">
      <For each={steps()}>{(step) => <StepView step={step} />}</For>
      <Show when={props.turn.error}>
        {(error) => (
          <p class="tool-status" data-status="failed" role="alert">
            ✕ {error().message}
          </p>
        )}
      </Show>
    </section>
  );
}

function StepView(props: { step: AppStep }): JSX.Element {
  return (
    <Show
      when={!isExplorationStep(props.step)}
      fallback={<CollapsedExploration step={props.step} />}
    >
      <div class="step">
        <For each={props.step.items}>{(item) => <ItemView item={item} />}</For>
      </div>
    </Show>
  );
}

/**
 * A step that only looked at things. Collapsed to a single line, expandable —
 * the information is never destroyed, just de-prioritized.
 */
function CollapsedExploration(props: { step: AppStep }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const label = (): string => summarizeExplorationStep(props.step.items.length);

  return (
    <div class="step">
      <button
        class="disclosure"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <span class="chevron" data-open={open()} aria-hidden="true">▶</span>
        <span>{label()}</span>
      </button>
      <Show when={open()}>
        <div class="step-tools">
          <For each={props.step.items}>{(item) => <ItemView item={item} />}</For>
        </div>
      </Show>
    </div>
  );
}

function ItemView(props: { item: AppThreadItem }): JSX.Element {
  return (
    <Show when={props.item} keyed>
      {(item) => {
        switch (item.type) {
          case "userMessage":
            return <div class="user-message">{item.content.map((part) => part.text).join("")}</div>;
          case "agentMessage":
            return <div class="agent-message">{item.text}</div>;
          case "reasoning":
            return <Reasoning text={item.content.join("")} />;
          case "commandExecution":
            return <CommandView item={item} />;
          case "fileChange":
            return <FileChangeView item={item} />;
          case "dynamicToolCall":
            return <ToolCallView item={item} />;
          case "contextCompaction":
            return <div class="tool-row"><span class="tool-label">Compacted context</span></div>;
        }
      }}
    </Show>
  );
}

function Reasoning(props: { text: string }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="reasoning">
      <button class="disclosure" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <span class="chevron" data-open={open()} aria-hidden="true">▶</span>
        <span>Thinking</span>
      </button>
      <Show when={open()}>
        <div class="reasoning-body">{props.text}</div>
      </Show>
    </div>
  );
}

function CommandView(props: { item: Extract<AppThreadItem, { type: "commandExecution" }> }): JSX.Element {
  // Failures start expanded. A non-zero exit is the single most likely thing
  // the user needs to read, and making them click for it is hostile.
  const [open, setOpen] = createSignal(false);
  const failed = (): boolean => props.item.status === "failed" || (props.item.exitCode ?? 0) !== 0;
  const output = (): string => props.item.aggregatedOutput ?? "";
  const show = (): boolean => open() || failed();

  return (
    <div>
      <div class="tool-row">
        <span class="tool-label">Ran</span>
        <span class="tool-detail" title={props.item.command}>{props.item.command}</span>
        <span class="tool-meta">
          <Show when={props.item.durationMs !== undefined}>
            {formatDuration(props.item.durationMs!)}{" "}
          </Show>
          <StatusGlyph status={props.item.status} exitCode={props.item.exitCode} />
        </span>
      </div>
      <Show when={output()}>
        <Show
          when={show()}
          fallback={
            <button class="disclosure" onClick={() => setOpen(true)} aria-expanded={false}>
              <span class="chevron" aria-hidden="true">▶</span>
              <span>Show output</span>
            </button>
          }
        >
          <pre class="output">{output()}</pre>
        </Show>
      </Show>
    </div>
  );
}

function FileChangeView(props: { item: Extract<AppThreadItem, { type: "fileChange" }> }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  return (
    <div>
      <button class="disclosure" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <span class="chevron" data-open={open()} aria-hidden="true">▶</span>
        <span class="tool-label">
          {props.item.changes.length === 1 ? "Edited" : `Edited ${props.item.changes.length} files`}
        </span>
        <span class="tool-detail">{props.item.changes.map((change) => change.path).join(", ")}</span>
        <span class="tool-meta"><DiffStat changes={props.item.changes} /></span>
      </button>
      <Show when={open()}>
        <For each={props.item.changes}>
          {(change) => (
            <Show when={change.diff} fallback={<div class="tool-row"><span class="tool-detail">{change.path}</span></div>}>
              <DiffView diff={change.diff!} />
            </Show>
          )}
        </For>
      </Show>
    </div>
  );
}

/**
 * Renders a unified diff. This is the clearest case for why the web UI is not
 * a terminal reskin: the protocol has carried structured `changes[]` with real
 * diff text all along, and a one-line summary throws that away.
 */
function DiffView(props: { diff: string }): JSX.Element {
  const lines = createMemo(() => props.diff.split("\n"));
  return (
    <div class="diff">
      <For each={lines()}>
        {(line) => <div class="diff-line" data-kind={diffKind(line)}>{line || " "}</div>}
      </For>
    </div>
  );
}

function diffKind(line: string): "add" | "del" | "meta" | "ctx" {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

function DiffStat(props: { changes: Array<{ diff?: string }> }): JSX.Element {
  const stat = createMemo(() => {
    let added = 0;
    let removed = 0;
    for (const change of props.changes) {
      for (const line of (change.diff ?? "").split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) added++;
        else if (line.startsWith("-") && !line.startsWith("---")) removed++;
      }
    }
    return { added, removed };
  });

  return (
    <Show when={stat().added || stat().removed}>
      <span class="stat-add">+{stat().added}</span>{" "}
      <span class="stat-del">−{stat().removed}</span>
    </Show>
  );
}

function ToolCallView(props: { item: Extract<AppThreadItem, { type: "dynamicToolCall" }> }): JSX.Element {
  const summary = createMemo(() => summarizeItem(props.item));
  return (
    <div class="tool-row">
      <span class="tool-label">{summary().label}</span>
      <span class="tool-detail" title={summary().detail}>{summary().detail}</span>
      <span class="tool-meta"><StatusGlyph status={props.item.status} /></span>
    </div>
  );
}

/** Status pairs a glyph with a hue so it never depends on color alone. */
function StatusGlyph(props: { status: string; exitCode?: number | undefined }): JSX.Element {
  const failed = (): boolean => props.status === "failed" || (props.exitCode !== undefined && props.exitCode !== 0);
  return (
    <span class="tool-status" data-status={failed() ? "failed" : props.status}>
      <Show when={failed()} fallback={
        <Show when={props.status === "completed"} fallback={<>⋯<span class="sr-only">running</span></>}>
          ✓<span class="sr-only">succeeded</span>
        </Show>
      }>
        ✕<span class="sr-only">failed{props.exitCode !== undefined ? ` with exit code ${props.exitCode}` : ""}</span>
      </Show>
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
