/**
 * Command risk classification for `bash`.
 *
 * Layered on top of (but not replacing) `src/policy/rules.ts`. That
 * module produces a binary `allow | deny | would_block` outcome
 * from a fixed set of regex rules. This module produces a
 * *graduated* `low | medium | high` risk label plus a list of
 * matched patterns, so the policy engine can decide:
 *
 *   - low:     run without further question
 *   - medium:  run, but log a "medium-risk command" audit event
 *   - high:    require explicit approval (or trusted-sandbox mode)
 *
 * The classification is intentionally rule-based and conservative
 * (it labels more, not less) — the policy engine applies the role /
 * approval gate, and the executor's existing `evaluateCommandPolicy`
 * continues to enforce the *hard deny* list (rm -rf /, dd to /dev,
 * sudo apt install, etc.).
 *
 * The patterns here are deliberately language-agnostic. They cover
 * shell-grammar shapes, not domain-specific commands. Adding new
 * languages does not require touching this file.
 */

export type ShellRisk = "low" | "medium" | "high";

export interface ShellRiskFinding {
  risk: ShellRisk;
  /** Why this risk level was assigned. The first match wins. */
  reason: string;
  /** Pattern id that matched, or "default". */
  ruleId: string;
}

interface Rule {
  ruleId: string;
  risk: ShellRisk;
  test: RegExp;
  reason: string;
}

/* -------------------------------------------------------------------------- */
/*                            Pattern catalog                                 */
/* -------------------------------------------------------------------------- */

/**
 * HIGH risk — anything that can affect the host, install software,
 * push to remote, or run untrusted code. The policy engine will
 * require approval for these by default; the trusted-sandbox
 * shortcut lets a configured environment skip approval.
 */
