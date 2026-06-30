/**
 * SlashCommandRegistry — host-agnostic slash-command dispatcher.
 *
 * The TUI does not exist yet (out of scope for this work), but the
 * slash commands themselves are still useful: the CLI surfaces them
 * via `reaper /<name>` (or `reaper <group>`), and a future TUI calls
 * `registry.handle(line)` against the same registry.
 *
 * Design:
 *   - SlashHost is an interface — `ConsoleHost` for the CLI prints
 *     to stdout/stdin. A future `TUIHost` would render in the
 *     conversation pane. The registry only knows about the four
 *     methods `print`, `printError`, `confirm`, `promptSecret`.
 *   - Commands are flat: `/skills list`, `/extensions doctor <id>`.
 *     First token is the command name (without the leading slash);
 *     remaining tokens are arguments.
 *   - Registration is order-preserving so `help`-style listings are
 *     stable.
 */

import type {
  ExtensionSlashCommandRegistration,
  SlashCommandArgSpec,
  SlashCommandHandler,
  SlashCommandResult,
} from "./contribution-types.js";

// Re-export for callers that don't want to reach into contribution-types.
export type { SlashCommandResult, SlashCommandHandler, SlashCommandArgSpec };

export interface SlashCommand {
  /** Slash name, e.g. "skills" or "extensions". Case-insensitive. */
  name: string;
  /** Short description shown in `help`. */
  description?: string | undefined;
  /** Argument spec. The registry does not enforce types, only count. */
  args?: SlashCommandArgSpec[] | undefined;
  /** Hidden commands do not show in `help`. */
  hidden?: boolean | undefined;
  /** Source: "builtin" or "extension:<id>". */
  source: "builtin" | string;
  /** Handler. */
  run: SlashCommandHandler;
}

export interface SlashHost {
  print(msg: string): void;
  printError(msg: string): void;
  confirm(msg: string): Promise<boolean> | boolean;
  promptSecret(msg: string): Promise<string | null> | string | null;
}

export interface SlashHandleContext {
  host: SlashHost;
  /** Original line, including the slash. */
  line: string;
  /** Parsed name (without slash). */
  name: string;
  /** Args passed to the command. */
  args: string[];
}

/** A simple console host backed by stdout/stderr/stdin. */
export class ConsoleHost implements SlashHost {
  private readonly out: NodeJS.WritableStream;
  private readonly err: NodeJS.WritableStream;
  private readonly in: { question(prompt: string, cb: (answer: string) => void): void; close?(): void } | null;
  /** Test-only override for confirm. */
  confirmDefault?: boolean;

  constructor(opts: { out?: NodeJS.WritableStream; err?: NodeJS.WritableStream; stdin?: NodeJS.ReadableStream } = {}) {
    this.out = (opts.out ?? process.stdout) as NodeJS.WritableStream;
    this.err = (opts.err ?? process.stderr) as NodeJS.WritableStream;
    this.in = (opts.stdin ?? null) as { question(prompt: string, cb: (answer: string) => void): void; close?(): void } | null;
  }

  print(msg: string): void {
    this.out.write(`${msg}\n`);
  }

  printError(msg: string): void {
    this.err.write(`${msg}\n`);
  }

  confirm(msg: string): boolean {
    if (this.confirmDefault !== undefined) return this.confirmDefault;
    if (!this.in) return false;
    const inq = this.in as { question?: (prompt: string, cb: (answer: string) => void) => void };
    if (typeof inq.question !== "function") return false;
    let answer = "";
    try {
      inq.question(`${msg} [y/N] `, (a: string) => { answer = a.trim(); });
    } catch {
      return false;
    }
    return /^(y|yes)$/i.test(answer);
  }

  promptSecret(_msg: string): string | null {
    // Secret prompts require a TTY that does not echo. Out of scope
    // for the console host; callers must implement a TUIHost.
    return null;
  }
}

export class SlashCommandRegistry {
  private readonly commands = new Map<string, SlashCommand>();

  register(cmd: SlashCommand): () => void {
    const key = cmd.name.toLowerCase();
    if (this.commands.has(key)) {
      throw new Error(`slash command "/${cmd.name}" already registered`);
    }
    this.commands.set(key, cmd);
    return () => this.unregister(cmd.name);
  }

