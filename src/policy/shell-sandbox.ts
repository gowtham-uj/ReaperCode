/**
 * Per-thread filesystem confinement for shell commands, using bubblewrap.
 *
 * Every chat thread owns a workspace directory. Confining the thread to it
 * used to be attempted by reading the command string: scan for absolute paths,
 * scan for `cd` targets, refuse anything that pointed outside. That approach
 * cannot work, and did not. A command is not a path list. `sh -c 'p=/et; cat
 * ${p}c/passwd'`, a heredoc, a script file, a symlink, `find / -name x`, and
 * anything spawned by a program the command started are all invisible to a
 * regex, and the guard that scanned for them was additionally skipped whenever
 * the server's own cwd was outside the workspace, which is every real thread.
 *
 * So the boundary moved into the kernel. Each command runs inside a mount
 * namespace that contains the system directories read-only, the thread's own
 * workspace read-write, and nothing else. A path outside the workspace does
 * not resolve because it is not mounted, which holds for every one of the
 * cases above without knowing anything about the command.
 *
 * The workspace is bound at its own absolute path rather than a fixed `/work`
 * so that paths mean the same thing inside and outside: the transcript, the
 * journal, the tool results, and the `pwd` the shell wrapper reports back are
 * all in terms of the real path, and rewriting them at the boundary would be a
 * second translation layer to get wrong.
 *
 * Network is deliberately left shared. The agent installs packages and calls
 * APIs, and this is a filesystem boundary, not an egress policy.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/** Read-only system directories the sandbox needs to run ordinary programs. */
const SYSTEM_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/lib32",
  "/libx32",
  "/etc",
  "/opt",
];

export interface ShellSandboxCommand {
  command: string;
  args: string[];
}

/**
 * One extra mount point for a sandboxed process, on top of the shared set.
 *
 * Its only user is Code Mode. The eval runtime talks to Reaper over a unix
 * socket, and a socket needs a path both sides can see; binding the socket's
 * directory at a fixed, short name inside the namespace keeps that path short
 * enough for the kernel's 108-byte limit no matter how deep the workspace
 * lives, and keeps the socket out of the workspace path the model's own code
 * would have to guess.
 */
export interface SandboxBind {
  /** Host directory that must already exist. */
  source: string;
  /** Absolute mount point inside the namespace. */
  target: string;
  /**
   * Mount read-only rather than read-write.
   *
   * Code Mode's dependency bind is the reason this exists. A script needs to
   * `require('playwright')`, and the package lives in Reaper's own
   * `node_modules`, which is outside the workspace and therefore unmounted. It
   * has to come in read-only: a script that could write to the module directory
   * could rewrite the library the next script loads, which is a capability
   * nothing in the feature asks for. Defaults to read-write so an existing
   * caller that wants a scratch directory keeps getting one.
   */
  readOnly?: boolean;
}

/**
 * The environment variable a sandboxed process needs to resolve packages from a
 * read-only dependency bind.
 *
 * `NODE_PATH` is set with bubblewrap's `--setenv`, never through the child's
 * environment: `buildChildEnv` strips `NODE_PATH` deliberately (a leak vector),
 * and that stripped env is what `spawn` receives, so setting it there would
 * silently do nothing. Passing it as a namespace argument sidesteps the
 * stripper entirely.
 */
export const SANDBOX_NODE_PATH_ENV = "NODE_PATH";

let availability: { path: string } | null | undefined;

/**
 * Whether bubblewrap is installed and can actually create a namespace here.
 *
 * Both halves are needed. A container that ships `bwrap` but denies
 * `CLONE_NEWNS` fails at the first command rather than at startup, and the
 * error is `Operation not permitted` from a program the user never invoked.
 * The probe runs once per process and is cached, including the negative.
 */
export function resolveBubblewrap(): string | undefined {
  if (availability !== undefined) return availability?.path ?? undefined;
  availability = probeBubblewrap();
  return availability?.path ?? undefined;
}

function probeBubblewrap(): { path: string } | null {
  const binary = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].find((candidate) =>
    existsSync(candidate));
  if (!binary) return null;
  /*
   * The probe runs the same mount set a real command gets, minus the
   * workspace. An abbreviated probe is worse than none: binding only `/usr`
   * leaves the dynamic loader unreachable, so `true` fails to exec and the
   * probe reports "no sandbox here" on a host where the sandbox works.
   */
  const probeArgs: string[] = [];
  for (const systemPath of SYSTEM_PATHS) {
    if (existsSync(systemPath)) probeArgs.push("--ro-bind", systemPath, systemPath);
  }
  probeArgs.push(
    "--tmpfs", "/tmp",
    "--proc", "/proc",
    "--dev", "/dev",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--",
    "/bin/sh", "-c", "exit 0",
  );
  const probe = spawnSync(binary, probeArgs, { stdio: "ignore", timeout: 10_000 });
  return probe.status === 0 ? { path: binary } : null;
}

