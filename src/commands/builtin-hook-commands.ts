/**
 * Built-in slash commands for the `/hooks` group.
 *
 * Subcommands:
 *   /hooks list           — list all hooks (drafts + registered) with trust + enforce
 *   /hooks show <id>      — show one hook + the first 4KB of its source
 *   /hooks approve <id>   — compile + register on the live HookRunner
 *   /hooks unapprove <id> — unregister + drop trust (keeps the draft on disk)
 *   /hooks remove <id>    — uninstall (deletes the on-disk JSON + unregisters)
 *
 * Source authoring goes through the model-callable `create_hook` /
 * `update_hook` tools; the slash command surface is for inspecting
 * and approving the live hook set without leaving the TUI.
 *
 * Host-agnostic; the host is the same `SlashHost` as `/skills` and
 * `/extensions`.
 */

import type { SlashCommand, SlashCommandResult } from "../extensions/slash-command-registry.js";
import type { HookLifecycle } from "../hooks/lifecycle.js";

export interface HooksCommandsDeps {
  lifecycle: HookLifecycle;
}

function ok(output: string, data?: unknown): SlashCommandResult {
  return data === undefined ? { ok: true, output } : { ok: true, output, data };
}
function err(output: string, error: string): SlashCommandResult {
  return { ok: false, output, error };
}

export function buildHooksCommands(deps: HooksCommandsDeps): SlashCommand[] {
  const { lifecycle } = deps;
  return [
    {
      name: "hooks",
      description: "Manage event hooks. Subcommands: list, show, approve, unapprove, remove.",
      source: "builtin",
      run: async (args, ctx) => {
        const sub = args[0] ?? "list";
        const rest = args.slice(1);
        ctx.host.print(`# /hooks ${sub}`);
        switch (sub) {
          case "list":
            return hooksList(lifecycle, ctx);
          case "show":
            return hooksShow(lifecycle, rest, ctx);
          case "approve":
            return hooksApprove(lifecycle, rest, ctx);
          case "unapprove":
            return hooksUnapprove(lifecycle, rest, ctx);
          case "remove":
            return hooksRemove(lifecycle, rest, ctx);
          default:
            return err(`unknown subcommand "${sub}"`, `try /hooks list|show|approve|unapprove|remove`);
        }
      },
    },
  ];
}

function hooksList(
  lifecycle: HookLifecycle,
  ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } },
): SlashCommandResult {
  const all = lifecycle.list();
  if (all.length === 0) {
    ctx.host.print("(no hooks installed)");
    return ok("(no hooks installed)");
  }
  for (const h of all) {
    ctx.host.print(
      `- ${h.id.padEnd(28)} ${h.event.padEnd(22)} ${h.trust.padEnd(20)} enforce=${String(h.enforce).padEnd(5)} ${h.description}`,
    );
  }
  return ok(`${all.length} hook(s)`, all);
}

function hooksShow(
  lifecycle: HookLifecycle,
  rest: string[],
  ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } },
): SlashCommandResult {
  const id = rest[0];
  if (!id) return err("missing hook id", "usage: /hooks show <id>");
  const h = lifecycle.get(id);
  if (!h) return err(`hook "${id}" not found`, "not found");
  ctx.host.print(`${h.id} (${h.trust}, enforce=${h.enforce})`);
  ctx.host.print(`  event: ${h.event}`);
  ctx.host.print(`  description: ${h.description}`);
  ctx.host.print(`  matcher: ${h.matcher ? JSON.stringify(h.matcher) : "(none)"}`);
  ctx.host.print(`  timeout_ms: ${h.timeout_ms}`);
  ctx.host.print(`  scope: ${h.scope}`);
  ctx.host.print(`  source (first 4KB):`);
  ctx.host.print("  ```js");
  ctx.host.print(h.source.slice(0, 4096));
  ctx.host.print("  ```");
  return ok(h.id, h);
}

async function hooksApprove(
  lifecycle: HookLifecycle,
  rest: string[],
  ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } },
): Promise<SlashCommandResult> {
  const id = rest[0];
  if (!id) return err("missing hook id", "usage: /hooks approve <id>");
  try {
    const r = await lifecycle.approve(id);
    if (!r.ok || !r.record) return err(r.error ?? "approve failed", r.error ?? "");
    ctx.host.print(`approved "${id}" — handler registered on live HookRunner`);
    return ok(id, r.record);
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e), e instanceof Error ? e.message : String(e));
  }
}

async function hooksUnapprove(
  lifecycle: HookLifecycle,
  rest: string[],
  ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } },
): Promise<SlashCommandResult> {
  const id = rest[0];
  if (!id) return err("missing hook id", "usage: /hooks unapprove <id>");
  const r = lifecycle.get(id);
  if (!r) return err(`hook "${id}" not found`, "not found");
  try {
    const u = await lifecycle.update({
      id,
      source: r.source,
      matcher: r.matcher,
      timeout_ms: r.timeout_ms,
      enforce: r.enforce,
    });
    if (!u.ok || !u.record) return err(u.error ?? "unapprove failed", u.error ?? "");
    ctx.host.print(`unapproved "${id}" — handler remains a draft`);
    return ok(id, u.record);
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e), e instanceof Error ? e.message : String(e));
  }
}

async function hooksRemove(
  lifecycle: HookLifecycle,
  rest: string[],
  ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } },
): Promise<SlashCommandResult> {
  const id = rest[0];
  if (!id) return err("missing hook id", "usage: /hooks remove <id>");
  try {
    const r = await lifecycle.uninstall(id);
    if (!r.ok) return err(r.error ?? "remove failed", r.error ?? "");
    ctx.host.print(`removed "${id}"`);
    return ok(id);
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e), e instanceof Error ? e.message : String(e));
  }
}

export { SlashCommand };
