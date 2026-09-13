/**
 * AC10: Extension slash-command registration via registerSlashCommand.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SlashCommandRegistry } from "../../../src/extensions/slash-command-registry.js";

test("AC10: SlashCommandRegistry register + handle round-trip", async () => {
  const reg = new SlashCommandRegistry();
  reg.register({
    name: "hello",
    description: "Say hello",
    source: "builtin",
    run: () => ({ ok: true, output: "Hello!" }),
  });
  const cmd = reg.get("hello");
  assert.ok(cmd, "slash command should be registered");
  const result = await reg.handle("/hello", {
    host: { print: () => {}, printError: () => {}, confirm: () => true, promptSecret: () => null },
  });
  assert.equal(result.ok, true);
  assert.equal(result.output, "Hello!");
});

test("AC10b: extension source prefix survives handle()", async () => {
  const reg = new SlashCommandRegistry();
  reg.register({
    name: "ping",
    description: "Ping",
    source: "extension:hello",
    run: () => ({ ok: true, output: "pong" }),
  });
  const result = await reg.handle("/ping", {
    host: { print: () => {}, printError: () => {}, confirm: () => true, promptSecret: () => null },
  });
  assert.equal(result.ok, true);
  assert.equal(result.output, "pong");
});

test("a skill name resolves as a skill invocation, not an unknown command", () => {
  /*
   * `/codemode` is what a person types, and it is not a slash command. The
   * registry answers for it — but only by handing the name back, because the
   * caller is the layer that knows the workspace and can read a body. This
   * class must stay host-agnostic: giving it a filesystem to read skills from
   * would make the one registry every host shares the one that touches disk.
   */
  const reg = new SlashCommandRegistry();
  reg.setSkillNames(() => ["codemode", "repo-understanding"]);

  assert.deepEqual(reg.resolveSkillInvocation("/codemode"), { name: "codemode", args: [] });
  assert.deepEqual(reg.resolveSkillInvocation("/CODEmode fix the build"), {
    name: "codemode",
    args: ["fix", "the", "build"],
  });

  // A registered command wins over a skill of the same name: commands are
  // code, skills are data, and the explicit registration is the intent.
  reg.register({ name: "codemode", source: "builtin", run: () => ({ ok: true, output: "" }) });
  assert.equal(reg.resolveSkillInvocation("/codemode"), null);

  // Anything else is still an unknown command.
  assert.equal(reg.resolveSkillInvocation("/nope"), null);
  assert.equal(reg.resolveSkillInvocation("not a slash line"), null);
  assert.equal(reg.resolveSkillInvocation("/"), null);
});

test("an unknown slash line still fails through handle()", async () => {
  const reg = new SlashCommandRegistry();
  reg.setSkillNames(() => ["codemode"]);
  const result = await reg.handle("/codemode", {
    host: { print: () => {}, printError: () => {}, confirm: () => true, promptSecret: () => null },
  });
  // `handle` refusing is the contract: the caller checks
  // `resolveSkillInvocation` first and treats the line as a skill.
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /unknown command/);
});
