/**
 * The short list of things Code Mode will not do.
 *
 * Code Mode runs the model's JavaScript as real Node: `fs`, `child_process`,
 * the network, npm packages, worker threads, genuine parallelism. A script that
 * reads a file through `node:fs` bypasses the permission and approval checks
 * that `tools.read` would have applied; what bounds it instead is the
 * bubblewrap mount namespace the worker runs in, which contains only the
 * thread's workspace and read-only system directories. So a script can read any
 * file *in its workspace* the way the Reaper process could, and none outside
 * it. See `transport.ts`.
 *
 * This file is not that boundary and should not be read as one. It is a guard
 * against the handful of operations that are catastrophic and *never*
 * intentional: overwriting the operating system, deleting the root filesystem,
 * exfiltrating the credentials Reaper itself is holding. A model doing legitimate
 * work never touches any of them, which is what makes refusing them free. A
 * determined script could work around every check here — `fs.open` with a
 * numeric fd, a command assembled at runtime — and that is fine, because the
 * threat being addressed is a plausible mistake, not an adversary.
 *
 * The rule for adding to these lists: an entry has to be something whose
 * *every* use is a disaster. "Writes to /usr/bin" is.
 *
 * Writes outside the workspace are refused too, which is a narrower rule than
 * that test and was a deliberate reversal. The argument against it was that
 * editing a file elsewhere on disk is ordinary work for an agent — true in
 * isolation, but `bash` is already confined this way (see the cwd check in
 * `tools/global/bash.ts`), and leaving eval unconfined made the two routes
 * disagree: a `cd` out of the workspace through `bash` is refused, while the
 * same move through `fs` was not. A model that finds the second door is not
 * doing anything wrong; it is taking the route that works. Whether the
 * workspace is the right boundary for both is a policy question, and the answer
 * here is that it is, because the agent's work is the workspace's contents.
 *
 * `/tmp` stays writable. Scratch files, sockets, and the odd `mktemp` are how
 * ordinary programs work, and a rule that broke them would push the model back
 * to `bash` for every temporary file.
 *
 * Both functions are self-contained on purpose, with their tables inline rather
 * than hoisted to module scope. They are stringified into the worker bootstrap
 * via `Function.prototype.toString`, so a reference to anything outside the
 * function body would be undefined by the time it runs. `GUARD_SOURCE` is that
 * serialization; the tests import the functions directly, which means the code
 * under test and the code in the worker are the same code.
 */

/** Which way the path is being crossed. Reads are judged more permissively. */
export type PathOperation = "read" | "write";

/**
 * Whether this path is one no script should be touching.
 *
 * `workspace` bounds writes: a write anywhere else is refused unless it is
 * under a temporary directory. Pass it or leave it out — with no workspace the
 * guard cannot make that judgement and skips it, which is what the tests that
 * exercise the other rules rely on.
 *
 * Returns the reason rather than a boolean so the refusal can say what it
 * objected to; a script told "denied" learns nothing, and a model told
 * "that is outside the workspace, work there instead" fixes its own code.
 */
