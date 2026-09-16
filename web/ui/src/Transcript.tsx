import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  deriveSteps,
  isExplorationStep,
  summarizeItem,
  type AppStep,
  type AppThreadItem,
  type AppTurn,
} from "@reaper/web-shared";

import { CodeModeView } from "./CodeModeView.js";
import { describeToolArgs, formatToolOutput, type ToolArgRow } from "@reaper/web-shared";
import { ContextView } from "./ContextView.js";
import { Markdown } from "./Markdown.js";
import { highlight } from "./syntax.js";
import { ToolIcon, type IconName } from "./tool-icons.js";
import { getToolPresentation, isTestCommand, presentationFor, type ToolPresentation } from "./tool-presentation.js";
import { formatDuration, RawDetails, StatusGlyph, ToolIconTile, ToolOutput, ToolSection } from "./transcript-bits.js";

/**
 * `activeTurnId` is what distinguishes "thinking, right now" from "thought".
 *
 * Only the newest turn can be the one running, and only the last item in it can
 * be the one still arriving — but the simpler question, "is this turn the active
 * one", is enough to decide whether reasoning renders live, and it avoids a
 * prop drill that has to change every time a new item type is added.
 */
export function Transcript({ turns, activeTurnId }: { turns: AppTurn[]; activeTurnId?: string }) {
  return (
    <>
      {turns.map((turn, index) => (
        <TurnView
          turn={turn}
          live={turn.id === activeTurnId}
          /*
           * The byline is suppressed only for a turn that continues the agent's
           * previous work.
           *
           * "Continues" means the turn carries no user message of its own: the
           * model answering in several passes is one answer, and byte-identical
           * agent turns split by the runtime should not each announce "Reaper".
           *
           * This used to suppress whenever the *previous* turn had agent content
           * in it, which is true of almost every turn in a real conversation
           * because a turn holds both the user's message and the reply to it.
           * The result was that only the first reply in a thread was ever
           * attributed and every later one rendered as bare text with no author
           * at all, so a reader scrolling a continued thread could not tell the
           * agent's answers from anything else on the page.
           */
          continued={index > 0 && !opensWithUserMessage(turn) && isAgentTurn(turns[index - 1]!)}
          key={turn.id}
        />
      ))}
    </>
  );
}

/** A turn with anything in it the agent produced, as opposed to the user's own message. */
function isAgentTurn(turn: AppTurn): boolean {
  return turn.items.some((item) => item.type !== "userMessage");
}

/**
 * Whether this turn carries a prompt of its own.
 *
 * The question the byline rule actually asks. A turn that contains a user
 * message is a new exchange and needs the agent labelled; one that does not is
 * the agent still working on the previous exchange and should stay unlabelled.
 */
function opensWithUserMessage(turn: AppTurn): boolean {
  return turn.items.some((item) => item.type === "userMessage");
}

const TurnView = memo(function TurnView({ turn, live, continued }: { turn: AppTurn; live: boolean; continued?: boolean }) {
  const steps = useMemo(() => deriveSteps(turn), [turn]);
  /*
   * A turn made only of the user's own message gets no byline. The bubble is
   * right-aligned and already says who wrote it; a "You" label above it would
   * be the third signal for the same fact.
   *
   * No timestamp, which the reference has and this does not: `AppTurn` carries
   * no time, and the only honest options were to invent one at render (wrong
   * the moment a thread is reloaded) or to leave it out. Left out.
   */
  const byline = !continued && isAgentTurn(turn);
  return (
    <section className="turn" data-continued={continued || undefined}>
      {byline && (
        <div className="turn-byline">
          <span className="turn-avatar" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 5.5h9.2a5.3 5.3 0 0 1 0 10.6H8.8V20H4V5.5Zm4.8 4v2.9h4.1a1.45 1.45 0 1 0 0-2.9H8.8Z" fill="currentColor" /><path d="m14.5 15.2 5.5 4.3h-6.1l-3.6-3.4 4.2-.9Z" fill="currentColor" opacity=".65" /></svg>
          </span>
          <span className="turn-speaker">Reaper</span>
        </div>
      )}
      {steps.map((step, index) => <StepView step={step} live={live} key={`${turn.id}-step-${index}`} />)}
      {turn.error && <p className="tool-status transcript-error" data-status="failed" role="alert">✕ {turn.error.message}</p>}
    </section>
  );
});

