/**
 * The program that runs inside the Code Mode worker.
 *
 * This is a template string rather than a module because the worker is started
 * with `eval: true`. The alternative — a real `.js` file resolved by path —
 * does not survive `npm run build:binary`, which esbuilds everything into one
 * self-contained `bin/reaper.mjs` with no sibling files to point a `new
 * Worker(url)` at. Inlining the source is what makes Code Mode work identically
 * from `tsx`, from `dist/`, and from the single-file bundle.
 *
 * What runs here is the model's code, unmodified, as real Node. It can import
 * npm packages, open sockets, spawn processes, and use every language feature
 * the host Node supports, because it *is* the host Node — a second thread of
 * it. The isolation that remains is the isolation a thread gives: its own V8
 * isolate, its own heap with a hard `resourceLimits` ceiling, and a
 * `terminate()` that kills a `while (true)` instantly. That is what keeps the
 * app responsive while untrusted code runs, and it is a liveness guarantee, not
 * a security one.
 *
 * Three things the worker owns:
 *
 * 1. **`tools.*`** — proxied back to the parent over `postMessage`, so every
 *    call lands in Reaper's real executor with its permission checks, approval
 *    prompts, tracing and audit intact. Genuinely concurrent: each call is a
 *    pending promise keyed by id, so `Promise.all` over ten tools runs ten at
 *    once rather than pretending to.
 * 2. **Console capture** — `console.*` is replaced so output streams to the
 *    transcript as it happens instead of arriving at the end.
 * 3. **The guard** — `fs` and `child_process` are wrapped to refuse the short
 *    list of catastrophic operations in `guard.ts`. Everything else passes
 *    straight through.
 */

import { GUARD_SOURCE } from "./guard.js";

/**
 * Build the worker program.
 *
 * Takes the guard source as a parameter rather than closing over it so the
 * seam is visible: everything the worker knows arrives as text, because a
 * worker started from a string has no lexical scope shared with this file.
 */
