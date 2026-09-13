/**
 * Reading a tool result's `output` in a test.
 *
 * Tool results reach the model as a *value*, not as JSON text — that is the
 * contract `ToolResult.output: unknown` states, and every consumer in `src/`
 * honours it by branching on `typeof output === "string"` and stringifying the
 * rest. Tests are the one place that kept assuming the opposite: three viewer
 * tests read `JSON.parse(result.output)`, which worked only because
 * `src/tools/viewer/dispatch.ts` was stringifying its three tools' payloads.
 * That stringify was a real defect — `const { window } = await
 * tools.file_view(...)` destructures a string and throws, which is precisely
 * the `JSON.parse` ceremony Code Mode exists to remove — and fixing it had to
 * break those tests rather than be hidden by them.
 *
 * So this helper exists for the same reason the defect was worth fixing: a test
 * that re-parses the payload is a test asserting the wrong contract. It keeps
 * accepting a string for the shrinking set of tools that genuinely return one
 * (`bash` output is text), so it is still the right thing to reach for.
 */

export function outputOf<T = Record<string, unknown>>(result: { output?: unknown }): T {
  const { output } = result;
  const value = typeof output === "string" ? JSON.parse(output) : output;
  return value as T;
}
