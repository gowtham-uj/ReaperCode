/**
 * Built-in slash commands for the `/skills` group.
 *
 * Subcommands:
 *   /skills list             — list registered skills with trust column
 *   /skills show <name>      — show one skill summary (no body)
 *   /skills search <query>  — search via SkillRouter; returns top-N summaries
 *   /skills add <path>      — install from a folder (delegates to SkillLifecycle)
 *   /skills enable <name>    — clear disableModelInvocation
 *   /skills disable <name>   — set disableModelInvocation
 *   /skills trust <name>     — promote to user-trusted
 *   /skills untrust <name>   — demote to project-untrusted
 *   /skills test <name>      — run validation.commands, update lastValidatedAt
 *   /skills doctor <name?>   — validate manifest + trust + allowedTools
 *   /skills create <name>    — open a draft at ~/.reaper/skills/drafts/<name>
 *   /skills pin <name>       — mark always-on; its body rides in every turn
 *   /skills unpin <name>     — stop doing that
 *
 * `pin`/`unpin` write `runtimeTunables.pinnedSkills` in the user's global
 * settings, through the exact writer the browser's Settings screen uses. They
 * are here as well as there because the two surfaces are used at different
 * moments: pinning is a decision you make while looking at the list of skills
 * you have, and this is the surface that lists them.
 *
 * The slash registry is host-agnostic. The handlers here take their
 * dependencies via `args` + the host's command context. We deliberately
 * do not import SkillRegistry directly: tests instantiate the registry
 * once and pass it via `ctx.deps.skills`.
 */

import { homedir } from "node:os";

import { updateUserSettings } from "../config/settings-file.js";
import {
  MAX_DISABLED_SKILLS,
  MAX_PINNED_SKILLS,
  normalizePinnedNames,
  readDisabledSkills,
  readPinnedSkills,
} from "../context/pinned-skills.js";
import { isPlainObject } from "../config/settings-file.js";
import type { SlashCommand, SlashCommandResult } from "../extensions/slash-command-registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { SkillLifecycle } from "../skills/lifecycle.js";

export interface SkillsCommandsDeps {
  registry: SkillRegistry;
  lifecycle: SkillLifecycle;
  /**
   * Where the user's settings live.
   *
   * Injected rather than read from `homedir()` at the call site so a test can
   * exercise `/skills pin` without touching the developer's real config — the
   * pin write goes to the same file the browser writes, so a test that is not
   * isolated would be editing the machine it runs on.
   */
  home?: string;
}

function ok(output: string, data?: unknown): SlashCommandResult {
  return data === undefined ? { ok: true, output } : { ok: true, output, data };
}
function err(output: string, error: string): SlashCommandResult {
  return { ok: false, output, error };
}

const SUBCOMMANDS = [
  "list", "show", "search", "add", "enable", "disable", "trust", "untrust",
  "test", "doctor", "create", "pin", "unpin",
] as const;

export function buildSkillsCommands(deps: SkillsCommandsDeps): SlashCommand[] {
  const { registry, lifecycle } = deps;
  const home = deps.home ?? homedir();
  return [
    {
      name: "skills",
      description: "Manage skills. Subcommands: list, show, search, add, enable, disable, trust, untrust, test, doctor, create, pin, unpin.",
      source: "builtin",
      run: async (args, ctx) => {
        const sub = args[0] ?? "list";
        const rest = args.slice(1);
        ctx.host.print(`# /skills ${sub}`);
        switch (sub) {
          case "list":
            return skillsList(registry, home, ctx);
          case "show":
            return skillsShow(registry, rest, home, ctx);
          case "search":
            return skillsSearch(registry, rest, ctx);
          case "add":
            return skillsAdd(lifecycle, rest, ctx);
          case "enable":
            return skillsEnable(registry, rest, home, ctx);
          case "disable":
            return skillsDisable(registry, rest, home, ctx);
          case "trust":
            return skillsTrust(lifecycle, rest, ctx);
          case "untrust":
            return skillsUntrust(lifecycle, rest, ctx);
          case "test":
            return await skillsTest(lifecycle, rest, ctx);
          case "doctor":
            return skillsDoctor(registry, rest, ctx);
          case "create":
            return skillsCreate(lifecycle, rest, ctx);
          case "pin":
            return skillsPin(registry, rest, home, ctx);
          case "unpin":
            return skillsUnpin(rest, home, ctx);
          default:
            return err(`unknown subcommand "${sub}"`, `try /skills ${SUBCOMMANDS.join("|")}`);
        }
      },
    },
  ];
}

