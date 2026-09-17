/**
 * Code Mode's confinement, tested the way the shell sandbox is tested: a real
 * script, run the way a turn runs it, trying to leave the workspace.
 *
 * The property under test is the one the old runtime could not have. Before
 * this, `eval` ran in a thread of Reaper's own process and a script that did
 * `fs.readFileSync('/etc/passwd')` got the file, because nothing stood between
 * the script and Reaper's filesystem. Now the worker runs inside the same
 * bubblewrap namespace a `bash` command gets, so the read fails for the same
 * reason a shell command's would: the path is not mounted.
 *
 * Each case asks the question that matters ("can the script read this?") rather
 * than the question the implementation happens to answer ("is this path on a
 * deny list?"), because a deny list is exactly the approach that kept leaking.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { evaluateScript } from "../../src/tools/eval.js";
import { sandboxAvailableForEval } from "../../src/tools/code/transport.js";
import type { CodeToolHost } from "../../src/tools/code/types.js";

const sandboxAvailable = sandboxAvailableForEval();

/**
 * A host that offers no tools.
 *
 * The scripts here call no `tools.*`, so the bridge is never used; an empty
 * catalogue keeps the test from depending on the registry, which is a different
 * surface with its own tests.
 */
function nullHost(): CodeToolHost {
  return {
    names: () => [],
    describe: () => undefined,
    invoke: async () => ({ ok: false, error: { code: "no_tools", message: "no tools" } }),
  } as unknown as CodeToolHost;
}

async function fixture(): Promise<{ workspace: string; outsideFile: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "reaper-eval-sandbox-"));
  const workspace = path.join(base, "workspace");
  await mkdir(workspace, { recursive: true });
  const outsideFile = path.join(base, "outside", "secret.txt");
  await mkdir(path.dirname(outsideFile), { recursive: true });
  await writeFile(outsideFile, "TOP-SECRET-VALUE\n");
  await writeFile(path.join(workspace, "inside.txt"), "workspace content\n");
  return { workspace, outsideFile };
}

async function evalScript(workspace: string, code: string): Promise<Record<string, unknown> | undefined> {
  return await evaluateScript({
    args: { code },
    toolCallId: "call-1",
    runId: `run-${Math.random().toString(36).slice(2)}`,
    host: nullHost(),
    workspace,
  });
}

test("a script runs inside the sandbox and its result comes back", { skip: !sandboxAvailable }, async () => {
  const { workspace } = await fixture();
  const output = await evalScript(workspace, "1 + 1");
  assert.equal(output?.status, "completed");
  assert.equal(output?.value, 2);
  assert.equal(output?.sandboxed, undefined, "a confined run does not carry sandboxed: false");
});

test("a script reads a file inside the workspace", { skip: !sandboxAvailable }, async () => {
  const { workspace } = await fixture();
  const output = await evalScript(
    workspace,
    "const fs = require('node:fs'); fs.readFileSync('inside.txt', 'utf8').trim()",
  );
  assert.equal(output?.status, "completed");
  assert.equal(output?.value, "workspace content");
});

test("a script cannot read a file outside the workspace", { skip: !sandboxAvailable }, async () => {
  const { workspace, outsideFile } = await fixture();
  /*
   * The assertion is on the observable outcome, not on an error class: the file
   * must not be read. A run that somehow succeeded while returning the content
   * would be the failure this test exists to catch, so the value is checked as
   * well as the status.
   */
  const output = await evalScript(
    workspace,
    `const fs = require('node:fs');
     try { ({ read: fs.readFileSync(${JSON.stringify(outsideFile)}, 'utf8') }) }
     catch (error) { ({ blocked: error.code }) }`,
  );
  const value = output?.value as { read?: string; blocked?: string } | undefined;
  assert.equal(value?.read, undefined, "the script must not read a file outside its workspace");
  assert.ok(value?.blocked, "the read should fail with a filesystem error");
});

test("a script cannot read a Reaper source file through an absolute path", { skip: !sandboxAvailable }, async () => {
  const { workspace } = await fixture();
  const output = await evalScript(
    workspace,
    `const fs = require('node:fs');
     try { ({ read: fs.readFileSync('/work/package.json', 'utf8').slice(0, 20) }) }
     catch (error) { ({ blocked: error.code }) }`,
  );
  const value = output?.value as { read?: string; blocked?: string } | undefined;
  assert.equal(value?.read, undefined, "a script must not reach Reaper's own checkout");
});

