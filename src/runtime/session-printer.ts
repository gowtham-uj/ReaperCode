/**
 * session-printer — surface the model's internal reasoning text and the
 * agent's tool-use activity to the user during a Reaper session, the same
 * way interactive coding sessions show the agent thinking and acting
 * while it works.
 *
 * Default behavior is silent so tests and structured harnesses are not
 * polluted. Enable with either:
 *   - REAPER_PRINT_REASONING=1 in the environment, or
 *   - pass an explicit onReasoning callback to RuntimeEngine / callMainAgent.
 */

import { WriteStream } from "node:tty";

// Shared with the browser so one call has one name on every surface.
import { contextTechniqueLabel, summarizeContextRun, toolLabel } from "../../web/shared/src/summarize.js";
import { getEngineTunables } from "../config/config-tunables.js";
import { streamEventsEnabled } from "../logging/stream-events.js";
import type { ContextEventPayload } from "./context-engineering-wiring.js";


export interface SessionPrinterOptions {
  /** Stream to write reasoning to. Defaults to process.stdout. */
  out?: NodeJS.WriteStream;
  /** Optional transform before printing (e.g. indentation, color). */
  format?: (text: string) => string;
}

export interface ToolCallPrintOptions {
  out?: NodeJS.WriteStream;
}

let globalReasoningEnabled = false;
let globalOut: NodeJS.WriteStream = process.stdout;

/** Resolve the stream for human text: stderr when stream-events owns stdout. */
function humanOut(): NodeJS.WriteStream {
  return streamEventsEnabled() ? process.stderr : globalOut;
}
export function enableSessionPrinter(enabled: boolean, out?: NodeJS.WriteStream): void {
  globalReasoningEnabled = enabled;
  if (out) globalOut = out;
}

export function isSessionPrinterEnabled(): boolean {
  if (globalReasoningEnabled) return true;
  return getEngineTunables().printReasoning === true;
}

function defaultFormat(text: string): string {
  // Dim, indented text so it visually reads as the model's thought process.
  const lines = text.split("\n");
  return lines.map((line) => `  │ ${line}`).join("\n");
}

function supportsColor(out: NodeJS.WriteStream): boolean {
  if (out instanceof WriteStream) {
    const tty = out as unknown as { isTTY?: boolean; getColorDepth?: () => number };
    if (!tty.isTTY) return false;
    const depth = tty.getColorDepth?.();
    return depth !== undefined && depth > 1;
  }
  return false;
}

export function dim(text: string, out: NodeJS.WriteStream = globalOut): string {
  return supportsColor(out) ? `\x1b[2m${text}\x1b[0m` : text;
}

function sectionHeader(kind: "reasoning" | "content", charCount: number): string {
  const label = kind === "reasoning" ? "thinking" : "model output";
  const suffix = charCount > 4000 ? ` (showing first 4000 of ${charCount})` : "";
  const header = `  ■ ${label}${suffix}`;
  return dim(header);
}

export function printTurnHeader(turn: number, opts?: ToolCallPrintOptions): void {
  if (!isSessionPrinterEnabled()) return;
  const out = opts?.out ?? humanOut();
  out.write(`\n${dim(`● Turn ${turn}`, out)}\n`);
}

/**
 * Report one context-management technique in the terminal.
 *
 * The terminal had nothing at all for this, so a CLI session that compacted
 * four times looked exactly like one that never did — and the user had no way
 * to tell a session that was managing its context from one that was about to
 * fall over. Same label vocabulary as the web row
 * (`contextTechniqueLabel` / `summarizeContextRun` in
 * `web/shared/src/summarize.ts`), so both surfaces describe one event with one
 * set of words.
 *
 * Silent for `started` on the cheap passes, which the runtime does not emit
 * anyway: a line per technique per turn would turn a busy session's output into
 * a compaction log.
 */
