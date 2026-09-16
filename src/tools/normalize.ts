import { randomUUID } from "node:crypto";

export function normalizeToolCall(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }

  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : randomUUID();
  const rawName =
    typeof raw.name === "string"
      ? raw.name
      : typeof raw.toolName === "string"
        ? raw.toolName
        : typeof raw.tool_name === "string"
          ? raw.tool_name
          : typeof raw.tool === "string"
            ? raw.tool
            : undefined;

  let args: unknown = raw.args;
  if (typeof raw.arguments === "string") {
    try {
      args = JSON.parse(raw.arguments);
    } catch {
      args = { rawArguments: raw.arguments };
    }
  } else if (raw.arguments && typeof raw.arguments === "object") {
    args = raw.arguments;
  } else if (raw.function && typeof raw.function === "object") {
    const fn = raw.function as Record<string, unknown>;
    if (typeof fn.arguments === "string") {
      try {
        args = JSON.parse(fn.arguments);
      } catch {
        args = { rawArguments: fn.arguments };
      }
    } else if (fn.arguments && typeof fn.arguments === "object") {
      args = fn.arguments;
    }
  } else if (raw.toolArgs && typeof raw.toolArgs === "object") {
    args = raw.toolArgs;
  } else if (raw.toolArguments && typeof raw.toolArguments === "object") {
    args = raw.toolArguments;
  } else if (raw.parameters && typeof raw.parameters === "object") {
    args = raw.parameters;
  }

  const inferredName = normalizeToolName(rawName, args);
  let normalizedName = inferredName;

  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;

    // Normalize common arg aliases
    // Every per-tool branch below rebuilds `args` from scratch, keeping only the
    // keys it names. So an alias missing from this list is not merely
    // un-normalized — it is *erased*, and the call is then dropped for a missing
    // required arg. `file_path` in particular is what several providers emit,
    // and its absence here is what produced `args.path: Required` drops.
    const normalizedPath = firstString(
      record.path,
      record.filePath,
      record.file_path,
      record.filename,
      record.file_name,
      record.file,
      raw.toolPath,
      raw.path,
      raw.filePath,
      raw.file_path,
    );
    const normalizedWorkspacePath = normalizeContainerWorkspacePath(normalizedPath);

    const normalizedOld =
      typeof record.oldString === "string"
        ? record.oldString
        : typeof record.old_str === "string"
          ? record.old_str
          : typeof record.old_string === "string"
            ? record.old_string
            : typeof record.oldContent === "string"
              ? record.oldContent
              : typeof raw.old_str === "string"
                ? raw.old_str
                : typeof raw.old_string === "string"
                  ? raw.old_string
                  : undefined;

    const normalizedNew =
      typeof record.newString === "string"
        ? record.newString
        : typeof record.new_str === "string"
          ? record.new_str
          : typeof record.new_string === "string"
            ? record.new_string
            : typeof record.newContent === "string"
              ? record.newContent
              : typeof raw.new_str === "string"
                ? raw.new_str
                : typeof raw.new_string === "string"
                  ? raw.new_string
                  : undefined;

    const normalizedCmd = firstString(record.cmd, record.command, record.script, record.shell_command);

    const normalizedStepId =
      typeof record.stepId === "string"
        ? record.stepId
        : typeof record.step_id === "string"
          ? record.step_id
          : undefined;

    let name = normalizeToolName(rawName, args);
    normalizedName = name;
    switch (name) {
      case "list_directory":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(typeof record.includeHidden === "boolean" ? { includeHidden: record.includeHidden } : {}),
        };
        break;
      case "grep_search":
        args = {
          ...(typeof record.pattern === "string" ? { pattern: record.pattern } : {}),
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(typeof record.include === "string" ? { include: record.include } : {}),
        };
        break;
      case "skim_file":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(typeof record.goalHint === "string" ? { goalHint: record.goalHint } : {}),
        };
        break;
      case "inspect_environment":
        args = {};
        break;
      case "web_search":
        args = {
          ...(typeof record.query === "string" ? { query: record.query } : {}),
          ...(typeof record.engine === "string" ? { engine: record.engine } : {}),
          ...(typeof record.maxResults === "number" ? { maxResults: record.maxResults } : {}),
          ...(typeof record.scrapePages === "number" ? { scrapePages: record.scrapePages } : {}),
        };
        break;
      case "edit_file": {
        const edits = Array.isArray(record.edits)
          ? record.edits
          : normalizedOld !== undefined || normalizedNew !== undefined
            ? [{ oldString: normalizedOld ?? "", newString: normalizedNew ?? "" }]
            : undefined;
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(edits ? { edits } : {}),
        };
        break;
      }
      case "write_file": {
        const content = firstString(record.content, record.text, record.file_text, record.contents);
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(content !== undefined ? { content } : {}),
        };
        break;
      }
      case "delete_file":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
        };
        break;
      case "bash": {
        const timeout =
          typeof record.timeout === "number"
            ? record.timeout
            : typeof record.timeoutMs === "number"
              ? Math.max(1, Math.ceil(record.timeoutMs / 1000))
              : undefined;
        const description =
          typeof record.description === "string"
            ? record.description
            : typeof record.summary === "string"
              ? record.summary
              : undefined;
        args = {
          ...(normalizedCmd ? { cmd: normalizedCmd } : {}),
          ...(description ? { description } : {}),
          ...(timeout !== undefined ? { timeout } : {}),
          ...(typeof record.run_in_background === "boolean" ? { run_in_background: record.run_in_background } : {}),
        };
        break;
      }
      case "file_view": {
        // `startLine` is the camelCase alias of `start_line` only. It was also
        // being copied into `window`, so `{startLine: 400}` asked for a
        // 400-line window — and anything over 500 failed the schema outright.
        //
        // `file_view` also absorbs the retired `view_file` and `file_scroll`
        // names (aliased above). Both asked for a window of a file, which is
        // what this tool is, so they land here rather than on the unknown-tool
        // path. `endLine` is translated into a window size because the schema
        // has no end_line: it is a start plus a length, and a model that says
        // "lines 40 to 60" means a 21-line window at 40.
        const startLine = firstNumber(record.start_line, record.startLine);
        const endLine = firstNumber(record.end_line, record.endLine);
        const explicitWindow = firstNumber(record.window, record.limit, record.numLines, record.num_lines);
        const window =
          explicitWindow ??
          (endLine !== undefined && startLine !== undefined && endLine >= startLine
            ? Math.min(endLine - startLine + 1, 500)
            : undefined);
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(startLine !== undefined ? { start_line: startLine } : {}),
          ...(window !== undefined ? { window } : {}),
        };
        break;
      }
      case "file_find":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(typeof record.pattern === "string" ? { pattern: record.pattern } : {}),
          ...(typeof record.start_line === "number" ? { start_line: record.start_line } : {}),
          ...(typeof record.startLine === "number" ? { start_line: record.startLine } : {}),
        };
        break;
      case "file_edit":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(typeof record.start_line === "number" ? { start_line: record.start_line } : {}),
          ...(typeof record.startLine === "number" ? { start_line: record.startLine } : {}),
          ...(typeof record.end_line === "number" ? { end_line: record.end_line } : {}),
          ...(typeof record.endLine === "number" ? { end_line: record.endLine } : {}),
          ...(typeof record.new_content === "string" ? { new_content: record.new_content } : {}),
          ...(typeof record.newContent === "string" ? { new_content: record.newContent } : {}),
          ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
        };
        break;
      case "browser_use":
        /*
         * Only the arguments the tool actually takes.
         *
         * The old `browser_control` case mapped an `action` verb and a dozen
         * per-action fields. `browser_use` takes a program, so the mapping is
         * three fields and the aliases that a model is likely to write for each:
         * `code`/`script`/`program` for the program, and `intent`/`goal` for the
         * sentence that goes in the journal.
         */
        args = {
          ...(typeof record.code === "string" ? { code: record.code } : {}),
          ...(typeof record.script === "string" ? { code: record.script } : {}),
          ...(typeof record.program === "string" ? { code: record.program } : {}),
          ...(typeof record.intent === "string" ? { intent: record.intent } : {}),
          ...(typeof record.goal === "string" ? { intent: record.goal } : {}),
          ...(typeof record.expected_revision === "number" ? { expected_revision: record.expected_revision } : {}),
          ...(typeof record.timeout_ms === "number" ? { timeout_ms: record.timeout_ms } : {}),
        };
        break;
      /*
       * `read_background_output` / `signal_process` / `write_to_process` are
       * aliased to `job` above, and all three carry the target process as
       * `pid`. `job` names it `jobId`, and it must be the *string* form — the
       * pid is what `bash` returns and what the process map is keyed by.
       * Coercing here means a model that calls the old name, or the new name
       * with a number, still reaches its process.
       */
      case "job": {
        const pid = record.pid ?? record.jobId ?? record.job_id;
        const jobId = typeof pid === "number" ? String(pid) : typeof pid === "string" ? pid : undefined;
        args = {
          ...(typeof record.action === "string" ? { action: record.action } : {}),
          ...(jobId !== undefined ? { jobId } : {}),
          ...(typeof record.signal === "string" ? { signal: record.signal } : {}),
          ...(typeof record.input === "string" ? { input: record.input } : {}),
          ...(typeof record.lines === "number" ? { lines: record.lines } : {}),
        };
        break;
      }
      case "activate_skill":
        args = {
          ...(typeof record.name === "string" ? { name: record.name } : {}),
        };
        break;
      case "web_fetch":
        args = {
          ...(typeof record.url === "string" ? { url: record.url } : {}),
          ...(typeof record.extractText === "boolean" ? { extractText: record.extractText } : {}),
        };
        break;
      case "search_tools":
        args = {
          ...(typeof record.query === "string" ? { query: record.query } : {}),
        };
        break;
      case "scratchpad":
        args = {
          ...(typeof record.action === "string" ? { action: record.action } : {}),
          ...(typeof record.note === "string" ? { note: record.note } : {}),
          ...(typeof record.label === "string" ? { label: record.label } : {}),
        };
        break;
      case "search_memory":
        args = {
          ...(typeof record.query === "string" ? { query: record.query } : {}),
          ...(typeof record.max_hits === "number" ? { max_hits: record.max_hits } : {}),
          ...(typeof record.include_body === "boolean" ? { include_body: record.include_body } : {}),
          ...(typeof record.session_id === "string" ? { session_id: record.session_id } : {}),
          ...(typeof record.since === "string" ? { since: record.since } : {}),
        };
        break;
      default:
        // Preserve original args for tools without a dedicated normalizer
        // (skills, extensions, hooks, etc.). Only overlay path/cmd aliases
        // when present — never wipe the payload to those keys alone.
        args = {
          ...record,
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(normalizedCmd ? { cmd: normalizedCmd } : {}),
        };
        break;
    }
  }

  return {
    id,
    name: normalizedName,
    args,
  };
}

