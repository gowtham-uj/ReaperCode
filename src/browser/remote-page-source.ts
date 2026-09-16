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
  function encodeArgument(value, depth) {
    if (typeof value === 'function') return { __reaperFn: value.toString() };
    if (value === null || typeof value !== 'object') return value;
    /*
     * A handle node travelled as an argument is sent as its handle.
     *
     * Without this it would be sent as a plain object, and because a node's
     * target is empty, \`Object.keys\` on it gives nothing: the host would
     * receive \`{}\` where a page was meant and every call taking a page —
     * \`browser.closePage(tab)\` is the one that found it — would fail with a
     * message about the method rather than about the argument.
     *
     * The marker is read off the node itself, so it works for a handle the
     * program has been carrying for a while as well as one it just got.
     */
    const marker = value.__reaperNode;
    if (marker && typeof marker.handle === 'number') return { __reaperNode: marker.handle };
    if (depth > 8) return value;
    if (Array.isArray(value)) return value.map((item) => encodeArgument(item, depth + 1));
    const out = {};
    for (const key of Object.keys(value)) out[key] = encodeArgument(value[key], depth + 1);
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

  /* The path a node carries, replayed from its handle. A step is [method, ...args]. */
  function makeNode(handle, path) {
    const node = {};
    const proxy = new Proxy(node, {
      get(_target, property) {
        if (typeof property === 'symbol') return undefined;
        /*
         * The marker that lets this node travel as an argument. Read by
         * \`encodeArgument\` above; not part of the Playwright surface, and named
         * with a prefix a page cannot collide with.
         */
        if (property === '__reaperNode') return { handle: handle, path: path };
        if (property === 'then') {
          /*
           * Awaiting a *pending chain* runs it. That is what makes
           * \`await page.click()\` work.
           *
           * A node with an empty path is a value that has already been
           * resolved, and it must NOT be thenable. This is the difference
           * between working and an infinite loop, and it took a heap exhaustion
           * to find: resolving a promise with a thenable makes JavaScript
           * unwrap it by calling \`then\`, which for a resolved node ran the
           * empty path again, which resolved to another thenable, forever.
           *
           * So a resolved node awaits to itself, which is what a caller wants:
           * \`const tab = await browser.newPage("x")\` gives the locator-like node
           * to keep calling, not another round trip.
           */
          if (path.length === 0) return undefined;
          return (onFulfilled, onRejected) =>
            run(handle, path).then(
              (value) => (onFulfilled ? onFulfilled(value) : value),
              onRejected,
            );
        }
        if (property === 'catch' || property === 'finally') return undefined;
        if (property === 'constructor') return undefined;
        /*
         * Every other property is a method that extends the path. Returning a new
         * node rather than calling immediately is what makes a held \`locator\`
         * reusable and a chain one round trip.
         */
        return (...args) => makeNode(handle, path.concat([[property, args]]));
      },
      has() {
        return true;
      },
    });
    return proxy;
  }

  /* One round trip. The path is encoded so functions survive, values decoded so handles come back live. */
  async function run(handle, path) {
    const encoded = path.map((step) => [step[0], ...step[1].map((arg) => encodeArgument(arg, 0))]);
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
  return {
    page: makeNode(__pageRoot.page, []),
    browser: makeNode(__pageRoot.browser, []),
    pages: makeNode(__pageRoot.pages, []),
    view: (...args) => __pageView('view', args),
    viewChanges: () => __pageView('viewChanges', []),
    screenshot: (...args) => __pageView('screenshot', args),
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
