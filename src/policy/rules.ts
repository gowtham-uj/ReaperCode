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

const hardDenyRules: Array<{ ruleId: string; test: RegExp; message: string }> = [
  { ruleId: "hard_deny_rm_root", test: /(^|\s)rm\s+-rf\s+\/(\s|$)/, message: "Refusing catastrophic root deletion" },
  { ruleId: "hard_deny_disk_dd", test: /(^|\s)dd\s+.*\bof=\/dev\//, message: "Refusing raw disk write command" },
  {
    ruleId: "hard_deny_host_package_manager",
    test: /\bsudo\s+(?:apt(?:-get)?|dnf|yum|apk|pacman|brew)\b|\b(?:apt(?:-get)?|dnf|yum|apk|pacman|brew)\s+(?:install|remove|upgrade|dist-upgrade)\b/,
    message:
      "Refusing host package-manager mutation. Use project-local or scratchpad-scoped dependencies; if a host capability is unavailable, record it as an environment limitation and continue with file/config validation.",
  },
  {
    ruleId: "hard_deny_global_tool_install",
    test: /\bsudo\s+(?:mv|cp|install|chmod)\b[\s\S]*(?:\/usr\/local|\/usr\/bin|\/bin|\/sbin)\b|(?:npm|pnpm|yarn)\s+(?:install|add)\s+-g\b|pip\s+install\b(?![\s\S]*(?:--target|--prefix|--user|\bvenv\b|\.venv))/,
    message:
      "Refusing global or system-level tool installation. Install dependencies inside the task workspace/scratchpad, or treat missing host tooling as an environment limitation.",
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

  for (const rule of context?.localRules?.rules ?? []) {
    if (!rule.pattern.test(command)) {
      continue;
    }
    return {
      outcome: rule.outcome === "allow" ? "allow" : "deny",
      ruleId: rule.ruleId,
      message: `Local rule matched: ${rule.raw}`,
    };
  }

  for (const rule of standardRules) {
    if (!rule.test.test(command)) {
      continue;
    }

    if (safetyProfile === "allow_all") {
      return { outcome: "would_block", ruleId: rule.ruleId, message: rule.message };
    }

    return { outcome: "deny", ruleId: rule.ruleId, message: rule.message };
  }

  return { outcome: "allow", ruleId: "allow_default", message: "Command allowed" };
}
