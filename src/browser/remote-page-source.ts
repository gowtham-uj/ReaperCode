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

  /*
   * Turn an argument into something that can cross the boundary.
   *
   * Nodes become handles. Plain data is copied. Functions are refused, and that
   * refusal is load-bearing: the host used to rebuild them from source with an
   * eval, which is an escape in the app-server process (see the node check below
   * for the ordering trap, and remote-page.ts for what the rebuild did).
   */
  async function encodeArgument(value, depth) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
    /*
     * The node check comes FIRST, before the function check, and the ordering is
     * load-bearing. A node is a Proxy over a function, so typeof is 'function'
     * for it, and testing for a function first would refuse every node passed as
     * an argument: view(page.locator("form")) sends a node, and it was coming
     * back as "a function cannot be passed to the browser bridge" for a locator
     * that is not a function at all.
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
    /*
     * A real function is refused, which is what closes the host-side eval.
     * Playwright accepts a source string anywhere it accepts a function, so the
     * rewrite is always available and the message names it.
     *
     * The common array callbacks never reach here, because those methods are
     * handled inside the sandbox: a chain like contexts().flatMap(c => c.pages())
     * is resolved first and the callback is then run on the resulting array, in
     * this process, against plain data. Refusing them outright would have broken
     * the most ordinary way to write a program, and that is the trade avoided.
     */
    if (typeof value === 'function') {
      throw new Error(
        'a function cannot be passed to the browser bridge; pass a source string instead, ' +
        'for example page.evaluate("document.title") or waitForFunction("window.ready")',
      );
    }
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

  /*
   * An array from the host, with its callback-taking methods made await-aware.
   *
   * A returned array is a real array of decoded values, so find, filter, some
   * and friends are the native ones. That is wrong for this API, and it fails
   * silently: an async predicate returns a Promise, a Promise is truthy, so
   * pages.find(async (p) => (await p.url()).includes("x")) returns the *first*
   * page however the page actually matches. Observed on a live run: the model
   * wrote exactly that, got the wrong tab, and the error it saw was about the
   * page it had not meant to select.
   *
   * Only arrays that come back from the host are wrapped, and only their
   * callback-taking methods, so everything else keeps native behaviour and
   * identity. The wrapper is a Proxy rather than a subclass so Array.isArray
   * and length stay true, which matters because a model checks both.
   */
  function decodeArray(value, depth) {
    const decoded = value.map((item) => decodeValue(item, depth + 1));
    /*
     * The callback-taking methods run the callback once per element themselves,
     * and only become a Promise when something actually awaits.
     *
     * Two constraints, and they pull in opposite directions.
     *
     * Delegating to the native method is wrong: filter and find test the
     * callback's return value for truthiness *synchronously*, so wrapping the
     * callback to return a Promise makes every element a match. Reproduced:
     * pages.filter(async (p) => (await p.url()).includes("x")) returned every
     * page.
     *
     * Making every method async is also wrong, and less obviously: p.map(fn)
     * would return a Promise even for a synchronous fn, so the ordinary
     * p.map((p) => p.url()).slice(0, 3) fails with "slice is not a function".
     * A model writes that without thinking, and being told its correct code is
     * broken is worse than the bug it was working around.
     *
     * So the callback is called exactly once per element, the raw results are
     * kept, and the method decides afterwards: all plain values means a plain
     * array is returned and the chain continues natively, and any Promise means
     * the whole thing resolves asynchronously. Calling once is what makes this
     * safe: a callback with a side effect is not run twice to find out which
     * world it is in.
     */
    const isThenable = (candidate) => candidate !== null && typeof candidate === 'object' && typeof candidate.then === 'function';

    /*
     * Calls the callback once per element until one returns a Promise, then
     * returns what it has plus where it stopped. The pending Promise is
     * returned already called, so the async continuation awaits that value
     * rather than calling the callback a second time.
     */
    function collect(callback) {
      const raw = [];
      for (let index = 0; index < decoded.length; index++) {
        const produced = callback(decoded[index], index, decoded);
        if (isThenable(produced)) return { async: true, from: index, raw, pending: produced };
        raw.push(produced);
      }
      return { async: false, raw };
    }

    /** Finish the same pass asynchronously, awaiting each remaining callback. */
    async function collectAsync(callback, already) {
      const raw = already.raw.slice();
      raw.push(await already.pending);
      for (let index = already.from + 1; index < decoded.length; index++) {
        raw.push(await callback(decoded[index], index, decoded));
      }
      return raw;
    }

    /** Apply one method's semantics to already-collected callback results. */
    function finish(method, raw, initial, hasInitial) {
      switch (method) {
        case 'map':
          return raw;
        case 'flatMap':
          return raw.reduce((out, item) => out.concat(item), []);
        case 'filter':
          return decoded.filter((_value, index) => Boolean(raw[index]));
        case 'find':
          return decoded.find((_value, index) => Boolean(raw[index]));
        case 'findIndex':
          return decoded.findIndex((_value, index) => Boolean(raw[index]));
        case 'some':
          return raw.some(Boolean);
        case 'every':
          return raw.every(Boolean);
        case 'forEach':
          return undefined;
        case 'reduce':
        case 'reduceRight': {
          const order = method === 'reduce'
            ? decoded.map((_value, index) => index)
            : decoded.map((_value, index) => index).reverse();
          let accumulator = hasInitial ? initial : decoded[order.shift()];
          for (const index of order) accumulator = raw[index];
          return accumulator;
        }
        default:
          return undefined;
      }
    }

    return new Proxy(decoded, {
      get(target, property) {
        if (typeof property !== 'string') return target[property];
        switch (property) {
          case 'map':
          case 'flatMap':
          case 'filter':
          case 'find':
          case 'findIndex':
          case 'some':
          case 'every':
          case 'forEach':
            return function (callback) {
              if (typeof callback !== 'function') return target[property](callback);
              const collected = collect(callback);
              if (!collected.async) return finish(property, collected.raw, undefined, false);
              return collectAsync(callback, collected).then((raw) => finish(property, raw, undefined, false));
            };
          case 'reduce':
          case 'reduceRight':
            return function (callback, initial) {
              if (typeof callback !== 'function') return target[property](callback);
              const hasInitial = arguments.length > 1;
              /*
               * Reduce carries an accumulator rather than a per-element value,
               * so it is run in order. The first result that turns out to be a
               * Promise switches the whole call to the async path, and the
               * accumulator chain resumes from there.
               */
              const order = property === 'reduce'
                ? target.map((_value, index) => index)
                : target.map((_value, index) => index).reverse();
              if (!hasInitial && order.length === 0) {
                throw new TypeError('Reduce of empty array with no initial value');
              }
              let accumulator = hasInitial ? initial : target[order.shift()];
              const remaining = order.map((index) => target[index]);
              const positions = order;
              for (let step = 0; step < remaining.length; step++) {
                const produced = callback(accumulator, remaining[step], positions[step], target);
                if (isThenable(produced)) {
                  return (async () => {
                    accumulator = await produced;
                    for (let rest = step + 1; rest < remaining.length; rest++) {
                      accumulator = await callback(accumulator, remaining[rest], positions[rest], target);
                    }
                    return accumulator;
                  })();
                }
                accumulator = produced;
              }
              return accumulator;
            };
          default:
            return target[property];
        }
      },
    });
  }

  function decodeValue(value, depth) {
    if (value === null || typeof value !== 'object') return value;
    if (typeof value.__reaperHandle === 'number') {
      /* A live object the program can keep using. */
      return makeNode(value.__reaperHandle, []);
    }
    if (depth > 8) return value;
    if (Array.isArray(value)) return decodeArray(value, depth);
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

        /*
         * A function argument is kept on the path rather than encoded here.
         *
         * 'run()' splits the path at a local array method and applies it in this
         * process (see LOCAL_ARRAY_METHODS), which is how a callback is allowed
         * without crossing the bridge. Every other step is encoded and sent, and
         * a function reaching 'encodeArgument' there is refused.
         */
        return makeNode(handle, head.concat([[last[0], args]]));
      },
      has() {
        return true;
      },
    };
    return new Proxy(function () {}, handler);
  }

  /* One round trip. The path is encoded so functions survive, values decoded so handles come back live. */
  /*
   * The array methods whose callback runs locally rather than crossing.
   *
   * 'contexts().flatMap(c => c.pages())' and '.filter(p => ...)' are how anyone
   * writes this, and their callbacks are functions. A function cannot cross the
   * bridge (that was the escape), so the sandbox runs these itself: the receiver
   * is resolved by the host, the elements come back as nodes, and the callback is
   * applied right here.
   */
  const LOCAL_ARRAY_METHODS = ['flatMap', 'map', 'filter', 'find', 'some', 'every', 'forEach', 'reduce'];

  /*
   * Apply one array method, awaiting what the callback returns.
   *
   * This is not 'Array.prototype[method].apply', and the difference is the whole
   * reason this exists. A Playwright callback is async: 'c => c.pages()' returns
   * a node, not an array of pages, and the built-in 'flatMap' would produce an
   * array of nodes. '.filter(p => p.url().includes(x))' then calls '.url()' on a
   * node, gets a node, and '.includes' is not a function on it, so the filter
   * silently matches nothing. The test that caught this wanted "the other
   * thread's page must not be findable" and got a program that failed on
   * 'others[0].goto'.
   *
   * So each callback result is awaited, and the method semantics are then applied
   * to the resolved values. The await is what a person writing this means: the
   * model wrote 'c => c.pages()' expecting pages.
   */
  async function applyArrayMethod(method, array, args) {
    const callback = args[0];
    const rest = args.slice(1);
    const results = [];
    for (let index = 0; index < array.length; index++) {
      results.push(await callback(array[index], index, array));
    }
    switch (method) {
      case 'map':
        return results;
      case 'flatMap':
        return results.reduce((out, value) => out.concat(value), []);
      case 'filter':
        return array.filter((_value, index) => results[index]);
      case 'find':
        return array.find((_value, index) => results[index]);
      case 'some':
        return results.some(Boolean);
      case 'every':
        return results.every(Boolean);
      case 'forEach':
        return undefined;
      case 'reduce': {
        /*
         * Reduce has no per-element pre-pass: its callback carries the
         * accumulator, so it is run in order with an await at each step.
         */
        const hasInitial = rest.length > 0;
        let accumulator = hasInitial ? rest[0] : array[0];
        for (let index = hasInitial ? 0 : 1; index < array.length; index++) {
          accumulator = await callback(accumulator, array[index], index, array);
        }
        return accumulator;
      }
      default:
        return undefined;
    }
  }

  /*
   * One step of a chain that continues past a local array method.
   *
   * A read on a node goes back to the host, so 'others[0].url()' still works: the
   * element is a node rooted at its own handle. A read on plain data is answered
   * here, which is what covers '.length' on the filtered array.
   */
  async function readLocal(current, name, args) {
    if (current === null || current === undefined) return undefined;
    if (current.__reaperNode) {
      // A node: extend its path with this step and let the host run it.
      const node = makeNode(current.__reaperNode.handle, current.__reaperNode.path.concat([[name, args]]));
      return node.__reaperNode ? node : node;
    }
    if (typeof current === 'object' && name in current) {
      const member = current[name];
      return typeof member === 'function' ? member.apply(current, args) : member;
    }
    return undefined;
  }

  async function run(handle, path) {
    /*
     * Split the path at the last local array method, so a chain like
     * 'contexts().flatMap(fn).length' resolves 'contexts()' on the host, applies
     * 'flatMap' here, and then continues with whatever follows against the
     * local result.
     */
    const splitAt = (() => {
      for (let index = path.length - 1; index >= 1; index--) {
        if (LOCAL_ARRAY_METHODS.indexOf(path[index][0]) !== -1 && typeof path[index][1][0] === 'function') return index;
      }
      return -1;
    })();

    if (splitAt !== -1) {
      const receiver = await run(handle, path.slice(0, splitAt));
      const array = Array.isArray(receiver) ? receiver : [];
      const step = path[splitAt];
      const applied = await applyArrayMethod(step[0], array, step[1]);
      const rest = path.slice(splitAt + 1);

      /*
       * The rest of the chain runs against the local value.
       *
       * It is plain data or nodes now, not a bridge path, so it is evaluated
       * here rather than sent. What is left after an array method is a read:
       * '.length', '[0]', '.url()' on an element. Leaving an element as a node
       * keeps all of that working, because a node already answers '.url()' and
       * a further call replays against the handle the host gave it.
       */
      let current = applied;
      for (const [name, args] of rest) {
        current = await readLocal(current, name, args);
      }
      return current;
    }

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

  /*
   * The control surface: the browser settings a program can change while it
   * works.
   *
   * Ride the same helper channel as view/viewChanges/screenshot, because they
   * are the same kind of thing (a named call the host answers, not a Playwright
   * method path) and because the channel already handles argument encoding and
   * error unwrapping. Each returns what the host says actually changed, so a
   * program that sets a setting it cannot have is told rather than reassured.
   *
   * \`browser.set(...)\` takes one object and is the shape most programs want;
   * the individual setters exist because a model that thinks in terms of "change
   * the user agent" should not have to build an object to say so.
   */
  async function set(settings) {
    return callHelper('set', [settings]);
  }
  async function setUserAgent(userAgent) {
    return callHelper('setUserAgent', [userAgent]);
  }
  async function setTimezone(timezone) {
    return callHelper('setTimezone', [timezone]);
  }
  async function setViewport(width, height) {
    return callHelper('setViewport', [width, height]);
  }
  async function setFullscreen(enabled) {
    return callHelper('setFullscreen', [enabled]);
  }
  async function setMobile(enabled) {
    return callHelper('setMobile', [enabled]);
  }
  async function blockAds(enabled) {
    return callHelper('blockAds', [enabled]);
  }
  async function bandwidth(options) {
    return callHelper('bandwidth', [options]);
  }
  async function settings() {
    return callHelper('settings', []);
  }
  async function rotateUserAgent() {
    return callHelper('rotateUserAgent', []);
  }
  /*
   * The download vault: files this thread saved, and their paths on disk.
   *
   * This is what makes a cross-site file transfer possible. A program downloads
   * an invoice on one site, and later, on another site, calls
   * \`setInputFiles(await download("invoice.pdf"))\`. Without it the file would
   * live in a context-scoped temporary directory and be gone by then.
   */
  async function downloads() {
    return callHelper('downloads', []);
  }
  async function download(name) {
    return callHelper('download', [name]);
  }
  /*
   * Trigger a download and get the file, in one call.
   *
   * The action is a source string, not a function, because the bridge refuses
   * functions and because it has to run on the host: a wait for the download
   * event cannot be awaited on this side, since the event is produced by the
   * action that has not run yet. See the note in the host's dispatch.
   *
   *   const file = await downloadAfter('page.click("#invoice")');
   *   await other.setInputFiles("#file", file.path);
   */
  async function downloadAfter(target) {
    return callHelper('downloadAfter', [target]);
  }

  return {
    page: makeNode(__pageRoot.page, []),
    browser: makeNode(__pageRoot.browser, []),
    pages: makeNode(__pageRoot.pages, []),
    view: (...args) => callHelper('view', args),
    viewChanges: () => callHelper('viewChanges', []),
    screenshot: (...args) => callHelper('screenshot', args),
    set,
    setUserAgent,
    setTimezone,
    setViewport,
    setFullscreen,
    setMobile,
    blockAds,
    bandwidth,
    settings,
    rotateUserAgent,
    downloads,
    download,
    downloadAfter,
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
export const BROWSER_PROGRAM_PARAMS = [
  "page", "browser", "view", "viewChanges", "screenshot", "pages",
  "set", "setUserAgent", "setTimezone", "setViewport", "setFullscreen", "setMobile",
  "blockAds", "bandwidth", "settings", "rotateUserAgent", "downloads", "download", "downloadAfter",
] as const;
