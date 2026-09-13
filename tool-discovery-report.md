# How deferred tools load into the model's context

---

> **Superseded in one respect.** This report is the record of a specific sweep run, and it
> describes the tool surface as it was at that time — 10 core tools and 20 deferred. `eval`
> has since been removed from `toolRegistry` entirely, at your request, so the surface is now
> 10 core and 19 deferred. The `eval` section below is kept as the history of what that run
> observed; it is not a description of the current surface. See `tools.md` for the live list.

Run against `deepinfra/zai-org/GLM-5.3-Flash`, keyword pre-pass **off**, up to 8 turns per scenario.

Every registered tool outside the core set is reachable by exactly one route, in four stages:

1. **Inventory** — the tool is named in the `# Available tools` block appended to the system
   prompt, with a one-line description but *no* schema. This is how the model learns it exists.
2. **Search** — the model calls `search_tools`, either with capability keywords (BM25 ranking) or
   `select:<name>` (exact). The call itself is what promotes the tool.
3. **Unlock** — the tool's full schema is added to the `tools` array on the *next* model call, and
   the name is dropped from the inventory, because it is no longer something to go looking for.
4. **Use** — the model calls it and the executor runs it.

A tool promoted by the content-prep keyword pre-pass skips stages 1–2: it is attached before the
first call, so the model never has to discover it. That is the optimisation working, and it is
reported separately (`pre-pass`) rather than counted as a discovery.

---

## `skim_file`

**PASS  · inventory ok · search ok (search) · schema ok · called 1x**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 1 call(s): `skim prune large file` → `skim_file`, `edit_file`, `file_view`, `bash`, `delete_file`, `write_file` |
| Unlock | route: **search**; schema on a later call: yes; dropped from inventory: yes |
| Use | ok |

Wire over 6 turn(s): 10 → 13 → 13 → 13 → 13 → 13 schemas.

- turn 1: called search_tools; said nothing, finishReason=tool_calls
- turn 2: called skim_file; said nothing, finishReason=tool_calls
- turn 3: called (nothing); said nothing, finishReason=stop
- turn 4: called (nothing); said nothing, finishReason=stop
- turn 5: called (nothing); said nothing, finishReason=stop
- turn 6: called (nothing); said nothing, finishReason=stop


## `inspect_environment`

**UNMET · inventory ok · search MISS · schema MISS · not called**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | never called |
| Unlock | route: **missing**; schema on a later call: **no**; dropped from inventory: **no** |
| Use | never called |

Wire over 7 turn(s): 10 → 10 → 10 → 10 → 10 → 10 → 10 schemas.

- turn 1: called (nothing); said nothing, finishReason=stop
- turn 2: called list_directory; said nothing, finishReason=tool_calls
- turn 3: called file_view, list_directory; said nothing, finishReason=tool_calls
- turn 4: called (nothing); said nothing, finishReason=stop
- turn 5: called (nothing); said nothing, finishReason=stop
- turn 6: called file_view, file_view; said nothing, finishReason=tool_calls
- turn 7: called (nothing); said "**Inventory of this workspace** (`/tmp/reaper-phase2-3RE4AH`), nothing installed:\n\n- **Manifests (1):** `package.json` —", finishReason=stop

> **Not exercised by this scenario.** The mechanism was never reached, so this run says nothing about it — neither pass nor fail. Making the task one core tools cannot answer is what turns this into a real test.

## `create_checkpoint`

**PASS  · inventory ok · search ok (select) · schema ok · called 1x**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 1 call(s): `select:create_checkpoint` → `create_checkpoint` |
| Unlock | route: **select**; schema on a later call: yes; dropped from inventory: yes |
| Use | ok |

Wire over 3 turn(s): 10 → 11 → 11 schemas.

- turn 1: called search_tools; said nothing, finishReason=tool_calls
- turn 2: called create_checkpoint; said nothing, finishReason=tool_calls
- turn 3: called (nothing); said "Checkpoint created: `cp-2026-09-10T14-08-49-163Z-86aca1c7-933a-4bf1-8f0e-830f020454c9` (base `e405af8`, restore availabl", finishReason=stop


## `restore_checkpoint`

**PASS  · inventory ok · search ok (select) · schema ok · called 1x**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 1 call(s): `select:restore_checkpoint` → `restore_checkpoint` |
| Unlock | route: **select**; schema on a later call: yes; dropped from inventory: yes |
| Use | ok |

Wire over 4 turn(s): 10 → 11 → 11 → 11 schemas.

