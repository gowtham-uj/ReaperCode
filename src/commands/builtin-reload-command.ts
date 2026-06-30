/**
 * Built-in `/reload` slash command. The user invoked feature
 * ("after I add new extensions and skills and hooks I could just
 * hit /reload") — this is the single command that hits all three
 * reload surfaces in one call:
 *
 *   - SkillRegistry       — `list({ includeUntrusted: true })` to count
 *   - ExtensionRegistry   — `discover()` to re-walk the disk
 *   - HookLifecycle       — `reload()` to re-walk + re-register
 *
 * Each reload is a no-op for the in-memory state if nothing changed
 * on disk. The command prints a small summary and returns ok.
 *
 * The host wires this command at CLI startup by passing the three
 * reload callbacks to `SlashCommandRegistry.registerReloadCommand`.
 */

import type { SlashCommand, SlashCommandResult } from "../extensions/slash-command-registry.js";

export interface ReloadCommandDeps {
  reloadSkills: () => { ok: boolean; loaded: number };
  reloadExtensions: () => { ok: boolean; loaded: number };
  reloadHooks: () => { ok: boolean; loaded: number; registered: number };
}

function ok(output: string, data?: unknown): SlashCommandResult {
  return data === undefined ? { ok: true, output } : { ok: true, output, data };
}
function err(output: string, error: string): SlashCommandResult {
  return { ok: false, output, error };
}

export function buildReloadCommand(deps: ReloadCommandDeps): SlashCommand {
  return {
    name: "reload",
    description: "Re-walk disk for skills, extensions, and hooks. Picks up hand-edited or copied-in artifacts.",
    source: "builtin",
    run: async (args, ctx) => {
      ctx.host.print("# /reload");
      if (args.length > 0) ctx.host.print(`(ignored args: ${args.join(" ")})`);
      const skills = deps.reloadSkills();
      const exts = deps.reloadExtensions();
      const hooks = deps.reloadHooks();
      const lines = [
        `skills: ${skills.loaded} loaded`,
        `extensions: ${exts.loaded} loaded`,
        `hooks: ${hooks.loaded} loaded (${hooks.registered} registered)`,
      ];
      for (const l of lines) ctx.host.print(l);
      const okFlag = skills.ok && exts.ok && hooks.ok;
      if (!okFlag) return err(lines.join("\n"), "one or more reload surfaces reported ok=false");
      return ok(lines.join("\n"), { skills, extensions: exts, hooks });
    },
  };
}
