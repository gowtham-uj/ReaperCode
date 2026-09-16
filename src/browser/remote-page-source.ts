/**
 * The program that builds `page` inside the sandbox.
 *
 * Kept as a string rather than a module, for the reason `worker-source.ts` and
 * `sandbox-relay.ts` are: `npm run build:binary` esbuilds everything into one
 * self-contained file with no siblings, so a `.js` a sandboxed process resolves
 * by path would exist in the dev tree and be missing from the shipped binary.
 *
 * ## The proxy
 *
 * What the program holds is a *path*, not an object. `page.getByRole("button")
 * .click()` builds `[getByRole("button"), click()]` and sends it in one frame
 * when the program awaits it. That is what makes this work for any Playwright
 * API rather than a list someone has to maintain: the host replays the same
 * calls on the real page, so the surface is whatever Playwright has.
 *
 * Two details make the proxy behave like the real thing:
 *
 * **It is awaitable.** A Playwright `click()` returns a promise, so `await
 * page.click(...)` has to work, and so does `.then()` on a chain that has not
 * been awaited yet. The proxy implements `then`, which is what turns a
 * recorded chain into a real call.
 *
 * **It is chainable and holds values.** `const row = page.getByRole("row")`
 * must survive being stored and used later, so a chain that is not awaited
 * resolves to a handle the host keeps alive, and further calls replay from that
 * handle rather than from the page.
 *
 * ## What it deliberately does not do
 *
 * It does not pass any object through. Every value that comes back is a plain
 * clone, so a program cannot reach a Playwright internal and call a method the
 * host never saw. The only way to act on the page is to name a method the host
 * will invoke on an object it resolved itself.
 */
