/**
 * Built-in slash commands for the `/extensions` group.
 *
 * Subcommands:
 *   /extensions list          — list discovered/installed extensions
 *   /extensions show <id>     — show one extension
 *   /extensions add <path>    — install from a folder
 *   /extensions enable <id>   — flip status to enabled
 *   /extensions disable <id>  — flip status to disabled
 *   /extensions trust <id>    — promote to user-trusted
 *   /extensions untrust <id>  — demote to project-untrusted
 *   /extensions doctor <id?>  — run ExtensionRegistry.doctor
 *   /extensions remove <id>   — uninstall (deletes install dir)
 *
 * Host-agnostic; the host is the same `SlashHost` as `/skills`.
 */

import type { SlashCommand, SlashCommandResult } from "../extensions/slash-command-registry.js";
import type { ExtensionRegistry } from "../extensions/registry.js";

export interface ExtensionsCommandsDeps {
  registry: ExtensionRegistry;
}

function ok(output: string, data?: unknown): SlashCommandResult {
  return data === undefined ? { ok: true, output } : { ok: true, output, data };
}
function err(output: string, error: string): SlashCommandResult {
  return { ok: false, output, error };
}

export function buildExtensionCommands(deps: ExtensionsCommandsDeps): SlashCommand[] {
  const { registry } = deps;
  return [
    {
      name: "extensions",
      description: "Manage extensions. Subcommands: list, show, add, enable, disable, trust, untrust, doctor, remove.",
      source: "builtin",
      run: async (args, ctx) => {
        const sub = args[0] ?? "list";
        const rest = args.slice(1);
        ctx.host.print(`# /extensions ${sub}`);
        switch (sub) {
          case "list":
            return extensionsList(registry, ctx);
          case "show":
            return extensionsShow(registry, rest, ctx);
          case "add":
            return extensionsAdd(registry, rest, ctx);
          case "enable":
            return extensionsEnable(registry, rest, ctx);
          case "disable":
            return extensionsDisable(registry, rest, ctx);
          case "trust":
            return extensionsTrust(registry, rest, ctx);
          case "untrust":
            return extensionsUntrust(registry, rest, ctx);
          case "doctor":
            return extensionsDoctor(registry, rest, ctx);
          case "remove":
            return extensionsRemove(registry, rest, ctx);
          default:
            return err(`unknown subcommand "${sub}"`, `try /extensions list|show|add|enable|disable|trust|untrust|doctor|remove`);
        }
      },
    },
  ];
}

function extensionsList(registry: ExtensionRegistry, ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const exts = registry.list();
  if (exts.length === 0) {
    ctx.host.print("(no extensions installed)");
    return ok("(no extensions installed)");
  }
  for (const e of exts) {
    ctx.host.print(`- ${e.id.padEnd(28)} ${e.trust.padEnd(20)} ${e.status.padEnd(10)} ${e.manifest.description ?? ""}`);
  }
  return ok(`${exts.length} extension(s)`, exts);
}

function extensionsShow(registry: ExtensionRegistry, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const id = rest[0];
  if (!id) return err("missing extension id", "usage: /extensions show <id>");
  const e = registry.get(id);
  if (!e) return err(`extension "${id}" not found`, "not found");
  ctx.host.print(`${e.id} (${e.trust}, ${e.status})`);
  ctx.host.print(`  description: ${e.manifest.description ?? ""}`);
  ctx.host.print(`  main: ${e.manifest.main ?? ""}`);
  ctx.host.print(`  permissions: ${(e.manifest.permissions ?? []).join(", ") || "(none)"}`);
  ctx.host.print(`  installPath: ${e.installPath}`);
  if (e.error) ctx.host.print(`  error: ${e.error}`);
  return ok(e.id, e);
}

function extensionsAdd(registry: ExtensionRegistry, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const path = rest[0];
  if (!path) return err("missing path", "usage: /extensions add <path> [--scope project|user] [--trust]");
  const scope = rest.includes("--scope") ? (rest[rest.indexOf("--scope") + 1] === "project" ? "project" : "user") : "user";
  const trust = rest.includes("--trust");
  const result = registry.install({ srcPath: path, scope, trust });
  if (!result.ok) return err(result.error ?? "install failed", result.error ?? "");
  ctx.host.print(`installed "${result.id ?? path}" as ${scope}${trust ? " (trusted)" : ""}`);
  return ok(result.id ?? path);
}

function extensionsEnable(registry: ExtensionRegistry, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const id = rest[0];
  if (!id) return err("missing extension id", "usage: /extensions enable <id>");
  const result = registry.enable(id);
  if (!result.ok) return err(result.error ?? "enable failed", result.error ?? "");
  ctx.host.print(`enabled "${id}"`);
  return ok(id);
}

function extensionsDisable(registry: ExtensionRegistry, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const id = rest[0];
  if (!id) return err("missing extension id", "usage: /extensions disable <id>");
  const result = registry.disable(id);
  if (!result.ok) return err(result.error ?? "disable failed", result.error ?? "");
  ctx.host.print(`disabled "${id}"`);
  return ok(id);
}

function extensionsTrust(registry: ExtensionRegistry, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const id = rest[0];
  if (!id) return err("missing extension id", "usage: /extensions trust <id>");
  const note = rest.slice(1).join(" ") || "trusted via slash command";
  const result = registry.trust_(id, note);
  if (!result.ok) return err(result.error ?? "trust failed", result.error ?? "");
  ctx.host.print(`trusted "${id}"`);
  return ok(id);
}

function extensionsUntrust(registry: ExtensionRegistry, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const id = rest[0];
  if (!id) return err("missing extension id", "usage: /extensions untrust <id>");
  const note = rest.slice(1).join(" ") || "untrusted via slash command";
  const result = registry.untrust(id, note);
  if (!result.ok) return err(result.error ?? "untrust failed", result.error ?? "");
  ctx.host.print(`untrusted "${id}"`);
  return ok(id);
}

function extensionsDoctor(registry: ExtensionRegistry, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const id = rest[0];
  const reports = registry.doctor(id);
  if (reports.length === 0) return err("no extensions found", "not found");
  for (const r of reports) {
    const tag = r.errors.length === 0 ? "OK" : "FAIL";
    ctx.host.print(`[${tag}] ${r.id}: ${r.errors.join("; ") || "no errors"}`);
    ctx.host.print(`  manifestOk=${r.manifestOk} mainLoads=${r.mainLoads} toolsHaveMetadata=${r.toolsHaveMetadata} hookTimeoutsOk=${r.hookTimeoutsOk} contributionsValid=${r.contributionsValid}`);
  }
  const any = reports.some((r) => r.errors.length > 0);
  return any ? err("one or more extensions failed doctor", "see above") : ok("all extensions healthy", reports);
}

function extensionsRemove(registry: ExtensionRegistry, rest: string[], ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } }): SlashCommandResult {
  const id = rest[0];
  if (!id) return err("missing extension id", "usage: /extensions remove <id>");
  const result = registry.uninstall(id);
  if (!result.ok) return err(result.error ?? "uninstall failed", result.error ?? "");
  ctx.host.print(`removed "${id}"`);
  return ok(id);
}
