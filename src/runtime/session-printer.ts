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
import { getEngineTunables } from "../config/config-tunables.js";


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
  const out = opts?.out ?? globalOut;
  out.write(`\n${dim(`● Turn ${turn}`, out)}\n`);
}

export function printToolCalls(toolCalls: Array<{ name: string; args?: Record<string, unknown> }>, opts?: ToolCallPrintOptions): void {
  if (!isSessionPrinterEnabled() || toolCalls.length === 0) return;
  const out = opts?.out ?? globalOut;
  for (const call of toolCalls) {
    const summary = summarizeToolCall(call.name, call.args ?? {});
    out.write(`  ${dim("→", out)} ${call.name}${summary ? ` ${dim("—", out)} ${summary}` : ""}\n`);
  }
}

function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  if (name === "write_file") return String(args.path ?? "");
  if (name === "replace_in_file") return String(args.path ?? "");
  if (name === "bash") {
    const cmd = String(args.command ?? args.cmd ?? "");
    const short = cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
    return short;
  }
  if (name === "read_file") return String(args.path ?? "");
  if (name === "list_directory") return String(args.path ?? "");
  if (name === "grep_search") {
    const pattern = String(args.pattern ?? "");
    return `${pattern}${args.path ? ` in ${args.path}` : ""}`;
  }
  if (name === "update_plan" || name === "update_todo") return "";
  return Object.values(args).slice(0, 2).map(String).join(" ");
}

/**
 * Print one model turn's reasoning / content output. Non-destructive:
 * does nothing unless the session printer is enabled.
 */
export function printAgentReasoning(reasoning?: string, content?: string, opts?: SessionPrinterOptions): void {
  if (!isSessionPrinterEnabled()) return;

  const out = opts?.out ?? globalOut;
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