function skillsList(
  registry: SkillRegistry,
  home: string,
  ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } },
): SlashCommandResult {
  const skills = registry.list();
  const pinned = readPinnedSkills(home);
  const alwaysOn = new Set(pinned);
  if (skills.length === 0) {
    ctx.host.print("(no skills installed)");
    return ok("(no skills installed)");
  }
  /*
   * Off comes from the settings list as well as the record, because a skill
   * switched off in this process's settings is not necessarily reflected in the
   * record the registry was handed at startup — the slash command and
   * `reaper skill disable` are separate entrypoints, and this list has to be
   * true after either of them.
   */
  const off = readDisabledSkills(home);
  const switchedOff = new Set(off);
  for (const s of skills) {
    const name = s.manifest.name;
    const isOff = switchedOff.has(name) || s.disabled === true;
    /*
     * The marks are one character rather than a word, because this list is
     * scanned rather than read and a `●` at the end of a name is visible
     * peripherally in a way that a trailing "always-on" is not. `○` for off is
     * deliberately the same shape — the two states are opposites of each other
     * and of nothing else, so they should read as a pair.
     */
    const mark = isOff ? " ○" : alwaysOn.has(name) ? " ●" : "";
    const label = isOff ? "off" : s.trust;
    ctx.host.print(`- ${name.padEnd(28)} ${label.padEnd(18)} ${s.manifest.category ?? "—"}${mark} ${s.manifest.description ?? ""}`);
  }
  if (pinned.length > 0) {
    ctx.host.print("");
    ctx.host.print(`● always on (${pinned.length}): ${pinned.join(", ")}`);
  }
  if (off.length > 0) {
    ctx.host.print(`○ off (${off.length}): ${off.join(", ")}`);
  }
  return ok(`${skills.length} skill(s)`, { skills, pinned, disabled: off });
}

/**
 * Pin a skill so its body rides in every turn.
 *
 * Validated against the registry rather than written blind: pinning a name that
 * matches nothing would silently do nothing forever, and the whole point of the
 * command is that the user gets what they asked for or hears why they did not.
 */
function skillsPin(
  registry: SkillRegistry,
  rest: string[],
  home: string,
  ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } },
): SlashCommandResult {
  const name = rest[0];
  if (!name) return err("missing skill name", "usage: /skills pin <name>");
  const skill = registry.get(name) ?? registry.list({ includeUntrusted: true }).find((s) => s.manifest.name === name);
  if (!skill) return err(`skill "${name}" not found`, "not found");

  const current = readPinnedSkills(home);
  if (current.includes(name)) {
    ctx.host.print(`"${name}" is already always on`);
    return ok(name);
  }
  if (current.length >= MAX_PINNED_SKILLS) {
    return err(`cannot pin more than ${MAX_PINNED_SKILLS} skills`, "too many pins");
  }

  try {
    const next = writePins(home, [...current, name]);
    ctx.host.print(`pinned "${name}" — its body now rides in every turn (${next.length} always on)`);
    return ok(name, next);
  } catch (cause) {
    return err(cause instanceof Error ? cause.message : "pin failed", "write failed");
  }
}

function skillsUnpin(
  rest: string[],
  home: string,
  ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } },
): SlashCommandResult {
  const name = rest[0];
  if (!name) return err("missing skill name", "usage: /skills unpin <name>");
  const current = readPinnedSkills(home);
  if (!current.includes(name)) {
    ctx.host.print(`"${name}" is not always on`);
    return ok(name);
  }
  try {
    const next = writePins(home, current.filter((entry) => entry !== name));
    ctx.host.print(`unpinned "${name}" (${next.length} always on)`);
    return ok(name, next);
  } catch (cause) {
    return err(cause instanceof Error ? cause.message : "unpin failed", "write failed");
  }
}

