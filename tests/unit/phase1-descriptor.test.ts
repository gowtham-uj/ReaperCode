import test from "node:test";
import assert from "node:assert/strict";

import { buildDescriptorsFromRegistry, resetDescriptors } from "../../src/tools/descriptor-builder.js";
import { getAllToolDescriptors, getToolDescriptor, registerToolDescriptor } from "../../src/tools/descriptor.js";
import { normalizeToolResult } from "../../src/tools/tool-result.js";
import { CORE_TOOL_NAMES } from "../../src/tools/registry.js";

/**
 * Phase 1 smoke test: verify that buildDescriptorsFromRegistry() generates
 * a descriptor for every tool in the registry, with correct loadMode
 * (core vs discoverable), family, and capability tier.
 */
test("Phase 1: buildDescriptorsFromRegistry generates descriptors for all registry tools", async () => {
  resetDescriptors();
  buildDescriptorsFromRegistry();

  const descriptors = getAllToolDescriptors();
  assert.ok(descriptors.length > 0, "descriptors should be generated");

  // Every descriptor should have required fields
  for (const d of descriptors) {
    assert.ok(d.name.length > 0, `descriptor ${d.name} should have a name`);
    assert.ok(d.label.length > 0, `descriptor ${d.name} should have a label`);
    assert.ok(d.summary.length > 0, `descriptor ${d.name} should have a summary`);
    assert.ok(d.description.length > 0, `descriptor ${d.name} should have a description`);
    assert.ok(["core", "discoverable"].includes(d.loadMode), `descriptor ${d.name} has valid loadMode`);
    assert.ok(["file", "search", "edit", "shell", "job", "diagnostic", "web", "memory", "exec"].includes(d.family), `descriptor ${d.name} has valid family`);
    assert.ok(["read", "write", "exec"].includes(d.capabilityTier), `descriptor ${d.name} has valid capabilityTier`);
    assert.ok(["shared", "exclusive"].includes(d.concurrency), `descriptor ${d.name} has valid concurrency`);
    assert.ok(["low", "medium", "high"].includes(d.contextCost), `descriptor ${d.name} has valid contextCost`);
    assert.equal(d.source, "builtin", `descriptor ${d.name} should have source=builtin`);
  }

  // Core tools should have loadMode "core"
  for (const coreName of CORE_TOOL_NAMES) {
    const d = getToolDescriptor(coreName);
    assert.ok(d, `core tool ${coreName} should have a descriptor`);
    assert.equal(d!.loadMode, "core", `core tool ${coreName} should have loadMode=core`);
  }

  resetDescriptors();
});

/**
 * Phase 1: verify specific descriptor classifications for key tools.
 */
test("Phase 1: key tool descriptors have correct metadata", async () => {
  resetDescriptors();
  buildDescriptorsFromRegistry();

  const bash = getToolDescriptor("bash");
  assert.ok(bash);
  assert.equal(bash!.family, "shell");
  assert.equal(bash!.capabilityTier, "exec");
  assert.equal(bash!.concurrency, "exclusive");
  assert.equal(bash!.loadMode, "core");

  const write_file = getToolDescriptor("write_file");
  assert.ok(write_file);
  assert.equal(write_file!.family, "edit");
  assert.equal(write_file!.capabilityTier, "write");
  assert.equal(write_file!.loadMode, "core");

  const file_view = getToolDescriptor("file_view");
  assert.ok(file_view);
  assert.equal(file_view!.family, "file");
  assert.equal(file_view!.capabilityTier, "read");
  assert.equal(file_view!.concurrency, "shared");
  assert.equal(file_view!.loadMode, "core");

  const search_tools = getToolDescriptor("search_tools");
  assert.ok(search_tools);
  assert.equal(search_tools!.family, "search");
  assert.equal(search_tools!.capabilityTier, "read");
  assert.equal(search_tools!.loadMode, "core");

  // Aliases should be populated for known tools
  assert.ok(bash!.aliases.includes("shell"), "bash should have 'shell' alias");
  assert.equal(bash!.aliases.includes("run_command"), false, "retired run_command must not be advertised");
  assert.ok(file_view!.aliases.includes("read"), "file_view should have 'read' alias");
  assert.ok(write_file!.aliases.includes("create_file"), "write_file should have 'create_file' alias");

  // Examples should be populated for known tools
  assert.ok(bash!.examples.length > 0, "bash should have examples");
  assert.ok(write_file!.examples.length > 0, "write_file should have examples");

  resetDescriptors();
});

/**
 * Phase 1: verify that normalizeToolResult wraps a legacy result correctly.
 */
test("Phase 1: normalizeToolResult wraps legacy results with correct metadata", async () => {
  // Success case
  const success = normalizeToolResult({
    ok: true,
    toolCallId: "tc-1",
    name: "write_file",
    args: { path: "hello.txt", content: "hello\n" },
    output: "File written: hello.txt",
    durationMs: 12,
  });
  assert.equal(success.ok, true);
  assert.equal(success.toolCallId, "tc-1");
  assert.equal(success.name, "write_file");
  assert.equal(success.isError, false);
  assert.equal(success.useless, false);
  assert.equal(success.durationMs, 12);
  assert.equal(success.content, "File written: hello.txt");

  // Error case
  const error = normalizeToolResult({
    ok: false,
    toolCallId: "tc-2",
    name: "bash",
    args: { cmd: "exit 1", description: "test" },
    durationMs: 50,
    error: { code: "exit_1", message: "Command failed with exit code 1" },
  });
  assert.equal(error.ok, false);
  assert.equal(error.isError, true);
  assert.equal(error.content, undefined);
});
