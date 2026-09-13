import test from "node:test";
import assert from "node:assert/strict";

import { buildDescriptorsFromRegistry, resetDescriptors } from "../../src/tools/descriptor-builder.js";
import { getToolDescriptor } from "../../src/tools/descriptor.js";
import { isKnownToolName } from "../../src/tools/tool-allowlist.js";
import { CORE_TOOL_NAMES, ON_DEMAND_TOOL_NAMES, toolRegistry } from "../../src/tools/registry.js";
import { normalizeToolCall } from "../../src/tools/normalize.js";

const STALE_TOOLS = [
  "complete_task",
  "advance_step",
  "delegate_to_plan",
  "cancel_subagent",
  "call_subagent",
  "poll_subagent",
  "agent",
  "agent_swarm",
  "task_create",
  "task_update",
  "task_list",
  "update_plan",
  "update_todo",
  "run_command",
  "run_shell_command",
  "sandbox_service_control",
];

/**
 * Canonical registry keys that must stay registered, pinned so they cannot
 * quietly vanish.
 *
 * The reverse of the list above. `eval` spent time on the stale list — it was
 * withdrawn when it was a thin `node -e` wrapper, a tool that handed the model
 * a child process and called that sandboxing, and this file held the name so it
 * could not come back half-wired. It has since been rebuilt on the runtime it
 * uses now and deliberately re-registered, so the guarantee is restated from
 * the other side: deleting the old entry without pinning the new one would
 * leave nothing here to notice if `eval` were removed again.
 *
 * These are *registry keys*, not model-facing names. An earlier version of this
 * list said `["eval", "read", "bash", "finish"]`, which was wrong twice over:
 * `read` is an alias normalised onto `file_view` and was never a key, and
 * `finish` is not this build's completion mechanism at all (the agent loop ends
 * on a message with no tool calls). A test asserting either would be asserting
 * a shape the product does not have — and since `isKnownToolName` is built
 * from the registry, it failed on the first entry that had no key behind it.
 *
 * The aliases are checked separately below, because "the model can still say
 * `read`" is a real guarantee and it is not the same guarantee as "`file_view`
 * exists".
 */
const REQUIRED_TOOLS = ["eval", "file_view", "bash", "write_file", "grep_search"];

/**
 * Model-facing spellings that must keep resolving to a real tool.
 *
 * Asserted through `normalizeToolCall` rather than against a table, so this
 * tests the path a provider response actually takes: the name arrives, gets
 * rewritten, and has to land on something that exists.
 */
const REQUIRED_ALIASES: Array<[string, string]> = [
  ["read", "file_view"],
  ["view", "file_view"],
  ["ls", "list_directory"],
  ["grep", "grep_search"],
  ["write", "write_file"],
  ["replace", "file_edit"],
];

test("retired planner, task, and shell tools are not registered or discoverable", () => {
  resetDescriptors();
  buildDescriptorsFromRegistry();

  for (const name of STALE_TOOLS) {
    assert.equal(name in toolRegistry, false, `${name} must not be in toolRegistry`);
    assert.equal(CORE_TOOL_NAMES.has(name), false, `${name} must not be core`);
    assert.equal(ON_DEMAND_TOOL_NAMES.has(name), false, `${name} must not be on-demand`);
    assert.equal(getToolDescriptor(name), undefined, `${name} must not have a descriptor`);
    assert.equal(isKnownToolName(name), false, `${name} must not be accepted by allowlist`);
  }

  resetDescriptors();
});

test("the tools the agent depends on are still registered and reachable", () => {
  resetDescriptors();
  buildDescriptorsFromRegistry();

  for (const name of REQUIRED_TOOLS) {
    assert.equal(name in toolRegistry, true, `${name} must be in toolRegistry`);
    assert.equal(getToolDescriptor(name) !== undefined, true, `${name} must have a descriptor`);
    assert.equal(isKnownToolName(name), true, `${name} must be accepted by the allowlist`);
  }

  /*
   * And the aliases still land. A model that has been saying `read` for a year
   * of conversation history does not stop saying it because the registry was
   * reorganised, so the rewrite has to keep working — and it has to keep
   * working *onto a name that exists*, which is the half a table lookup alone
   * would not prove.
   */
  for (const [alias, canonical] of REQUIRED_ALIASES) {
    const normalized = normalizeToolCall({ name: alias, arguments: "{}" }) as { name?: string };
    assert.equal(normalized.name, canonical, `${alias} must normalise to ${canonical}`);
    assert.equal(canonical in toolRegistry, true, `${canonical} must exist for ${alias} to resolve to it`);
  }

  resetDescriptors();
});

test("normalization does not alias natural finish words to removed complete_task", () => {
  const finish = normalizeToolCall({ id: "finish-1", name: "finish", args: { summary: "done" } }) as { name: string };
  const complete = normalizeToolCall({ id: "complete-1", name: "complete", args: { summary: "done" } }) as { name: string };
  assert.equal(finish.name, "finish");
  assert.equal(complete.name, "complete");
});

test("normalization does not alias retired shell names to bash", () => {
  for (const name of ["run_command", "run_shell_command", "sandbox_service_control"]) {
    const normalized = normalizeToolCall({ id: name, name, args: { cmd: "true" } }) as { name: string };
    assert.equal(normalized.name, name);
  }
});
