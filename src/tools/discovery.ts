/**
 * Per-run tool discovery store.
 * Tracks which non-core tools the model has explicitly discovered via search_tools.
 * Scoped per runId so concurrent eval runs don't share state.
 */

const DEFAULT_RUN = "__default__";
const stores = new Map<string, Set<string>>();

export function getDiscoveredTools(runId: string = DEFAULT_RUN): Set<string> {
  let set = stores.get(runId);
  if (!set) {
    set = new Set();
    stores.set(runId, set);
  }
  return set;
}

export function discoverTools(toolNames: string[], runId: string = DEFAULT_RUN): void {
  const set = getDiscoveredTools(runId);
  for (const name of toolNames) set.add(name);
}

export function clearDiscoveredTools(runId: string): void {
  stores.delete(runId);
}