export function printContextEvent(
  event: ContextEventPayload,
  opts?: { out?: NodeJS.WriteStream },
): void {
  if (!isSessionPrinterEnabled()) return;
  // Only the model-call techniques can stall, so only they get a "started"
  // line — that is the one case where a reader benefits from knowing it began
  // before it finishes.
  if (event.phase === "started" && event.technique !== "full_summary" && event.technique !== "handoff_summary") {
    return;
  }
  const out = opts?.out ?? humanOut();
  const label = contextTechniqueLabel(event.technique);
  if (event.phase === "started") {
    out.write(`  ${dim("◆", out)} ${label}…\n`);
    return;
  }
  if (event.phase === "failed") {
    const why = event.reason ? ` ${dim("—", out)} ${event.reason}` : "";
    out.write(`  ${dim("◆", out)} ${label} ${dim("✕", out)}${why}\n`);
    return;
  }
  const detail = summarizeContextRun({
    ...(event.savedChars !== undefined ? { savedChars: event.savedChars } : {}),
    ...(event.savedTokens !== undefined ? { savedTokens: event.savedTokens } : {}),
    ...(event.messagesBefore !== undefined ? { messagesBefore: event.messagesBefore } : {}),
    ...(event.messagesAfter !== undefined ? { messagesAfter: event.messagesAfter } : {}),
    ...(event.detail !== undefined ? { detail: event.detail } : {}),
  });
  out.write(`  ${dim("◆", out)} ${label}${detail ? ` ${dim("—", out)} ${detail}` : ""}\n`);
}

export function printToolCalls(toolCalls: Array<{ name: string; args?: Record<string, unknown> }>, opts?: ToolCallPrintOptions): void {
  if (!isSessionPrinterEnabled() || toolCalls.length === 0) return;
  const out = opts?.out ?? humanOut();
  for (const call of toolCalls) {
    const summary = summarizeToolCall(call.name, call.args ?? {});
    /*
     * The tool's own name, beautified — `Write file`, not `write_file`.
     *
     * Underscores are a fact about how tools are keyed and nothing a reader
     * should have to decode. The browser renders the same label from the same
     * package (`toolLabel` in `web/shared/src/summarize.ts`), so a person
     * watching the terminal and a person watching the browser see one
     * vocabulary rather than two for the same call.
     */
    out.write(`  ${dim("→", out)} ${toolLabel(call.name)}${summary ? ` ${dim("—", out)} ${summary}` : ""}\n`);
    /*
     * Code Mode gets a second line, because a one-line summary of a program is
     * not a summary of anything. What the model actually wrote is the whole
     * point of the feature, and a terminal is where someone reads it.
     */
    if (call.name === "eval") printEvalSource(call.args ?? {}, out);
  }
}

/**
 * The model's script, under its call line.
 *
 * Bounded on two axes: at most 24 lines and 160 columns each. Both exist for
 * the same reason — a script is untrusted output and can be arbitrarily large,
 * and a terminal that scrolls a thousand lines of minified JavaScript has
 * buried the turn it was meant to narrate. The elision is stated rather than
 * silent, because a truncated program that claims to be complete is worse than
 * no program at all.
 */
function printEvalSource(args: Record<string, unknown>, out: NodeJS.WriteStream): void {
  const code = typeof args.code === "string" ? args.code.replace(/\n+$/, "") : "";
  if (!code) return;
  const all = code.split("\n");
  const shown = all.slice(0, MAX_PRINTED_SOURCE_LINES);
  for (const line of shown) {
    const clipped = line.length > MAX_PRINTED_SOURCE_COLUMNS ? `${line.slice(0, MAX_PRINTED_SOURCE_COLUMNS - 1)}…` : line;
    out.write(`      ${dim(clipped, out)}\n`);
  }
  if (all.length > shown.length) {
    out.write(`      ${dim(`… ${all.length - shown.length} more lines`, out)}\n`);
  }
}

const MAX_PRINTED_SOURCE_LINES = 24;
const MAX_PRINTED_SOURCE_COLUMNS = 160;