export function isDangerousPath(target: string, operation: "read" | "write", workspace?: string): string | undefined {
  if (typeof target !== "string" || target.length === 0) return undefined;

  /*
   * Resolved before matching, because `/etc/../etc/passwd` and
   * `/workspace/../../etc/passwd` are the same destination as `/etc/passwd`
   * and a prefix test on the raw string sees three different places. Relative
   * paths resolve against the process cwd, which is the same base Node itself
   * would use for the call being guarded.
   */
  /*
   * Reached through `process.getBuiltinModule` rather than `require`.
   *
   * This function is stringified into the worker, so it cannot close over an
   * import; but `require` is not a safe substitute, because the worker's
   * CommonJS scope and an ESM test's scope differ and the function is called
   * from both. `getBuiltinModule` is defined in either, which is what lets the
   * tests exercise the same text the worker runs instead of a copy of it.
   */
  const path = process.getBuiltinModule("node:path");
  const resolved = path.resolve(target);
  const home = process.getBuiltinModule("node:os").homedir();

  /*
   * Secrets first, and checked for reads as well as writes: these are the
   * files whose *contents* are the damage. Reaper's own credential store is on
   * the list because eval runs inside Reaper — a script that reads it has the
   * keys to every provider the user has configured, which is a far larger
   * blast radius than anything in the project.
   */
  const secrets = [
    `${home}/.ssh`,
    `${home}/.aws/credentials`,
    `${home}/.config/gcloud/credentials.db`,
    `${home}/.config/gh/hosts.yml`,
    `${home}/.reaper/credentials`,
    `${home}/.reaper/providers.json`,
    `${home}/.docker/config.json`,
    `${home}/.npmrc`,
    `${home}/.kube/config`,
  ];
  for (const secret of secrets) {
    if (resolved === secret || resolved.startsWith(`${secret}/`)) {
      return `${resolved} holds credentials. Code Mode will not read or write it. If a task genuinely needs a secret, it should come in through the environment or a Reaper tool, not be read off disk by a script.`;
    }
  }

  if (operation === "read") return undefined;

  /*
   * System directories, write only. Reading /usr/lib is how you find out what
   * is installed and is nobody's problem; writing to it replaces the machine's
   * software with whatever the script thought it was doing.
   *
   * /dev is the exception that needs an exception: /dev/null and /dev/stdout
   * are ordinary plumbing, and a guard that blocked them would break shell
   * redirection for no benefit.
   */
  const systemRoots = ["/etc", "/usr", "/bin", "/sbin", "/boot", "/lib", "/lib64", "/sys", "/proc", "/var/lib", "/System", "/Library"];
  for (const root of systemRoots) {
    if (resolved === root || resolved.startsWith(`${root}/`)) {
      return `${resolved} is inside ${root}, which belongs to the operating system. Code Mode will not write there. Work in the workspace instead.`;
    }
  }
  if (resolved.startsWith("/dev/") && !/^\/dev\/(null|stdout|stderr|tty|zero|urandom|random|fd\/\d+)$/.test(resolved)) {
    return `${resolved} is a device node. Code Mode will not write to it.`;
  }
  if (resolved === "/") {
    return "Code Mode will not write to the filesystem root.";
  }

  /*
   * The workspace boundary, last so the more specific refusals above get to
   * explain themselves first. A path under the workspace, or under a temp
   * directory, is where work happens; anywhere else is not this agent's to
   * change.
   *
   * `workspace` arrives already resolved by the caller, which knows the thread
   * root; resolving it here would put `process.cwd()` in the answer, and the
   * worker's cwd is the parent's, not the thread's.
   */
  if (typeof workspace === "string" && workspace.length > 0) {
    const root = path.resolve(workspace);
    const inWorkspace = resolved === root || resolved.startsWith(`${root}${path.sep}`);
    // Inline rather than a module constant: this function is stringified into
    // the worker, so anything it closes over outside its own body is undefined
    // there. See the note at the top of the file.
    const inTemp = ["/tmp", "/var/tmp"].some((dir) => resolved === dir || resolved.startsWith(`${dir}/`));
    if (!inWorkspace && !inTemp) {
      return `${resolved} is outside the workspace (${root}). Code Mode writes only inside the workspace or a temporary directory; write there instead.`;
    }
  }
  return undefined;
}

/**
 * Whether this shell command is one of the few that are never a good idea.
 *
 * Deliberately narrow. Commands are strings assembled at runtime and any
 * pattern match on them is defeatable, so trying to be thorough would buy
 * nothing but false refusals on legitimate work — `rm -rf node_modules` is a
 * completely normal thing for an agent to run. What is matched here is the set
 * of commands that destroy the machine or the disk, where a false positive
 * costs the model one rephrasing and a false negative costs the user their
 * system.
 */
