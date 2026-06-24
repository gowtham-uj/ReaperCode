import type { ToolCall } from "../tools/types.js";

export type ExecutionKind = "read" | "write" | "shell_barrier" | "shell_non_barrier";

const barrierCommandPatterns = [
  /\bnpm\b/,
  /\bnpx\b/,
  /\bpnpm\b/,
  /\byarn\b/,
  /\bbun\b/,
  /\bpytest\b/,
  /\bgo\s+test\b/,
  /\bcargo\b/,
  /\bmake\b/,
  /\bcmake\b/,
  /\bpip\s+install\b/,
  /\bgit\s+commit\b/,
  /\bnode\b.*\btest\b/,
  /\b(?:nodemon|tsx|ts-node)\b.*\b(?:server|index|app)\.[cm]?[jt]s\b/,
  /\bnode\b\s+(?:(?:index|app|server)\.[cm]?js|(?:server|src|api|backend)\/(?:server|index|app)\.[cm]?js)\b/,
  /\btouch\b/,
  /\bcp\b/,
  /\bmv\b/,
  /\brm\b/,
  /\bmkdir\b/,
  />/,
  /\|/,
];

export function classifyToolCall(call: ToolCall): ExecutionKind {
  if (call.name === "complete_task") {
    return "shell_barrier";
  }

  if (call.name === "delegate_to_plan") {
    return "read";
  }

  if (call.name === "get_tool_output") {
    return "read";
  }
  if (call.name === "read_file" || call.name === "list_directory" || call.name === "grep_search" || call.name === "git_status" || call.name === "git_diff") {
    return "read";
  }

  if (
    call.name === "write_file" ||
    call.name === "replace_in_file" ||
    call.name === "replace_symbol" ||
    call.name === "delete_file" ||
    call.name === "create_checkpoint" ||
    call.name === "restore_checkpoint"
  ) {
    return "write";
  }

  if (call.name === "run_shell_command") {
    if (call.args.forceNonBarrier === true) {
      return "shell_non_barrier";
    }

    if (call.args.barrier === true) {
      return "shell_barrier";
    }

    if (barrierCommandPatterns.some((pattern) => pattern.test(call.args.cmd))) {
      return "shell_barrier";
    }

    return "shell_non_barrier";
  }

  if (call.name === "sandbox_service_control") {
    if (["exec", "write_file", "copy_to_service", "restart", "start", "stop"].includes(call.args.action)) {
      return "shell_barrier";
    }
    return "read";
  }

  return "read";
}
