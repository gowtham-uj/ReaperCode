import { memo, useMemo, useState } from "react";
import {
  deriveSteps,
  isExplorationStep,
  summarizeExplorationStep,
  summarizeItem,
  type AppStep,
  type AppThreadItem,
  type AppTurn,
} from "@reaper/web-shared";

import { CodeModeView } from "./CodeModeView.js";
import { ContextView } from "./ContextView.js";
import { Markdown } from "./Markdown.js";
import { formatDuration, StatusGlyph } from "./transcript-bits.js";

/**
 * `activeTurnId` is what distinguishes "thinking, right now" from "thought".
 *
 * Only the newest turn can be the one running, and only the last item in it can
 * be the one still arriving — but the simpler question, "is this turn the active
 * one", is enough to decide whether reasoning renders live, and it avoids a
 * prop drill that has to change every time a new item type is added.
 */
export function Transcript({ turns, activeTurnId }: { turns: AppTurn[]; activeTurnId?: string }) {
  return <>{turns.map((turn) => <TurnView turn={turn} live={turn.id === activeTurnId} key={turn.id} />)}</>;
}

const TurnView = memo(function TurnView({ turn, live }: { turn: AppTurn; live: boolean }) {
  const steps = useMemo(() => deriveSteps(turn), [turn]);
  return (
    <section className="turn">
      {steps.map((step, index) => <StepView step={step} live={live} key={`${turn.id}-step-${index}`} />)}
      {turn.error && <p className="tool-status transcript-error" data-status="failed" role="alert">✕ {turn.error.message}</p>}
    </section>
  );
});

const StepView = memo(function StepView({ step, live }: { step: AppStep; live: boolean }) {
  return isExplorationStep(step)
    ? <CollapsedExploration step={step} />
    : <div className="step">{step.items.map((item) => <ItemView item={item} live={live} key={item.id} />)}</div>;
});

function CollapsedExploration({ step }: { step: AppStep }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="step exploration-step">
      <button className="disclosure" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="chevron" data-open={open || undefined} aria-hidden="true">›</span>
        <span>{summarizeExplorationStep(step.items.length)}</span>
      </button>
      {/*
        `live={false}` — a collapsed exploration step is finished by definition.
        It is what the step *was*, summarised, and reasoning inside it has
        already been superseded by whatever came after.
      */}
      {open && <div className="step-tools">{step.items.map((item) => <ItemView item={item} live={false} key={item.id} />)}</div>}
    </div>
  );
}

const ItemView = memo(function ItemView({ item, live }: { item: AppThreadItem; live: boolean }) {
  switch (item.type) {
    case "userMessage": return <div className="user-message">{item.content.map((part) => part.text).join("")}</div>;
    /*
     * Rendered as markdown, not as text.
     *
     * The model writes headings, bullets, bold and fenced code — that is what
     * an answer looks like — and this printed the markup verbatim, so a
     * `## Summary` arrived on screen as the characters `## Summary`. The
     * component renders React elements rather than HTML, so model output is
     * never handed to the DOM as markup; see the note at the top of
     * `Markdown.tsx` for why that is the safer of the two obvious designs.
     */
    case "agentMessage": return <div className="agent-message"><Markdown text={item.text} /></div>;
    case "reasoning": return <Reasoning text={item.content.join("")} live={live} />;
    case "commandExecution": return <CommandView item={item} />;
    case "fileChange": return <FileChangeView item={item} />;
    case "dynamicToolCall": return <ToolCallView item={item} />;
    case "contextManagement": return <ContextView item={item} />;
  }
});

