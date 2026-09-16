/**
 * Running a model's browser program somewhere it cannot read the filesystem.
 *
 * ## The problem this solves, and why it is not the obvious shape
 *
 * `browser_use` runs model-written Playwright in the app-server process, next to
 * the provider keys. A program can call
 * `process.getBuiltinModule("node:fs").readFileSync("/etc/hostname")` and get
 * real content. `eval` is confined by bubblewrap; `browser_use` was not, and a
 * hole beside a wall is the wall.
 *
 * The obvious fix is to give the sandboxed worker its own CDP connection. That
 * fix is wrong, and it was measured rather than reasoned about. Three
 * connections to Steel were opened and probed:
 *
 *     thread A   contexts=2, its own page at example.com
 *     thread B   contexts=2, sees 17 pages total, including A's
 *     fresh      contexts=1, sees 17 pages, including both
 *
 * Every connection sees every page. `connectOverCDP` has no per-target
 * restriction, and a *page-level* endpoint is no better: `Target.getTargets` on
 * one returned all 21 targets. So a worker with its own connection would reach
 * every other thread's tabs, and the isolation that `scoped-page.ts` provides
 * today would be gone. Steel cannot help either: it has one `browserInstance`,
 * and every session's `websocketUrl` is the same global address. Its own
 * architecture doc says a session gets an isolated browser *context*, and
 * contexts are per-connection, which is exactly the mechanism that fails here.
 *
 * ## What this does instead
 *
 * The program runs in the sandbox with **no browser connection at all**. It gets
 * a proxy: every Playwright call becomes a frame over the IPC socket the eval
 * relay already carries, and the host replays it against the real, scoped page.
 * The program's reach is therefore exactly the reach of the page it was handed,
 * which is the scoped one, so confinement and per-thread isolation both hold.
 *
 * The cost is one round trip per Playwright call. On a click that is a millisecond
 * against the tens Playwright already spends, and it is the price of the only
 * arrangement that gives both properties.
 *
 * ## Why the proxy is generic rather than a list of methods
 *
 * A hand-written subset of the Page and Locator APIs would be wrong in a way
 * that fails at the call site: a model writes `getByRole(...).filter(...)` and
 * the proxy has never heard of `filter`. So the proxy carries a *path* rather
 * than a method table. `page.locator("#x").click()` accumulates
 * `[locator("#x"), click()]`, and the host replays exactly that against the real
 * object. Anything Playwright has works, including API added after this was
 * written, because the host is calling the same library the model is.
 *
 * The path is data, so a program cannot smuggle a property access into it that
 * the host would treat as a method call, and the host only ever invokes methods
 * on objects it resolved itself.
 */

import { playwrightName } from "./serialize.js";

/** One step of a program's call chain. */
export interface CallStep {
  /** The property name invoked. */
  method: string;
  /** Arguments, already structurally cloned across the boundary. */
  args: unknown[];
}

/** What the host sends back for one call. */
export type CallResult =
  | { kind: "value"; value: unknown }
  | { kind: "handle"; handle: number; name: string }
  | { kind: "error"; message: string; name?: string | undefined };

/**
 * How deep a chain of live objects one program may hold.
 *
 * Playwright objects are handles, and a handle table is state the host owns for
 * the length of a program. Bounded so a loop that collects locators cannot grow
 * it without limit; the number is far above any real program's working set.
 */
export const MAX_LIVE_HANDLES = 2_000;

/** How many arguments one call may carry, so a huge blob cannot cross the wire. */
const MAX_ARGS = 32;

/**
 * The host's side of the proxy: a table of live Playwright objects and a replay
 * for the call paths a program sends.
 *
 * Deliberately not a class with a lifecycle of its own. It is created per
 * program, holds handles for the length of that program, and is dropped with it,
 * so there is nothing to dispose and no state that can outlive the step it
 * belongs to.
 */
export class RemotePageHost {
  private readonly handles = new Map<number, unknown>();
  private nextHandle = 1;
  private readonly rootHandles: Record<string, number> = {};

  /**
   * Take the objects a program's surface roots at.
   *
   * Named rather than positional so the worker's `browserRoots` and this agree
   * by construction: the names are the same words, and adding a root means
   * adding it in both places rather than shifting every index by one.
   */
  constructor(primary: unknown, roots: Record<string, unknown> = {}) {
    this.handles.set(0, primary);
    this.rootHandles["page"] = 0;
    for (const [name, value] of Object.entries(roots)) {
      const handle = this.nextHandle++;
      this.handles.set(handle, value);
      this.rootHandles[name] = handle;
    }
  }

  /** The handles the program's surface roots at, by name. */
  roots(): Record<string, number> {
    return { ...this.rootHandles };
  }