function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  if (name === "write_file") return String(args.path ?? "");
  if (name === "file_edit") return String(args.path ?? "");
  if (name === "bash") {
    const cmd = String(args.command ?? args.cmd ?? "");
    const short = cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
    return short;
  }
  if (name === "file_view") return String(args.path ?? "");
  if (name === "list_directory") return String(args.path ?? "");
  if (name === "grep_search") {
    const pattern = String(args.pattern ?? "");
    return `${pattern}${args.path ? ` in ${args.path}` : ""}`;
  }
  if (name === "update_plan" || name === "update_todo") return "";
  /*
   * Code Mode. The source is printed on its own lines below the call, so the
   * summary stays a summary: what the program is *for*, in one line, the same
   * way every other tool answers it.
   */
  if (name === "eval") {
    const code = typeof args.code === "string" ? args.code.trim() : "";
    if (!code) return "";
    const lines = code.split("\n");
    const first = (lines.find((line) => line.trim()) ?? "").trim();
    const short = first.length > 72 ? `${first.slice(0, 71)}…` : first;
    return lines.length > 1 ? `${short} (+${lines.length - 1} lines)` : short;
  }
  return Object.values(args).slice(0, 2).map(String).join(" ");
}

/**
 * What a Code Mode call produced, after it finishes.
 *
 * Deliberately printed *after* the call rather than streamed during it. The
 * live stream is what the web transcript shows, and it works there because a
 * browser can update a region in place; a terminal cannot, so interleaving
 * would push the script off the screen to reprint it as a log. One report, once
 * the call returns, is what a terminal is good at.
 *
 * Two lines always, more only when there is something to say: the shape of the
 * run, then — for any failure, and for any console output worth reading — the
 * text that explains it. A successful two-line script prints one line.
 */
export function printToolResult(
  result: { name: string; ok: boolean; output: unknown; error?: { code: string; message: string } },
  opts?: ToolCallPrintOptions,
): void {
  if (!isSessionPrinterEnabled()) return;
  if (result.name !== "eval") return;
  const record = result.output && typeof result.output === "object" && !Array.isArray(result.output)
    ? (result.output as Record<string, unknown>)
    : undefined;
  const out = opts?.out ?? humanOut();

  if (!record) {
    if (!result.ok) out.write(`    ${dim(`✕ ${result.error?.message ?? "failed"}`, out)}\n`);
    return;
  }

  out.write(`    ${dim(describeEvalRun(record), out)}\n`);

  const failure = describeEvalFailure(record);
  if (failure) out.write(`    ${dim(`✕ ${failure}`, out)}\n`);

  /*
   * The hint belongs on screen, not only in the model's context. It is the
   * sentence that says what to do *instead*, and someone watching a script fail
   * wants to know the model was told, and told something useful. Indented under
   * the error it corrects.
   *
   * The one hint that actually fires today is the fresh-environment one — a
   * `ReferenceError` naming a variable an earlier eval declared — which is the
   * mistake the runtime's no-shared-state design makes easy to make. There is
   * no longer a host-module hint here: `node:fs` is a real module in this
   * runtime and importing it is not an error.
   */
  const hint = evalHint(record);
  if (hint) out.write(`      ${dim(`↳ ${hint}`, out)}\n`);

  for (const line of evalConsoleTail(record)) {
    out.write(`    ${dim(`│ ${line}`, out)}\n`);
  }
}