- turn 1: called search_tools; said nothing, finishReason=tool_calls
- turn 2: called list_directory; said nothing, finishReason=tool_calls
- turn 3: called restore_checkpoint; said nothing, finishReason=tool_calls
- turn 4: called (nothing); said "Restored checkpoint `cp-2026-09-10T14-08-59-756Z-3345fce3-acc5-49bf-85f6-4ecf888af157`. Tracked files are back to base r", finishReason=stop


## `web_fetch`

**PASS  · inventory ok · search ok (select) · schema ok · called 1x**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 1 call(s): `select:web_fetch` → `web_fetch` |
| Unlock | route: **select**; schema on a later call: yes; dropped from inventory: yes |
| Use | ok |

Wire over 3 turn(s): 10 → 11 → 11 schemas.

- turn 1: called search_tools; said nothing, finishReason=tool_calls
- turn 2: called web_fetch; said nothing, finishReason=tool_calls
- turn 3: called (nothing); said "Fetched live (HTTP 200). The first heading is exactly:\n\n**Example Domain**", finishReason=stop


## `web_search`

**FAIL  · inventory ok · search ok (search) · schema ok · not called**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 1 call(s): `web search` → `web_search`, `search_tools`, `web_fetch`, `search_memory`, `grep_search`, `edit_file` |
| Unlock | route: **search**; schema on a later call: yes; dropped from inventory: yes |
| Use | never called |

Wire over 3 turn(s): 10 → 14 → 14 schemas.

- turn 1: called search_tools; said nothing, finishReason=tool_calls
- turn 2: called web_fetch; said nothing, finishReason=tool_calls
- turn 3: called (nothing); said "The latest stable major version of `zod` on npm is **4** — the `latest` tag currently points to `zod@4.6.1`, fetched dir", finishReason=stop

> the model never called it after unlocking it

## `edit_file`

**PASS  · inventory ok · search ok (select) · schema ok · called 1x**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 1 call(s): `select:edit_file` → `edit_file` |
| Unlock | route: **select**; schema on a later call: yes; dropped from inventory: yes |
| Use | ok |

Wire over 6 turn(s): 10 → 11 → 11 → 11 → 11 → 11 schemas.

- turn 1: called search_tools, grep_search; said nothing, finishReason=tool_calls
- turn 2: called file_view; said nothing, finishReason=tool_calls
- turn 3: called file_view; said nothing, finishReason=tool_calls
- turn 4: called edit_file; said nothing, finishReason=tool_calls
- turn 5: called grep_search; said nothing, finishReason=tool_calls
- turn 6: called (nothing); said "Done in a single `edit_file` call with two blocks: `timeout: 30` → `timeout: 45` (line 2) and `retries: 3` → `retries: 5", finishReason=stop


## `delete_file`

**UNMET · inventory ok · search MISS · schema MISS · not called**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | never called |
| Unlock | route: **missing**; schema on a later call: **no**; dropped from inventory: **no** |
| Use | never called |

Wire over 3 turn(s): 10 → 10 → 10 schemas.

- turn 1: called grep_search, list_directory; said nothing, finishReason=tool_calls
- turn 2: called bash; said "Grep across the workspace found \"obsolete\" only in `.reaper` logs — no source imports. Deleting:", finishReason=tool_calls
- turn 3: called (nothing); said "Deleted `src/obsolete.ts`. Verified first: a workspace-wide grep for \"obsolete\" matched nothing under `src/` (only `.rea", finishReason=stop

> **Not exercised by this scenario.** The mechanism was never reached, so this run says nothing about it — neither pass nor fail. Making the task one core tools cannot answer is what turns this into a real test.

## `file_find`

**PASS  · inventory ok · search ok (select) · schema ok · called 5x**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 1 call(s): `select:file_find` → `file_find` |
| Unlock | route: **select**; schema on a later call: yes; dropped from inventory: yes |
| Use | ok, ok, ok, ok, ok |

Wire over 7 turn(s): 10 → 11 → 11 → 11 → 11 → 11 → 11 schemas.

- turn 1: called search_tools; said "I'll unlock the single-file pattern-jump tool (`file_find`) first.", finishReason=tool_calls
- turn 2: called file_find; said nothing, finishReason=tool_calls
- turn 3: called file_find; said "`handleRequest` (line 6001) trims input, calls `validatePayload`. Jumping to the next function:", finishReason=tool_calls
- turn 4: called file_find; said "`validatePayload` trims again — the first trim was redundant — and delegates to `normalizeInput`.", finishReason=tool_calls
- turn 5: called file_find; said nothing, finishReason=tool_calls
- turn 6: called file_find; said nothing, finishReason=tool_calls
- turn 7: called (nothing); said "Chain traced entirely via `file_find` pattern jumps (no paging through the file). All five functions are one-liners, eac", finishReason=stop


## `diagnostics`