test("a script cannot write outside the workspace", { skip: !sandboxAvailable }, async () => {
  const { workspace } = await fixture();
  const target = path.join(path.dirname(workspace), "escape.txt");
  /*
   * The assertion is on the host filesystem, not on whether the write threw.
   *
   * `/tmp` is mounted writable inside the namespace on purpose — a command's
   * scratch files have to survive between turns — so a script writing to a path
   * *under* `/tmp` does not error: it lands in the workspace's own scratch
   * directory, which is exactly the confinement working. What must never happen
   * is the byte arriving at the host path the script named, so that is what is
   * checked. Asking "did the write throw" would pass or fail depending on where
   * the fixture happened to live, which is not the property.
   */
  await evalScript(
    workspace,
    `const fs = require('node:fs');
     try { fs.writeFileSync(${JSON.stringify(target)}, 'escaped'); } catch {}`,
  );
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(target), false, "the script must not write to a path outside its workspace");
});

test("a script cannot write to a directory that is not mounted at all", { skip: !sandboxAvailable }, async () => {
  const { workspace } = await fixture();
  /*
   * `/root` is not one of the mounted paths, so this is the case where the
   * namespace makes the write fail rather than merely redirect it. It is the
   * shape the old runtime got wrong: a script could write anywhere the Reaper
   * process could.
   */
  const output = await evalScript(
    workspace,
    `const fs = require('node:fs');
     try { fs.writeFileSync('/root/escape.txt', 'escaped'); ({ wrote: true }) }
     catch (error) { ({ blocked: error.code }) }`,
  );
  const value = output?.value as { wrote?: boolean; blocked?: string } | undefined;
  assert.equal(value?.wrote, undefined, "the script must not write to an unmounted path");
  assert.ok(value?.blocked, "the write should fail with a filesystem error");
});

test("a script can write inside the workspace and the file is really there", { skip: !sandboxAvailable }, async () => {
  const { workspace } = await fixture();
  const output = await evalScript(
    workspace,
    "const fs = require('node:fs'); fs.writeFileSync('from-eval.txt', 'hello'); 'written'",
  );
  assert.equal(output?.value, "written");
  const { readFile } = await import("node:fs/promises");
  assert.equal((await readFile(path.join(workspace, "from-eval.txt"), "utf8")), "hello");
});

test("a script's console output still reaches the transcript", { skip: !sandboxAvailable }, async () => {
  const { workspace } = await fixture();
  const output = await evalScript(workspace, "console.log('from-sandbox'); 'done'");
  const consoleEntries = output?.console as Array<{ text: string }> | undefined;
  assert.equal(consoleEntries?.[0]?.text, "from-sandbox");
});

test("two evals in the same workspace do not share a relay", { skip: !sandboxAvailable }, async () => {
  const { workspace } = await fixture();
  /*
   * Each eval gets its own socket and its own relay, and a value written by one
   * is not visible in the other. The sockets live in a fresh temp directory per
   * transport precisely so two runs cannot collide on one path, and this is the
   * check that the isolation holds.
   */
  const first = await evalScript(workspace, "globalThis.leak = 'x'; 'first'");
  const second = await evalScript(workspace, "typeof globalThis.leak");
  assert.equal(first?.value, "first");
  assert.equal(second?.value, "undefined", "state from one sandboxed eval must not reach the next");
});

test("a script that fails still reports through the sandbox", { skip: !sandboxAvailable }, async () => {
  const { workspace } = await fixture();
  const output = await evalScript(workspace, "throw new Error('boom from sandbox')");
  assert.equal(output?.status, "error");
  const error = output?.error as { message?: string } | undefined;
  assert.match(error?.message ?? "", /boom from sandbox/);
});

test("a script's timeout is enforced inside the sandbox", { skip: !sandboxAvailable }, async () => {
  const { workspace } = await fixture();
  const output = await evaluateScript({
    args: { code: "while (true) {}", timeout_ms: 1500 },
    toolCallId: "call-timeout",
    runId: `run-${Math.random().toString(36).slice(2)}`,
    host: nullHost(),
    workspace,
  });
  assert.equal(output?.status, "timeout", "the deadline must reach a script spinning in the sandbox");
});

/**
 * A script can import a package from the harness's own `node_modules`.
 *
 * This is what the read-only dependency bind is for. Before it, a script that
 * did `import('playwright')` got `ERR_MODULE_NOT_FOUND` — the namespace
 * contains the workspace and system directories, and the package lives outside
 * both — which is why browser code could not run in the same sandbox as
 * everything else.
 *
 * The assertion is on `resolve`, not on a successful launch: resolving proves
 * the module is reachable inside the namespace, and loading playwright is the
 * only thing this test needs to know. Starting a browser is a different test's
 * job and would make this one depend on a browser being installed.
 */
