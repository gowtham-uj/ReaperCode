/**
 * Phase 2 placeholder for viewer-tool executor cases.
 *
 * In Phase 2 the four viewer tools are registered in `toolRegistry` and have
 * Zod schemas, but their executor case arms are deliberately **not** added
 * yet — appending cases to `executeInner`'s `switch (call.name)` would force
 * the central `ToolCallSchema` discriminated union to grow past the
 * TypeScript narrowing budget, which would surface 83+ pre-existing
 * type errors across `src/execution/planner.ts`,
 * `src/execution/scheduler.ts`, `src/policy/sandbox.ts`,
 * `src/runtime/engine.ts`, etc.
 *
 * Phase 3 will (a) widen the union once via a single fix to
 * `normalizeToolCall`'s return type, (b) add the four case arms, and (c)
 * restore full coverage. Until then, calling a viewer tool surfaces a
 * structured `UNKNOWN_TOOL` error from the existing unknown-tool guard,
 * which is the correct Phase-2 behavior.
 *
 * This file exists so future contributors can grep for
 * `executor-viewer-cases` and know where to add the eventual assertion.
 */