**PASS  · inventory ok · search ok (select) · schema ok · called 1x**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 1 call(s): `select:diagnostics` → `diagnostics` |
| Unlock | route: **select**; schema on a later call: yes; dropped from inventory: yes |
| Use | ok |

Wire over 3 turn(s): 10 → 11 → 11 schemas.

- turn 1: called search_tools; said nothing, finishReason=tool_calls
- turn 2: called diagnostics; said nothing, finishReason=tool_calls
- turn 3: called (nothing); said "Diagnostics (tsc) ran on `src/broken.ts` — 1 error, not fixed per your instruction:\n\n- **Line 1, col 14 — TS2322**: `Typ", finishReason=stop


## `apply_patch_edit`

**PASS  · inventory ok · search ok (select) · schema ok · called 1x**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 1 call(s): `select:apply_patch_edit` → `apply_patch_edit` |
| Unlock | route: **select**; schema on a later call: yes; dropped from inventory: yes |
| Use | ok |

Wire over 3 turn(s): 10 → 11 → 11 schemas.

- turn 1: called search_tools; said nothing, finishReason=tool_calls
- turn 2: called apply_patch_edit; said nothing, finishReason=tool_calls
- turn 3: called (nothing); said "Applied. Both files modified as specified: `src/a.ts` → `export const a = 2;` and `src/b.ts` → `export const b = 2;` (1 ", finishReason=stop


## `scratchpad`

**PASS  · inventory ok · search ok (select) · schema ok · called 2x**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 1 call(s): `select:scratchpad` → `scratchpad` |
| Unlock | route: **select**; schema on a later call: yes; dropped from inventory: yes |
| Use | ok, ok |

Wire over 4 turn(s): 10 → 11 → 11 → 11 schemas.

- turn 1: called search_tools; said nothing, finishReason=tool_calls
- turn 2: called scratchpad; said nothing, finishReason=tool_calls
- turn 3: called scratchpad; said nothing, finishReason=tool_calls
- turn 4: called (nothing); said "Saved and read back from `.reaper/memory/scratch.md`:\n\n> **API config**\n> API base URL: https://api.example.test. Stagin", finishReason=stop


## `job`

**PASS  · inventory ok · search ok (select) · schema ok · called 1x**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 1 call(s): `select:job` → `job` |
| Unlock | route: **select**; schema on a later call: yes; dropped from inventory: yes |
| Use | ok |

Wire over 4 turn(s): 10 → 11 → 11 → 11 schemas.

- turn 1: called search_tools; said nothing, finishReason=tool_calls
- turn 2: called bash; said nothing, finishReason=tool_calls
- turn 3: called job; said nothing, finishReason=tool_calls
- turn 4: called (nothing); said "Watch is running (PID 1745793), printing the timestamp every second. First poll shows three lines so far: `14:12:48`, `1", finishReason=stop


## `search_memory`

**UNMET · inventory ok · search MISS · schema MISS · not called**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | never called |
| Unlock | route: **missing**; schema on a later call: **no**; dropped from inventory: **no** |
| Use | never called |

Wire over 4 turn(s): 10 → 10 → 10 → 10 schemas.

- turn 1: called (nothing); said nothing, finishReason=stop
- turn 2: called (nothing); said nothing, finishReason=stop
- turn 3: called (nothing); said nothing, finishReason=stop
- turn 4: called (nothing); said nothing, finishReason=stop

> **Not exercised by this scenario.** The mechanism was never reached, so this run says nothing about it — neither pass nor fail. Making the task one core tools cannot answer is what turns this into a real test.

## `activate_skill`

**PASS  · inventory ok · search ok (select) · schema ok · called 1x (errored)**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 2 call(s): `select:activate_skill` → `activate_skill`; `select:skill_manager` → `skill_manager` |
| Unlock | route: **select**; schema on a later call: yes; dropped from inventory: yes |
| Use | failed (Skill 'github' is not registered in the SkillMemoryRegistry. Only skills registered in the registry may be activated.) |

Wire over 5 turn(s): 10 → 11 → 11 → 12 → 12 schemas.

- turn 1: called search_tools; said nothing, finishReason=tool_calls
- turn 2: called activate_skill; said nothing, finishReason=tool_calls
- turn 3: called search_tools; said nothing, finishReason=tool_calls
- turn 4: called list_directory; said nothing, finishReason=tool_calls
- turn 5: called (nothing); said "Blocked: the `github` skill can't be activated here.\n\n`activate_skill(\"github\")` returned: *\"Skill 'github' is not regis", finishReason=stop

> Not fully exercisable here: built-in skill bodies are deleted from this build, so nothing is activatable.

## `skill_manager`