export const REMOTE_PAGE_SOURCE = String.raw`
'use strict';

/**
 * Build the browser surface for a program running in the sandbox.
 *
 * \`__pageCall\` is the host's transport: it takes a handle, a path and the
 * arguments, replays the path against the real page, and answers with a value,
 * a new handle, or an error.
 */
function buildRemoteBrowser(__pageCall, __pageRoot, __pageView) {
  const promise = Promise.resolve();

  /* Arguments that cannot be cloned are sent as source, and rebuilt by the host. */
  async function encodeArgument(value, depth) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
    /*
     * The node check comes FIRST, before the function check, and the ordering is
     * load-bearing. A node is a Proxy over a function, so typeof is 'function'
     * for it, and testing for a function first would serialize every one as
     * source text: view(page.locator("form")) would send a function's toString
     * instead of the region, which is the silent-scoping bug returning through a
     * different door.
     */
    const marker = value.__reaperNode;
    if (marker && typeof marker.handle === 'number') {
      if (marker.path && marker.path.length > 0) {
        const resolved = await run(marker.handle, marker.path);
        const resolvedMarker = resolved && resolved.__reaperNode;
        return { __reaperNode: resolvedMarker ? resolvedMarker.handle : marker.handle };
      }
      return { __reaperNode: marker.handle };
    }
    if (typeof value === 'function') return { __reaperFn: value.toString() };
    if (depth > 8) return value;
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) out.push(await encodeArgument(item, depth + 1));
      return out;
    }
    const out = {};
    for (const key of Object.keys(value)) out[key] = await encodeArgument(value[key], depth + 1);
    return out;
  }

  function decodeValue(value, depth) {
    if (value === null || typeof value !== 'object') return value;
    if (typeof value.__reaperHandle === 'number') {
      /* A live object the program can keep using. */
      return makeNode(value.__reaperHandle, []);
    }
    if (depth > 8) return value;
    if (Array.isArray(value)) return value.map((item) => decodeValue(item, depth + 1));
    const out = {};
    for (const key of Object.keys(value)) out[key] = decodeValue(value[key], depth + 1);
    return out;
  }

  /*
   * A node: callable, awaitable, and chainable, all at once.
   *
   * The proxy targets a *function* rather than a plain object, which is what
   * lets one expression serve both a call and a read. Playwright needs both:
   * page.locator("a").count() calls, contexts()[0] indexes, and a bare chain
   * awaited for its value is a read. An object target cannot be called, and a
   * plain function target shadows the proxy with its own length and name, so
   * neither alone works.
   *
   * Everything stays lazy: a node accumulates a path and the host runs the whole
   * path when the program awaits it. Indexing and property reads are steps like
   * any other, so contexts().filter(f)[0].goto(url) is one round trip, not four.
   */
  function makeNode(handle, path) {
    const handler = {
      get(_target, property) {
        if (typeof property === 'symbol') return undefined;
        /*
         * The marker that lets this node travel as an argument. Read by
         * encodeArgument above; not part of the Playwright surface, and named
         * with a prefix a page cannot collide with.
         */
        if (property === '__reaperNode') return { handle: handle, path: path };
        if (property === 'then') {
          /*
           * Awaiting runs the chain, which is what makes await page.click()
           * work.
           *
           * A node with an empty path is already resolved and must NOT be
           * thenable: resolving a promise with a thenable makes JavaScript
           * unwrap it by calling then, so a resolved node would run the empty
           * path, resolve to another thenable, and loop forever. That cost a
           * heap exhaustion to find, and it is why this branch exists.
           */
          if (path.length === 0) return undefined;
          return (onFulfilled, onRejected) =>
            run(handle, path).then(
              (value) => (onFulfilled ? onFulfilled(value) : value),
              onRejected,
            );
        }
        /*
         * catch and finally work, because a real Playwright call has them and a
         * model writes them.
         *
         * They were undefined in the first version and that is the kind of
         * difference that misleads rather than fails: Playwright's own API
         * returns promises, so .catch(() => fallback) is an idiom a model
         * reaches for without thinking, and getting "catch is not a function"
         * teaches it that the page is broken rather than that the bridge is
         * narrow. Both resolve the chain and delegate, so the semantics match
         * what the model already knows.
         */
        if (property === 'catch' || property === 'finally') {
          const run1 = (onFulfilled, onRejected) =>
            run(handle, path).then(
              (value) => (onFulfilled ? onFulfilled(value) : value),
              onRejected,
            );
          if (path.length === 0) {
            // An already-resolved node: nothing to catch, and finally still
            // has to run the callback the model passed.
            return property === 'catch'
              ? (onRejected) => run1(undefined, onRejected)
              : (onFinally) => { const r = run1(undefined, undefined); if (onFinally) onFinally(); return r; };
          }
          return property === 'catch'
            ? (onRejected) => run1(undefined, onRejected)
            : (onFinally) => run1(undefined, undefined).then((v) => { if (onFinally) onFinally(); return v; });
        }
        if (property === 'constructor') return undefined;
        if (property === 'apply' || property === 'call' || property === 'bind') return undefined;
        /*
         * Everything else extends the path. Whether the program meant a call or
         * a read is decided by the host when it runs the step: a method is
         * invoked, a property is read, and an index into an array takes the
         * element.
         */
        return makeNode(handle, path.concat([[property, []]]));
      },
      apply(_target, _thisArg, args) {
        /*
         * A call replaces the last step's arguments. The last step is the method
         * name, so page.locator("a").count() becomes locator(a) then count(),
         * and the arguments land on the step they belong to rather than being
         * appended after it.
         *
         * Calling a *root* is the case that made this branch exist. pages() is a
         * root the host owns, so the call is an invoke on handle 2 with no step
         * before it, and returning the node unchanged meant the call never
         * reached the host: pages() came back as an unawaited value. A marker
         * step is what carries the arguments, and the host reads it as "call
         * this object itself".
         */
        if (path.length === 0) return makeNode(handle, [['__reaperInvoke', args]]);
        const last = path[path.length - 1];
        const head = path.slice(0, -1);
        return makeNode(handle, head.concat([[last[0], args]]));
      },
      has() {
        return true;
      },
    };
    return new Proxy(function () {}, handler);
  }

  /* One round trip. The path is encoded so functions survive, values decoded so handles come back live. */
  async function run(handle, path) {
    /*
     * Sequentially, not with Promise.all. Encoding an argument may itself be a
     * round trip (a pending chain passed as an argument), and those have to
     * reach the host in the order the program wrote them: the host resolves them
     * against a handle table that has to still hold what the earlier ones named.
     */
    const encoded = [];
    for (const step of path) {
      const args = [];
      for (const arg of step[1]) args.push(await encodeArgument(arg, 0));
      encoded.push([step[0], ...args]);
    }
    const reply = await __pageCall(handle, encoded);
    if (!reply || typeof reply !== 'object') {
      throw new Error('the browser bridge returned nothing for ' + path.map((s) => s[0]).join('.'));
    }
    if (reply.kind === 'error') {
      const error = new Error(reply.message || 'the page call failed');
      if (reply.name) error.name = reply.name;
      throw error;
    }
    if (reply.kind === 'handle') return makeNode(reply.handle, []);
    return decodeValue(reply.value, 0);
  }

  /*
   * The handles that are not the page. Each is a node rooted at its own handle,
   * so a program cannot reach from one to another except by a call the host
   * replays and accepts.
   */
  /*
   * The helpers encode their arguments the same way a method call does.
   *
   * They have to, and skipping it was a bug with a silent failure. A helper
   * receives its arguments as raw JavaScript, so \`view(page.locator("form"))\`
   * handed the transport a live proxy node. A node is a Proxy over an empty
   * object, so it crosses the boundary as nothing, the host received no target,
   * and the helper read the whole page: the scoping a program asked for was
   * silently ignored and it paid for the page anyway. Encoding resolves a
   * pending chain to the handle the host should actually look at.
   */
  async function callHelper(name, args) {
    const encoded = [];
    for (const arg of args) encoded.push(await encodeArgument(arg, 0));
    return __pageView(name, encoded);
  }

  return {
    page: makeNode(__pageRoot.page, []),
    browser: makeNode(__pageRoot.browser, []),
    pages: makeNode(__pageRoot.pages, []),
    view: (...args) => callHelper('view', args),
    viewChanges: () => callHelper('viewChanges', []),
    screenshot: (...args) => callHelper('screenshot', args),
  };
}

/* Emitted as an expression so the host can inject it into a worker scope. */
buildRemoteBrowser
`;

/**
 * The program arguments the browser profile is compiled with.
 *
 * Named here rather than in the tool so the sandbox's surface and the tool's
 * documentation cannot drift: this list is what a program may use, and it is
 * exactly what `buildRemoteBrowser` returns.
 */
export const BROWSER_PROGRAM_PARAMS = ["page", "browser", "view", "viewChanges", "screenshot", "pages"] as const;