function describeEvalRun(record: Record<string, unknown>): string {
  const parts: string[] = [];
  if (record.status !== "completed") parts.push(String(record.status));
  const callRecords = Array.isArray(record.toolCalls) ? (record.toolCalls as Array<Record<string, unknown>>) : [];
  if (callRecords.length > 0) {
    /*
     * Which tools ran, not just how many.
     *
     * The count alone says a script did something; the names say what, and for
     * an audit that is the whole question. Repeated names collapse to `grep_search
     * ×12` — common in the loops eval is for, and a comma-separated list of the
     * same word twelve times is noise where a number is information.
     *
     * A failed call is marked, because "the script called bash" and "the script
     * called bash and it was refused" are different facts about the run.
     */
    const counts = new Map<string, { count: number; failed: boolean }>();
    for (const call of callRecords) {
      const name = toolLabel(String(call.name ?? "tool"));
      const entry = counts.get(name) ?? { count: 0, failed: false };
      entry.count += 1;
      if (call.ok === false) entry.failed = true;
      counts.set(name, entry);
    }
    const named = [...counts].map(([name, e]) =>
      `${name}${e.count > 1 ? ` ×${e.count}` : ""}${e.failed ? " ✕" : ""}`,
    );
    parts.push(named.join(", "));
  }
  const value = previewEvalValue(record.value);
  if (value) parts.push(`→ ${value}`);
  const ms = typeof record.durationMs === "number" ? record.durationMs : undefined;
  if (ms !== undefined) parts.push(ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
  return parts.join(" · ") || "done";
}

function describeEvalFailure(record: Record<string, unknown>): string | undefined {
  const error = record.error;
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : "Error";
    const message = typeof e.message === "string" ? e.message : "";
    return `${name}: ${message}`;
  }
  if (typeof record.note === "string" && record.note) return record.note;
  return undefined;
}

/** The correction the runtime attached to a failure, if it attached one. */
function evalHint(record: Record<string, unknown>): string | undefined {
  const error = record.error;
  if (!error || typeof error !== "object") return undefined;
  const hint = (error as Record<string, unknown>).hint;
  return typeof hint === "string" && hint ? hint : undefined;
}

/** The last few console lines, plus how many were withheld. */
function evalConsoleTail(record: Record<string, unknown>): string[] {
  const entries = Array.isArray(record.console) ? record.console : [];
  const lines = entries
    .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>).text : undefined))
    .filter((text): text is string => typeof text === "string")
    .map((text) => text.replace(/\n+$/, ""))
    .filter((text) => text.length > 0);
  if (lines.length === 0) return [];
  const tail = lines.slice(-MAX_PRINTED_CONSOLE_LINES);
  const omitted = lines.length - tail.length;
  return omitted > 0 ? [`… ${omitted} earlier lines`, ...tail] : tail;
}

const MAX_PRINTED_CONSOLE_LINES = 8;

/**
 * A one-line rendering of what the script returned.
 *
 * Strings are shown as themselves rather than as JSON — the common case is that
 * the model returned a sentence, and `"a sentence"` with quotes reads as a
 * value where the sentence reads as an answer. Every other type is JSON, which
 * is both accurate and what a terminal reader expects.
 */
function previewEvalValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value.length > 100 ? `${value.slice(0, 99)}…` : value;
  const json = JSON.stringify(value);
  if (json === undefined) return "";
  return json.length > 100 ? `${json.slice(0, 99)}…` : json;
}

/**
 * Print one model turn's reasoning / content output. Non-destructive:
 * does nothing unless the session printer is enabled.
 */
export function printAgentReasoning(reasoning?: string, content?: string, opts?: SessionPrinterOptions): void {
  if (!isSessionPrinterEnabled()) return;

  const out = opts?.out ?? humanOut();
  const format = opts?.format ?? defaultFormat;
  const parts: string[] = [];

  const reasoningTrimmed = reasoning?.trim();
  if (reasoningTrimmed) {
    const preview = reasoningTrimmed.length > 4000 ? `${reasoningTrimmed.slice(0, 4000)}\n...` : reasoningTrimmed;
    parts.push(sectionHeader("reasoning", reasoningTrimmed.length));
    parts.push(format(preview));
  }

  const contentTrimmed = content?.trim();
  if (contentTrimmed) {
    const alreadyShown = reasoningTrimmed && contentTrimmed.includes(reasoningTrimmed);
    if (!alreadyShown || contentTrimmed.length > (reasoningTrimmed?.length ?? 0)) {
      const preview = contentTrimmed.length > 4000 ? `${contentTrimmed.slice(0, 4000)}\n...` : contentTrimmed;
      parts.push(sectionHeader("content", contentTrimmed.length));
      parts.push(format(preview));
    }
  }

  if (parts.length === 0) return;
  out.write(`${parts.join("\n")}\n`);
}
