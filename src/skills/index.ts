/**
 * Public barrel for the first-class skill system.
 *
 *   src/skills/
 *     types.ts        — SkillManifest, SkillTrust, InstalledSkillRecord
 *     manifest.ts     — parseSkillManifest / writeSkillManifest
 *     trust.ts        — TrustResolver
 *     router.ts       — SkillRouter (returns summaries only)
 *     discovery.ts    — discoverSkills walks the 4 locations
 *     registry.ts     — SkillRegistry (wraps SkillMemoryRegistry)
 *     lifecycle.ts    — install / uninstall / draft / test / trust
 *
 * `./built-in/` is an optional packaged-skill root. Reaper currently ships
 * no built-in skill bodies; project, user, and extension skills remain active.
 *
 * (Note: the previous `validator.ts` was removed in the 2026-06
 * cleanup; manifest validation now happens inline in `manifest.ts`.)
 */

export * from "./types.js";
export * from "./manifest.js";
export * from "./trust.js";
export * from "./router.js";
export * from "./discovery.js";
export * from "./registry.js";
export * from "./lifecycle.js";
