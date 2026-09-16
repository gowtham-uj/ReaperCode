import type { ToolCall} from "../tools/types.js";

// ── Permission modes ──
// yolo: allow everything (default — tools run without prompting)
// accept_edits: auto-allow safe reads/writes, ask for everything else
// auto: same as accept_edits here; the LLM classification path this mode was
//       named for is declared below and has no caller.
// strict: ask for everything that is not a read
//
// The hard-deny patterns below apply in every mode, yolo included: `rm -rf /`
// and its neighbours are refused whatever the user has selected.
export type PermissionMode = "yolo" | "accept_edits" | "auto" | "strict";

// ── Classification result ──
export interface PermissionClassification {
  outcome: "safe" | "dangerous" | "needs_confirmation";
  reasoning: string;
  confidence: number; // 0-1
  ruleMatch?: string;
}

// ── Denial tracker ──
export class DenialTracker {
  private consecutiveDenials = 0;
  private totalDenials = 0;
  private readonly maxConsecutive = 3;
  private readonly maxTotal = 10;
  private forcedAskMode = false;

  recordDenial(): void {
    this.consecutiveDenials++;
    this.totalDenials++;
    if (this.consecutiveDenials >= this.maxConsecutive) {
      this.forcedAskMode = true; // escalate to always-ask
    }
  }

  recordAllow(): void { this.consecutiveDenials = 0; }
  isForcedAskMode(): boolean { return this.forcedAskMode || this.totalDenials >= this.maxTotal; }
  reset() { this.consecutiveDenials = 0; this.totalDenials = 0; this.forcedAskMode = false; }
}

