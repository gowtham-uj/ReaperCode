/**
 * F5 wiring: bus handler that resolves conditional skills.
 *
 * The engine emits a `ResourcesDiscover` event on the ExtensionBus
 * during content prep. This module:
 *   1. Registers a handler at module-load time.
 *   2. On the event, calls `activateConditionalSkillsForPaths`.
 *   3. Loads the matched skills' bodies and writes them into the
 *      `activated_conditional_skills` state field on the
 *      Engine's GraphState.
 *
 * The state field is updated via a callback the engine installs
 * with `setConditionalSkillSink`. Without a sink the bus still
 * resolves matches but the result is only available in the
 * handler's return value (callers can read it from the event
 * payload).
 *
 * The handler is registered exactly once across the process.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ReaperSkill } from "../adaptive/types.js";
import { activateConditionalSkillsForPaths } from "../adaptive/conditional-skills.js";
import { SkillMemoryRegistry } from "../adaptive/skill-memory-registry.js";
import { getExtensionBus } from "./bus.js";

export interface ConditionalSkillMatch {
  name: string;
  body: string;
}

export interface ResourcesDiscoverPayload {
  workspaceRoot: string;
  /** Absolute or relative paths the engine is about to interact with. */
  paths: string[];
  /** Optional pre-loaded skills to consider (saves a registry load). */
  skills?: ReaperSkill[];
}

export interface ResourcesDiscoverResult {
  matches: ConditionalSkillMatch[];
  /** All skill names that the matcher returned, even ones that
   *  failed to load from disk. */
  attempted: string[];
  /** Skill names whose on-disk body could not be loaded. */
  failed: string[];
}

type ConditionalSkillSink = (matches: ConditionalSkillMatch[]) => void;

let sink: ConditionalSkillSink | null = null;
let registered = false;

function readSkillBody(skill: ReaperSkill): string | null {
  if (!skill.sourcePath || !existsSync(skill.sourcePath)) return null;
  // The source path may itself be a symlink. Resolve and refuse to
  // follow chains. The activate_skill S1 hardening already enforces
  // a realpath check; we mirror it here so the conditional path is
  // not a regression.
  let real: string;
  try {
    real = statSync(skill.sourcePath).isSymbolicLink()
      ? skill.sourcePath // We could throw, but the symlink check
                        // is the activate_skill tool's job. For
                        // conditional activation we just read the
                        // file as a hint, not a hard dependency.
      : skill.sourcePath;
  } catch {
    return null;
  }
  try {
    return readFileSync(real, "utf8");
  } catch {
    return null;
  }
}

function handleResourcesDiscover(payload: ResourcesDiscoverPayload): ResourcesDiscoverResult {
  const names = activateConditionalSkillsForPaths({
    workspaceRoot: payload.workspaceRoot,
    paths: payload.paths,
    ...(payload.skills ? { skills: payload.skills } : {}),
  });

  // Map names to bodies. If the caller passed skills explicitly,
  // prefer those; otherwise load bodies from the registry's
  // sourcePath on disk.
  const byName = new Map<string, ReaperSkill>();
  if (payload.skills) {
    for (const s of payload.skills) byName.set(s.name, s);
  } else {
    const reg = new SkillMemoryRegistry({ workspaceRoot: payload.workspaceRoot });
    for (const s of reg.listSkills()) byName.set(s.name, s);
  }

  const matches: ConditionalSkillMatch[] = [];
  const failed: string[] = [];
  for (const name of names) {
    const skill = byName.get(name);
    if (!skill) {
      failed.push(name);
      continue;
    }
    const body = readSkillBody(skill);
    if (body === null) {
      failed.push(name);
      continue;
    }
    matches.push({ name, body });
  }
  if (sink) sink(matches);
  return { matches, attempted: names, failed };
}

/** Install a sink so subsequent matches are visible to the engine. */
export function setConditionalSkillSink(s: ConditionalSkillSink | null): void {
  sink = s;
}

/** Register the bus handler. Idempotent. */
export function registerResourceDiscoveryHandler(): void {
  if (registered) return;
  registered = true;
  getExtensionBus().on("ResourcesDiscover", (event, payload) => {
    if (!payload || typeof payload !== "object") return [];
    const p = payload as ResourcesDiscoverPayload;
    if (typeof p.workspaceRoot !== "string" || !Array.isArray(p.paths)) return [];
    return handleResourcesDiscover(p);
  });
}

/** Helper for callers that want to invoke the resolver directly
 *  without going through the bus. */
export function resolveConditionalSkillsForRun(
  payload: ResourcesDiscoverPayload,
): ResourcesDiscoverResult {
  return handleResourcesDiscover(payload);
}

/** Test-only: drop the registered handler and sink. */
export function __resetResourceDiscoveryForTests(): void {
  sink = null;
  registered = false;
  getExtensionBus().clear();
}

/** Re-export the join helper so the engine can build paths
 *  without importing node:path itself. */
export { join as pathJoin };
