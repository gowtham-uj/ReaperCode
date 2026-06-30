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
 *
 * The slash registry is host-agnostic. The handlers here take their
 * dependencies via `args` + the host's command context. We deliberately
 * do not import SkillRegistry directly: tests instantiate the registry
 * once and pass it via `ctx.deps.skills`.
 */

import type { SlashCommand, SlashCommandResult } from "../extensions/slash-command-registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { SkillLifecycle } from "../skills/lifecycle.js";

export interface SkillsCommandsDeps {
  registry: SkillRegistry;
  lifecycle: SkillLifecycle;
}

function ok(output: string, data?: unknown): SlashCommandResult {
  return data === undefined ? { ok: true, output } : { ok: true, output, data };
}
function err(output: string, error: string): SlashCommandResult {
  return { ok: false, output, error };
}

export function buildSkillsCommands(deps: SkillsCommandsDeps): SlashCommand[] {
  const { registry, lifecycle } = deps;
  return [
    {
      name: "skills",
      description: "Manage skills. Subcommands: list, show, search, add, enable, disable, trust, untrust, test, doctor, create.",
      source: "builtin",
      run: async (args, ctx) => {
        const sub = args[0] ?? "list";
        const rest = args.slice(1);
        ctx.host.print(`# /skills ${sub}`);
        switch (sub) {
          case "list":
            return skillsList(registry, ctx);
          case "show":
            return skillsShow(registry, rest, ctx);
          case "search":
            return skillsSearch(registry, rest, ctx);
          case "add":
            return skillsAdd(lifecycle, rest, ctx);
          case "enable":
            return skillsEnable(registry, rest, ctx);
          case "disable":
            return skillsDisable(registry, rest, ctx);
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
          default:
            return err(`unknown subcommand "${sub}"`, `try /skills list|show|search|add|enable|disable|trust|untrust|test|doctor|create`);
        }
      },
    },
  ];
}

function skillsList(registry: SkillRegistry, ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const skills = registry.list();
  if (skills.length === 0) {
    ctx.host.print("(no skills installed)");
    return ok("(no skills installed)");
  }
  for (const s of skills) {
    ctx.host.print(`- ${s.manifest.name.padEnd(28)} ${s.trust.padEnd(18)} ${s.manifest.category ?? "—"} ${s.manifest.description ?? ""}`);
  }
  return ok(`${skills.length} skill(s)`, skills);
}

function skillsShow(registry: SkillRegistry, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const name = rest[0];
  if (!name) return err("missing skill name", "usage: /skills show <name>");
  const s = registry.get(name);
  if (!s) return err(`skill "${name}" not found`, "not found");
  ctx.host.print(`${s.manifest.name} (${s.trust})`);
  ctx.host.print(`  category: ${s.manifest.category ?? "—"}`);
  ctx.host.print(`  description: ${s.manifest.description ?? ""}`);
  ctx.host.print(`  allowedTools: ${(s.manifest.allowedTools ?? []).join(", ") || "(none)"}`);
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

function skillsEnable(registry: SkillRegistry, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const name = rest[0];
  if (!name) return err("missing skill name", "usage: /skills enable <name>");
  const okFlag = registry.enable(name);
  if (!okFlag) return err(`cannot enable "${name}"`, "not found");
  ctx.host.print(`enabled "${name}"`);
  return ok(name);
}

function skillsDisable(registry: SkillRegistry, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const name = rest[0];
  if (!name) return err("missing skill name", "usage: /skills disable <name>");
  const okFlag = registry.disable(name);
  if (!okFlag) return err(`cannot disable "${name}"`, "not found");
  ctx.host.print(`disabled "${name}"`);
  return ok(name);
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