const HIGH_RISK_RULES: Rule[] = [
  { ruleId: "shell.sudo",          risk: "high", test: /(^|\s|;|&&|\|\|)\bsudo\b/,        reason: "Uses sudo" },
  { ruleId: "shell.su",            risk: "high", test: /(^|\s|;|&&|\|\|)\bsu\b\s+-/,      reason: "Switches user" },
  { ruleId: "shell.host_pkg",      risk: "high", test: /\b(?:apt(?:-get)?|dnf|yum|apk|pacman|brew)\s+(?:install|remove|upgrade|dist-upgrade|autoremove|purge)\b/, reason: "Host package manager" },

  { ruleId: "shell.pip_global",    risk: "high", test: /pip[23]?\s+install\b(?![\s\S]*?(?:--target|--prefix|--user|\bvenv\b|\.venv))/, reason: "pip install outside venv / user / target" },
  { ruleId: "shell.dd_to_dev",     risk: "high", test: /\bdd\b[\s\S]*\bof=\/dev\//, reason: "Writes to a raw block device" },
  { ruleId: "shell.mkfs",          risk: "high", test: /\bmkfs(?:\.[a-z0-9]+)?\b\s+\/dev\//, reason: "Formats a filesystem" },
  { ruleId: "shell.rm_root",       risk: "high", test: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+\//, reason: "Recursive delete targeting root" },
  { ruleId: "shell.fork_bomb",     risk: "high", test: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "Fork bomb" },
  { ruleId: "shell.curl_pipe_sh",  risk: "high", test: /\bcurl\b[\s\S]*\|\s*(?:sh|bash|zsh|ksh)\b/, reason: "Pipes remote response into a shell" },
  { ruleId: "shell.wget_pipe_sh",  risk: "high", test: /\bwget\b[\s\S]*\|\s*(?:sh|bash|zsh|ksh)\b/, reason: "Pipes remote response into a shell" },
  { ruleId: "shell.force_push",    risk: "high", test: /\bgit\s+push\b[\s\S]*--force\b|\bgit\s+push\b[\s\S]*-f\b/, reason: "Force push" },
  { ruleId: "shell.reset_hard",    risk: "high", test: /\bgit\s+reset\s+--hard\b/, reason: "git reset --hard discards local changes" },
  { ruleId: "shell.clean_git",     risk: "high", test: /\bgit\s+clean\s+-?[\-a-zA-Z]*f[\-a-zA-Z]*d?[\-a-zA-Z]*\b/, reason: "git clean -fd removes untracked files" },
  { ruleId: "shell.chmod_recursive", risk: "high", test: /\bchmod\s+(?:-R\s+)?777\b|\bchmod\s+-R\b\s+\//, reason: "chmod 777 or recursive chmod on root" },
  { ruleId: "shell.chown_recursive", risk: "high", test: /\bchown\s+-R\b\s+\//, reason: "chown -R on root" },
  { ruleId: "shell.kill_root",     risk: "high", test: /\bkill\s+-9\s+1\b|\bkill\s+--signal\s+9\s+1\b/, reason: "Targets PID 1 (init)" },
  { ruleId: "shell.shutdown",      risk: "high", test: /\b(?:shutdown|reboot|halt|poweroff)\b/, reason: "System power control" },
  { ruleId: "shell.iptables",      risk: "high", test: /\b(?:iptables|nft|ufw)\b/, reason: "Modifies firewall rules" },
  { ruleId: "shell.systemctl",     risk: "high", test: /\bsystemctl\s+(?:enable|disable|mask|start|stop|restart)\b/, reason: "Modifies a system service" },
  { ruleId: "shell.crontab",       risk: "high", test: /\bcrontab\b/, reason: "Modifies scheduled jobs" },
  { ruleId: "shell.write_etc",     risk: "high", test: /(?:>|>>|tee\s+)\s*\/etc\//, reason: "Writes to /etc" },
  { ruleId: "shell.write_proc",    risk: "high", test: /(?:>|>>|tee\s+)\s*\/proc\/|\btee\s+\/proc\//, reason: "Writes to /proc" },
  { ruleId: "shell.write_sys",     risk: "high", test: /(?:>|>>|tee\s+)\s*\/sys\//, reason: "Writes to /sys" },
  { ruleId: "shell.write_boot",    risk: "high", test: /(?:>|>>|tee\s+)\s*\/boot\//, reason: "Writes to /boot" },
  { ruleId: "shell.network_admin", risk: "high", test: /\b(?:ifconfig|ip\s+(?:link|addr|route)\s+(?:add|del|change)|route\s+(?:add|del))\b/, reason: "Modifies network configuration" },
  { ruleId: "shell.docker_socket", risk: "high", test: /\b(?:docker|podman)\s+(?:run|exec|build|push|pull|rm|rmi)\b/, reason: "Docker / podman lifecycle" },
  { ruleId: "shell.kubectl_apply", risk: "high", test: /\bkubectl\s+(?:apply|create|delete|drain|cordon|uncordon)\b/, reason: "kubectl mutates cluster state" },
  { ruleId: "shell.terraform_apply", risk: "high", test: /\bterraform\s+apply\b/, reason: "terraform apply" },
  { ruleId: "shell.aws_mutate",    risk: "high", test: /\baws\s+(?:s3|ec2|rds|iam|lambda)\s+(?:rm|delete|terminate|create|put|update)\b/, reason: "AWS mutating command" },
  { ruleId: "shell.gcloud_mutate", risk: "high", test: /\bgcloud\s+(?:compute|sql|container|functions|dns)\b[\s\S]*\b(?:create|delete|update|deploy)\b/, reason: "gcloud mutating command" },
  { ruleId: "shell.heroku_mutate", risk: "high", test: /\bheroku\s+(?:apps:destroy|ps:restart|config:set|pg:reset)\b/, reason: "Heroku mutating command" },
];

/**
 * MEDIUM risk — local mutation inside the workspace, package
 * installs scoped to the project, network egress that may carry
 * credentials, builds / test runners. These run without approval
 * but are audited.
 */
const MEDIUM_RISK_RULES: Rule[] = [
  { ruleId: "shell.local_pkg_install", risk: "medium", test: /(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\b/, reason: "Installs project dependencies" },
  { ruleId: "shell.global_install",risk: "medium", test: /(?:npm|pnpm|yarn)\s+(?:install|add|i)\s+-g\b|\byarn\s+global\s+add\b/, reason: "Global node tool install" },
  { ruleId: "shell.pip_local",         risk: "medium", test: /\bpip[23]?\s+install\b[\s\S]*?(?:--target|--prefix|--user|\bvenv\b|\.venv)/, reason: "pip install inside a venv / target / user" },
  { ruleId: "shell.poetry_add",        risk: "medium", test: /\bpoetry\s+(?:add|install|update|remove)\b/, reason: "Poetry dependency change" },
  { ruleId: "shell.cargo_add",         risk: "medium", test: /\bcargo\s+(?:add|install|remove|update)\b/, reason: "Cargo dependency change" },
  { ruleId: "shell.go_mod",            risk: "medium", test: /\bgo\s+(?:get|mod\s+(?:tidy|download|edit))\b/, reason: "Go module change" },
  { ruleId: "shell.gem_install",       risk: "medium", test: /\bgem\s+install\b/, reason: "Ruby gem install" },
  { ruleId: "shell.bundle",            risk: "medium", test: /\bbundle\s+(?:install|update|add)\b/, reason: "Bundler dependency change" },
  { ruleId: "shell.composer",          risk: "medium", test: /\bcomposer\s+(?:install|require|update|remove)\b/, reason: "PHP composer dependency change" },
  { ruleId: "shell.make",              risk: "medium", test: /\b(make|gmake|cmake)\b\s+(?!clean\b)/, reason: "Build invocation" },
  { ruleId: "shell.cargo_build",       risk: "medium", test: /\bcargo\s+build\b/, reason: "Cargo build" },
  { ruleId: "shell.go_build",          risk: "medium", test: /\bgo\s+build\b/, reason: "Go build" },
  { ruleId: "shell.test_runner",       risk: "medium", test: /\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+test)\b|\b(?:pytest|unittest|mocha|jest|vitest|go\s+test|cargo\s+test|bundle\s+exec\s+rspec|phpunit|composer\s+test)\b/, reason: "Runs a test command" },
  { ruleId: "shell.touch_etc",         risk: "medium", test: /\btouch\b\s+\/(?:tmp|var|home|root)\b/, reason: "Touches a system path" },
  { ruleId: "shell.rm_inside_workspace", risk: "medium", test: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*|-rf|-fr|-R|-f)\b/, reason: "Recursive delete" },
  { ruleId: "shell.mv_overwrite",      risk: "medium", test: /\bmv\b\s+.*\s+\/etc\/|\bmv\b\s+.*\s+\/usr\//, reason: "Moves into a system path" },
  { ruleId: "shell.cp_overwrite",      risk: "medium", test: /\bcp\b\s+.*\s+\/etc\/|\bcp\b\s+.*\s+\/usr\//, reason: "Copies into a system path" },
  { ruleId: "shell.chmod_world",       risk: "medium", test: /\bchmod\b\s+(?:[a-z\+]+\s+)?(?:[0-7]{3,4}|\+[rwx]+)/, reason: "chmod" },
  { ruleId: "shell.chown",             risk: "medium", test: /\bchown\b/, reason: "chown" },
  { ruleId: "shell.network_egress",    risk: "medium", test: /\b(?:curl|wget|fetch|http)\b[\s\S]*?(?:-X|--request|--data|-d|-T|--upload|-O)\b/, reason: "Network egress with payload" },
  { ruleId: "shell.git_mutate",        risk: "medium", test: /\bgit\s+(?:commit|merge|rebase|cherry-pick|tag|branch\s+-[dDmMrR])\b/, reason: "git mutation" },
  { ruleId: "shell.daemonize",         risk: "medium", test: /\bnohup\b|\bdisown\b/, reason: "Backgrounds a long-running process" },
  { ruleId: "shell.find_exec",         risk: "medium", test: /\bfind\b[\s\S]*-exec\b/, reason: "find -exec" },
  { ruleId: "shell.env_dump",          risk: "medium", test: /\benv\b\s*$|\bprintenv\b/, reason: "Dumps environment variables" },
  { ruleId: "shell.write_to_root",     risk: "medium", test: /(?:>|>>|tee\s+)\s*\/(?!workspace|app|home\/|tmp|var|opt|usr|etc|proc|sys|boot|dev|root|run)\w+/, reason: "Redirects to a non-workspace path" },
];

/**
 * LOW risk — read-only inspection. Anything not matched by MEDIUM
 * or HIGH falls into LOW. We only enumerate explicit LOW ids for
 * instrumentation (so we can label "the agent is just looking
 * around" in trajectories). The default bucket is also "low".
 */
const LOW_RISK_RULES: Rule[] = [
  { ruleId: "shell.ls",            risk: "low", test: /(^|\s|;|&&|\|\|)\bls\b/,         reason: "Lists files" },
  { ruleId: "shell.cat",           risk: "low", test: /(^|\s|;|&&|\|\|)\bcat\b/,        reason: "Reads file content" },
  { ruleId: "shell.head_tail",     risk: "low", test: /(^|\s|;|&&|\|\|)\b(?:head|tail|less|more)\b/, reason: "Reads file content" },
  { ruleId: "shell.find",          risk: "low", test: /(^|\s|;|&&|\|\|)\bfind\b(?![\s\S]*-exec)/, reason: "Read-only find" },
  { ruleId: "shell.grep",          risk: "low", test: /(^|\s|;|&&|\|\|)\b(?:grep|rg|ag|ack)\b/, reason: "Grep" },
  { ruleId: "shell.echo",          risk: "low", test: /(^|\s|;|&&|\|\|)\becho\b/,       reason: "Echo" },
  { ruleId: "shell.pwd",           risk: "low", test: /(^|\s|;|&&|\|\|)\bpwd\b/,        reason: "Prints working directory" },
  { ruleId: "shell.which",         risk: "low", test: /(^|\s|;|&&|\|\|)\b(?:which|whereis|command|type)\b/, reason: "Locates a binary" },
  { ruleId: "shell.git_status",    risk: "low", test: /\bgit\s+(?:status|log|diff|show|branch|remote|tag|ls-files|ls-tree)\b/, reason: "Read-only git" },
  { ruleId: "shell.node_eval",     risk: "low", test: /\bnode\b\s+-e\b\s+['"][^'"]*['"]/, reason: "Inline node -e (single quoted, presumed safe)" },
  { ruleId: "shell.python_eval",   risk: "low", test: /\bpython[23]?\b\s+-c\b\s+['"][^'"]*['"]/, reason: "Inline python -c (single quoted, presumed safe)" },
];

/* -------------------------------------------------------------------------- */
/*                                Public API                                  */
/* -------------------------------------------------------------------------- */

/**
 * Classify a single shell command string. The first match in
 * HIGH > MEDIUM > LOW wins; the default bucket is "medium" because
 * an unclassified command is one we did not recognize, and we
 * prefer false-positive "medium" over false-negative "low".
 */
export function classifyCommandRisk(cmd: string): ShellRiskFinding {
  if (typeof cmd !== "string" || cmd.length === 0) {
    return { risk: "low", ruleId: "empty", reason: "Empty command" };
  }
  for (const r of HIGH_RISK_RULES) {
    if (r.test.test(cmd)) return { risk: r.risk, ruleId: r.ruleId, reason: r.reason };
  }
  for (const r of MEDIUM_RISK_RULES) {
    if (r.test.test(cmd)) return { risk: r.risk, ruleId: r.ruleId, reason: r.reason };
  }
  for (const r of LOW_RISK_RULES) {
    if (r.test.test(cmd)) return { risk: r.risk, ruleId: r.ruleId, reason: r.reason };
  }
  return { risk: "medium", ruleId: "unclassified", reason: "Command did not match any catalogued pattern" };
}

/**
 * True iff the catalog says this command is high-risk. Equivalent
 * to `classifyCommandRisk(cmd).risk === "high"` but with a single
 * regex pass.
 */
export function isHighRiskCommand(cmd: string): boolean {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  for (const r of HIGH_RISK_RULES) {
    if (r.test.test(cmd)) return true;
  }
  return false;
}

/** True iff the catalog says this command is at least medium-risk. */
export function isMediumOrHighRiskCommand(cmd: string): boolean {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  for (const r of HIGH_RISK_RULES) {
    if (r.test.test(cmd)) return true;
  }
  for (const r of MEDIUM_RISK_RULES) {
    if (r.test.test(cmd)) return true;
  }
  return false;
}

/** Expose rule counts so tests / dashboards can report coverage. */
export const SHELL_RISK_RULE_COUNTS = Object.freeze({
  high: HIGH_RISK_RULES.length,
  medium: MEDIUM_RISK_RULES.length,
  low: LOW_RISK_RULES.length,
});