export function isDangerousCommand(command: string): string | undefined {
  if (typeof command !== "string" || command.length === 0) return undefined;
  const text = command.replace(/\s+/g, " ").trim();

  const patterns: Array<[RegExp, string]> = [
    // `rm -rf /` and the variants that differ only in flag order or a trailing
    // glob. The negative lookahead is what keeps `rm -rf /work/tmp` allowed:
    // the danger is the root itself, not every absolute path.
    [/\brm\s+(-[a-zA-Z]+\s+)*\/(\s|$|\*)/, "`rm` targeting the filesystem root would delete the machine."],
    [/\bmkfs(\.\w+)?\b/, "`mkfs` formats a filesystem."],
    [/\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|hd|disk)/, "`dd` writing to a raw disk device overwrites the drive."],
    [/:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, "That is a fork bomb."],
    [/\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, "Code Mode will not power the machine down."],
    [/>\s*\/dev\/(sd|nvme|hd|disk)/, "Writing to a raw disk device overwrites the drive."],
    [/\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\/(\s|$)/, "`chmod 777 /` opens every file on the machine."],

    /*
     * The other route to a browser. Reaper starts Steel and attaches to it;
     * nothing else in a script should be fetching or starting a browser of its
     * own, because a second one is not the one the live pane is showing and not
     * the one holding the thread's logins.
     *
     * These are refusals with a route attached, not a boundary: `npx` can be
     * spelled a dozen ways and a determined script can reach around any pattern.
     * The point is that the obvious attempt fails clearly rather than quietly
     * working, and that the failure names what to do instead.
     */
    [
      /\bplaywright\s+install\b/,
      "`playwright install` downloads a browser, and there is already one running. Use `browser_use`; Reaper starts and connects the browser for you.",
    ],
    [
      /*
       * Every package manager spells "install" differently: apt/dnf/yum/pacman
       * say `install`, apk says `add`, brew says `install` but also `cask
       * install`. Matching the verb per manager is what keeps `apk add chromium`
       * from slipping through while `apt-get install -y curl` stays allowed.
       */
      /\b(apt-get|apt)\b[^|;&]*\binstall\b[^|;&]*\b(chromium|chrome|google-chrome|chromium-browser|firefox)\b/,
      "That installs a browser, and there is already one running. Use `browser_use` instead of installing another.",
    ],
    [
      /\bapk\b[^|;&]*\badd\b[^|;&]*\b(chromium|chrome|firefox)\b/,
      "That installs a browser, and there is already one running. Use `browser_use` instead of installing another.",
    ],
    [
      /\b(dnf|yum|pacman|zypper)\b[^|;&]*\b(-S|install|add)\b[^|;&]*\b(chromium|chrome|google-chrome|chromium-browser|firefox)\b/,
      "That installs a browser, and there is already one running. Use `browser_use` instead of installing another.",
    ],
    [
      /\bbrew\b[^|;&]*\b(install|cask)\b[^|;&]*\b(chromium|chrome|google-chrome|firefox)\b/,
      "That installs a browser, and there is already one running. Use `browser_use` instead of installing another.",
    ],
    [
      /\b(chrome|chromium|headless_shell|chrome-headless-shell)\b[^|;&]*\s--(remote-debugging-port|headless|user-data-dir)\b/,
      "That starts a second browser. Reaper owns the browser process and there is already one attached; drive it with `browser_use`.",
    ],
  ];

  for (const [pattern, reason] of patterns) {
    if (pattern.test(text)) {
      return `${reason} Code Mode refused to run: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`;
    }
  }
  return undefined;
}

/**
 * Wrap a loaded `playwright` module so it cannot start a browser of its own.
 *
 * Reaper starts Steel and attaches to it, once. A script that calls
 * `chromium.launch()` gets a second, unrelated browser: not the one the live
 * pane is showing, not the one holding the thread's cookies, and a fresh login
 * wall on every call. The refusal is therefore the operation, not the script.
 *
 * This patches the module object in place rather than replacing the require.
 * Three reasons, all of them observed rather than assumed:
 *
 *   - The model's script reaches Playwright by at least three routes: the
 *     `require` parameter, `await import(...)`, and `require` inside a helper
 *     module it wrote. Only a module-level patch covers all three.
 *   - `chromium` and friends are exported as getters on some builds, so a plain
 *     assignment silently fails. `defineProperty` is used when assignment does.
 *   - The module is cached, so the patch is applied once and every later require
 *     of the same specifier gets the guarded copy for free.
 *
 * `connectOverCDP` is deliberately left alone against the configured endpoint
 * and refused against any other. The thread's browser is the one we started;
 * pointing Playwright at a different one is the same mistake as launching.
 *
 * Like everything else in this file this is a guard, not a boundary. A script
 * can reach around it. The point is that the obvious attempt fails with a
 * message naming the right thing to do instead of quietly half-working.
 */