/**
 * One step of a turn, as the reference draws it.
 *
 * A step is one model request plus the tools it called, and the reference wraps
 * that in a card: a header naming the activity with a count and a total
 * duration, a status badge, and the actions below on a rail. The card is what
 * makes a long turn legible — it turns "forty rows" into "six things the agent
 * did", which is the unit a reader reasons about.
 *
 * A step with nothing but reads collapses to its header, because exploring is
 * not the work; the card is the summary and the reader opens it when they want
 * the detail. Anything that changed state stays open.
 *
 * A step with no tool calls at all — prose and reasoning — is not a card. It is
 * the model thinking out loud, and boxing that would put a border around the
 * transcript's main content.
 */
const StepView = memo(function StepView({ step, live }: { step: AppStep; live: boolean }) {
  const toolItems = step.items.filter(isToolItem);
  const proseItems = step.items.filter((item) => !isToolItem(item));
  const label = stepLabel(step);
  const duration = stepDurationMs(step);
  const collapsible = isCollapsibleStep(step);
  // A step whose tools are all reads, and which has no prose of its own, is the
  // header alone until opened. Anything else shows its actions.
  if (toolItems.length === 0) {
    return <div className="step">{proseItems.map((item) => <ItemView item={item} live={live} key={item.id} />)}</div>;
  }
  return (
    <div className="step">
      {proseItems.map((item) => <ItemView item={item} live={live} key={item.id} />)}
      <StepCard
        step={step}
        label={label}
        durationMs={duration}
        collapsible={collapsible}
        live={live}
      />
    </div>
  );
});

/**
 * The tools a step ran, as a card.
 *
 * The rail is the reference's most distinctive element and the reason the card
 * exists: each action is marked with the same status glyph used elsewhere, on a
 * vertical connector, so the reader sees where in a sequence something failed
 * rather than only that something did.
 */
function StepCard({
  step,
  label,
  durationMs,
  collapsible,
  live,
}: {
  step: AppStep;
  label: string;
  durationMs: number | undefined;
  collapsible: boolean;
  live: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);
  /*
   * A step that becomes consequential while it is running has to open, because
   * the decision to collapse was made when it was only reads. Without this, a
   * step that started as three greps and then wrote a file stayed folded and the
   * edit was invisible until something else re-rendered the card.
   */
  const forcedOpen = !collapsible;
  useEffect(() => {
    if (forcedOpen) setOpen(true);
  }, [forcedOpen]);

  const tools = step.items.filter(isToolItem);
  const runningItem = live ? tools.find((item) => "status" in item && item.status === "inProgress") : undefined;
  const running = runningItem !== undefined;
  const failed = tools.some((item) => ("status" in item && item.status === "failed"));

  return (
    <div className="step-card" data-open={open || undefined} data-failed={failed || undefined}>
      <button className="step-card-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="chevron" data-open={open || undefined} aria-hidden="true">›</span>
        {/*
          The step's own icon is drawn bare, not in a filled tile. The
          reference is explicit about this: its cluster header is a purple
          magnifier on the header's own background, and the only filled tiles
          in the whole panel are the two actions that changed something. A
          filled tile here competes with those for the same meaning.
        */}
        <span className="step-card-icon" data-tone={failed ? "failed" : undefined} aria-hidden="true">
          <ToolIcon name={dominant(step).icon} size={17} />
        </span>
        <span className="step-card-title">{label}</span>
        <span className="step-card-count">
          {tools.length === 1 ? "1 action" : `${tools.length} actions`}
          {durationMs !== undefined ? ` · ${formatDuration(durationMs)}` : ""}
        </span>
        {running
          ? <span className="step-card-badge" data-tone="running"><span className="step-card-pulse" aria-hidden="true" />In progress…</span>
          : failed
            ? <span className="step-card-badge" data-tone="failed">Failed</span>
            : null}
      </button>
      {/*
        Tools only. The step's prose is rendered above the card by `StepView`,
        and rendering `step.items` here printed the model's paragraph a second
        time inside the box — the same sentence twice, three lines apart.
      */}
      {open && (
        <div className="step-card-body">
          {tools.map((item) => <ItemView item={item} live={live} key={item.id} />)}
        </div>
      )}
      {/*
        Folded, but something is still running: show that one row.

        "What is the agent doing right now" is the first question a reader has
        of a live transcript, and a folded card answers it with a badge that
        says "In progress…" and nothing else. A fifty-read step folds — that is
        the point of folding it — but the call currently in flight stays
        visible, so the fold costs the history and not the present.
      */}
      {!open && runningItem && (
        <div className="step-card-body" data-peek>
          <ItemView item={runningItem} live={live} key={runningItem.id} />
        </div>
      )}
    </div>
  );
}

