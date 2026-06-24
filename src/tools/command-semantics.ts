export type ShellCommandSemanticKind =
  | "inspect"
  | "producer"
  | "weak_check"
  | "strict_verifier"
  | "destructive"
  | "background_server";

export interface ShellCommandSemantic {
  kind: ShellCommandSemanticKind;
  reason: string;
}

export function classifyShellCommandSemantics(command: string): ShellCommandSemantic {
  const normalized = command.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  if (!normalized) return { kind: "weak_check", reason: "empty command" };

  if (isDestructiveCommand(normalized)) {
    return { kind: "destructive", reason: "destructive filesystem or git operation" };
  }

  if (isBackgroundServerCommand(normalized)) {
    return { kind: "background_server", reason: "long-running service/server command" };
  }

  if (isPlaceholderSuccessCommand(normalized)) {
    return { kind: "weak_check", reason: "placeholder success output or unconditional success" };
  }

  if (isVersionOrPresenceProbe(normalized)) {
    return { kind: "weak_check", reason: "version/presence probe does not exercise task behavior" };
  }

  if (isStrictVerifierCommand(normalized)) {
    return { kind: "strict_verifier", reason: "command checks behavior, build, tests, or artifact contents" };
  }

  if (isProducerCommand(normalized)) {
    return { kind: "producer", reason: "command creates, builds, converts, generates, installs, or runs the produced artifact" };
  }

  if (isInspectCommand(lower)) {
    return { kind: "inspect", reason: "read-only inspection command" };
  }

  return { kind: "producer", reason: "stateful or runtime command without an explicit assertion" };
}

export function isWeakVerificationCommand(command: string): boolean {
  const semantic = classifyShellCommandSemantics(command);
  return semantic.kind === "weak_check" || semantic.kind === "inspect" || semantic.kind === "producer";
}

function isPlaceholderSuccessCommand(command: string): boolean {
  return (
    /^(?:true|exit\s+0)\s*$/i.test(command) ||
    /^(?:echo|printf)\b[\s\S]*(?:success|passed|complete|done|ok|verified|working|fixed)/i.test(command) ||
    /\bpython3?\s+-c\s+(['"])\s*print\s*\([^)]*(?:success|passed|complete|done|ok|verified)[^)]*\)\s*\1\s*$/i.test(command) ||
    /\bnode\s+-e\s+(['"])\s*console\.log\s*\([^)]*(?:success|passed|complete|done|ok|verified)[^)]*\)\s*\1\s*$/i.test(command)
  );
}

function isVersionOrPresenceProbe(command: string): boolean {
  return (
    /^(?:cd\s+[^;&|]+\s*&&\s*)?(?:which|command\s+-v|type|whereis)\s+[A-Za-z0-9_./@+-]+\s*$/i.test(command) ||
    /^(?:cd\s+[^;&|]+\s*&&\s*)?[A-Za-z0-9_./@+-]+\s+(?:--version|-v|-V|version)\s*$/i.test(command) ||
    /^(?:cd\s+[^;&|]+\s*&&\s*)?(?:python3?|node|npm|pnpm|yarn|bun|go|cargo|rustc|gcc|g\+\+|clang|clang\+\+|java|javac)\s+(?:--version|-v|-V|version)\s*$/i.test(command)
  );
}

function isStrictVerifierCommand(command: string): boolean {
  return (
    /\b(?:npm\s+(?:run\s+)?(?:test|build|lint|check)|pnpm\s+(?:run\s+)?(?:test|build|lint|check)|yarn\s+(?:run\s+)?(?:test|build|lint|check)|bun\s+(?:run\s+)?(?:test|build|lint|check))\b/i.test(command) ||
    /\b(?:node\s+--test|pytest|ruff|mypy|go\s+test|go\s+vet|cargo\s+(?:test|check|clippy)|mvn\s+test|gradle\s+test|jest|vitest|mocha|playwright|cypress|tap|tsc|eslint)\b/i.test(command) ||
    /\b(?:cmake\s+--build|make(?:\s|$)|ninja(?:\s|$)|g\+\+|gcc|clang\+\+|clang|cargo\s+build|go\s+build)\b/i.test(command) ||
    /(?:^|[;&|]\s*)(?:test\s+|\[\s+|diff\b|cmp\b|sha1sum\b|sha256sum\b|md5sum\b|grep\s+-q\b|jq\s+-e\b)/i.test(command) ||
    (/\bpython3?\s+-c\b/i.test(command) && /\b(?:assert|raise\s+SystemExit|sys\.exit|open|Path|json|hashlib)\b|==|!=|<=|>=/.test(command)) ||
    (/\bnode\s+-e\b/i.test(command) && /\b(?:assert|process\.exit|fs\.readFileSync|JSON\.parse)\b|==|!=|===|!==/.test(command)) ||
    (/\b(?:curl|wget)\b/i.test(command) && /\b(?:grep\s+-q|jq\s+-e|python3?\s+-c|node\s+-e|test\s+|\[\s+|diff|cmp|assert)\b/i.test(command))
  );
}

function isProducerCommand(command: string): boolean {
  return (
    /\b(?:create|write|generate|produce|convert|transform|export|render|serialize|migrate|compile|build|install|add|init|scaffold)\b/i.test(command) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|create|exec|dlx|run\s+(?:dev|start|serve|generate|build))\b/i.test(command) ||
    /\b(?:python3?|node|ruby|perl|bash|sh)\s+(?:\.\/)?[A-Za-z0-9_./-]+\.(?:py|mjs|js|rb|pl|sh)(?:\s|$)/i.test(command) ||
    /(?:^|[^<>])>{1,2}[^&]|\btee\s+/.test(command)
  );
}

function isInspectCommand(lower: string): boolean {
  return /^(?:cd\s+[^;&|]+\s*&&\s*)?(?:ls|find|rg|grep|cat|head|tail|wc|stat|file|strings|jq|awk|sed|pwd|tree|du)\b/.test(lower);
}

function isDestructiveCommand(command: string): boolean {
  return (
    /(?:^|[;&|]\s*)(?:rm\s+-rf|git\s+(?:reset\s+--hard|clean\s+-fd|checkout\s+--)|chmod\s+-R|chown\s+-R)\b/i.test(command) ||
    /(?:^|[;&|]\s*)(?:find\b[\s\S]*\b-delete\b)/i.test(command)
  );
}

function isBackgroundServerCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)\b|\b(?:vite|next\s+dev|webpack\s+serve|uvicorn|gunicorn|flask\s+run|python3?\s+-m\s+http\.server)\b/i.test(command);
}
