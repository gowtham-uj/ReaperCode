import type { ToolCall } from "../tools/types.js";

export function getShellCommandArg(call: ToolCall): string {
  return call.name === "bash" && typeof call.args.cmd === "string" ? call.args.cmd : "";
}


export function isMutatingToolCall(call: ToolCall): boolean {
  if (call.name === "sandbox_service_control") {
    return ["exec", "write_file", "copy_to_service", "restore_from_image", "restart", "start", "stop"].includes(call.args.action);
  }
  return call.name === "write_file" || call.name === "edit_file" || call.name === "replace_in_file" || call.name === "replace_symbol" || call.name === "delete_file";
}