/**
 * Past this many actions, a step folds no matter what is in it.
 *
 * Fifty reads in a row is not an unusual run, it is what a rename across a
 * codebase looks like, and rendering fifty rows produced a screen and a half of
 * near-identical lines with the one call that mattered at the bottom. The step
 * header says "51 actions" and opens on a click, which is the same information
 * in one line.
 */
const STEP_FOLD_ABOVE = 12;

/**
 * Whether a step opens folded.
 *
 * Length, and only length. The earlier rule folded any step made entirely of
 * reads, and screenshotting it against the reference showed that to be wrong:
 * a step of five searches is the activity cluster the reference draws *open*,
 * with a tick beside each row, because those five rows are how the reader
 * follows what the agent worked out. Folding them replaces the reasoning with
 * a number.
 *
 * What actually makes a step unreadable is fifty of them, and that is a
 * different problem with a different threshold. So the exploration predicate
 * stops deciding this — it still answers "did this step change anything" for
 * the shared store, which is what it was written for.
 */
function isCollapsibleStep(step: AppStep): boolean {
  return step.items.filter(isToolItem).length > STEP_FOLD_ABOVE;
}

/** Whether an item is a tool call rather than prose. */
function isToolItem(item: AppThreadItem): item is Extract<AppThreadItem, { type: "dynamicToolCall" | "commandExecution" | "fileChange" }> {
  return item.type === "commandExecution" || item.type === "fileChange" || item.type === "dynamicToolCall";
}

/**
 * What a step was doing, in a phrase.
 *
 * Taken from the tools it ran rather than from the model's prose: the prose is
 * already displayed above the card, and repeating it in the header would say
 * the same thing twice. The tool mix is what the header can add — "searching",
 * "reading", "editing" — and a mixed step is named for its most consequential
 * action, because that is the one a reader scanning needs to notice.
 */
function stepLabel(step: AppStep): string {
  /*
   * The model's own words first. The reference titles its card "Investigating
   * authentication", which is a description of intent that no amount of
   * inspecting tool names can produce: "Searching" is what the calls were,
   * and "investigating authentication" is what they were *for*.
   *
   * The model already writes that sentence — it says what it is about to do
   * before it does it — so the title is taken from the commentary in this same
   * step rather than asked for separately. No extra request, no new protocol
   * field, and it degrades to the tool-derived label when the model dived
   * straight into calling tools without narrating.
   */
  const stated = statedIntent(step);
  if (stated) return stated;
  return dominant(step).stepLabel;
}

/**
 * The presentation of the step's most consequential action.
 *
 * Not the most frequent one. A step that ran nine greps and then wrote a file is
 * an edit, because the edit is what the reader has to notice and the greps are
 * how it got there. `CATEGORY_RANK` is that judgement, in order.
 */
const CATEGORY_RANK: ToolPresentation["category"][] =
  ["edit", "command", "test", "eval", "agent", "browser", "search", "web", "list", "read", "config", "generic"];

function dominant(step: AppStep): ToolPresentation {
  const present = new Set(step.items.filter(isToolItem).map(itemPresentation).map((p) => p.category));
  for (const category of CATEGORY_RANK) {
    if (present.has(category)) return presentationFor(category);
  }
  return presentationFor("generic");
}

/** How any transcript item that represents an action should be drawn. */
function itemPresentation(item: Extract<AppThreadItem, { type: "dynamicToolCall" | "commandExecution" | "fileChange" }>): ToolPresentation {
  if (item.type === "fileChange") return presentationFor("edit");
  if (item.type === "commandExecution") return presentationFor(isTestCommand(item.command) ? "test" : "command");
  return getToolPresentation(item.tool);
}

/**
 * The step's title, in the model's own words, when it stated one.
 *
 * The first clause of the commentary that precedes the tools. Models open a
 * step with "I'm tracing where authentication state gets lost" or "Let me check
 * the session store", and the verb phrase in that opening is a better title
 * than anything derivable from the tool names, because it names the goal rather
 * than the mechanism.
 *
 * Conservative about what it accepts. A title is a glance, so anything that is
 * not a short opening clause is rejected and the tool-derived label is used
 * instead — a truncated paragraph in the header is worse than "Searching",
 * which is at least true and short.
 */