  /** Register from an extension's `ExtensionSlashCommandRegistration`. */
  registerFromExtension(extensionId: string, reg: ExtensionSlashCommandRegistration): () => void {
    return this.register({
      name: reg.name,
      description: reg.description,
      args: reg.args,
      hidden: reg.hidden,
      source: `extension:${extensionId}`,
      run: reg.handler,
    });
  }

  unregister(name: string): boolean {
    return this.commands.delete(name.toLowerCase());
  }

  /** Drop every command registered by a given source (e.g. an extension). */
  unregisterBySource(source: string): number {
    let removed = 0;
    for (const [key, cmd] of this.commands) {
      if (cmd.source === source) {
        this.commands.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get(name: string): SlashCommand | null {
    return this.commands.get(name.toLowerCase()) ?? null;
  }

  list(opts: { includeHidden?: boolean } = {}): SlashCommand[] {
    const out: SlashCommand[] = [];
    for (const cmd of this.commands.values()) {
      if (!opts.includeHidden && cmd.hidden) continue;
      out.push(cmd);
    }
    return out;
  }

  /** Complete a partial command name (e.g. "/sk" → ["skills"]). */
  complete(partial: string): string[] {
    const needle = partial.replace(/^\//, "").toLowerCase();
    const out: string[] = [];
    for (const cmd of this.commands.keys()) {
      if (cmd.startsWith(needle)) out.push(cmd);
    }
    return out;
  }

  /**
   * Handle a slash-command line. Lines starting with `/` are treated
   * as commands; lines without `/` return `{ok:false, error}` so
   * callers can fall through to the model.
   */
  async handle(line: string, ctx: Partial<SlashHandleContext> = {}): Promise<SlashCommandResult> {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) {
      return { ok: false, output: "", error: `not a slash command: ${line}` };
    }
    const tokens = trimmed.slice(1).split(/\s+/);
    const name = tokens.shift() ?? "";
    const args = tokens;
    const cmd = this.commands.get(name.toLowerCase());
    if (!cmd) {
      return { ok: false, output: "", error: `unknown command "/${name}". try /help` };
    }
    const host: SlashHost = ctx.host ?? new ConsoleHost();
    const cmdCtx = {
      commandName: cmd.name,
      host: { print: host.print.bind(host), printError: host.printError.bind(host) },
    };
    try {
      return await cmd.run(args, cmdCtx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, output: "", error: `command "/${name}" failed: ${msg}` };
    }
  }

  /** Render a help listing. */
  help(host: SlashHost, opts: { includeHidden?: boolean } = {}): void {
    const cmds = this.list(opts);
    if (cmds.length === 0) {
      host.print("(no commands registered)");
      return;
    }
    const max = Math.max(...cmds.map((c) => c.name.length));
    for (const c of cmds) {
      host.print(`  /${c.name.padEnd(max)}  ${c.description ?? ""}`);
    }
  }

  /**
   * Register the built-in `/reload` command. Hits all three reload
   * surfaces in one call:
   *   - reload_skills (in-memory registry rebuild)
   *   - reload_extensions (ExtensionRegistry.discover)
   *   - reload_hooks (HookLifecycle.reload)
   *
   * The CLI binary calls this at startup with the live handlers.
   * Returns the unregister function (rarely useful; provided for
   * symmetry with `register`).
   */
  registerReloadCommand(opts: {
    reloadSkills: () => { ok: boolean; loaded: number };
    reloadExtensions: () => { ok: boolean; loaded: number };
    reloadHooks: () => { ok: boolean; loaded: number; registered: number };
  }): () => void {
    return this.register({
      name: "reload",
      description: "Re-walk disk and rebuild skills, extensions, and hooks registries in one call.",
      source: "builtin",
      run: async (_args, ctx) => {
        try {
          const skills = opts.reloadSkills();
          const exts = opts.reloadExtensions();
          const hooks = opts.reloadHooks();
          const out =
            `Reloaded: skills=${skills.loaded} extensions=${exts.loaded} hooks=${hooks.loaded} (registered=${hooks.registered})`;
          ctx.host.print(out);
          return { ok: true, output: out };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          ctx.host.printError(`reload failed: ${msg}`);
          return { ok: false, output: "", error: msg };
        }
      },
    });
  }
}