export function guardPlaywrightModule(mod: unknown, allowedCdpUrl: string | undefined): void {
  const refusal = (operation: string): Error => {
    const error = new Error(
      `REAPER_REFUSED: ${operation} would start a browser that Reaper is not managing. ` +
        `One is already running and already connected to this thread, holding its pages and logins. ` +
        `Use the \`browser\` object that is in scope: it is the same browser the live pane shows. ` +
        `There is nothing to launch.`,
    );
    (error as Error & { code?: string }).code = "REAPER_REFUSED";
    return error;
  };

  /*
   * `defineProperty` when assignment does not stick, so a getter-only export
   * does not defeat the guard silently. `configurable: true` keeps the module
   * patchable by a later call without a TypeError.
   */
  const replace = (holder: Record<string, unknown>, key: string, value: unknown): void => {
    if (!holder || (typeof holder !== "object" && typeof holder !== "function")) return;
    try {
      holder[key] = value;
    } catch {
      /* fall through to defineProperty */
    }
    if (holder[key] !== value) {
      try {
        Object.defineProperty(holder, key, { value, configurable: true, writable: true, enumerable: true });
      } catch {
        /* a frozen export cannot be patched; the command guard still covers the shell route */
      }
    }
  };

  const browsers = ["chromium", "firefox", "webkit"];
  for (const name of browsers) {
    const type = (mod as Record<string, unknown> | undefined)?.[name];
    if (!type || typeof type !== "object") continue;
    const record = type as Record<string, unknown>;
    // Idempotent: the module is cached, so a second require must not double-wrap.
    if (record.__reaperGuarded === true) continue;

    replace(record, "launch", () => {
      throw refusal(`${name}.launch()`);
    });
    replace(record, "launchPersistentContext", () => {
      throw refusal(`${name}.launchPersistentContext()`);
    });
    replace(record, "launchServer", () => {
      throw refusal(`${name}.launchServer()`);
    });
    replace(record, "executablePath", () => {
      throw refusal(`${name}.executablePath()`);
    });

    /*
     * `connect` speaks the Playwright wire protocol to a browser server, which
     * is a different browser or none. Only `connectOverCDP` is meaningful here,
     * and only against the endpoint we started.
     */
    replace(record, "connect", () => {
      throw refusal(`${name}.connect()`);
    });

    const originalConnectOverCDP = record.connectOverCDP;
    if (typeof originalConnectOverCDP === "function") {
      replace(record, "connectOverCDP", function (this: unknown, url?: string, ...rest: unknown[]) {
        /*
         * Raw Chrome's port is refused before the endpoint comparison, because
         * it is wrong even if someone configured it as the allowed endpoint.
         * Steel owns the browser, and connecting to Chrome directly reaches
         * past it; a run that did that would look connected and skip the layer
         * the live pane and the session lifecycle are built on.
         *
         * The port list is inline rather than imported for the same reason the
         * tables above are: this function is stringified into the worker, and a
         * name from module scope is undefined by the time it runs there. See
         * the file header. It is the same two ports as
         * `browser/steel-endpoint.ts`; the tests assert they agree.
         */
        if (typeof url === "string") {
          const portText = (url.split("/")[2] ?? "").split(":")[1];
          const port = portText === undefined ? NaN : Number(portText);
          if (port === 9222 || port === 9223) {
            throw refusal(`${name}.connectOverCDP(${url})`);
          }
        }
        if (allowedCdpUrl && typeof url === "string" && url !== allowedCdpUrl) {
          throw refusal(`${name}.connectOverCDP(${url})`);
        }
        return (originalConnectOverCDP as (...args: unknown[]) => unknown).call(this, url, ...rest);
      });
    }

    replace(record, "__reaperGuarded", true);
  }
}

/**
 * The three functions above, as text the worker can evaluate.
 *
 * The worker is started with `eval: true` and a source string, so it has no
 * module of its own to import from — anything it needs has to arrive inside
 * that string. Serializing the real functions rather than maintaining a second
 * copy is what keeps the tested code and the running code identical; a copy
 * would drift the first time either list changed.
 */
export const GUARD_SOURCE = `${isDangerousPath.toString()}\n${isDangerousCommand.toString()}\n${guardPlaywrightModule.toString()}`;
