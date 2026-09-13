/**
 * Turning a filesystem errno into an answer a model can act on.
 *
 * Every read tool resolves a `path` argument and then hits the filesystem, so
 * every one of them can fail the same ways: the path is missing, the path is
 * the wrong *kind* of thing (a file where a directory was wanted, or the
 * reverse), permission was denied, or the path escapes the sandbox. Left
 * alone, Node reports each of these as an `Error` whose `code` is a POSIX
 * errno and whose message is written for a person reading a stack trace.
 *
 * The executor copies that `code` and message straight into the envelope the
 * model reads, so "unhandled" does not mean "silent" — it means the model
 * receives `ENOTDIR: not a directory, scandir '/…/src/legacy.ts'`, naming no
 * tool, no argument, and no alternative. A model cannot tell which of its
 * arguments was rejected, so it usually just repeats the call.
 *
 * That is not hypothetical. `grep_search` refused a file path this way during a
 * live run; the model read the errno as a broken tool, reasoned
 * "grep_search fails because it treats path as dir?", and abandoned the call.
 * **A valid request that fails with an unreadable error costs more than the one
 * call — it teaches the model the tool is unreliable**, and the model then
 * routes around the tool for the rest of the session.
 *
 * This is one shared module because the alternative already failed once:
 * `grep_search` and its recovery-session (`WAL`) twin were separate copies of
 * the same logic, so fixing the direct path would have left the bug live in the
 * recovery path. Anything translating errnos for a tool belongs here.
 */

/** A failure whose `code` the executor will carry into the model's result envelope. */
export class ToolArgumentError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_argument" | "not_found" | "io_error" | "permission_denied",
  ) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

export interface FileErrorContext {
  /** The path exactly as the model passed it, so the message quotes its own words back. */
  requestedPath: string;
  /** What the tool needs the path to be. */
  needs: "file" | "directory";
  /**
   * The tool to use when the path turns out to be the other kind, as a phrase
   * the message can finish with — e.g. `` `list_directory` for a directory's
   * entries ``.
   */
  instead: string;
}

/**
 * Run `fn`, translating a raw filesystem errno into a `ToolArgumentError`.
 *
 * `ENOTDIR` and `EISDIR` are the same mistake in opposite directions, so both
 * are reported as "this is the wrong kind of thing, here is the tool that wants
 * it". Anything without a code we recognise is rethrown untouched rather than
 * flattened into a generic error, because an errno we do not know is a bug
 * worth surfacing, not a message worth guessing at.
 */
export async function withFileErrors<T>(context: FileErrorContext, fn: () => Promise<T>): Promise<T> {
  const { requestedPath, needs, instead } = context;
  try {
    return await fn();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;

    if (code === "ENOTDIR" || code === "EISDIR") {
      const actual = needs === "file" ? "a directory, not a file" : "a file, not a directory";
      throw new ToolArgumentError(
        `'${requestedPath}' is ${actual}. Use ${instead}, or pass a path that is ${needs === "file" ? "a file" : "a directory"}.`,
        "invalid_argument",
      );
    }
    if (code === "ENOENT") {
      throw new ToolArgumentError(`No such ${needs}: '${requestedPath}'.`, "not_found");
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new ToolArgumentError(`Permission denied reading '${requestedPath}'.`, "permission_denied");
    }
    throw error;
  }
}

/** The `code` an executor reads off a thrown error to build the model's envelope. */
export function errorCodeOf(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}