/** First argument that is a string, so alias lists read as a flat sequence. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number") return value;
  }
  return undefined;
}

function normalizeContainerWorkspacePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, "/");
  if (normalized === "/app") return ".";
  if (normalized.startsWith("/app/")) return normalized.slice("/app/".length);
  return value;
}


/**
 * The model-facing names, mapped onto registry keys.
 *
 * Module-level rather than a local in `normalizeToolName` because a second
 * caller needs the same answer: Code Mode's bridge offers `tools.*`, and a
 * model that has learned `read` and `write` from the alias surface of the
 * ordinary tool list will reach for `tools.read` first. See
 * `canonicalToolName`.
 */
export const TOOL_ALIASES: Readonly<Record<string, string>> = {
    bash: "bash",
    browser: "browser_use",
    browser_use: "browser_use",
    browser_action: "browser_use",
    /*
     * Native-desktop synonyms are deliberately *not* mapped onto
     * `browser_control`. A model that asks for `computer_use` or `screenshot`
     * is asking to drive the host machine, which Reaper does not do; silently
     * redirecting that to a headless page automation would be a different
     * action wearing the same name, and the model would never learn otherwise.
     * An unmapped name falls through to the unknown-tool path, which says so.
     */
    read: "file_view",
    open_file: "file_view",
    /*
     * `view_file` and `file_scroll` are mapped onto `file_view`, not kept as
     * names of their own. Both were window-of-a-file operations and `file_view`
     * is exactly that; there is no second action left for a distinct name to
     * mean, and `file_view` with an explicit `start_line` is stateless, so a
     * model that says `file_scroll direction=down` still gets its lines.
     *
     * `file_scroll` deliberately keeps no `direction` handling: the argument
     * describes a cursor that no longer exists, so honouring it would require
     * reintroducing the per-run viewport this consolidation removed.
     */
    view_file: "file_view",
    view: "file_view",
    file_scroll: "file_view",
    scroll_file: "file_view",
    list: "list_directory",
    ls: "list_directory",
    search: "grep_search",
    grep: "grep_search",
    write: "write_file",
    create_file: "write_file",
    write_to_file: "write_file",
    edit: "file_edit",
    replace: "file_edit",
    delete: "delete_file",
    /*
     * The three process-control names all map onto `job`, which is the same
     * three operations behind one action argument. `get_tool_output` is
     * deliberately absent: it took a Reaper-internal `artifactId`, and there is
     * no path to redirect it to — the equivalent today is the persisted output
     * path that `bash` returns, which is a `file_view`. Guessing at one from an
     * artifact id would invent an answer, so it falls through to the
     * unknown-tool path and says so.
     */
    read_background_output: "job",
    read_process_output: "job",
    signal_process: "job",
    write_to_process: "job",
    job_control: "job",
};

