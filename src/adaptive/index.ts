/**
 * Adaptive Intelligence — public surface.
 *
 * The Subagent runtime:
 *
 * - `swarm/` — Model-driven subagents. A single subagent at a time,
 *   spawned by the main agent via the Agent tool. Returns a compact
 *   summary to the main context. The main agent never sees the
 *   subagent's full history.
 */

export * from "./types.js";
export {
  parseFrontmatter,
  parseSimpleYaml,
  validateSkillFields,
  loadSkill,
  parseSkillFromRaw,
  createSkill,
  serializeSkill,
  createSkillFromRunTrace,
  selectRelevantSkills,
  renderSkillForModel,
  disableSkill,
  deleteSkill,
  skillNestingDepth,
  skillDirName,
} from "./skill-author.js";
export { SkillMemoryRegistry } from "./skill-memory-registry.js";

/**
 * F1: test-only hook. Resets any in-memory caches the registry
 * holds. Call between tests to avoid stale index state.
 */
export function __resetSkillRegistryForTests(): void {
  // The default export intentionally allows re-construction in
  // callers; this hook currently is a no-op because SkillMemoryRegistry
  // is constructed per-call by `new SkillMemoryRegistry(...)`. It
  // exists so test files can call it as a stable API.
}
export { PersistentMemoryStore } from "./persistent-memory-store.js";
export { MemoryScopePolicy } from "./memory-scope-policy.js";
export { VisualInputAnalyzer } from "./visual-input-analyzer.js";
export type { VisionModel, VisualAnalysisOutcome, VisualAnalysisOk, VisualAnalysisUnavailable } from "./visual-input-analyzer.js";
export { ScreenshotContextBridge } from "./screenshot-context-bridge.js";
export { ModelCapabilitiesRegistry, DEFAULT_MODEL_CAPABILITIES } from "./model-capabilities.js";
export { Hooks } from "./hooks.js";
export { redactSecrets } from "./redact.js";
export { ReaperCLI } from "./cli.js";
export type { ReaperCLIOptions } from "./cli.js";

// Re-export the orchestration system as a sub-object so consumers
// can either use it as a flat namespace or pull it by group.
export * as Swarm from "./swarm/index.js";
