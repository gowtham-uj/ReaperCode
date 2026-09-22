/**
 * The main agent's tool inventory, rendered from the live registry.
 *
 * `tools.md` is a file a person reads and edits (a Drop/Pin worklist), so it is
 * generated rather than hand-written and it goes stale the moment a tool is
 * renamed. It had: the committed copy listed `browser_control` and `skim_file`
 * while the registry held `browser_use` and no such thing as `skim_file`, so a
 * reader was being told about a tool that does not exist and not told about the
 * one that does.
 *
 * The render lives here rather than in the script so that the same function that
 * writes the file also checks it: a test compares the committed `tools.md`
 * against `renderToolList()`, which is the only shape of check that cannot drift
 * from the generator. A generator that lives in a `.mts` script cannot be
 * imported by the test suite without running the script's write as a side
 * effect, which is what a comparing test must not do.
 */
import { CORE_TOOL_NAMES, toolRegistry } from "./registry.js";

const allNames = (): string[] => Object.keys(toolRegistry).sort();

const row = (name: string): string =>
  `| \`${name}\` | ${toolRegistry[name as keyof typeof toolRegistry].description.split("\n")[0]!.replace(/\|/g, "\\|")} |`;

/**
 * Render one group of the deferred set, keeping only names that still exist.
 *
 * The groups are a reading aid and are written by hand, so they go stale the
 * moment a tool is consolidated, which is how the previous version came to list
 * `view_file`, `create_skill`, `get_tool_output`, and a dozen computer-control
 * tools that had all been deleted. Filtering against the live registry means a
 * retired name simply stops appearing, and a new tool that belongs to no group
 * is visible as the gap it is rather than silently rendered twice.
 */
const group = (registered: string[], members: string[]): string => {
  const present = members.filter((name) => registered.includes(name));
  if (present.length === 0) return "(none)";
  const missing = members.filter((name) => !registered.includes(name));
  return present.join(", ") + (missing.length ? ` (retired: ${missing.join(", ")})` : "");
};

/**
 * The deferred groups, by hand, as a reading aid.
 *
 * Exported because the drift test names them as the reason a grouped line can
 * change without the registry moving, and a reader of that test needs to know
 * they are the only part of this file that is not derived from the registry.
 */
export const DEFERRED_GROUPS: Array<{ label: string; members: string[] }> = [
  { label: "Files and search", members: ["edit_file", "file_find", "delete_file", "inspect_environment", "diagnostics", "apply_patch_edit"] },
  { label: "Git and checkpoints", members: ["create_checkpoint", "restore_checkpoint"] },
  { label: "Background processes", members: ["job"] },
  { label: "Web", members: ["web_search", "web_fetch"] },
  { label: "Browsers", members: ["browser_use"] },
  { label: "Skill authoring", members: ["activate_skill", "skill_manager"] },
  { label: "Extension authoring", members: ["extension_manager"] },
  { label: "Hook authoring", members: ["hook_manager"] },
  { label: "Memory", members: ["search_memory", "scratchpad"] },
];

/** The whole file, as it should appear on disk. */
export function renderToolList(): string {
  const all = allNames();
  const core = all.filter((name) => CORE_TOOL_NAMES.has(name));
  const deferred = all.filter((name) => !CORE_TOOL_NAMES.has(name));
  const grouped = DEFERRED_GROUPS.map(
    ({ label, members }) => `- **${label}:** ${group(deferred, members)}`,
  ).join("\n");

  return `# Reaper main agent: tool inventory

${all.length} tools are registered. The wire carries a schema for **${core.length}** of them on
every model call; the other **${deferred.length}** are named in the system prompt and unlocked by
\`search_tools\` (keyword, or \`select:<name>\`).

Mark a tool **Drop** below and the next change takes it out of \`toolRegistry\`; mark one **Pin**
and it moves into \`CORE_TOOL_NAMES\` so it ships with a full schema every turn. Nothing here is
enforced by the file itself; it is a worklist.

## Core: full schema on every call (${core.length})

| Tool | What it does |
| --- | --- |
${core.map(row).join("\n")}

## Deferred: behind \`search_tools\` (${deferred.length})

| Tool | What it does | Drop? | Pin? |
| --- | --- | --- | --- |
${deferred.map((name) => `${row(name)} |  |  |`).join("\n")}

---

## Grouped view of the deferred set

${grouped}

Regenerate with \`node --import=tsx scripts/emit-tool-list.mts\`.
`;
}