/** Reset the cached probe. Tests only. */
export function resetBubblewrapProbe(): void {
  availability = undefined;
}

/**
 * Build the argv that runs `shell shellArgs...` confined to `workspaceRoot`.
 *
 * Returns undefined when bubblewrap is unavailable, so the caller runs the
 * command unconfined rather than failing. That is the honest outcome for a
 * host without user namespaces: refusing every command would make the product
 * unusable there, and pretending to confine would be worse than either.
 */
/**
 * The mount and namespace arguments every sandboxed process shares.
 *
 * Factored out so `bash` and `eval` are confined by the *same* definition. They
 * were not before: bash ran through bubblewrap and eval ran in a `Worker` thread
 * inside the Reaper process, sharing Reaper's own filesystem and network. A
 * script could `fs.readFileSync('/etc/passwd')` or read another thread's
 * workspace, and the code's own header admitted Code Mode "is no longer a
 * security boundary". One definition is what keeps the two from drifting apart
 * again — a mount added for bash is a mount the script gets too.
 *
 * Everything here is shared: system directories read-only, the workspace
 * read-write, and the workspace-backed scratch dirs. The caller appends its own
 * `--chdir` and command.
 */
export function sandboxMountArgs(workspaceRoot: string, extraBinds: readonly SandboxBind[] = []): string[] {
  const root = path.resolve(workspaceRoot);
  const args: string[] = [];

  for (const systemPath of SYSTEM_PATHS) {
    if (existsSync(systemPath)) args.push("--ro-bind", systemPath, systemPath);
  }

  /*
   * Writable state is persisted under the workspace, not thrown away.
   *
   * The first version tmpfs'd `/tmp` and `$HOME`, which made every bash call a
   * fresh machine: a cache or scratch file written by one command was gone the
   * next, so the agent reinstalled toolchains over and over and its work did
   * not survive a turn boundary. Confinement is a *mount* boundary, not a
   * *lifetime* boundary — a path outside the workspace is still unmounted, but
   * a path inside it must persist. So the writable places are directories
   * inside the workspace's own `.reaper` scratch, bound read-write, and the
   * real home and real `/tmp` are simply not mounted (a path inside them is as
   * unreachable as any other outside path, but the workspace bind of the
   * scratch dir at `$HOME` still gives programs their caches and dotfiles).
   *
   * These are the *only* writable paths in the namespace. The root is remounted
   * read-only below, so any other write fails with `Read-only file system`
   * rather than landing invisibly on a throwaway filesystem.
   */
  const scratch = path.join(root, ".reaper");
  const scratchTmp = path.join(scratch, "sandbox", "tmp");
  const scratchVarTmp = path.join(scratch, "sandbox", "var-tmp");
  const scratchHome = path.join(scratch, "sandbox", "home");
  mkdirSync(scratchTmp, { recursive: true });
  mkdirSync(scratchVarTmp, { recursive: true });
  mkdirSync(scratchHome, { recursive: true });
  /*
   * The scratch home starts empty, so `git commit` inside the sandbox fails
   * with "Author identity unknown" — the real `~/.gitconfig` is not mounted,
   * which is the point. Seed a minimal identity once (never overwriting one
   * the agent has since written) so commits succeed, matching the fallback
   * identity the engine's own git calls use in src/workspace/git.ts.
   */
  const scratchGitConfig = path.join(scratchHome, ".gitconfig");
  if (!existsSync(scratchGitConfig)) {
    const name = process.env.GIT_AUTHOR_NAME ?? "Reaper Tests";
    const email = process.env.GIT_AUTHOR_EMAIL ?? "reaper-tests@example.com";
    writeFileSync(scratchGitConfig, `[user]\n\tname = ${name}\n\temail = ${email}\n`);
  }
  const home = process.env.HOME;
  if (home && path.isAbsolute(home)) args.push("--bind", scratchHome, home);
  args.push("--bind", scratchTmp, "/tmp");
  args.push("--bind", scratchVarTmp, "/var/tmp");

  /*
   * Caller-supplied mounts go last, so a deliberately added bind cannot be
   * shadowed by one of the ones above. Destination paths are created by
   * bubblewrap itself when they do not exist, which is what lets a caller name
   * a mount point that is not a real directory on the host.
   */
  for (const bind of extraBinds) {
    args.push(bind.readOnly ? "--ro-bind" : "--bind", path.resolve(bind.source), bind.target);
  }

  return args;
}

/**
 * The `NODE_PATH` value implied by a set of extra binds.
 *
 * A read-only bind whose target looks like a `node_modules` mount is a package
 * root the caller wants resolvable, so it is exported. Computed from the binds
 * rather than passed separately so the two cannot disagree — a mount without
 * the variable is a silent `MODULE_NOT_FOUND`, which is exactly how this
 * feature failed the first time it was tried.
 */
export function nodePathForBinds(extraBinds: readonly SandboxBind[]): string[] {
  return extraBinds
    .filter((bind) => bind.readOnly === true && /(^|\/)node_modules$/.test(bind.target))
    .map((bind) => bind.target);
}

