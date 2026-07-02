import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyBashCommand,
  isReadOnlyBashCommand,
  evaluateBashPermission,
  BashInputSchema,
} from "../../../../src/tools/bash/index.js";

test("classifyBashCommand tags read-only commands", () => {
  assert.equal(classifyBashCommand("cat file.txt").category, "read");
  assert.equal(classifyBashCommand("ls -la").category, "read");
});

test("classifyBashCommand tags filesystem writes", () => {
  assert.equal(classifyBashCommand("echo x > file.txt").category, "write");
  assert.equal(classifyBashCommand("mkdir foo").category, "unknown");
});

test("classifyBashCommand detects network and install commands", () => {
  assert.equal(classifyBashCommand("curl https://example.com").category, "network");
  assert.equal(classifyBashCommand("npm install").category, "install");
});

test("isReadOnlyBashCommand accepts safe read commands", () => {
  assert.equal(isReadOnlyBashCommand("cat file.txt").allow, true);
  assert.equal(isReadOnlyBashCommand("grep foo file.txt").allow, true);
  assert.equal(isReadOnlyBashCommand("echo x > file.txt").allow, false);
});

test("evaluateBashPermission blocks writes in read-only mode", () => {
  const result = evaluateBashPermission({ command: "echo x > file.txt" }, "read_only", "/tmp", "/tmp");
  assert.equal(result.outcome, "would_block");
});

test("evaluateBashPermission allows reads in read-only mode", () => {
  const result = evaluateBashPermission({ command: "cat file.txt" }, "read_only", "/tmp", "/tmp");
  assert.equal(result.outcome, "allow");
});

test("evaluateBashPermission escalates destructive commands", () => {
  const result = evaluateBashPermission({ command: "rm -rf /" }, "workspace_write", "/tmp", "/tmp");
  assert.equal(result.outcome, "deny");
  assert.equal(result.ruleId, "bash_dangerous");
  assert.deepEqual(result.allowedIn, ["danger_full_access"]);
});

test("BashInputSchema accepts new canonical field names", () => {
  const modern = BashInputSchema.parse({
    command: "echo hello",
    description: "say hi",
    timeout: 30,
    run_in_background: false,
  });
  assert.equal(modern.command, "echo hello");
  assert.equal(modern.timeout, 30);
});

test("BashInputSchema requires a command", () => {
  assert.throws(() => BashInputSchema.parse({}));
});

test("BashInputSchema requires a timeout (no default)", () => {
  // The bash tool requires `timeout` in seconds (matching the
  // reference-agent pattern, e.g. pi-mono). Parsing without it
  // throws — there is no default.
  assert.throws(() => BashInputSchema.parse({ command: "echo hi" } as any));
  assert.throws(() => BashInputSchema.parse({ command: "echo hi", timeout: 0 } as any));
  assert.throws(() => BashInputSchema.parse({ command: "echo hi", timeout: 4000 } as any));
});