/**
 * Commit a pin set through the same writer the browser uses.
 *
 * Deliberately not a second `settings.json` writer. The file is one document
 * with one set of rules — partial schema, unknown keys preserved, atomic
 * replace — and two implementations of that would eventually disagree in the
 * worst possible place.
 */
/**
 * Write the switched-off set, through the same writer the CLI uses.
 *
 * Called from `/skills disable` and `/skills enable` in both hosts — the
 * terminal and the browser's slash palette — so the two cannot produce
 * different files from the same command.
 */
function writeDisabledSkills(home: string, names: readonly string[]): string[] {
  const cleaned = normalizePinnedNames(names).slice(0, MAX_DISABLED_SKILLS);
  updateUserSettings(home, (before) => ({
    ...before,
    runtimeTunables: {
      ...(isPlainObject(before.runtimeTunables) ? before.runtimeTunables : {}),
      disabledSkills: cleaned,
    },
  }));
  return cleaned;
}

function writePins(home: string, pins: string[]): string[] {
  const cleaned = normalizePinnedNames(pins).slice(0, MAX_PINNED_SKILLS);
  updateUserSettings(home, (before) => ({
    ...before,
    runtimeTunables: {
      ...(isPlainObject(before.runtimeTunables) ? before.runtimeTunables : {}),
      pinnedSkills: cleaned,
    },
  }));
  return cleaned;
}

function skillsShow(
  registry: SkillRegistry,
  rest: string[],
  home: string,
  ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } },
): SlashCommandResult {
  const name = rest[0];
  if (!name) return err("missing skill name", "usage: /skills show <name>");
  const s = registry.get(name);
  if (!s) return err(`skill "${name}" not found`, "not found");
  const pinned = readPinnedSkills(home).includes(s.manifest.name);
  ctx.host.print(`${s.manifest.name} (${s.trust})`);
  ctx.host.print(`  category: ${s.manifest.category ?? "—"}`);
  ctx.host.print(`  description: ${s.manifest.description ?? ""}`);
  ctx.host.print(`  allowedTools: ${(s.manifest.allowedTools ?? []).join(", ") || "(none)"}`);
  ctx.host.print(`  always on: ${pinned ? "yes — body is in every turn" : "no"}`);
  // Body is intentionally NOT shown — summaries only.
  return ok(s.manifest.name, s);
}

function skillsSearch(registry: SkillRegistry, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const query = rest.join(" ");
  if (!query) return err("missing query", "usage: /skills search <query>");
  const top = registry.selectTopN({ query, n: 5 });
  if (top.length === 0) {
    ctx.host.print("(no skills matched)");
    return ok("(no skills matched)");
  }
  for (const s of top) {
    ctx.host.print(`- ${s.name}  score=${s.score.toFixed(1)}  ${s.description ?? ""}`);
  }
  return ok(`${top.length} match(es)`, top);
}

function skillsAdd(lifecycle: SkillLifecycle, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const path = rest[0];
  if (!path) return err("missing path", "usage: /skills add <path> [--scope project|user] [--trust]");
  const scope = rest.includes("--scope") ? (rest[rest.indexOf("--scope") + 1] === "project" ? "project" : "user") : "user";
  const trust = rest.includes("--trust");
  const result = lifecycle.installFromPath({ srcPath: path, scope, trust });
  if (!result.ok) return err(result.error ?? "install failed", result.error ?? "");
  ctx.host.print(`installed "${result.name ?? path}" as ${scope}${trust ? " (trusted)" : ""}`);
  return ok(result.name ?? path);
}

function skillsEnable(
  registry: SkillRegistry,
  rest: string[],
  home: string,
  ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } },
): SlashCommandResult {
  const name = rest[0];
  if (!name) return err("missing skill name", "usage: /skills enable <name>");
  if (!registry.get(name)) return err(`cannot enable "${name}"`, "not found");
  try {
    writeDisabledSkills(home, readDisabledSkills(home).filter((entry) => entry !== name));
    registry.enable(name);
    ctx.host.print(`enabled "${name}"`);
    return ok(name);
  } catch (cause) {
    return err(cause instanceof Error ? cause.message : "write failed", "write failed");
  }
}

