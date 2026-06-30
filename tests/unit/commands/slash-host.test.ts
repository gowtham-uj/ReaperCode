/**
 * AC17: `/skills` and `/extensions` work via slash host.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SlashCommandRegistry, ConsoleHost } from "../../../src/extensions/slash-command-registry.js";

test("AC17: SlashCommandRegistry hosts the skills and extensions groups", async () => {
  const reg = new SlashCommandRegistry();
  reg.register({
    name: "skills",
    description: "List/manage skills",
    source: "builtin",
    run: () => ({ ok: true, output: "skills: ok" }),
  });
  reg.register({
    name: "extensions",
    description: "List/manage extensions",
    source: "builtin",
    run: () => ({ ok: true, output: "extensions: ok" }),
  });
  const r1 = await reg.handle("/skills list", {
    host: { print: () => {}, printError: () => {}, confirm: () => true, promptSecret: () => null },
  });
  assert.equal(r1.ok, true);
  assert.match(r1.output, /skills/);
  const r2 = await reg.handle("/extensions list", {
    host: { print: () => {}, printError: () => {}, confirm: () => true, promptSecret: () => null },
  });
  assert.equal(r2.ok, true);
  assert.match(r2.output, /extensions/);
});

test("AC17b: handle returns ok:false for non-slash input", async () => {
  const reg = new SlashCommandRegistry();
  const r = await reg.handle("hello world", {
    host: { print: () => {}, printError: () => {}, confirm: () => true, promptSecret: () => null },
  });
  assert.equal(r.ok, false);
});

test("AC17c: handle returns ok:false for unknown command", async () => {
  const reg = new SlashCommandRegistry();
  const r = await reg.handle("/unknown", {
    host: { print: () => {}, printError: () => {}, confirm: () => true, promptSecret: () => null },
  });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /unknown command/);
});

test("AC17d: ConsoleHost uses provided out stream", () => {
  let captured = "";
  const fakeOut = { write: (s: string) => { captured += s; return true; } } as unknown as NodeJS.WritableStream;
  const host = new ConsoleHost({ out: fakeOut, err: fakeOut });
  host.print("hi");
  assert.equal(captured.trim(), "hi");
});
