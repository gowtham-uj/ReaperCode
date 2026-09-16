/**
 * The workspace boundary, tested at the only level where it means anything:
 * a real command, run the way a turn runs it, trying to leave.
 *
 * The previous guard was a regex over the command string, and every test it
 * had passed while the guard leaked — because the tests asked the same
 * question the regex did ("does this command mention a path outside?") rather
 * than the question that matters ("can this command read a file outside?").
 * So these cases are written as reads and writes with an observable result,
 * and three of them are forms no string scan can see: a path assembled at
 * runtime, a path reached through a symlink, and a path a second process
 * opens.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { executeBashTool, isForegroundShellResult } from "../../src/tools/global/bash.js";
import { resolveBubblewrap } from "../../src/policy/shell-sandbox.js";

const sandboxAvailable = resolveBubblewrap() !== undefined;

async function run(workspace: string, cmd: string, sandbox?: boolean): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const result = await executeBashTool(
    workspace,
    { cmd, timeoutMs: 30_000, ...(sandbox === false ? { sandbox: false } : {}) },
    "allow_all",
  );
  if (!isForegroundShellResult(result)) throw new Error("expected a foreground result");
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

async function fixture(): Promise<{ workspace: string; outsideFile: string; outsideDir: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "reaper-sandbox-"));
  const workspace = path.join(base, "workspace");
  const outsideDir = path.join(base, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  const outsideFile = path.join(outsideDir, "secret.txt");
  await writeFile(outsideFile, "TOP-SECRET-VALUE\n");
  await writeFile(path.join(workspace, "inside.txt"), "workspace content\n");
  return { workspace, outsideFile, outsideDir };
}

test("the sandbox lets ordinary work inside the workspace through", { skip: !sandboxAvailable }, async () => {
  const { workspace } = await fixture();
  const read = await run(workspace, "cat inside.txt");
  assert.equal(read.exitCode, 0);
  assert.match(read.stdout, /workspace content/);

  const write = await run(workspace, "printf 'made here\\n' > made.txt && cat made.txt");
  assert.equal(write.exitCode, 0);
  assert.match(write.stdout, /made here/);
  // The write is real, not confined to a throwaway overlay: the sandbox binds
  // the workspace itself, so the file survives the process that made it.
  assert.equal(await readFile(path.join(workspace, "made.txt"), "utf8"), "made here\n");
});

test("a program the command starts still cannot see outside", { skip: !sandboxAvailable }, async () => {
  const { workspace, outsideFile } = await fixture();
  // node, not the shell. The old guard inspected the shell command; anything
  // the command launched was past it.
  const result = await run(
    workspace,
    `node -e "try { process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8')) } catch (e) { process.stdout.write('DENIED ' + e.code) }" ${JSON.stringify(outsideFile)}`,
  );
  assert.match(result.stdout, /DENIED ENOENT/);
  assert.doesNotMatch(result.stdout, /TOP-SECRET-VALUE/);
});

test("a path assembled at runtime cannot escape either", { skip: !sandboxAvailable }, async () => {
  const { workspace, outsideFile } = await fixture();
  const head = outsideFile.slice(0, 4);
  const tail = outsideFile.slice(4);
  // No absolute path appears in the command text. A scanner sees two string
  // literals; the kernel sees a path that is not mounted.
  const result = await run(workspace, `p=${JSON.stringify(head)}; q=${JSON.stringify(tail)}; cat "$p$q" 2>&1 || echo DENIED`);
  assert.match(result.stdout, /DENIED/);
  assert.doesNotMatch(result.stdout, /TOP-SECRET-VALUE/);
});

test("a symlink out of the workspace resolves to nothing", { skip: !sandboxAvailable }, async () => {
  const { workspace, outsideFile } = await fixture();
  await symlink(outsideFile, path.join(workspace, "link.txt"));
  const result = await run(workspace, "cat link.txt 2>&1 || echo DENIED");
  assert.match(result.stdout, /DENIED/);
  assert.doesNotMatch(result.stdout, /TOP-SECRET-VALUE/);
});

test("a write outside the workspace does not land", { skip: !sandboxAvailable }, async () => {
  const { workspace, outsideDir } = await fixture();
  const target = path.join(outsideDir, "planted.txt");
  await run(workspace, `printf 'x\\n' > ${JSON.stringify(target)} 2>&1 || echo DENIED`);
  await assert.rejects(readFile(target, "utf8"), /ENOENT/);
});

test("the sandbox does not hide the home directory's own workspace", { skip: !sandboxAvailable }, async () => {
  // The tmpfs over $HOME is mounted before the workspace bind precisely so a
  // workspace under the home directory is not covered by it. That ordering is
  // the kind of thing that works until someone reorders two lines.
  const home = process.env.HOME;
  if (!home) return;
  const workspace = await mkdtemp(path.join(home, ".reaper-sandbox-test-"));
  await writeFile(path.join(workspace, "under-home.txt"), "still here\n");
  const result = await run(workspace, "cat under-home.txt");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /still here/);
});

test("turning the sandbox off restores full filesystem access", { skip: !sandboxAvailable }, async () => {
  const { workspace, outsideFile } = await fixture();
  // The opt-out has to be a real opt-out. With the sandbox off the only thing
  // left is the string scan, which allows a path it cannot see, so this is
  // also the case that proves the two paths are genuinely different.
  const head = outsideFile.slice(0, 4);
  const tail = outsideFile.slice(4);
  const result = await run(workspace, `p=${JSON.stringify(head)}; q=${JSON.stringify(tail)}; cat "$p$q"`, false);
  assert.match(result.stdout, /TOP-SECRET-VALUE/);
});
