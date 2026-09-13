/**
 * Argument projection for the consolidated `*_manager` tools.
 *
 * A manager validates a flat object — its own `action`, plus every field any
 * of its operations might need — and then hands the chosen operation to that
 * operation's own handler. The per-operation schemas are `.strict()`, which is
 * what makes them worth re-running at all: a `create` that carries a field only
 * `uninstall` understands is a mistake the model should hear about rather than
 * have quietly dropped on the floor.
 *
 * But a strict schema applied to the manager's whole argument object fails on
 * `action` every single time, because `action` is not a field of any one
 * operation. It has to come out first, and this is the one place that knows so.
 *
 * Values that are explicitly `undefined` are dropped too. Zod treats a present
 * key holding `undefined` as absent for *known* fields, but strict-mode
 * unrecognized-key detection runs over the input's own key set — so a manager
 * field the model never sent would still be reported as an unrecognized key.
 *
 * Callers pass only `"action"`. Anything else a specific operation needs gone
 * is gone because the operation's own strict schema rejects it, which is the
 * behaviour we want to keep.
 */
export function operationArgs<T extends object>(
  args: T,
  managerKeys: readonly string[] = ["action"],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (managerKeys.includes(key)) continue;
    out[key] = value;
  }
  return out;
}