test("a script can resolve a package from the harness dependency bind", { skip: !sandboxAvailable }, async () => {
  const { workspace } = await fixture();
  const output = await evalScript(
    workspace,
    `let resolved = null, failure = null;
     try { resolved = require.resolve('playwright'); } catch (error) { failure = error.code; }
     ({ resolved, failure })`,
  );
  assert.equal(output?.status, "completed", `script failed: ${JSON.stringify(output?.error ?? {})}`);
  const value = output?.value as { resolved?: string; failure?: string | null } | undefined;
  /*
   * `null`, not `undefined`. The script initialises `failure` to `null` and
   * returns it unchanged when the resolve succeeds, and the value crosses the
   * worker boundary as JSON — where `null` stays `null`. Asserting
   * `undefined` fails on a successful resolve, which is the opposite of what
   * this test is for, and it did: it reported a passing resolve as a failure.
   */
  assert.ok(value?.failure == null, `require.resolve must not fail inside the sandbox, got: ${JSON.stringify(value?.failure)}`);
  assert.ok(
    typeof value?.resolved === "string" && value.resolved.includes("playwright"),
    `playwright must resolve inside the sandbox, got ${JSON.stringify(value)}`,
  );
});

test("the dependency bind is read-only", { skip: !sandboxAvailable }, async () => {
  const { workspace } = await fixture();
  const output = await evalScript(
    workspace,
    `const fs = require('node:fs');
     try { fs.writeFileSync('/reaper-deps/node_modules/__probe.txt', 'x'); ({ wrote: true }) }
     catch (error) { ({ blocked: error.code }) }`,
  );
  const value = output?.value as { wrote?: boolean; blocked?: string } | undefined;
  assert.equal(value?.wrote, undefined, "a script must not be able to write into the dependency tree");
  assert.ok(value?.blocked, "the write should fail with a filesystem error");
});

/**
 * The network boundary, which did not exist until it was probed.
 *
 * Every other case in this file tests the filesystem, and the filesystem
 * boundary held. The network one did not: the sandbox tail had
 * `--unshare-pid`, `--unshare-ipc` and `--unshare-uts` and no `--unshare-net`,
 * so a script shared the host's network namespace and loopback was fully
 * reachable. Measured from inside a script before the flag was added: it
 * fetched `127.0.0.1:9222/json/version`, listed every thread's page targets,
 * opened a raw CDP WebSocket to another thread's page and navigated it from
 * example.com to example.org.
 *
 * That is the whole point of `scoped-page.ts` defeated from one `fetch`.
 * Scoping closes the widening chain for a program that holds a `page`; a raw
 * socket to the CDP port never asks for one.
 *
 * The trade is that a sandboxed command now has no network at all, including no
 * DNS. That is what the sandbox is for, and it is what `bash` promises: a
 * command reaches its workspace and nothing else.
 */
test("a script cannot reach the network, including the browser's own CDP port", { skip: !sandboxAvailable }, async () => {
  const { workspace } = await fixture();
  const output = await evalScript(
    workspace,
    `const probe = async (url) => { try { await fetch(url); return 'reachable' } catch { return 'blocked' } };
     ({
       cdp: await probe('http://127.0.0.1:9222/json/version'),
       steel: await probe('http://127.0.0.1:3000/v1/health'),
       gateway: await probe('http://127.0.0.1:4180/healthz'),
       dns: await probe('http://example.com/'),
     })`,
  );
  const value = output?.value as { cdp?: string; steel?: string; gateway?: string; dns?: string } | undefined;

  assert.equal(value?.cdp, "blocked", "raw Chrome's CDP port must not be reachable from a script");
  /*
   * Steel's port as well as Chrome's, because that is where the browser tool's
   * own endpoint lives now. Reaching it from a script would be the same bypass
   * through a different door: Steel's cast socket and session routes are
   * unscoped, so a sandboxed program that could open them would see every
   * thread's pages without ever asking for a `page`.
   */
  assert.equal(value?.steel, "blocked", "Steel's API port must not be reachable from a script");
  assert.equal(value?.gateway, "blocked", "the app-server gateway is on loopback and must not be reachable from a script");
  assert.equal(value?.dns, "blocked", "a sandboxed script has no network at all, not even outbound");
});
