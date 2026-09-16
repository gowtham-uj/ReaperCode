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

    /*
     * An index into an array, which is a step like any other.
     *
     * `contexts()[0]` and `(await pages)[0]` both arrive here, because the
     * sandbox cannot know whether a chain is an array until the host runs it.
     * Refusing it was what made `others[0].goto(...)` fail with a message about
     * the method when the chain simply had not been resolved.
     */
    if (Array.isArray(current) && /^\d+$/.test(step.method) && step.args.length === 0) {
      return (current as unknown[])[Number(step.method)];
    }

    /*
     * The object itself is being called, which happens only for a root.
     *
     * `pages()` is the case: the worker's root is the host's own function, and
     * there is no property to look up because the call is the whole operation.
     * The marker name is prefixed the same way the node marker is, so no
     * Playwright member can collide with it and a program cannot produce it by
     * naming a real method.
     */
    if (step.method === "__reaperInvoke") {
      if (typeof current !== "function") {
        throw new Error("this object is not callable");
      }
      return await (current as (...given: unknown[]) => unknown).apply(undefined, step.args.map((arg) => this.resolve(reviveArgument(arg))));
    }

    const target = current as Record<string, unknown>;
    const member = target[step.method];
    /*
     * A property read, not a call. `page.context().browser().contexts().length`
     * is the shape that found this: the sandbox cannot tell a property from a
     * method, so `.length` arrives as a step with no arguments, and refusing it
     * made every program that reads a length or an attribute fail with a message
     * about a method that does not exist.
     *
     * Reading it is safe because the host resolved `current` itself: this
     * returns a property of an object the program legitimately holds, and the
     * program still cannot name a property it did not reach through a chain of
     * calls it was allowed to make.
     */
    if (typeof member !== "function") {
      if (step.args.length > 0) {
        throw new Error(`${step.method} is not a method on this object`);
      }
      return member;
    }

    /*
     * Revived arguments, for the one shape that cannot cross IPC as data: a
     * function. `page.evaluate(fn)` and `locator.waitFor({ state })` both take
     * them, and Playwright itself sends a function to the browser as source, so
     * rebuilding it here is the same mechanism rather than a new one.
     */
    const args = step.args.map((arg) => this.resolve(reviveArgument(arg)));
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
   * Public because the observation helpers need it and do not go through
   * `call`. An unknown handle is an error rather than `undefined`: passing
   * `undefined` to Playwright would fail with a message about the argument's
   * type, which is the wrong fact.
   */
  resolve(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => this.resolve(item));
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
 * Walk an argument for the one thing the host must never do: call a function.
 *
 * There is nothing to rebuild any more, and that is deliberate. Arguments are
 * data: the sandbox refuses to send a function at all (see
 * `remote-page-source.ts`, which explains the escape this closed), so this only
 * has to recurse through containers and hand back what it was given.
 *
 * The revival that used to live here was `new Function("return (" + src + ")")()`
 * and it ran *in this process*. A payload shaped like
 * `0) || (process.getBuiltinModule('fs').writeFileSync(...), 0) || (0` closed the
 * wrapper's paren and executed at revival time, in the app-server, before
 * Playwright was ever reached. Reproduced by writing a file to the host
 * filesystem from a sandboxed program. Deleting the primitive is the fix; a
 * smarter parser would only move the boundary.
 */
function reviveArgument(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => reviveArgument(item));
  const candidate = value as { __reaperFn?: unknown };
  /*
   * Belt to the sandbox's braces. The worker refuses to encode a function, so a
   * wrapper arriving here means something bypassed it, and running it is exactly
   * what must not happen. Named so the failure says which side sent it.
   */
  if (typeof candidate.__reaperFn === "string") {
    throw new Error("a function argument reached the browser bridge; functions must not cross this boundary");
  }
  return value;
}