function Reasoning({ text, live }: { text: string; live: boolean }) {
  /*
   * While the turn is running, thinking is shown rather than hidden.
   *
   * It used to render only inside a collapsed disclosure, which meant a turn
   * that spent forty-five seconds thinking — measured, and normal for a
   * reasoning model on a slow provider — displayed "Reaper is working…" and
   * nothing else. A person cannot tell that apart from a request that hung, and
   * the thinking text was arriving the whole time.
   *
   * Once the turn ends it collapses to a summary line, because a finished
   * transcript where every answer is preceded by several paragraphs of
   * thinking is harder to read than the answer was hard to wait for. So: visible
   * while it matters, out of the way when it does not.
   */
  const [open, setOpen] = useState(false);
  if (live) {
    return (
      <div className="reasoning" data-live>
        {/*
          A label, not just styling.
          
          Dimmed italic marks this as a different register, and a reader who
          arrives mid-stream has no reason to trust a visual convention they
          have not learned yet — thinking and answer are both prose from the
          model. One word removes the ambiguity.
        */}
        <div className="reasoning-head"><span className="reasoning-dot" aria-hidden="true" />Thinking…</div>
        <div className="reasoning-live" aria-live="polite" aria-label="Thinking">
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="reasoning">
      <button className="disclosure" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="chevron" data-open={open || undefined} aria-hidden="true">›</span><span>Thinking</span>
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  );
}

function CommandView({ item }: { item: Extract<AppThreadItem, { type: "commandExecution" }> }) {
  const [open, setOpen] = useState(false);
  const failed = item.status === "failed" || (item.exitCode ?? 0) !== 0;
  const output = item.aggregatedOutput ?? "";
  return (
    <div className="tool-block">
      <div className="tool-row">
        <span className="tool-icon" aria-hidden="true">›_</span>
        <span className="tool-label">Ran</span>
        <span className="tool-detail" title={item.command}>{item.command}</span>
        <span className="tool-meta">{item.durationMs !== undefined ? `${formatDuration(item.durationMs)} ` : ""}<StatusGlyph status={item.status} {...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {})} /></span>
      </div>
      {output && (open || failed ? <pre className="output" data-terminal>{output}</pre> : (
        <button className="disclosure sub-disclosure" onClick={() => setOpen(true)} aria-expanded={false}>
          <span className="chevron" aria-hidden="true">›</span><span>Show output</span>
        </button>
      ))}
    </div>
  );
}

function FileChangeView({ item }: { item: Extract<AppThreadItem, { type: "fileChange" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-block">
      <button className="disclosure tool-disclosure" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="chevron" data-open={open || undefined} aria-hidden="true">›</span>
        <span className="tool-label">{item.changes.length === 1 ? "Edited" : `Edited ${item.changes.length} files`}</span>
        <span className="tool-detail">{item.changes.map((change) => change.path).join(", ")}</span>
        <span className="tool-meta"><DiffStat changes={item.changes} /></span>
      </button>
      {open && item.changes.map((change) => change.diff
        ? <DiffView diff={change.diff} key={change.path} />
        : <div className="tool-row" key={change.path}><span className="tool-detail">{change.path}</span></div>)}
    </div>
  );
}

export function DiffView({ diff }: { diff: string }) {
  return <div className="diff" data-diff>{diff.split("\n").map((line, index) => <div className="diff-line" data-kind={diffKind(line)} key={index}>{line || " "}</div>)}</div>;
}

function DiffStat({ changes }: { changes: Array<{ diff?: string }> }) {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    for (const line of (change.diff ?? "").split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
    }
  }
  return added || removed ? <><span className="stat-add">+{added}</span> <span className="stat-del">−{removed}</span></> : null;
}

/**
 * A tool call, in the shape its own work deserves.
 *
 * `eval` is the only tool that gets a view of its own, and the reason is that
 * it is the only one that runs *other tool calls inside it*. A single row can
 * report that a script ran; it cannot report what the script did, and with Code
 * Mode that is the entire interesting part — the program the model wrote, the
 * calls it made, and the one value it kept.
 */
function ToolCallView({ item }: { item: Extract<AppThreadItem, { type: "dynamicToolCall" }> }) {
  if (item.tool === "eval") return <CodeModeView item={item} />;
  const summary = summarizeItem(item);
  return (
    <div className="tool-row">
      <span className="tool-icon" aria-hidden="true">⌁</span>
      <span className="tool-label">{summary.label}</span>
      <span className="tool-detail" title={summary.detail}>{summary.detail}</span>
      <span className="tool-meta"><StatusGlyph status={item.status} /></span>
    </div>
  );
}

function diffKind(line: string): "add" | "del" | "meta" | "ctx" {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}
