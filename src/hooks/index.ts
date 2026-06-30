/**
 * Public barrel for the declarative hook system.
 *
 *   src/hooks/
 *     sandbox.ts     — compileHookSource (new Function wrapper + size cap)
 *     lifecycle.ts   — HookLifecycle (persist / compile / register / trust)
 *
 * Hooks are independent of extensions: a hook is a JS handler
 * persisted as JSON at <scope>/.reaper/hooks/<id>.json, compiled
 * with `new Function('event', body)`, and registered on the live
 * HookRunner. The `enforce` flag is the safety gate: false = observe
 * only, true = blockable.
 */

export * from "./sandbox.js";
export * from "./lifecycle.js";
