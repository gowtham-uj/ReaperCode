/**
 * The program that hosts Code Mode's worker *inside* the sandbox.
 *
 * Code Mode used to run its worker in the Reaper process, which is a thread of
 * a process that can see the whole machine. The tool's own header was honest
 * about it: reading `/etc/passwd` or another thread's workspace from a script
 * worked, because nothing separated the script from Reaper's own filesystem.
 * `bash` has been confined by bubblewrap for a while; `eval` was the hole next
 * to it, and a hole beside a wall is the wall.
 *
 * So the script now runs in the same mount namespace a shell command gets. The
 * worker itself has to live in there — that is the whole point, a worker on the
 * host runs with the host's filesystem. But the worker must still talk to the
 * host: every `tools.*` call is a round trip into Reaper's real executor with
 * its permission checks and audit log, and that executor is outside.
 *
 * A worker started with `eval: true` can only receive its program through
 * `workerData`, which is an in-process channel, so a process on the outside
 * cannot start it directly. This relay is the process that closes the gap: it
 * runs inside the namespace, owns the worker, and carries frames to the host
 * over a unix socket that the host bound into the namespace. Messages are
 * serialized with `node:v8` rather than JSON so a result containing a BigInt or
 * a Buffer or a cyclic object travels the same way it would over `postMessage`;
 * the two sides are the same Node version, which is what makes that safe.
 *
 * Kept as a string rather than a `.js` file for the same reason the worker
 * source is: `npm run build:binary` esbuilds everything into one file with no
 * siblings to resolve a path against, so a file on disk would exist in the dev
 * tree and be missing from the shipped binary. The host writes this text into
 * the workspace scratch at run time, where the namespace can read it.
 */
export const CODE_MODE_RELAY_SOURCE = String.raw`
'use strict';
const net = require('node:net');
const v8 = require('node:v8');
const { Worker } = require('node:worker_threads');

const socketPath = process.env.REAPER_CODE_IPC;
if (!socketPath) {
  process.stderr.write('reaper code relay: REAPER_CODE_IPC is not set\n');
  process.exit(2);
}

/* Framing: a 4-byte big-endian length, then a v8-serialized message. The same
 * frame format is implemented on the host side. */
let inbound = Buffer.alloc(0);
const socket = net.connect(socketPath);

function send(message) {
  if (socket.destroyed) return;
  let payload;
  try {
    payload = v8.serialize(message);
  } catch (error) {
    /* A value the worker produced that cannot be serialized is the worker's
     * problem to report, not a reason to drop the connection; send a plain
     * error frame instead of throwing out of an event handler. */
    payload = v8.serialize({ type: 'workerError', error: { name: 'DataCloneError', message: String(error && error.message || error) } });
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
}

socket.on('connect', () => send({ type: 'ready' }));

socket.on('data', (chunk) => {
  inbound = Buffer.concat([inbound, chunk]);
  while (inbound.length >= 4) {
    const size = inbound.readUInt32BE(0);
    if (inbound.length < 4 + size) break;
    const frame = inbound.subarray(4, 4 + size);
    inbound = inbound.subarray(4 + size);
    let message;
    try {
      message = v8.deserialize(frame);
    } catch {
      continue;
    }
    handle(message);
  }
});

let worker = null;
let closing = false;

function handle(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'start') {
    if (worker) return;
    worker = new Worker(message.workerSource, {
      eval: true,
      workerData: message.workerData,
      resourceLimits: message.resourceLimits,
      execArgv: message.execArgv,
      /* stdout/stderr follow the relay's own fds, which the host holds open, so
       * a package the script imports writing to fd 1 lands in Reaper's output
       * exactly as it did when the worker was in-process. */
      stdout: false,
      stderr: false,
    });
    worker.on('message', (value) => send(value));
    worker.on('error', (error) => {
      send({
        type: 'workerError',
        error: { name: error && error.name, message: error && error.message, code: error && error.code },
      });
    });
    worker.on('exit', (code) => {
      worker = null;
      send({ type: 'workerExit', code });
      if (closing) process.exit(0);
    });
    return;
  }
  if (message.type === 'terminate') {
    if (worker) void worker.terminate();
    return;
  }
  if (message.type === 'shutdown') {
    closing = true;
    if (worker) void worker.terminate();
    else process.exit(0);
    return;
  }
  /*
   * Everything else is the host answering the worker — a toolResult, a
   * modelResult — and has to go straight through. Dropping it here is the
   * quiet failure this relay is most exposed to: the script's await on a tool
   * call never settles, no error is raised anywhere, and the run dies on its
   * deadline with no indication that the answer existed and was discarded.
   */
  if (worker) worker.postMessage(message);
}

/* The host closing the socket means the run is over, whatever state the worker
 * is in. There is no one left to report to, so the relay takes the worker down
 * with it rather than leaving an orphaned script spinning in the namespace. */
function shutdown() {
  closing = true;
  if (worker) void worker.terminate();
  process.exit(0);
}
socket.on('close', shutdown);
socket.on('error', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;
