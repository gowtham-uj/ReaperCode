/**
 * SubagentOutputWriter — append-only human-readable transcript for a
 * single subagent run.
 *
 * Writes to one or more files; tee'd writes to extra paths are
 * best-effort.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { WireEvent } from "./types.js";

export interface WireMessageLike {
  kind: "stage" | "tool_call" | "tool_result" | "text" | "summary" | "error";
  // arbitrary per-kind fields
  [k: string]: unknown;
}

export class SubagentOutputWriter {
  private readonly path: string;
  private readonly extraPaths: string[];

  constructor(path: string, extraPaths: string[] = []) {
    this.path = path;
    this.extraPaths = extraPaths;
    mkdirSync(dirname(path), { recursive: true });
  }

  stage(name: string): void { this.append(`[stage] ${name}\n`); }
  toolCall(name: string): void { this.append(`[tool] ${name}\n`); }
  toolResult(status: "ok" | "error", brief?: string): void {
    this.append(brief ? `[tool_result] ${status}: ${brief}\n` : `[tool_result] ${status}\n`);
  }
  text(text: string): void { if (text) this.append(text); }
  summary(text: string): void { if (text) this.append(`\n[summary]\n${text}\n`); }
  error(message: string): void { this.append(`[error] ${message}\n`); }

  /** Dispatch a wire event to the right method. */
  writeWireEvent(ev: WireEvent): void {
    switch (ev.kind) {
      case "stage":       this.stage(ev.name); break;
      case "tool_call":   this.toolCall(ev.name); break;
      case "tool_result": this.toolResult(ev.status, ev.brief); break;
      case "text":        this.text(ev.text); break;
      case "summary":     this.summary(ev.text); break;
      case "error":       this.error(ev.message); break;
    }
  }

  private append(text: string): void {
    try { appendFileSync(this.path, text); } catch { /* best-effort */ }
    for (const p of this.extraPaths) {
      try { appendFileSync(p, text); } catch { /* best-effort */ }
    }
  }
}