  /**
   * Replay one call chain and describe the result.
   *
   * Replays from the object named by `handle`, so a program that holds
   * intermediate values does not pay to rebuild the chain each time. The walk is
   * strictly a sequence of method calls: there is no way for a program to name a
   * property directly, which is what keeps this from being an escape hatch into
   * Playwright's internals.
   */
  async call(handle: number, path: CallStep[]): Promise<CallResult> {
    const start = this.handles.get(handle);
    if (start === undefined) {
      return { kind: "error", name: "StaleHandle", message: `the object this call was made on is no longer available (handle ${handle})` };
    }

    let current: unknown = start;
    try {
      for (const step of path) {
        current = await this.step(current, step);
      }
    } catch (error) {
      /*
       * A thrown Playwright call is the program's own failure and must arrive as
       * one. Swallowing it into a value would turn "the click timed out because
       * a dialog is in the way" into `undefined`, which is the failure the whole
       * receipt design exists to prevent.
       */
      const failure = error as Error;
      return { kind: "error", name: failure.name, message: failure.message };
    }

    return this.describe(current);
  }

  /** One step: get the named method off the current object and call it. */
  private async step(current: unknown, step: CallStep): Promise<unknown> {
    if (current === null || current === undefined) {
      throw new Error(`cannot call ${step.method}(): the value before it was ${current === null ? "null" : "undefined"}`);
    }
    if (step.args.length > MAX_ARGS) {
      throw new Error(`${step.method}() was called with ${step.args.length} arguments, which is more than the ${MAX_ARGS} this bridge accepts`);
    }

    const target = current as Record<string, unknown>;
    const member = target[step.method];
    if (typeof member !== "function") {
      throw new Error(`${step.method} is not a method on this object`);
    }

    /*
     * Revived arguments, for the one shape that cannot cross IPC as data: a
     * function. `page.evaluate(fn)` and `locator.waitFor({ state })` both take
     * them, and Playwright itself sends a function to the browser as source, so
     * rebuilding it here is the same mechanism rather than a new one.
     */
    const args = step.args.map((arg) => this.revive(reviveArgument(arg)));
    return await (member as (...given: unknown[]) => unknown).apply(current, args);
  }

  /**
   * Describe a value for the wire: a handle when it is a live Playwright object,
   * a plain value when it is anything else.
   */
  private describe(value: unknown): CallResult {
    if (Array.isArray(value)) {
      /*
       * `locator.all()` is the case this exists for: it returns an array of
       * Locators, and serializing those as plain objects would hand the program
       * a pile of internals it cannot call. Each element is described
       * recursively, so an array of handles arrives as an array of handles.
       */
      const items: unknown[] = [];
      for (const item of value) {
        if (playwrightName(item) !== undefined) {
          const handle = this.remember(item);
          if (handle === undefined) return { kind: "error", name: "TooManyHandles", message: handleFailure() };
          items.push({ __reaperHandle: handle });
        } else {
          items.push(item);
        }
      }
      return { kind: "value", value: items };
    }

    const name = playwrightName(value);
    if (name !== undefined) {
      const handle = this.remember(value);
      if (handle === undefined) return { kind: "error", name: "TooManyHandles", message: handleFailure() };
      return { kind: "handle", handle, name };
    }

    return { kind: "value", value };
  }

  /**
   * Replace a handle marker with the live object it names.
   *
   * Done here rather than in `reviveArgument` because the table is the host's,
   * and a free function has no business reaching into it. An unknown handle is
   * an error rather than `undefined`: passing `undefined` to Playwright would
   * fail with a message about the argument's type, which is the wrong fact.
   */
  private revive(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => this.revive(item));
    const candidate = value as { __reaperNode?: unknown };
    if (typeof candidate.__reaperNode !== "number") return value;
    const held = this.handles.get(candidate.__reaperNode);
    if (held === undefined) {
      throw new Error(`the object passed as an argument is no longer available (handle ${candidate.__reaperNode})`);
    }
    return held;
  }

  /** Store a live object and return its handle, or undefined when the table is full. */
  private remember(value: unknown): number | undefined {
    for (const [id, held] of this.handles) {
      if (held === value) return id;
    }
    if (this.handles.size >= MAX_LIVE_HANDLES) return undefined;
    const handle = this.nextHandle++;
    this.handles.set(handle, value);
    return handle;
  }
}

function handleFailure(): string {
  return `the program is holding more than ${MAX_LIVE_HANDLES} live page objects, which is more than this bridge tracks`;
}

/**
 * Rebuild an argument that cannot travel as structured data.
 *
 * Only functions need this. They arrive as `{ __reaperFn: "<source>" }` and are
 * rebuilt with `new Function`, which is what Playwright does with the functions
 * it sends into the page. The consequence is the same one Playwright documents:
 * the function must be self-contained, because its closure did not come with it.
 */
function reviveArgument(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    // An array can hold handles, so it is walked rather than passed through.
    return value.map((item) => reviveArgument(item));
  }
  const candidate = value as { __reaperFn?: unknown; __reaperNode?: unknown };
  /*
   * A live object travelling as an argument, sent by the worker as its handle.
   *
   * `browser.closePage(tab)` is the call that found this: without it the page
   * arrived as `{}` and the failure named the method rather than the argument.
   */
  if (typeof candidate.__reaperNode === "number") return value;
  if (typeof candidate.__reaperFn !== "string") return value;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(`return (${candidate.__reaperFn})`)();
  } catch {
    /*
     * A function that does not parse is refused rather than passed through,
     * because passing the wrapper object to Playwright would fail with a message
     * about an unexpected argument rather than about the real problem.
     */
    throw new Error("a function argument could not be rebuilt from its source");
  }
}
