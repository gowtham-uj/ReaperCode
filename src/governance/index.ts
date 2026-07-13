/**
 * Public surface for the ToolPolicy governance layer.
 *
 * Consumers import the metadata, role profiles, shell-risk classification,
 * ordering advisories, and policy evaluator from this barrel.
 *
 * The modules themselves remain individually importable; the
 * barrel exists so callers do not need to know which file each
 * symbol lives in.
 */

export * from "./tool-metadata.js";
export * from "./role-profiles.js";
export * from "./shell-risk.js";
export * from "./preferred-ordering.js";
export * from "./policy-engine.js";
