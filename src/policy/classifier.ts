import type { ToolCall} from "../tools/types.js";

// ── Permission modes ──
// yolo: allow everything (default)
// accept_edits: auto-allow safe reads/writes, ask for dangerous ops
// auto: LLM-based classification
// strict: always ask for confirmation
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
const hardDenyPatterns = [
  { pattern: /rm\s+-rf\s+\/(?:\s|$)/, ruleId: "hard_deny_rm_root", desc: "Recursive root deletion" },
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

    // 4. Auto mode — defer to LLM classifier (needs_confirmation)
    if (this.mode === "auto") {
      return { outcome: "needs_confirmation", reasoning: "Needs AI classification", confidence: 0.5 };
    }

    // 5. Strict — always ask
    return { outcome: "needs_confirmation", reasoning: "Strict mode — needs confirmation", confidence: 0.0 };
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
    if (["read_file", "list_directory", "grep_search", "skim_file", "get_tool_output",
          "read_background_output"].includes(call.name)) {
      return { outcome: "safe", reasoning: "Read-only tool", confidence: 1.0 };
    }

    if (
      [
        "browser_control",
        "computer_control",
        "mouse_move",
        "mouse_click",
        "mouse_scroll",
        "keyboard_type",
        "keyboard_press",
        "screenshot",
        "get_screen_size",
        "get_mouse_position",
        "wait",
        "start_live_view",
        "stop_live_view",
        "request_human_approval",
        "is_human_intervening",
      ].includes(call.name)
    ) {
      if (this.mode === "accept_edits") {
        return { outcome: "safe", reasoning: "Browser/computer UI control — auto-accepted", confidence: 0.85 };
      }
      return { outcome: "needs_confirmation", reasoning: "Browser/computer UI control — needs approval", confidence: 0.5 };
    }

    // Shell commands go through shell-specific logic
    if (call.name === "bash") {
      return this.classifyShellCommand((call.args as any)?.cmd ?? "");
    }

    // Write tools — safe in accept_edits, needs confirmation otherwise
    if (["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(call.name)) {
      if (this.mode === "accept_edits") {
        return { outcome: "safe", reasoning: "File write — auto-accepted", confidence: 0.85 };
      }
      return { outcome: "needs_confirmation", reasoning: "File write — needs approval", confidence: 0.5 };
    }

    // Control tools
    if (["complete_task", "delegate_to_plan", "activate_skill"].includes(call.name)) {
      return { outcome: "safe", reasoning: "Control tool", confidence: 0.95 };
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