// ── Fast-path regex classifier ──
// Trailing-character class for shell-segment boundaries: whitespace,
// common shell metacharacters, end-of-string, or start-of-string.
// Anchoring on these avoids missing `rm -rf /;`, `rm -rf /| ...`,
// `echo a && rm -rf /` and similar concatenations that the naive
// `(?:\s|$)` regex silently allowed.
const SHELL_BOUNDARY = String.raw`(?:^|[;\s&|()<>])`;
const SHELL_BOUNDARY_END = String.raw`(?:[;\s&|()<>]|$)`;
const hardDenyPatterns = [
  { pattern: new RegExp(`${SHELL_BOUNDARY}rm\\s+-rf\\s+\\/${SHELL_BOUNDARY_END}`), ruleId: "hard_deny_rm_root", desc: "Recursive root deletion" },
  { pattern: /dd\s+.*\bof=\/dev\//, ruleId: "hard_deny_disk_dd", desc: "Raw disk write" },
  { pattern: />\s*\/dev\/sda/, ruleId: "hard_deny_disk_overwrite", desc: "Raw disk overwrite" },
  { pattern: /chmod\s+(-R\s+)?777\s+\//, ruleId: "hard_deny_chmod_root", desc: "World-writable root" },
  { pattern: /:\(\)\s*\{/, ruleId: "hard_deny_fork_bomb", desc: "Fork bomb pattern" },
  { pattern: /mkfs\./, ruleId: "hard_deny_mkfs", desc: "Filesystem format" },
];

const safeReadPatterns = [
  /^(cat|head|tail|less)\s+/,
  /^(ls|dir|tree)\s*/,
  /^(find|locate)\s+/,
  /^(grep|rg|ag)\s+/,
  /^(git\s+(status|log|diff|show|branch|tag))\b/,
  /^(node|python|ruby|php)\s+(--version|-v|--help)\b/,
  /^(npm|yarn|pnpm)\s+(list|ls|info|view|outdated|audit)\b/,
  /^(which|type|command)\s+/,
  /^(echo|printf|wc|sort|uniq|cut|awk|sed)\s+/,
];

const safeWritePatterns = [
  /^(mkdir|touch)\s+/,
  /^(cp|mv)\s+/,
  /^(npm|yarn|pnpm)\s+install\b/,
  /^(npm|yarn|pnpm)\s+add\b/,
  /^(git\s+(add|commit|checkout|switch|restore))\b/,
];

/**
 * Tools whose own effect is nothing, because everything they do they do by
 * calling other tools that are classified on their own merits.
 *
 * Kept in step with the same-named set in `sandbox.ts` by
 * `tests/unit/code-mode.test.ts`, which fails if one gains a name the other
 * does not have — a drift here would silently make `eval` need confirmation in
 * one gate and not the other.
 */
export const COMPOSITE_TOOL_NAMES: ReadonlySet<string> = new Set(["eval"]);

// ── Classifier ──
export class PermissionClassifier {
  private denialTracker = new DenialTracker();

  constructor(private mode: PermissionMode) {}

  classifyShellCommand(cmd: string): PermissionClassification {
    // 1. Hard deny — always reject
    for (const rule of hardDenyPatterns) {
      if (rule.pattern.test(cmd)) {
        return { outcome: "dangerous", reasoning: rule.desc, confidence: 1.0, ruleMatch: rule.ruleId };
      }
    }

    // 2. YOLO mode — allow everything (default)
    if (this.mode === "yolo") {
      return { outcome: "safe", reasoning: "YOLO mode — all commands allowed", confidence: 1.0 };
    }

    // 3. Accept-edits mode — auto-allow safe patterns
    if (this.mode === "accept_edits") {
      if (safeReadPatterns.some((p) => p.test(cmd))) {
        return { outcome: "safe", reasoning: "Safe read-only command", confidence: 0.95 };
      }
      if (safeWritePatterns.some((p) => p.test(cmd))) {
        return { outcome: "safe", reasoning: "Safe write operation", confidence: 0.9 };
      }
    }

    // 4. Auto mode — ask, rather than guess
    if (this.mode === "auto") {
      return { outcome: "needs_confirmation", reasoning: "Not on the safe fast path — needs confirmation", confidence: 0.5 };
    }

    /*
     * 5. Strict, and the fallthrough for accept_edits.
     *
     * Both land here for anything the fast path did not clear, and both ask. The
     * reasoning used to read "Strict mode — needs confirmation" for either one,
     * so an `accept_edits` user was told they were in a mode they had not
     * selected. The reason string is not decoration: it is what the approval
     * prompt quotes back to the user.
     */
    return {
      outcome: "needs_confirmation",
      reasoning: this.mode === "strict" ? "Strict mode — needs confirmation" : "Not on the safe fast path — needs confirmation",
      confidence: 0.0,
    };
  }

  classifyToolCall(call: ToolCall): PermissionClassification {
    // YOLO mode — everything is allowed (hard denies still apply for shell commands)
    if (this.mode === "yolo") {
      if (call.name === "bash") {
        return this.classifyShellCommand((call.args as any)?.cmd ?? "");
      }
      return { outcome: "safe", reasoning: "YOLO mode", confidence: 1.0 };
    }

    // Read tools are always safe
    if (["file_view", "file_find", "list_directory", "grep_search", "skim_file"].includes(call.name)) {
      return { outcome: "safe", reasoning: "Read-only tool", confidence: 1.0 };
    }

    if (call.name === "browser_use") {
      if (this.mode === "accept_edits") {
        return { outcome: "safe", reasoning: "Browser UI control — auto-accepted", confidence: 0.85 };
      }
      return { outcome: "needs_confirmation", reasoning: "Browser UI control — needs approval", confidence: 0.5 };
    }

    // Shell commands go through shell-specific logic
    if (call.name === "bash") {
      return this.classifyShellCommand((call.args as any)?.cmd ?? "");
    }

    // Write tools — safe in accept_edits, needs confirmation otherwise
    if (["write_file", "file_edit", "edit_file", "delete_file"].includes(call.name)) {
      if (this.mode === "accept_edits") {
        return { outcome: "safe", reasoning: "File write — auto-accepted", confidence: 0.85 };
      }
      return { outcome: "needs_confirmation", reasoning: "File write — needs approval", confidence: 0.5 };
    }

    // Control tools
    if (call.name === "activate_skill") {
      return { outcome: "safe", reasoning: "Control tool", confidence: 0.95 };
    }

    /*
     * Composite tools carry no authority of their own — for the calls this
     * classifier can see.
     *
     * Every Reaper tool `eval` reaches is dispatched individually through the
     * executor, which means this method runs again — on the inner call, with the
     * model's real arguments — before anything happens. Classifying the
     * container as needing confirmation would therefore ask the user to approve
     * "run some JavaScript" (with the old reasoning string "Unknown tool type",
     * since the fallthrough has no idea what it is looking at) and *then* ask
     * again for each write inside it. One useless prompt, and a misleading one.
     *
     * What a script does with raw Node is not a Reaper tool call and never
     * arrives here, so "composite" is a claim about the `tools.*` half only.
     * Classifying the container as a plain unknown tool would ask the same
     * useless question without gating any of the raw path either — there is no
     * answer this function could return that would make `fs` need approval, so
     * the approval would buy nothing but a prompt. See the note in
     * `src/tools/code/node-runtime.ts`.
     */
    if (COMPOSITE_TOOL_NAMES.has(call.name)) {
      return { outcome: "safe", reasoning: "Composite tool — its own calls are classified individually", confidence: 0.9 };
    }

    return { outcome: "needs_confirmation", reasoning: "Unknown tool type", confidence: 0.3 };
  }

  // LLM-based classification for commands that pass the fast-path but aren't clearly safe
  async llmClassify(cmd: string, generateFn: (prompt: string) => Promise<string>): Promise<PermissionClassification> {
    try {
      const response = await generateFn(
        `Classify this shell command as SAFE or DANGEROUS for Reaper. ` +
        `Reply with only one word: SAFE or DANGEROUS.\n\nCommand: ${cmd}\n\n` +
        `SAFE = read-only, installs packages, creates files, runs tests, builds code. ` +
        `DANGEROUS = deletes files outside workspace, modifies system config, accesses network services, ` +
        `force-pushes, executes encoded/piped scripts from URLs.\n\nClassification:`
      );
      const isSafe = response.trim().toUpperCase().startsWith("SAFE");
      return {
        outcome: isSafe ? "safe" : "dangerous",
        reasoning: `LLM classified as ${isSafe ? "SAFE" : "DANGEROUS"}`,
        confidence: isSafe ? 0.85 : 0.9,
      };
    } catch {
      // If LLM fails, fail-closed
      return { outcome: "dangerous", reasoning: "LLM classifier failed — fail-closed", confidence: 0.0 };
    }
  }

  // Full pipeline: fast-path + optional LLM
  async classify(
    call: ToolCall,
    llmClassifyFn?: (cmd: string) => Promise<string>,
  ): Promise<PermissionClassification> {
    if (this.denialTracker.isForcedAskMode()) {
      return { outcome: "needs_confirmation", reasoning: "Forced ask-mode after repeated denials", confidence: 1.0 };
    }

    const fastResult = this.classifyToolCall(call);

    // If clearly safe/dangerous, return fast result
    if (fastResult.outcome !== "needs_confirmation" && fastResult.confidence > 0.8) {
      return fastResult;
    }

    // If needs_confirmation and we have LLM and it's a shell command, try LLM classifier
    if (call.name === "bash" && llmClassifyFn) {
      const cmd = (call.args as any)?.cmd ?? "";
      const llmResult = await this.llmClassify(cmd, llmClassifyFn);
      if (llmResult.outcome === "dangerous") {
        this.denialTracker.recordDenial();
      } else {
        this.denialTracker.recordAllow();
      }
      return llmResult;
    }

    return fastResult;
  }

  getDenialTracker(): DenialTracker { return this.denialTracker; }
  setMode(mode: PermissionMode) { this.mode = mode; }
}
