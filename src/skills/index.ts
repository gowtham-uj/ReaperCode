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
 * The 17 built-in skills live under `./built-in/<name>/` and are
 * discovered by `discoverSkills` when the registry boots.
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
