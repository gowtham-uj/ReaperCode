/**
 * Adaptive Intelligence public surface: skills, memory, hooks, visual input,
 * capabilities, redaction, and CLI integration.
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

