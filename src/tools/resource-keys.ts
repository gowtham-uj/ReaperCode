import path from "node:path";

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

/**
 * Normalize a path into a collision key.
 *
 * These keys decide whether two calls may run concurrently, so two
 * spellings of the same file MUST produce the same key. `./src/app.ts`,
 * `src/app.ts`, and `src/sub/../app.ts` are one file — and on
 * case-insensitive filesystems (macOS, Windows) so are `src/App.ts` and
 * `src/app.ts`. Without folding, two writes to the same file land in the
 * same island and race, last-write-wins.
 *
 * Case folding is unconditional rather than platform-gated: treating
 * distinct files as colliding only costs a little parallelism, while
 * missing a real collision corrupts file content.
 */
function normalizePathKey(target: string): string {
  return path.normalize(target).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function fileKey(target: string | undefined): string[] {
  return target ? [`file:${normalizePathKey(target)}`] : [];
}

function dirKey(target: string | undefined): string[] {
  return target ? [`dir:${normalizePathKey(target)}`] : [];
}

/**
 * Runtime resource declarations for safe parallel scheduling. Unknown tools
 * default to declared:false so they serialize until explicitly reviewed.
 */
export function declaredResourcesForToolCall(call: ToolCall): ResourceKeys {
  const args = asRecord(call.args);
  switch (call.name) {
    case "view_file":
    case "file_view":
    case "file_scroll":
    case "file_find":
    case "skim_file":
      return { declared: true, keys: fileKey(stringArg(args, "path")) };

    case "write_file":
    case "edit_file":
    case "file_edit":
    case "delete_file":
      return { declared: true, keys: fileKey(stringArg(args, "path", "filePath")) };

    case "list_directory":
      return { declared: true, keys: dirKey(stringArg(args, "path")) };

    case "grep_search": {
      const target = stringArg(args, "path") ?? ".";
      const pattern = stringArg(args, "pattern") ?? "";
      return { declared: true, keys: [`grep:${normalizePathKey(target)}:${pattern}`] };
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