/**
 * `/skills disable` — the settings list, not a file in the skill's folder.
 *
 * This called `registry.disable`, which writes a `disabled` marker next to the
 * skill's manifest. For a built-in that is the shipped source tree in a
 * checkout, or a temp directory the bundle regenerates at startup — so the
 * marker either edited the installation or was gone by the next run, and the
 * command reported success either way. It also disagreed with the CLI's
 * `skill disable`, which reads the user's settings: two "disable" commands
 * that produced two different states.
 *
 * Both write `runtimeTunables.disabledSkills` now. The registry record is
 * still updated, so the process that ran the command shows the change
 * immediately rather than at the next discovery.
 */
function skillsDisable(
  registry: SkillRegistry,
  rest: string[],
  home: string,
  ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } },
): SlashCommandResult {
  const name = rest[0];
  if (!name) return err("missing skill name", "usage: /skills disable <name>");
  if (!registry.get(name)) return err(`cannot disable "${name}"`, "not found");
  try {
    writeDisabledSkills(home, [...readDisabledSkills(home), name]);
    registry.disable(name);
    ctx.host.print(`disabled "${name}"`);
    return ok(name);
  } catch (cause) {
    return err(cause instanceof Error ? cause.message : "write failed", "write failed");
  }
}

function skillsTrust(lifecycle: SkillLifecycle, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const name = rest[0];
  if (!name) return err("missing skill name", "usage: /skills trust <name>");
  const note = rest.slice(1).join(" ") || "trusted via slash command";
  const result = lifecycle.trust(name, note);
  if (!result.ok) return err(result.error ?? "trust failed", result.error ?? "");
  ctx.host.print(`trusted "${name}"`);
  return ok(name);
}

function skillsUntrust(lifecycle: SkillLifecycle, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const name = rest[0];
  if (!name) return err("missing skill name", "usage: /skills untrust <name>");
  const note = rest.slice(1).join(" ") || "untrusted via slash command";
  const result = lifecycle.untrust(name, note);
  if (!result.ok) return err(result.error ?? "untrust failed", result.error ?? "");
  ctx.host.print(`untrusted "${name}"`);
  return ok(name);
}

function skillsTest(lifecycle: SkillLifecycle, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): Promise<SlashCommandResult> {
  const name = rest[0];
  if (!name) return Promise.resolve(err("missing skill name", "usage: /skills test <name>"));
  return lifecycle.testSkill(name).then((result) => {
    if (!result.ok) return err(result.error ?? "test failed", result.error ?? "");
    ctx.host.print(`test "${name}" passed (${result.results.length} command(s))`);
    return ok(name);
  });
}

function skillsDoctor(registry: SkillRegistry, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const name = rest[0];
  const reports = registry.doctor(name);
  if (reports.length === 0) return err("no skills found", "not found");
  for (const r of reports) {
    const tag = r.ok ? "OK" : "FAIL";
    ctx.host.print(`[${tag}] ${r.name}: ${r.errors.join("; ") || "no errors"}`);
  }
  const any = reports.some((r) => !r.ok);
  return any ? err("one or more skills failed doctor", "see above") : ok("all skills healthy", reports);
}

function skillsCreate(lifecycle: SkillLifecycle, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const name = rest[0];
  if (!name) return err("missing skill name", "usage: /skills create <name>");
  const manifest: import("../skills/types.js").SkillManifest = {
    name,
    version: "0.1.0",
    description: "draft skill (edit skill.json and SKILL.md)",
    category: "prompt-enhancement",
    whenToUse: "draft",
    allowedTools: [],
    trust: "draft",
  };
  const result = lifecycle.createDraft(manifest, `# ${name}\n\nDescribe this skill in 3-7 imperative steps.\n\n## When NOT to use\n\n- TBD\n`);
  if (!result.ok) return err(result.error ?? "draft failed", result.error ?? "");
  ctx.host.print(`draft created at ${result.skillDir}`);
  return ok(result.skillDir);
}
