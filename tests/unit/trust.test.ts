import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyReadFileTrust,
  classifyToolResultTrust,
  countUntrustedMarkers,
  wrapUntrustedContent,
} from "../../src/context/trust.js";

test("web_search, web_fetch, and MCP tools are untrusted", () => {
  for (const name of ["web_search", "web_fetch", "web_research_search"]) {
    assert.equal(classifyToolResultTrust({ name, args: {} }), "untrusted");
  }
  assert.equal(
    classifyToolResultTrust({ name: "mcp__github__list_issues", args: {} }),
    "untrusted",
  );
});

test("in-workspace reads, grep, git are trusted by default", () => {
  assert.equal(classifyToolResultTrust({ name: "read_file", args: { path: "src/index.ts" } }), "trusted");
  assert.equal(classifyToolResultTrust({ name: "grep_search", args: { pattern: "TODO" } }), "trusted");
  assert.equal(classifyToolResultTrust({ name: "list_directory", args: {} }), "trusted");
  assert.equal(classifyToolResultTrust({ name: "git_status", args: {} }), "trusted");
});

test("shell commands that fetch external data are untrusted", () => {
  for (const cmd of [
    "curl https://api.example.com/v1",
    "wget https://example.com/file.tar.gz",
    "ssh user@host cat /etc/hostname",
    "git fetch origin",
    "git pull --rebase origin main",
    "npm install lodash",
    "npm view react versions",
    "apt install -y curl",
  ]) {
    assert.equal(
      classifyToolResultTrust({ name: "bash", args: { cmd } }),
      "untrusted",
      `expected '${cmd}' to be untrusted`,
    );
  }
});

test("local shell commands are trusted", () => {
  for (const cmd of [
    "ls -la",
    "npm test",
    "git commit -m msg",
    "node --test isPalindrome.test.js",
  ]) {
    assert.equal(
      classifyToolResultTrust({ name: "bash", args: { cmd } }),
      "trusted",
      `expected '${cmd}' to be trusted`,
    );
  }
});

test("read_file outside the workspace root is untrusted", () => {
  const result = { name: "read_file", args: { path: "/tmp/external.txt" } };
  assert.equal(classifyReadFileTrust(result, "/workspace"), "untrusted");
  assert.equal(classifyReadFileTrust(result, undefined), "trusted");
  const inside = { name: "read_file", args: { path: "/workspace/src/index.ts" } };
  assert.equal(classifyReadFileTrust(inside, "/workspace"), "trusted");
});

test("wrapUntrustedContent adds the canary markers and is idempotent", () => {
  const wrapped = wrapUntrustedContent("hello", "web_search");
  assert.match(wrapped, /<<<UNTRUSTED_EXTERNAL_CONTENT>>>/);
  assert.match(wrapped, /<<<END_UNTRUSTED_EXTERNAL_CONTENT>>>/);
  // Idempotent: re-wrapping returns the same string.
  assert.equal(wrapUntrustedContent(wrapped, "x"), wrapped);
});

test("countUntrustedMarkers counts open and close pairs", () => {
  const counts = countUntrustedMarkers(wrapUntrustedContent("a", "x"));
  assert.equal(counts.opens, 1);
  assert.equal(counts.closes, 1);
});