const INTENT_MAX_CHARS = 48;

function statedIntent(step: AppStep): string | undefined {
  const prose = step.items.find((item) => item.type === "agentMessage");
  if (!prose || prose.type !== "agentMessage") return undefined;
  const first = prose.text.trim().split("\n")[0]?.trim();
  if (!first) return undefined;
  // A heading, a list item, or a fence is structure rather than narration.
  if (/^[#\-*>`|]/.test(first)) return undefined;
  const sentence = first.split(/(?<=[.!?])\s/)[0]?.trim() ?? first;
  /*
   * Strip the first-person opening so the title reads as a label rather than as
   * a quote: "I'm tracing where auth state gets lost" becomes "Tracing where
   * auth state gets lost", which is the register the rest of the header is in.
   */
  const stripped = sentence.replace(/^(?:I(?:'m| am| will| 'll|'ll)?|Let me|Now|First|Next|Then)\s+/i, "");
  const clause = stripped.split(/,\s|\sand\s|\sso\s|\sbecause\s|\sto\s/)[0]?.trim().replace(/[.:;]+$/, "");
  if (!clause || clause.length > INTENT_MAX_CHARS || clause.split(/\s+/).length < 2) return undefined;
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

/**
 * The step's wall-clock span.
 *
 * The sum of its tools' durations rather than a first-to-last timestamp: the
 * items do not carry reliable timestamps for every kind, and the sum is the
 * number a reader wants anyway, which is how long the work took rather than how
 * long ago it started.
 */
function stepDurationMs(step: AppStep): number | undefined {
  let total: number | undefined;
  for (const item of step.items) {
    if (item.type === "dynamicToolCall" && typeof item.durationMs === "number") {
      total = (total ?? 0) + item.durationMs;
    } else if (item.type === "commandExecution" && typeof item.durationMs === "number") {
      total = (total ?? 0) + item.durationMs;
    }
  }
  return total;
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

/**
 * A shell command, as a card.
 *
 * Follows the reference layout: an icon tile and a title on the head row, the
 * command beside it, a duration on the right, and then the terminal itself —
 * the echoed command line followed by what it printed, in one block.
 *
 * One block rather than a "Command" section above an "Output" section, which is
 * what this was and which the reference is a direct argument against. A
 * terminal is a thing people have read for fifty years, the prompt line and the
 * output belong to each other, and splitting them into two collapsible boxes
 * with uppercase headers turned two lines of shell into five lines of chrome.
 * The echo also solves the case the "Command" section was written for: a
 * command too long for the head row is still readable in full, wrapped, at the
 * top of its own output.
 */
function CommandView({ item }: { item: Extract<AppThreadItem, { type: "commandExecution" }> }) {
  const failed = item.status === "failed" || (item.exitCode ?? 0) !== 0;
  const output = item.aggregatedOutput ?? "";
  const presentation = presentationFor(isTestCommand(item.command) ? "test" : "command");
  const test = presentation.category === "test";
  return (
    <ToolCard
      status={failed ? "failed" : item.status}
      icon={presentation.icon}
      weight={presentation.weight}
      title={test ? "Run tests" : "Run command"}
      detail={item.command}
      {...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {})}
      {...(failed && item.exitCode !== undefined ? { note: `exit ${item.exitCode}` } : {})}
    >
      <ToolOutput text={output} command={item.command} />
      <RawDetails
        tool="bash"
        args={{ command: item.command, ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}) }}
        callId={item.id}
        {...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {})}
      />
    </ToolCard>
  );
}

/**
 * The shared shape of every action: a rail mark, a head row, a body.
 *
 * One component rather than three copies because the head row is what makes a
 * mixed transcript scannable, and it only works if a command, an edit, and a
 * tool call are the *same* row with different content. Three near-identical
 * head rows drifted apart within a day of being written, and the drift is
 * visible precisely where it hurts: the column a reader's eye follows.
 *
 * Collapsed by default when the call succeeded. That is the reference's
 * behaviour and it is right for the same reason the step card is: a finished
 * read is a line, not a box, and a turn with fifteen of them should be fifteen
 * lines. Failures and running calls open themselves, because those are the two
 * states the reader is scanning for.
 */
function ToolCard({
  status,
  icon,
  weight = "light",
  title,
  detail,
  durationMs,
  note,
  trailing,
  children,
}: {
  status: string;
  icon: IconName;
  weight?: ToolPresentation["weight"];
  title: string;
  detail?: string | undefined;
  durationMs?: number | undefined;
  note?: string | undefined;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  const failed = status === "failed";
  const running = status === "inProgress";
  const rich = weight === "rich";
  /*
   * Which cards open themselves, and why the rule is the tool's weight rather
   * than its state.
   *
   * The reference answers this directly: its two edit and command cards are
   * drawn with the diff and the terminal output visible, and its five search
   * and read rows are drawn as single lines. That is not a fold state a user
   * chose, it is the difference between an action that changed something and an
   * action that looked at something. An edit whose diff is behind a click is an
   * edit the reader has to go and check; a read whose contents are inline is
   * four hundred lines in the way of the next thing.
   *
   * So: rich actions open, light ones fold, and a failure opens whatever it is,
   * because the reader has to see the error without hunting for it.
   *
   * Running is not in this rule. A call in flight is a one-line row with
   * "Running…" at the end, the same height as the finished rows above it —
   * expanding it pushed a 280px block into the middle of a cluster whose value
   * is uniform rows, to say "Waiting for the result…" which the row already
   * said.
   */
  const [open, setOpen] = useState(failed || (rich && !running));
  /*
   * A call that fails after it was collapsed has to open itself. The initial
   * state is captured at mount, when a call is usually still running or has
   * just succeeded, so without this a call that succeeded and was then marked
   * failed by a later event kept its collapsed row and the error was invisible.
   */
  useEffect(() => {
    if (failed) setOpen(true);
  }, [failed]);
  const hasBody = Boolean(children);
  return (
    <div className="tool-card" data-status={status} data-open={open || undefined} data-weight={weight}>
      <button
        className="tool-card-head"
        aria-expanded={open}
        disabled={!hasBody}
        onClick={() => setOpen((value) => !value)}
      >
        <RailMark status={status} />
        {/*
          A passing test run is green, everything else that changed something is
          accent. The reference draws exactly this and it is the one place where
          a tile's colour carries information rather than rank: "the tests are
          green" is the fact a reader scans a run for, and it is worth a colour
          nothing else uses.
        */}
        <ToolIconTile icon={icon} tone={failed ? "failed" : icon === "test" && status === "completed" ? "success" : rich ? "accent" : "plain"} />
        <span className="tool-card-title">{title}</span>
        {detail && <span className="tool-card-paths" title={detail}>{detail}</span>}
        {/*
          The +/- counts sit beside the path, not at the far edge.

          "Updated src/auth/session.ts +12 −3" is one phrase and the reference
          sets it as one; pushing the counts to the right margin put four
          columns of whitespace between a file and how much of it changed, and
          made them line up with the durations, which are a different kind of
          fact entirely.
        */}
        {trailing && <span className="tool-card-inline">{trailing}</span>}
        <span className="tool-card-meta">
          {/*
            The state in words, not only as a mark on the rail.

            The rail's glyph is the fast signal and carries `sr-only` text, but
            a row of twenty calls is scanned for two things — did any of these
            fail, is anything still running — and a red "✕" answers neither
            from across the column. A failure always says so; a success does
            not, because twenty rows each saying "Success" is the noise the
            rail was introduced to remove.
          */}
          {note && <span className="tool-card-note" data-tone={failed ? "failed" : undefined}>{note}</span>}
          {failed && !note && <span className="tool-card-note" data-tone="failed">Failed</span>}
          {running && <span className="tool-card-note" data-tone="running">Running…</span>}
          {durationMs !== undefined && <span className="tool-card-duration">{formatDuration(durationMs)}</span>}
        </span>
      </button>
      {open && hasBody && <div className="tool-card-body">{children}</div>}
    </div>
  );
}

/**
 * The rail: a status mark in a fixed column down the left of a step's actions.
 *
 * The reference's most distinctive element, and the one that does real work. A
 * pill at the end of each row answers "did this one fail" one row at a time;
 * a column of marks answers "did any of these fail, and where" in a single
 * glance at a step with twenty actions in it. The connector between marks is
 * what makes them read as one sequence rather than twenty separate rows.
 */
function RailMark({ status }: { status: string }) {
  return (
    <span className="tool-rail" data-status={status} aria-hidden="true">
      <StatusGlyph status={status} />
    </span>
  );
}

/**
 * File edits, as a card.
 *
 * The paths and the +/- counts are on the head row, where they answer "what
 * changed and by how much" without expanding anything; the diffs are the body,
 * because a diff is what a reader expands *for*. That split is what the old
 * single-disclosure version got wrong: everything was behind the same click, so
 * checking which files an edit touched and reading the diff cost the same
 * action.
 */
function FileChangeView({ item }: { item: Extract<AppThreadItem, { type: "fileChange" }> }) {
  const label = item.changes.length === 1 ? "Updated" : `Updated ${item.changes.length} files`;
  const withDiff = item.changes.filter((change) => change.diff);
  const single = item.changes.length === 1;
  return (
    <ToolCard
      status={item.status}
      icon="edit"
      weight="rich"
      title={label}
      detail={item.changes.map((change) => change.path).join(", ")}
      durationMs={item.durationMs}
      trailing={<DiffStat changes={item.changes} />}
    >
      {/*
        A diff when there is one, and nothing when there is not.

        The empty state used to say "No diff recorded for this file", which
        reads as a failure and is not one: the usual write produces no diff
        because the projection only records the path and the tool name. A card
        that announces missing content it never had is worse than a card with
        one line in it, so the head row's path is the whole story for an
        ordinary write and the body appears only when a diff was captured.

        A single file's diff goes in bare. The head row already names the path
        and carries the +/- counts, so wrapping it in a section headed with the
        same path and the same counts said everything twice and cost a click to
        reach the one thing the card is for. Several files keep their headers,
        because then the header is the only thing telling the reader which diff
        they are looking at.
      */}
      {single
        ? withDiff.map((change) => (
            <DiffView
              diff={change.diff!}
              key={change.path}
              {...(change.truncated ? { truncated: true } : {})}
              {...(change.additions !== undefined || change.removals !== undefined
                ? { totalLines: (change.additions ?? 0) + (change.removals ?? 0) }
                : {})}
            />
          ))
        : withDiff.map((change) => (
            <ToolSection key={change.path} title={change.path} mono={false} trailing={<DiffStat changes={[change]} />}>
              <DiffView
                diff={change.diff!}
                {...(change.truncated ? { truncated: true } : {})}
                {...(change.additions !== undefined || change.removals !== undefined
                  ? { totalLines: (change.additions ?? 0) + (change.removals ?? 0) }
                  : {})}
              />
            </ToolSection>
          ))}
    </ToolCard>
  );
}

/**
 * How many diff lines show before the rest is held back.
 *
 * A refactor that touches a thousand lines produces a diff nobody reads inline;
 * what they want from the transcript is confirmation that the right file
 * changed in roughly the right way, and the shape of the first hunk gives them
 * that. The full diff is one click further on, and the file viewer is where a
 * thousand-line review actually belongs.
 */
const DIFF_PREVIEW_LINES = 14;

export function DiffView({ diff, truncated, totalLines }: { diff: string; truncated?: boolean; totalLines?: number }) {
  const rows = useMemo(() => numberDiff(diff), [diff]);
  const [full, setFull] = useState(false);
  const long = rows.length > DIFF_PREVIEW_LINES;
  const shown = full || !long ? rows : rows.slice(0, DIFF_PREVIEW_LINES);
  return (
    <>
      <div className="diff" data-diff>
        {shown.map((row, index) => (
          <div className="diff-line" data-kind={row.kind} key={index}>
            {/*
              Two gutters, old and new, which is what the reference draws and
              what a one-column diff cannot do: on a removed line the old number
              is the only one that exists, and on an added line the new one is.
              Showing a single running count makes both of those a lie.
            */}
            <span className="diff-num" aria-hidden="true">{row.old ?? ""}</span>
            <span className="diff-num" aria-hidden="true">{row.next ?? ""}</span>
            <span className="diff-sign" aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "del" ? "-" : ""}</span>
            <span className="diff-text">{row.text ? highlight(row.text) : " "}</span>
          </div>
        ))}
      </div>
      {/*
        The expand button says what it will actually show.

        "View the full diff" is only true when the whole thing is here. A very
        large change is capped on the server and arrives as a preview, so
        offering to show "the full diff" on one of those would promise rows the
        client does not have. When that has happened the button says so instead,
        and the count it prints is the count it holds.
      */}
      {long && (
        <button className="tool-more" onClick={() => setFull((value) => !value)} aria-expanded={full}>
          {full ? "Show less" : `View all ${rows.length.toLocaleString()} lines here`}
        </button>
      )}
      {truncated && (
        <p className="diff-truncated">
          {totalLines !== undefined
            ? `Preview only. ${totalLines.toLocaleString()} lines changed in this file; open it in the workspace to read the rest.`
            : "Preview only. This change was too large to send in full; open the file in the workspace to read the rest."}
        </p>
      )}
    </>
  );
}

interface DiffRow {
  kind: "add" | "del" | "meta" | "ctx";
  /** Line number in the file before the change, where the line existed. */
  old?: number;
  /** Line number after the change, where the line exists. */
  next?: number;
  text: string;
}

/**
 * A unified diff, with each line's number on both sides.
 *
 * The counters come from the hunk header — `@@ -100,7 +100,8 @@` says this hunk
 * starts at line 100 in both files — and then advance the way the format
 * defines: a context line advances both, a removal advances only the old side,
 * an addition only the new. That is the whole algorithm, and it is worth doing
 * rather than approximating with a running index, because the numbers are the
 * one part of a diff a reader takes to the editor with them.
 *
 * A diff with no hunk header gets no numbers at all. The alternative is to start
 * counting at 1 and be confidently wrong about every line.
 */
function numberDiff(diff: string): DiffRow[] {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  return diff.split("\n").flatMap((line): DiffRow[] => {
    const row = numberLine(line);
    return row ? [row] : [];
  });

  function numberLine(line: string): DiffRow | undefined {
    /*
     * A hunk header, with or without numbers.
     *
     * `@@ -100,7 +100,8 @@` names where the following lines live. A bare `@@`
     * marks the same boundary but says nothing about position, which is what a
     * diff from `edit_file` or an unanchored `file_edit` produces: those calls
     * carry the before and after text and no line number, so the server emits
     * no position rather than a guessed one. Both forms are absorbed here and
     * dropped, because a header is the format talking to a parser. The bare
     * form additionally clears the counters, so the rows under it render
     * without a gutter instead of continuing the previous hunk's numbering.
     */
    const hunk = /^@@(?: -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@)?/.exec(line);
    if (hunk) {
      oldLine = hunk[1] === undefined ? undefined : Number(hunk[1]);
      newLine = hunk[2] === undefined ? undefined : Number(hunk[2]);
      /*
       * The hunk header sets the counters and is then dropped.
       *
       * `@@ -100,7 +100,8 @@` is the diff format talking to a diff parser: it
       * says where the following lines live, and once the gutters say that on
       * every row it has nothing left to tell a reader. The reference draws no
       * such line, and rendering it put a row of punctuation at the top of
       * every edit card.
       */
      return undefined;
    }
    const kind = diffKind(line);
    if (kind === "meta") return { kind, text: line };
    const text = kind === "ctx" ? line.replace(/^ /, "") : line.slice(1);
    if (kind === "add") {
      const row: DiffRow = newLine === undefined ? { kind, text } : { kind, next: newLine, text };
      if (newLine !== undefined) newLine += 1;
      return row;
    }
    if (kind === "del") {
      const row: DiffRow = oldLine === undefined ? { kind, text } : { kind, old: oldLine, text };
      if (oldLine !== undefined) oldLine += 1;
      return row;
    }
    const row: DiffRow = {
      kind,
      ...(oldLine !== undefined ? { old: oldLine } : {}),
      ...(newLine !== undefined ? { next: newLine } : {}),
      text,
    };
    if (oldLine !== undefined) oldLine += 1;
    if (newLine !== undefined) newLine += 1;
    return row;
  }
}

/**
 * The +/- counts on an edit's head row.
 *
 * Counted here only when the server did not send them. It usually does now, and
 * its numbers win because they are the only ones that survive truncation: a long
 * change is previewed rather than sent whole, so a truncated diff is missing
 * added lines and counting it reports a smaller change than the one that
 * happened. The local count remains as the fallback for a transcript projected
 * before the counts existed, and for any client that has not been reloaded.
 */
function DiffStat({ changes }: { changes: Array<{ diff?: string; additions?: number; removals?: number }> }) {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    if (change.additions !== undefined || change.removals !== undefined) {
      added += change.additions ?? 0;
      removed += change.removals ?? 0;
      continue;
    }
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
/**
 * Any other tool, as a card.
 *
 * The head row is the same shape as the command and edit cards, so a transcript
 * of mixed calls scans down one column of tiles and pills rather than changing
 * shape with the tool. Below it: the arguments as label/value rows, and the
 * output.
 *
 * Showing the arguments is the point of this card rather than a nicety. A call's
 * output is often surprising, and the argument is what explains it — a grep that
 * returned nothing is explained by its pattern, a write in the wrong place by
 * its path. The previous version showed a one-line paraphrase, so the reader had
 * to reconstruct the request from the response.
 *
 * Output opens by default when the call failed or is still running, and is
 * collapsed behind its section header when it succeeded. A failure the reader
 * has to click to see is a failure that gets missed, and a successful call's
 * output is usually noise they scroll past to reach the next thing.
 */
function ToolCallView({ item }: { item: Extract<AppThreadItem, { type: "dynamicToolCall" }> }) {
  if (item.tool === "eval") return <CodeModeView item={item} />;
  const summary = summarizeItem(item);
  const argRows = describeToolArgs(item.arguments);
  const output = item.error ? item.error : formatToolOutput(item.result);
  const running = item.status === "inProgress";
  const presentation = getToolPresentation(item.tool);
  return (
    <ToolCard
      status={running ? "inProgress" : item.status}
      icon={presentation.icon}
      weight={presentation.weight}
      title={summary.label}
      detail={summary.detail}
      {...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {})}
      {...(resultNote(item.tool, output) !== undefined ? { note: resultNote(item.tool, output) } : {})}
    >
      {/*
        Arguments open by default, and that is the difference between a card
        that explains a call and one that only reports it. They are also the
        short half: a call's arguments are a few lines and its output can be
        thousands, so hiding the small half while showing the large one had the
        cost backwards.
      */}
      {argRows.length > 0 && (
        <ToolSection title="Arguments" defaultOpen>
          <ArgList rows={argRows} />
        </ToolSection>
      )}
      {/*
        Output open by default, height-capped, matching the reference: a reader
        looking at a tool card has usually come for the output, and making them
        click for it is a tax on the common case. The cap (22rem, scrollable) is
        what makes always-open safe: a 10,000-line build log is a scrollable box
        in the card rather than a wall that buries the rest of the transcript.
      */}
      {output && (
        <ToolSection title="Output" defaultOpen hint={item.error ? "the call failed" : undefined}>
          <ToolOutput text={output} />
        </ToolSection>
      )}
      {running && !output && (
        <ToolSection title="Output" defaultOpen>
          <div className="tool-running">Waiting for the result…</div>
        </ToolSection>
      )}
      <RawDetails
        tool={item.tool}
        {...(item.arguments !== undefined ? { args: item.arguments } : {})}
        callId={item.id}
        {...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {})}
      />
    </ToolCard>
  );
}

/**
 * What the call found, in three words, for the collapsed row.
 *
 * The reference puts "8 matches" beside a search and it is the single most
 * useful thing on a folded row: it is the difference between "this search ran"
 * and "this search is why the next step went the way it did". Only for tools
 * where a count is meaningful — a note that says "412 lines" beside a file read
 * is filler, and a row of filler is worse than a row without it.
 */
function resultNote(tool: string, output: string): string | undefined {
  if (!output) return undefined;
  if (!getToolPresentation(tool).countsResults) return undefined;
  const lines = output.split("\n").filter((line) => line.trim()).length;
  if (lines === 0) return "no matches";
  return lines === 1 ? "1 match" : `${lines} matches`;
}

/**
 * A call's arguments, as rows.
 *
 * The key column is fixed-width so the values line up down the card, which is
 * what makes a three-argument call readable at a glance rather than a paragraph
 * of key: value pairs.
 */
function ArgList({ rows }: { rows: ToolArgRow[] }) {
  return (
    <dl className="tool-args">
      {rows.map((row) => (
        <div className="tool-arg" key={row.key}>
          <dt className="tool-arg-key">{row.key}</dt>
          <dd className="tool-arg-value">
            {row.value !== undefined && <span className="tool-arg-scalar">{row.value}</span>}
            {row.block !== undefined && <pre className="tool-arg-block">{row.block}</pre>}
            {row.structured !== undefined && <pre className="tool-arg-block">{row.structured}</pre>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function diffKind(line: string): "add" | "del" | "meta" | "ctx" {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}
