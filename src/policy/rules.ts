export type SafetyProfile = "allow_all" | "standard" | "strict";

export interface CommandPolicyDecision {
  outcome: "allow" | "deny" | "would_block";
  ruleId: string;
  message: string;
}

export interface RuleEvaluationContext {
  localRules?: {
    hash: string;
    rules: Array<{ outcome: "allow" | "deny"; ruleId: string; pattern: RegExp; raw: string }>;
  };
}

// Trailing-character class for shell-segment boundaries: whitespace,
// common shell metacharacters, end-of-string, or start-of-string.
// Anchoring on these avoids missing `rm -rf /;`, `rm -rf /| ...`,
// `echo a && rm -rf /` and similar concatenations that the naive
// `(\s|$)` regex silently allowed.
const SHELL_BOUNDARY = String.raw`(?:^|[;\s&|()<>])`;
const SHELL_BOUNDARY_END = String.raw`(?:[;\s&|()<>]|$)`;
const hardDenyRules: Array<{ ruleId: string; test: RegExp; message: string }> = [
  { ruleId: "hard_deny_rm_root", test: new RegExp(`${SHELL_BOUNDARY}rm\\s+-rf\\s+\\/${SHELL_BOUNDARY_END}`), message: "Refusing catastrophic root deletion" },
  { ruleId: "hard_deny_disk_dd", test: /(^|\s)dd\s+.*\bof=\/dev\//, message: "Refusing raw disk write command" },
  {
    ruleId: "hard_deny_host_package_manager",
    test: /\bsudo\s+(?:apt(?:-get)?|dnf|yum|apk|pacman|brew)\b|\b(?:apt(?:-get)?|dnf|yum|apk|pacman|brew)\s+(?:install|remove|upgrade|dist-upgrade)\b/,
    message:
      "Refusing host package-manager mutation. Use project-local or scratchpad-scoped dependencies; if a host capability is unavailable, record it as an environment limitation and continue with file/config validation.",
  },
];

const standardRules: Array<{ ruleId: string; test: RegExp; message: string }> = [
  { ruleId: "block_force_push", test: /git\s+push\s+--force/, message: "Force push is blocked by standard policy" },
  { ruleId: "block_curl_pipe_sh", test: /curl\b.*\|\s*(sh|bash)\b/, message: "Piped remote shell execution is blocked" },
];

export function evaluateCommandPolicy(command: string, safetyProfile: SafetyProfile, context?: RuleEvaluationContext): CommandPolicyDecision {
  for (const rule of hardDenyRules) {
    if (rule.test.test(command)) {
      return { outcome: "deny", ruleId: rule.ruleId, message: rule.message };
    }
  }

  // Local rules (rules.local.md) are explicit user-authored policy.
  // They must be honored in EVERY safety profile — including
  // `allow_all` (yolo). A local `deny` is a hard denial; an `allow`
  // permits the command even if a built-in standard rule would block
  // it.
  for (const rule of context?.localRules?.rules ?? []) {
    if (!rule.pattern.test(command)) {
      continue;
    }
    if (rule.outcome === "allow") {
      return { outcome: "allow", ruleId: rule.ruleId, message: `Local rule matched: ${rule.raw}` };
    }
    return { outcome: "deny", ruleId: rule.ruleId, message: `Local rule matched: ${rule.raw}` };
  }

  for (const rule of standardRules) {
    if (!rule.test.test(command)) {
      continue;
    }

    if (safetyProfile === "allow_all") {
      // Built-in standard rules remain advisory in yolo so the
      // trusted-local-use default is unchanged. Local denies above
      // already promoted to a real deny; this branch only fires for
      // built-in standard rules.
      return { outcome: "would_block", ruleId: rule.ruleId, message: rule.message };
    }

    return { outcome: "deny", ruleId: rule.ruleId, message: rule.message };
  }

  return { outcome: "allow", ruleId: "allow_default", message: "Command allowed" };
}