/**
 * The namespace tail shared by both builders: proc/dev, the workspace bind, a
 * read-only root, and the unshare flags. The caller supplies `--chdir` and the
 * command.
 *
 * The read-only root is about honesty rather than containment. Without it,
 * `mkdir -p /outside/thing` succeeds: the path does not exist, so it is created
 * on the throwaway tmpfs backing the namespace's root, and the command exits 0
 * — the write is correctly contained, and the agent is told it worked. It then
 * builds on a file that exists nowhere, and the failure surfaces much later as
 * something unrelated. Read-only turns that into `Read-only file system` at the
 * point of the write, which is a result the model can act on. The writable
 * places are the ones mounted before this: the workspace, /tmp, /var/tmp, $HOME.
 *
 * ## `--unshare-net`, which was missing and mattered
 *
 * Without it the sandbox shares the host's network namespace, so loopback is
 * reachable and a sandboxed script can talk to every service the host runs.
 * Measured from inside an `eval` script before this flag was added: it fetched
 * `127.0.0.1:9222/json/version`, enumerated every thread's page targets, opened
 * a raw CDP WebSocket to another thread's page, and navigated it from
 * example.com to example.org. `scoped-page.ts` closes the widening chain for a
 * program holding a `page`; a raw socket bypasses it entirely, and `bash`,
 * `browser_use` and skill validation had the same reach because they share this
 * tail.
 *
 * The unix-socket IPC that `eval` uses is unaffected: it is a filesystem object
 * bound in by `--bind`, not a TCP port, and a network namespace does not touch
 * it. Verified both ways with the flag on — the unix socket answers, and
 * `curl 127.0.0.1:9222` returns nothing.
 *
 * This does mean a sandboxed command has no network at all, including no DNS.
 * That is the intended trade and it is what `bash`'s own description promises:
 * a sandboxed process reaches its workspace and nothing else.
 */
function sandboxNamespaceTail(root: string, workingDirectory: string): string[] {
  return [
    "--proc", "/proc",
    "--dev", "/dev",
    "--bind", root, root,
    "--remount-ro", "/",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-net",
    "--die-with-parent",
    "--new-session",
    "--chdir", insideWorkspace(root, workingDirectory) ? path.resolve(workingDirectory) : root,
  ];
}

export function buildSandboxedShellCommand(input: {
  workspaceRoot: string;
  workingDirectory: string;
  shell: string;
  shellArgs: string[];
}): ShellSandboxCommand | undefined {
  const bwrap = resolveBubblewrap();
  if (!bwrap) return undefined;
  const root = path.resolve(input.workspaceRoot);
  const args = [
    ...sandboxMountArgs(root),
    ...sandboxNamespaceTail(root, input.workingDirectory),
    "--",
    input.shell,
    ...input.shellArgs,
  ];
  return { command: bwrap, args };
}

/**
 * Build the argv that runs `node <script>` confined to `workspaceRoot`.
 *
 * Same mounts as a shell command, because a script must be confined exactly the
 * way a command is — that is the whole point. The script's protocol channel
 * (fd 3) and its stdout/stderr are inherited into the namespace; bubblewrap
 * passes an already-open descriptor through untouched, so the parent keeps its
 * pipe while the child sees only the sandboxed filesystem.
 *
 * `extraEnv` is applied by the caller via the child's `env`, not here, so this
 * stays a pure argv builder.
 */
export function buildSandboxedNodeCommand(input: {
  workspaceRoot: string;
  workingDirectory: string;
  nodePath: string;
  scriptPath: string;
  scriptArgs?: string[];
  extraBinds?: readonly SandboxBind[];
}): ShellSandboxCommand | undefined {
  const bwrap = resolveBubblewrap();
  if (!bwrap) return undefined;
  const root = path.resolve(input.workspaceRoot);
  const binds = input.extraBinds ?? [];
  const nodePathEntries = nodePathForBinds(binds);
  const args = [
    ...sandboxMountArgs(root, binds),
    /*
     * `--setenv` for the dependency path, not the child environment.
     *
     * `buildChildEnv` strips `NODE_PATH` on purpose and that stripped env is
     * what `spawn` gets, so setting it on the child would be a no-op that looks
     * like a working configuration until a script tries to import and gets
     * `MODULE_NOT_FOUND`. As a namespace argument it reaches the process
     * regardless. `--setenv` is placed before `--remount-ro` is irrelevant to
     * ordering, but it must precede the `--` terminator, which it does.
     */
    ...(nodePathEntries.length > 0
      ? ["--setenv", SANDBOX_NODE_PATH_ENV, nodePathEntries.join(":")]
      : []),
    ...sandboxNamespaceTail(root, input.workingDirectory),
    "--",
    input.nodePath,
    input.scriptPath,
    ...(input.scriptArgs ?? []),
  ];
  return { command: bwrap, args };
}

function insideWorkspace(root: string, target: string): boolean {
  const resolved = path.resolve(target);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}
