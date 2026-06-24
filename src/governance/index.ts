/**
 * Public surface for the ToolPolicy governance layer.
 *
 * Consumers import from this barrel:
 *   - the engine's `ToolExecutor` for the per-call gate
 *   - the runtime's `verifyNode` for the completion-safety check
 *   - the test suite for the assertions
 *
 * The modules themselves remain individually importable; the
 * barrel exists so callers do not need to know which file each
 * symbol lives in.
 *
 * Note: the swarm used to call into this layer for the role-aware
 * gate. The controlled 7-role swarm was replaced with a
 * model-driven sub-agent runtime; the runtime no longer maps its
 * work to fixed role names. The governance roles (explorer /
 * architect / implementer / test / reviewer / critic / browser /
 * root) are still used internally as policy anchors.
 */

export * from "./tool-metadata.js";
export * from "./role-profiles.js";
export * from "./shell-risk.js";
export * from "./completion-safety.js";
export * from "./preferred-ordering.js";
export * from "./policy-engine.js";