/**
 * A model-facing tool name resolved to the registry key it means.
 *
 * Exported so Code Mode can answer the same question the executor does. The
 * problem it solves is that the model learns tool names in two places and they
 * do not agree: the ordinary tool list is presented with aliases folded in
 * (`read`, `write`, `grep` are all names a model will have seen and used), while
 * `tools.*` inside eval was keyed strictly on registry names. So a model that
 * had just called `read` successfully would write `await tools.read(...)`,
 * and be told there is no such tool — while `file_view` sat right there in
 * `tools.list()`. The names the model knows are the names it should be able to
 * use; making it learn a second vocabulary to reach the same tools is a tax on
 * exactly the thing that makes Code Mode worth reaching for.
 *
 * Unchanged name in, unchanged name out: this maps the aliases and has no
 * opinion about whether the result exists. Callers check that themselves — the
 * bridge tests the outcome against the registry, which stays the single source
 * of truth for what a tool is called.
 */
export function canonicalToolName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return TOOL_ALIASES[normalized] ?? name;
}

/**
 * Every other name a tool answers to, given its registry key.
 *
 * The reverse of the table above, and the reason it exists is `describe`. Code
 * Mode answers `tools.describe(name)` out of a map built once per call, keyed by
 * the names the bridge offers — canonical ones. But the bridge *accepts* the
 * aliases, so without this `tools.read(...)` works and `tools.describe("read")`
 * returns `undefined`, which reads as "that tool takes no arguments" rather
 * than "you asked about it under a name I do not index". Returning the names
 * means the map can carry both keys and the two answers agree.
 *
 * Identity entries are dropped: `bash: "bash"` is in the table so that a bare
 * `bash` normalizes, not because `bash` is an alias of itself, and returning it
 * would have callers add duplicate keys.
 */
export function aliasesForTool(canonical: string): readonly string[] {
  return Object.entries(TOOL_ALIASES)
    .filter(([alias, target]) => target === canonical && alias !== canonical)
    .map(([alias]) => alias);
}

function normalizeToolName(rawName: string | undefined, _args: unknown): string | undefined {
  const canonical = rawName?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = TOOL_ALIASES;
  if (canonical && aliases[canonical]) {
    return aliases[canonical];
  }
  return rawName;
}
