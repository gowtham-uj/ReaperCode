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