**PASS  · inventory ok · search ok (search) · schema ok · called 3x**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 1 call(s): `skill manager create draft` → `skill_manager`, `hook_manager`, `extension_manager`, `activate_skill`, `create_checkpoint`, `write_file` |
| Unlock | route: **search**; schema on a later call: yes; dropped from inventory: yes |
| Use | ok, ok, ok |

Wire over 9 turn(s): 10 → 15 → 15 → 15 → 15 → 15 → 15 → 15 → 15 schemas.

- turn 1: called search_tools; said nothing, finishReason=tool_calls
- turn 2: called skill_manager; said nothing, finishReason=tool_calls
- turn 3: called skill_manager; said nothing, finishReason=tool_calls
- turn 4: called list_directory; said nothing, finishReason=tool_calls
- turn 5: called list_directory; said nothing, finishReason=tool_calls
- turn 6: called skill_manager; said "The first (failed-looking) call actually left a draft at the user-level drafts dir. I'll remove it and recreate cleanly.", finishReason=tool_calls
- turn 7: called bash; said nothing, finishReason=tool_calls
- turn 8: called bash; said nothing, finishReason=tool_calls
- turn 9: called (nothing); said nothing

> Not fully exercisable here: the trust-promoting actions are approval-gated; only `create` is reachable unattended.

## `extension_manager`

**PASS  · inventory ok · search ok (select) · schema ok · called 2x**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 1 call(s): `select:extension_manager` → `extension_manager` |
| Unlock | route: **select**; schema on a later call: yes; dropped from inventory: yes |
| Use | ok, ok |

Wire over 4 turn(s): 10 → 11 → 11 → 11 schemas.

- turn 1: called search_tools; said nothing, finishReason=tool_calls
- turn 2: called extension_manager; said nothing, finishReason=tool_calls
- turn 3: called extension_manager; said nothing, finishReason=tool_calls
- turn 4: called (nothing); said "Draft extension `hello-world` created.\n\n- Location: `.reaper/extensions/hello-world/` (`extension.json` + `main.js`)\n- V", finishReason=stop

> Not fully exercisable here: trust and enable are approval-gated; only `create` is reachable unattended.

## `hook_manager`

**PASS  · inventory ok · search ok (select) · schema ok · called 1x**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 1 call(s): `select:hook_manager` → `hook_manager` |
| Unlock | route: **select**; schema on a later call: yes; dropped from inventory: yes |
| Use | ok |

Wire over 3 turn(s): 10 → 11 → 11 schemas.

- turn 1: called search_tools; said nothing, finishReason=tool_calls
- turn 2: called hook_manager; said nothing, finishReason=tool_calls
- turn 3: called (nothing); said "Draft created: `log-file-write` (`.reaper/hooks/log-file-write.json`).\n\n- Event: **FileChanged** — the closest supported", finishReason=stop

> Not fully exercisable here: approve is approval-gated; only `create` is reachable unattended.

## `browser_control`

**PASS  · inventory ok · search ok (select) · schema ok · called 2x**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | 1 call(s): `select:browser_control` → `browser_control` |
| Unlock | route: **select**; schema on a later call: yes; dropped from inventory: yes |
| Use | ok, ok |

Wire over 4 turn(s): 10 → 11 → 11 → 11 schemas.

- turn 1: called search_tools; said nothing, finishReason=tool_calls
- turn 2: called browser_control; said nothing, finishReason=tool_calls
- turn 3: called browser_control; said nothing, finishReason=tool_calls
- turn 4: called (nothing); said "Done. Loaded https://example.com (title: \"Example Domain\") and captured a 1280×900 screenshot:\n\n`/tmp/reaper-phase2-Q27f", finishReason=stop

> Not fully exercisable here: needs a Playwright browser session, which this headless harness does not provide.

## `eval`

**UNMET · inventory ok · search MISS · schema MISS · not exercised**

| Stage | Result |
| --- | --- |
| Inventory (listed / schema withheld) | yes / yes — first call carried 10 schemas and named 20 deferred tools |
| Search | never called |
| Unlock | route: **missing**; schema on a later call: **no**; dropped from inventory: **no** |
| Use | never called |

Wire over 4 turn(s): 10 → 10 → 10 → 10 schemas.

- turn 1: called (nothing); said nothing, finishReason=stop
- turn 2: called (nothing); said nothing, finishReason=stop
- turn 3: called (nothing); said nothing, finishReason=stop
- turn 4: called (nothing); said nothing, finishReason=stop

> Not fully exercisable here: pulled from this round at the user's request; the tool is being rebuilt later.
> **Not exercised by this scenario.** The mechanism was never reached, so this run says nothing about it — neither pass nor fail. Making the task one core tools cannot answer is what turns this into a real test.
