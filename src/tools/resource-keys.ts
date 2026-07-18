import type { ToolCall, ResourceKeys } from "./types.js";
import { EMPTY_RESOURCE_KEYS } from "./types.js";
import { classifyToolCall } from "../execution/planner.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringArg(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function fileKey(path: string | undefined): string[] {
  return path ? [`file:${path}`] : [];
}

function dirKey(path: string | undefined): string[] {
  return path ? [`dir:${path}`] : [];
}

/**
 * Runtime resource declarations for safe parallel scheduling. Unknown tools
 * default to declared:false so they serialize until explicitly reviewed.
 */
export function declaredResourcesForToolCall(call: ToolCall): ResourceKeys {
  const args = asRecord(call.args);
  switch (call.name) {
    case "read_file":
    case "view_file":
    case "file_view":
    case "file_scroll":
    case "file_find":
    case "skim_file":
      return { declared: true, keys: fileKey(stringArg(args, "path")) };

    case "write_file":
    case "replace_in_file":
    case "edit_file":
    case "file_edit":
    case "delete_file":
      return { declared: true, keys: fileKey(stringArg(args, "path", "filePath")) };

    case "list_directory":
      return { declared: true, keys: dirKey(stringArg(args, "path")) };

    case "grep_search": {
      const path = stringArg(args, "path") ?? ".";
      const pattern = stringArg(args, "pattern") ?? "";
      return { declared: true, keys: [`grep:${path}:${pattern}`] };
    }

    case "git_status":
    case "git_diff":
      return EMPTY_RESOURCE_KEYS;

    case "bash": {
      const kind = classifyToolCall(call);
      return kind === "shell_non_barrier" ? EMPTY_RESOURCE_KEYS : { declared: false, keys: ["shell:barrier"] };
    }

      return EMPTY_RESOURCE_KEYS;

    default:
      return { declared: false, keys: [`tool:${call.name}`] };
  }
}