function buildWorkerSource(guard: string): string {
  return `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const nodeModule = require('node:module');
const vm = require('node:vm');

${guard}

/* ------------------------------------------------------------------ *
 * Console capture.
 *
 * Replaced rather than wrapped: the model's script and anything it
 * imports both write here, and the transcript wants both. Serialisation
 * is best-effort — a circular object or a Proxy that throws on property
 * access must not be able to kill the run it was only trying to log.
 * ------------------------------------------------------------------ */
let consoleBytes = 0;
const maxConsoleBytes = workerData.limits.maxConsoleBytes;
let consoleTruncated = false;

function render(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || (value.name + ': ' + value.message);
  try {
    return require('node:util').inspect(value, { depth: 4, breakLength: 120, maxArrayLength: 100 });
  } catch {
    return String(value);
  }
}

function emit(level, args) {
  let text;
  try {
    text = args.map(render).join(' ');
  } catch {
    text = '[unserialisable console argument]';
  }
  if (consoleTruncated) return;
  if (consoleBytes + text.length > maxConsoleBytes) {
    consoleTruncated = true;
    /*
     * The flag goes as its own message as well as the marker line.
     *
     * The host counts console bytes too, but it never sees the overflow: this
     * is where the bytes are dropped, so the host's own counter stops short of
     * the ceiling and its consoleTruncated flag stayed false. The result then
     * said "nothing was cut" about output that had been cut — the one piece of
     * information the model needs to know that the log it is reading is not
     * the whole log. Sniffing for the marker text would work and would break
     * the first time someone reworded it.
     */
    parentPort.postMessage({ type: 'consoleTruncated' });
    parentPort.postMessage({ type: 'console', level: 'warn', text: '[console output truncated]' });
    return;
  }
  consoleBytes += text.length;
  parentPort.postMessage({ type: 'console', level, text });
}

for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir']) {
  const mapped = level === 'trace' || level === 'dir' ? 'log' : level;
  console[level] = (...args) => emit(mapped, args);
}

/* ------------------------------------------------------------------ *
 * tools.* — the bridge back to Reaper's executor.
 *
 * Concurrency here is real. Each call gets an id and a pending entry;
 * the parent may answer them in any order, and ten in flight is ten
 * running. Promise.all over tools.read does what it looks like it does.
 * ------------------------------------------------------------------ */
const pending = new Map();
let nextCallId = 0;

function callTool(name, args) {
  return new Promise((resolve, reject) => {
    const id = ++nextCallId;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'tool', id, name, args: args === undefined ? {} : args });
  });
}

const tools = new Proxy({}, {
  get(_target, property) {
    if (typeof property !== 'string') return undefined;
    if (property === 'list') return () => workerData.tools.map((t) => ({ name: t.name, description: t.description }));
    if (property === 'describe') return (name) => workerData.schemas[name];
    if (property === 'then') return undefined; // so \`await tools\` does not hang
    return (args) => callTool(property, args);
  },
  has(_target, property) {
    if (typeof property !== 'string') return false;
    if (property === 'list' || property === 'describe') return true;
    return workerData.tools.some((t) => t.name === property)
      || (workerData.aliases ?? []).includes(property);
  },
  ownKeys() {
    return workerData.tools.map((t) => t.name);
  },
  getOwnPropertyDescriptor() {
    return { enumerable: true, configurable: true };
  },
});

/* ------------------------------------------------------------------ *
 * models.* — the thread's chat models, callable from a script.
 *
 * The same shape as tools.* and over the same channel, because it is the
 * same idea: a capability the host owns, lent to the script for the length
 * of one program. A script that fans out over several models gets real
 * concurrency, exactly as Promise.all over tools.* does — each call is a
 * pending entry keyed by id, and the parent answers them as they finish.
 *
 * Only bound when the host offers it. An embedding with no conversation
 * behind it has no models to lend, and \`models\` being undefined there is a
 * truer answer than a function that rejects on first use.
 * ------------------------------------------------------------------ */
function callModel(args) {
  return new Promise((resolve, reject) => {
    const id = ++nextCallId;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'model', id, args: args === undefined ? {} : args });
  });
}

const models = workerData.models
  ? {
      list: () => workerData.models.slice(),
      call: (args) => callModel(args),
    }
  : undefined;

/* ------------------------------------------------------------------ *
 * The guard, applied where the damage would happen.
 *
 * fs and child_process are patched in the module cache before the
 * script runs, so a later \`require('fs')\` or \`import('node:fs')\`
 * gets the guarded copy. This stops the catastrophic-and-never-intended
 * operations listed in guard.ts. It is not an attempt to contain a
 * hostile script, which a thread with full Node cannot do anyway.
 * ------------------------------------------------------------------ */
class CodeModeRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodeModeRefusal';
    this.code = 'REAPER_REFUSED';
  }
}

/*
 * Relative paths become workspace-relative, and that is a correctness fix
 * before it is anything else.
 *
 * Node resolves a relative path against \`process.cwd()\`, and a Worker's cwd is
 * the *parent's* cwd — \`process.chdir()\` throws \`ERR_WORKER_UNSUPPORTED_OPERATION\`
 * in a thread and the \`Worker\` constructor's \`cwd\` option is silently ignored,
 * so the thread cannot have a cwd of its own. That left Code Mode holding two
 * different ideas of where it was: \`require\` and \`import\` resolved against the
 * workspace via \`createRequire\`, while \`fs\` and \`child_process\` resolved
 * against wherever Reaper happened to be launched.
 *
 * Observed live, in the browser drive. The model was asked to read
 * \`src/sample/expected.json\`, a file that existed in the thread's workspace,
 * and its script died on \`ENOENT: no such file or directory, open
 * 'src/sample/expected.json'\` — because the lookup went to Reaper's own
 * checkout, which has no such file. The same lookup against a path that happens
 * to exist in both trees is worse than a failure: it is a silent read of the
 * wrong project's source.
 *
 * The write direction is worse again and is why this lives in the guard rather
 * than beside it. \`fs.writeFileSync('src/routes/auth.ts', …)\` from a thread
 * whose workspace is \`~/.reaper/workspaces/<id>\` was writing into Reaper's own
 * source tree, with the audit trail of a tool call that appears to have stayed
 * inside the workspace.
 *
 * Resolving here fixes both readings at once, because every guarded call goes
 * through this wrapper and every guarded call is also where the danger check
 * happens — so the path that gets checked and the path that gets used are now
 * the same string. \`path.resolve\` leaves an absolute path alone, which keeps
 * the deliberate case working: a model writing to /tmp is doing something
 * normal and the guard's job is to judge it, not to redirect it into the
 * workspace.
 */
function resolveAgainstWorkspace(target) {
  return require('node:path').resolve(workerData.workspace, target);
}

/*
 * Every filesystem entry point that takes a path, and what each path *is*.
 *
 * The first version of this guard listed only the functions it wanted to
 * refuse — \`writeFileSync\`, \`rmSync\`, and friends — which was the right list
 * for a refusal and the wrong list for a resolution. A script that wrote
 * \`written.txt\` and then asked \`fs.existsSync('written.txt')\` got \`true\` from
 * the write and \`false\` from the check, because the write was guarded and the
 * check was not. That is worse than either answer being wrong on its own: the
 * model is told its file exists and does not exist in the same breath, and it
 * has no way to find out which one to believe.
 *
 * So the list is now exhaustive by function rather than by danger. A path is
 * resolved because it is a path, whether or not the guard has an opinion about
 * where it points; the guard's opinion is the second step, and it is per
 * argument, because several of these calls take two paths that mean opposite
 * things — \`copyFile(src, dest)\` reads one and writes the other, and refusing
 * it because the *source* is in /etc would be a false refusal.
 *
 * Index 0 is omitted nowhere on purpose: \`symlink(target, linkPath)\` stores
 * \`target\` as literal text to be interpreted relative to the link's own
 * directory, so resolving it against the workspace would change what the link
 * points at. It is the one path argument in the API that is data rather than a
 * location, and it is left alone.
 */
const FS_PATHS = {
  // Reads — everything here is inspected, not modified.
  readFile: [[0, 'read']], readFileSync: [[0, 'read']], createReadStream: [[0, 'read']],
  readdir: [[0, 'read']], readdirSync: [[0, 'read']],
  opendir: [[0, 'read']], opendirSync: [[0, 'read']],
  stat: [[0, 'read']], statSync: [[0, 'read']],
  lstat: [[0, 'read']], lstatSync: [[0, 'read']],
  statfs: [[0, 'read']], statfsSync: [[0, 'read']],
  access: [[0, 'read']], accessSync: [[0, 'read']], existsSync: [[0, 'read']],
  realpath: [[0, 'read']], realpathSync: [[0, 'read']],
  readlink: [[0, 'read']], readlinkSync: [[0, 'read']],
  watch: [[0, 'read']], watchFile: [[0, 'read']], unwatchFile: [[0, 'read']],

  // Writes — the path is where something is created, changed or destroyed.
  writeFile: [[0, 'write']], writeFileSync: [[0, 'write']],
  appendFile: [[0, 'write']], appendFileSync: [[0, 'write']],
  createWriteStream: [[0, 'write']],
  unlink: [[0, 'write']], unlinkSync: [[0, 'write']],
  rm: [[0, 'write']], rmSync: [[0, 'write']],
  rmdir: [[0, 'write']], rmdirSync: [[0, 'write']],
  mkdir: [[0, 'write']], mkdirSync: [[0, 'write']],
  mkdtemp: [[0, 'write']], mkdtempSync: [[0, 'write']],
  truncate: [[0, 'write']], truncateSync: [[0, 'write']],
  chmod: [[0, 'write']], chmodSync: [[0, 'write']],
  chown: [[0, 'write']], chownSync: [[0, 'write']],
  lchown: [[0, 'write']], lchownSync: [[0, 'write']],
  utimes: [[0, 'write']], utimesSync: [[0, 'write']],
  lutimes: [[0, 'write']], lutimesSync: [[0, 'write']],
  cp: [[0, 'read'], [1, 'write']], cpSync: [[0, 'read'], [1, 'write']],
  copyFile: [[0, 'read'], [1, 'write']], copyFileSync: [[0, 'read'], [1, 'write']],
  // Renaming *out* of a system directory is as destructive as writing into one,
  // so both ends of a rename are judged as writes.
  rename: [[0, 'write'], [1, 'write']], renameSync: [[0, 'write'], [1, 'write']],
  link: [[0, 'read'], [1, 'write']], linkSync: [[0, 'read'], [1, 'write']],
  // Only the link's own location; see the note above.
  symlink: [[1, 'write']], symlinkSync: [[1, 'write']],
};

/*
 * \`open\` is the one entry point whose operation is not in its name.
 *
 * \`fs.open('/etc/passwd', 'w')\` truncates a system file, and classifying it as
 * a read — which is what the previous list did by putting it with \`readFile\` —
 * meant the guard waved it through. The flags decide, and the test is \`wa+\`
 * rather than \`w\` so that \`r+\` counts: a file opened for read-and-write is a
 * file being written.
 */
function openOperation(flags) {
  return typeof flags === 'string' && /[wa+]/.test(flags) ? 'write' : 'read';
}

function guardPath(spec) {
  return (original) => function (...args) {
    for (const [index, operation] of spec) {
      if (typeof args[index] === 'string') args[index] = resolveAgainstWorkspace(args[index]);
      const reason = isDangerousPath(
        typeof args[index] === 'string' ? args[index] : '',
        operation === 'open' ? openOperation(args[1]) : operation,
      );
      if (reason) throw new CodeModeRefusal(reason);
    }
    return original.apply(this, args);
  };
}

function patchModule(id, patches) {
  const mod = require(id);
  for (const [name, wrap] of Object.entries(patches)) {
    const original = mod[name];
    if (typeof original !== 'function') continue;
    mod[name] = wrap(original);
  }
  return mod;
}

/** \`open\` resolves the path and then asks the flags what it is. */
FS_PATHS.open = [[0, 'open']];
FS_PATHS.openSync = [[0, 'open']];

const fsPatches = {};
for (const [name, spec] of Object.entries(FS_PATHS)) fsPatches[name] = guardPath(spec);
patchModule('node:fs', fsPatches);

/*
 * The promise API is a second surface with its own bindings, not a wrapper over
 * the first, so patching \`node:fs\` does not reach it. It is the same table:
 * every name here exists on both, with the same argument order.
 *
 * \`fs.promises\` and \`require('node:fs/promises')\` are the same object in Node,
 * so assigning through either name reaches both — which matters, because the
 * live model writes \`require('node:fs/promises')\` about as often as it writes
 * \`require('node:fs').promises\`.
 */
const fsp = require('node:fs/promises');
for (const [name, spec] of Object.entries(FS_PATHS)) {
  if (typeof fsp[name] === 'function') fsp[name] = guardPath(spec)(fsp[name]);
}

/*
 * A child process inherits the thread's cwd, and the thread's cwd is the
 * parent's — the same disagreement the filesystem guard above exists to close.
 * \`execSync('cat src/sample/module-0.ts')\` would therefore run against Reaper's
 * own checkout, which is the identical bug wearing a shell.
 *
 * So the shell gets an explicit \`cwd\`, and an option the model already set
 * wins: a script that deliberately runs in a subdirectory means it, and
 * overriding that would be the guard making a decision the model already made.
 */
/*
 * Where the options object sits is not fixed for the \`spawn\` family.
 *
 * \`execFile(file, args, options)\` and \`execFile(file, options)\` are both valid,
 * and \`spawn\` is the same — so an index hardcoded to 2 would insert a stray
 * argument when the model omitted the args array, and Node would then read the
 * model's options object as the args list. \`args[1]\` being an array is exactly
 * how Node itself decides, so the same test is used here.
 */
/*
 * The synchronous calls get a deadline of their own, and this is the fix for a
 * timeout that did not work.
 *
 * \`worker.terminate()\` is how the 30-second limit is enforced, and it is a
 * request to stop at the next V8 safepoint. A thread parked inside a blocking
 * syscall never reaches one, so a script that called \`execSync('sleep 300')\`
 * could not be stopped at all: the limit fired, \`terminate()\` was called, and
 * nothing happened until the child exited on its own. Observed in the browser
 * drive as a Code Mode row reading \`3m 18s\` beside the message "The script ran
 * longer than 30000ms and was stopped" — the two numbers describing the same
 * event, six times apart.
 *
 * Node's own \`timeout\` option does what \`terminate()\` cannot: it kills the
 * child, which unblocks the syscall, which returns the thread to JavaScript,
 * where the pending termination finally lands. So the deadline is handed to the
 * child instead.
 *
 * The value is what is *left* of the eval's budget, not the whole of it. A
 * child given the full 30 seconds partway through a script would push the real
 * wall clock past the limit by however long the script had already run, which
 * is the same class of drift this exists to remove.
 *
 * A \`timeout\` the model set itself is clamped rather than replaced: it is the
 * model's own bound on its own command, and shortening it below the remaining
 * budget would be wrong in the other direction — but letting it *exceed* the
 * budget would let a script escape the limit that governs it.
 */
function withDeadline(options) {
  const remaining = Math.max(1, workerData.deadlineAt - Date.now());
  const modelTimeout = typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : Infinity;
  return Math.min(modelTimeout, remaining);
}

/*
 * Child processes are reported to the host, so it can outlive them cleanly.
 *
 * The deadline above handles the synchronous case; this handles the other one.
 * A script that starts a background process and finishes leaves that process
 * running — the worker is gone, the eval is reported complete, and something is
 * still on the machine holding a port or writing to a file. \`bash\` has had that
 * solved since the beginning, through a tracked-children list that gets SIGTERM
 * and then SIGKILL; this is the same fact reported through the same kind of
 * channel.
 *
 * Reported rather than killed here because the kill must happen on the host: by
 * the time it is needed, the thread that would run it is the thread being
 * terminated. Purely additive, and wrapped, because a failed post must not
 * break the model's call — the worst case is an uncollected process, which is
 * exactly where things already were.
 */
function trackChild(child) {
  try {
    if (child && typeof child.pid === 'number') {
      parentPort.postMessage({ type: 'child', pid: child.pid });
    }
  } catch {
    // Ignored on purpose; see above.
  }
  return child;
}

/*
 * Finding the options slot is the fiddly part, and getting it wrong breaks the
 * model's code in a way that looks like its own mistake.
 *
 * These functions have three interchangeable arities each:
 *
 *     exec(cmd, cb)                 exec(cmd, opts, cb)
 *     spawn(file, args, opts)       spawn(file, opts)        spawn(file, args, cb)
 *
 * So the position is not fixed and cannot be assumed. An earlier version
 * hardcoded it, and \`exec('echo hi', (e, out) => …)\` — the single most common
 * way to run a command asynchronously — had its callback *replaced* by an
 * options object. The script then awaited a callback that no longer existed and
 * hung until the eval timed out. Node would have thrown \`callback is not a
 * function\`; instead the model got a timeout and no error, on code that was
 * correct.
 *
 * The rule here is Node's own: skip an args array if there is one, and put the
 * options object in the slot before it — inserting rather than overwriting when
 * a callback is already sitting there.
 */
function optionsSlot(args, baseIndex) {
  let index = baseIndex;
  while (index < args.length && (args[index] === undefined || args[index] === null)) index += 1;
  // A function here is the callback, and options belong in front of it.
  if (index < args.length && typeof args[index] === 'function') return { index, insert: true };
  return { index, insert: false };
}

function guardCommand(original, spawnFamily, sync) {
  return function (...args) {
    const reason = isDangerousCommand(typeof args[0] === 'string' ? args[0] : '');
    if (reason) throw new CodeModeRefusal(reason);

    const baseIndex = spawnFamily && Array.isArray(args[1]) ? 2 : 1;
    const { index, insert } = optionsSlot(args, baseIndex);
    const existing = insert ? undefined : args[index];
    const base = existing && typeof existing === 'object' ? existing : {};
    const next = Object.assign({}, base, { cwd: base.cwd ?? workerData.workspace });
    /*
     * Only the synchronous calls. An async \`spawn\` returns immediately, so the
     * thread reaches a safepoint on its own and \`terminate()\` works; giving it
     * a timeout would kill a process the script is deliberately waiting on in
     * the background, which is a thing it is allowed to do.
     */
    if (sync) next.timeout = withDeadline(base);
    if (insert) args.splice(index, 0, next);
    else args[index] = next;

    const result = original.apply(this, args);
    /*
     * Every asynchronous form returns a ChildProcess, and that handle is the
     * thing worth reporting. The synchronous ones have already exited by the
     * time they return, so there is nothing left to track — and tracking one
     * would send the host a pid that is about to be reused by something else.
     */
    return sync ? result : trackChild(result);
  };
}
/*
 * Three flags per entry: whether the args array sits at index 1, and whether
 * the call blocks the thread. Only the \`*Sync\` three can park it.
 */
patchModule('node:child_process', {
  exec: (o) => guardCommand(o, false, false),
  execSync: (o) => guardCommand(o, false, true),
  spawn: (o) => guardCommand(o, true, false),
  spawnSync: (o) => guardCommand(o, true, true),
  execFile: (o) => guardCommand(o, true, false),
  execFileSync: (o) => guardCommand(o, true, true),
  fork: (o) => guardCommand(o, true, false),
});


/* ------------------------------------------------------------------ *
 * Running the script.
 *
 * Compiled as an async function body so top-level await works and the
 * completion value of the last expression is what comes back — the
 * return semantics the tool promises. \`vm.compileFunction\` with the
 * bridge names as parameters is what puts \`tools\` in scope without a
 * global, and \`require\`/\`import\` resolve against the workspace so an
 * npm package installed in the project is importable.
 * ------------------------------------------------------------------ */
const workspaceRequire = nodeModule.createRequire(workerData.workspace + '/__codemode__.js');

function isPromise(value) {
  return value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
}

/**
 * Compile the model's code as an *async* function body.
 *
 * \`vm.compileFunction\` builds a plain function, and a plain function body
 * rejects top-level \`await\` — which every \`tools.*\` call needs and which
 * the tool description explicitly promises. Wrapping the body in an async
 * arrow and returning its promise is what makes that promise true.
 *
 * The wrapper costs one line of offset in stack traces, which \`lineFromStack\`
 * on the host side already accounts for.
 */
function compile(body) {
  /*
   * \`body\` is already a complete async IIFE expression — transform.ts emits
   * \`(async () => { … })()\` — so this only has to return it. Wrapping it in
   * a second async arrow, as an earlier version did, made the outer one return
   * nothing and threw away every script's value while still reporting success:
   * the tool's one central promise, silently broken.
   */
  return vm.compileFunction(
    'return ' + body + ';',
    /*
     * \`models\` is always a parameter, even when the host offers none. A script
     * that reaches for it then gets \`models.list()\` failing on \`undefined\` —
     * a plain JavaScript error naming the thing that is missing — rather than
     * a \`ReferenceError\` that reads as a typo in the script. When the host does
     * offer it, the same name is bound to the real surface.
     */
    ['tools', 'models', 'require', '__dirname', '__filename'],
    {
      filename: 'codemode.js',
      /*
       * Without this, \`await import('node:fs')\` fails with "A dynamic
       * import callback was not specified" — a message about vm internals
       * that has nothing to do with the model's code, raised for the exact
       * line the live model kept writing. Delegating to the workspace
       * resolver makes \`import()\` resolve the same specifiers \`require\`
       * does: node builtins, and npm packages installed in the project.
       */
      importModuleDynamically: (specifier) => import(workspaceResolve(specifier)),
    },
  );
}

/**
 * Turn a bare specifier into something \`import()\` can load from here.
 *
 * The worker's own module URL is inside node_modules or a bundle, so a bare
 * \`lodash\` would resolve against the wrong tree — the workspace is where the
 * model's dependencies actually are. Builtins are passed through untouched,
 * and an unresolvable specifier is passed through too so the failure the model
 * sees is Node's own "Cannot find package", not ours.
 */
function workspaceResolve(specifier) {
  if (specifier.startsWith('node:') || nodeModule.isBuiltin(specifier)) return specifier;
  try {
    return require('node:url').pathToFileURL(workspaceRequire.resolve(specifier)).href;
  } catch {
    return specifier;
  }
}

async function main() {
  /*
   * The host already decided where the value-producing tail is.
   *
   * That analysis lives in transform.ts, which searches candidate splits and
   * verifies each one actually compiles — including the awkward shapes, like a
   * script ending in try/catch, where the value is produced inside a block. A
   * second implementation here would be a worse copy of it that drifts, so the
   * worker receives the finished source and only runs it.
   */
  let value = compile(workerData.compiled).call(
    undefined,
    tools,
    models,
    workspaceRequire,
    workerData.workspace,
    workerData.workspace + '/codemode.js',
  );
  if (isPromise(value)) value = await value;
  return value;
}

/* ------------------------------------------------------------------ *
 * Messages from the parent: tool results, and nothing else.
 * ------------------------------------------------------------------ */
parentPort.on('message', (message) => {
  if (message.type !== 'toolResult' && message.type !== 'modelResult') return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) {
    /*
     * A tool resolves to its payload; a model call resolves to the prose,
     * because that is what a script wants to work with. Handing back the
     * envelope would make every caller write \`(await models.call(...)).text\`,
     * which is the JSON-parse ceremony this environment exists to remove.
     */
    entry.resolve(message.type === 'modelResult' ? message.text : message.output);
  } else {
    const error = new Error(message.error.message);
    /*
     * Named per call site, because a script catching this needs to tell a
     * refused tool from a failed model call — they want different retries.
     * \`tool\` stays attached on the tool path so the existing hint machinery
     * keeps working.
     */
    error.name = message.type === 'modelResult' ? 'ReaperModelError' : 'ReaperToolError';
    error.code = message.error.code;
    error.tool = message.error.tool;
    entry.reject(error);
  }
});

main().then(
  (value) => { parentPort.postMessage({ type: 'done', value: safeValue(value) }); },
  (error) => {
    parentPort.postMessage({
      type: 'failed',
      error: {
        name: (error && error.name) || 'Error',
        message: (error && error.message) || String(error),
        stack: error && error.stack ? String(error.stack) : undefined,
        code: error && error.code ? String(error.code) : undefined,
        tool: error && error.tool ? String(error.tool) : undefined,
      },
    });
  },
);

/**
 * Reduce the completion value to something structured-cloneable.
 *
 * A worker's postMessage uses the structured clone algorithm, which
 * throws on functions, symbols, and class instances with accessors —
 * and the model returns whatever it returns. Anything that will not
 * clone is rendered to a string rather than allowed to kill the run at
 * the last step, after the work is already done.
 */
function safeValue(value) {
  const seen = new WeakSet();
  function walk(node, depth) {
    if (node === null || node === undefined) return node;
    const type = typeof node;
    if (type === 'string' || type === 'number' || type === 'boolean') return node;
    // The "n" suffix is kept: a bare 10 for a bigint is indistinguishable
    // from the number 10 in the result, and telling them apart is exactly
    // what a model is checking for when it converts a large value.
    if (type === 'bigint') return node.toString() + 'n';
    if (type === 'function') return '[Function' + (node.name ? ': ' + node.name : '') + ']';
    if (type === 'symbol') return node.toString();
    if (node instanceof Error) return { name: node.name, message: node.message };
    if (node instanceof Date) return node.toISOString();
    if (node instanceof Map) return walk(Object.fromEntries(node), depth);
    if (node instanceof Set) return walk([...node], depth);
    if (depth > 20) return '[nested too deeply]';
    if (seen.has(node)) return '[Circular]';
    seen.add(node);
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer) return '[binary ' + (node.byteLength || 0) + ' bytes]';
    const out = {};
    for (const key of Object.keys(node)) {
      try { out[key] = walk(node[key], depth + 1); } catch (e) { out[key] = '[threw on access]'; }
    }
    return out;
  }
  try {
    return walk(value, 0);
  } catch {
    return String(value);
  }
}
`;
}

export const CODE_MODE_WORKER_SOURCE = buildWorkerSource(GUARD_SOURCE);
