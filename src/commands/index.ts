/**
 * Barrel for the commands module. The CLI imports `registerBuiltinCommands`
 * to wire the built-in slash commands into a SlashCommandRegistry; the
 * slash commands themselves import registry + lifecycle classes from
 * `../skills/`, `../extensions/`, and `../hooks/`.
 */

import type { SlashCommandRegistry } from "../extensions/slash-command-registry.js";
import { buildSkillsCommands, type SkillsCommandsDeps } from "./builtin-skills-commands.js";
import { buildExtensionCommands, type ExtensionsCommandsDeps } from "./builtin-extension-commands.js";
import { buildHooksCommands, type HooksCommandsDeps } from "./builtin-hook-commands.js";
import { buildReloadCommand, type ReloadCommandDeps } from "./builtin-reload-command.js";

export interface BuiltinCommandsDeps {
  skills: SkillsCommandsDeps;
  extensions: ExtensionsCommandsDeps;
  hooks: HooksCommandsDeps;
  reload: ReloadCommandDeps;
}

/**
 * Register the built-in `/skills`, `/extensions`, `/hooks`, and
 * `/reload` commands on `reg`. Returns the unsubscribe functions for
 * all groups so a caller can detach them (e.g. when tearing down a
 * TUI session).
 */
export function registerBuiltinCommands(reg: SlashCommandRegistry, deps: BuiltinCommandsDeps): Array<() => void> {
  const offs: Array<() => void> = [];
  for (const cmd of buildSkillsCommands(deps.skills)) offs.push(reg.register(cmd));
  for (const cmd of buildExtensionCommands(deps.extensions)) offs.push(reg.register(cmd));
  for (const cmd of buildHooksCommands(deps.hooks)) offs.push(reg.register(cmd));
  offs.push(reg.register(buildReloadCommand(deps.reload)));
  return offs;
}

export { buildSkillsCommands } from "./builtin-skills-commands.js";
export { buildExtensionCommands } from "./builtin-extension-commands.js";
export { buildHooksCommands } from "./builtin-hook-commands.js";
export { buildReloadCommand } from "./builtin-reload-command.js";
export type { SkillsCommandsDeps, ExtensionsCommandsDeps, HooksCommandsDeps, ReloadCommandDeps };
