# Pi-vs-Reaper Coding-Agent Feature Gap Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Bring Reaper closer to the latest Pi Coding Agent (`@earendil-works/pi-coding-agent@0.80.2`) by implementing Pi features Reaper lacks or only partially covers, with priority on repo/resource handling, session continuity, extension/package management, compaction, and tool robustness.

**Architecture:** Reaper should keep its Codex-style single main-agent ownership model, but borrow Pi's mature supporting subsystems: repo-scoped resource discovery with trust, session tree/fork/resume semantics, package-backed extensions/skills/prompts, model-aware tool outputs, robust path/source parsing, and session compaction. The work should be delivered as dependency-gated PRs, each preserving Reaper's recent stress harness and not reintroducing over-blocking graph control.

**Tech Stack:** TypeScript/Node, Reaper runtime (`src/runtime`), tools (`src/tools`), context (`src/context`), extensions (`src/extensions`), config/model providers, Node test runner via `scripts/run-node-tests.mjs`.

---

## Source Baseline Used

### Latest Pi source inspected

The local Pi mono checkout had no usable `origin`, so I pulled the latest published package explicitly:

```bash
npm view @earendil-works/pi-coding-agent version dist.tarball --json
# latest: 0.80.2
npm pack @earendil-works/pi-coding-agent@0.80.2
```

Extracted source/runtime path used for comparison:

```text
/tmp/pi-coding-agent-latest/package
```

Key Pi files inspected:

- `dist/core/package-manager.js` / local source `packages/coding-agent/src/core/package-manager.ts`
- `dist/utils/git.js`
- `dist/utils/paths.js`
- `dist/core/resource-loader.js`
- `dist/core/project-trust.js`
- `dist/core/trust-manager.js`
- `dist/core/session-manager.js`
- `dist/core/agent-session-runtime.js`
- `dist/core/compaction/compaction.js`
- `dist/core/extensions/types.d.ts`
- `dist/core/tools/{read,bash,edit,file-mutation-queue,index}.js`
- `dist/core/output-guard.js`

### Reaper source inspected

Canonical repo:

```text
/workspace/reapercode-main
```

Current head during planning:

```text
df1df3e fix(runtime): allow final no-tool summaries to terminate (#43)
```

Key Reaper files inspected:

- `src/runtime/engine.ts`
- `src/runtime/main-agent-prompt.ts`
- `src/runtime/main-agent-node.ts`
- `src/tools/executor.ts`
- `src/tools/registry.ts`
- `src/extensions/{package,loader,registry,lifecycle,types}.ts`
- `src/context/session-summary.ts`
- `src/context/compaction/reactive-compact.ts`
- `src/context/history-compaction.ts`
- `src/hooks/{lifecycle,sandbox}.ts`

---

## Executive Summary: What Pi Has That Reaper Is Missing

Pi is not just a model loop. It has a mature *coding-agent platform layer* around the loop. Reaper now has a strong main-agent loop, but Pi is ahead in these supporting systems:

1. **Package/repo-backed resource manager** for extensions, skills, prompts, and themes.
2. **Project trust model** before loading project-local settings/resources/extensions.
3. **Robust git/package source handler** supporting `npm:`, `git:`, `github:`, `https:`, `ssh:`, local paths, refs, dedupe, updates, and safe path roots.
4. **Resource precedence and collision model**: project local > project auto > user local > user auto > package resources.
5. **Session tree with durable IDs, fork, branch summaries, import/export, and resume/new switching hooks.**
6. **Model-driven session compaction with token-aware cut points and file-operation preservation.**
7. **Extension runtime API** with lifecycle events, UI hooks, commands, keybindings, custom tools, before/after provider hooks, before/after tool hooks, compaction hooks, and project trust hooks.
8. **Tool output UX/robustness**: streaming bash updates, full-output spill files, image reads/resizing, exact multi-edit patches, per-file mutation queues, model-aware image omission, stdout backpressure guard.
9. **Global/session package settings and update flows** for installed agent resources.
10. **Prompt/resources loading from ancestor context files** (`AGENTS.md`, `CLAUDE.md`) with project trust gating and source attribution.

Reaper has partial analogues for several of these (extensions, hooks, session summary, compaction, background processes, MCP, checkpoints), but they are more bespoke and less integrated than Pi's platform layer.

---

## Gap Matrix

| Pi capability | Pi evidence | Reaper status | Missing in Reaper | Priority |
|---|---|---|---|---|
| Package/resource manager | `core/package-manager.js`, `utils/git.js` | Extension authoring exists; no package manager | No npm/git/local package source install/update/list/resolve for skills/extensions/prompts | P0 |
| Latest repo/source handler | `parseGitUrl`, safe refs, `git@host:path@ref`, https/ssh/git URL parsing | No equivalent package source parser | Need robust source parser + safe install roots + update checks | P0 |
| Project trust | `project-trust.js`, `trust-manager.js` | Extension/hook trust exists, but no whole-project trust gate | Project `.reaper` resources can be loaded without unified trust decision | P0 |
| Resource precedence | `resourcePrecedenceRank()` | Reaper loads registries ad hoc | No deterministic precedence for project/user/package resources | P0 |
| Context file loading | `resource-loader.js` loads global + ancestors `AGENTS.md`/`CLAUDE.md` | Cockpit has repo snapshot and skills; no uniform ancestor loader | Need `.reaper` + AGENTS/CLAUDE/appended system prompt loading with source info | P1 |
| Session tree/fork/resume | `session-manager.js`, `agent-session-runtime.js` | Run dirs and session summary exist | No durable conversation tree, fork-at-message, branch summaries, import/export | P1 |
| Compaction | `core/compaction/compaction.js` | Heuristic session summary + reactive compact | No model-generated branch/session summary with token cut points and file operation details | P1 |
| Extension API | `extensions/types.d.ts` | Extensions/tools/hooks exist | Much narrower API: no UI, commands/keybindings, project_trust event, compaction/provider hooks | P1 |
| Tool UX and robustness | Pi read/bash/edit implementations | Reaper tools are capable but different | Missing image read, multi-edit exact replacements, per-file mutation queue, streaming bash partial updates, stdout backpressure guard | P1/P2 |
| Settings/packages | `settings-manager`, package settings | Config exists | No user/project package settings with install/update/remove/list | P1 |
| Package resource filters | package manager patterns `!`, `+`, `-` | none | Need include/exclude/force include/exclude per package resource type | P2 |
| Cloud-sync ignore | `markPathIgnoredByCloudSync` | no analogue | Optional quality improvement for managed install dirs | P3 |
| TUI/RPC UI extension surface | `ExtensionUIContext` | Reaper runtime/API focus, not TUI | Out of scope unless Reaper gets interactive UI | P3 |

---

## Design Principles

1. **Do not reintroduce deterministic control over the coding loop.** Pi's platform features should support the main agent, not replace it.
2. **Trust-gate project-local executable resources.** Project `.reaper/extensions`, hooks, package-installed code, and prompt append files must be disabled until trusted.
3. **Package manager is infrastructure, not a model tool first.** Implement a typed internal package/resource resolver first; expose model tools only after tests and trust gates.
4. **Prefer permissive coding-agent behavior after resources are trusted.** Do not add over-blocking gates in the runtime loop.
5. **Every phase gets targeted tests plus one stress run where relevant.**
6. **Keep PRs small.** This should be 6–8 PRs, not a single platform mega-PR.

---

## Proposed Implementation Tiers

### Tier 0 — Safety and scaffolding

Goal: create the foundational types and tests without changing runtime behavior.

Deliverables:

- New internal package/resource manager module skeleton.
- Source parser tests covering latest Pi repo-handler behavior.
- Project trust model types/store, not yet enforced.

### Tier 1 — Project trust + resource resolver

Goal: match Pi's core repo/resource handling.

Deliverables:

- `src/resources/source-parser.ts`
- `src/resources/package-manager.ts`
- `src/resources/resource-loader.ts`
- `src/resources/project-trust.ts`
- deterministic precedence and collision diagnostics
- project trust enforced before project-local executable resources load

### Tier 2 — Session tree/fork/resume + compaction

Goal: make Reaper continuation more Codex/Pi-like across sessions.

Deliverables:

- durable session JSONL with entry IDs and parent IDs
- resume/new/fork APIs
- branch summaries and model-generated compaction
- integration into `main-agent-prompt.ts` cockpit

### Tier 3 — Extension API and package-installed resources

Goal: let Reaper load installed packages that contribute extensions/skills/prompts safely.

Deliverables:

- package install/update/list/remove flows
- package `reaper` manifest support mirroring Pi's `pi` manifest
- resource filters and precedence
- extension lifecycle events: project trust, session start/shutdown, before/after tool, before/after model, compaction

### Tier 4 — Tool robustness parity

Goal: improve Reaper's base coding tools using Pi patterns.

Deliverables:

- per-file mutation queue for write/edit/delete operations
- multi-edit exact replacement tool support
- image-aware `read_file` or new `read` compatibility alias
- streaming/partial shell updates in trajectory
- output spill files and better tool output summaries

### Tier 5 — Stress/eval upgrade

Goal: prove these features improve Reaper as a coding agent.

Deliverables:

- package/resource fixture tests
- project trust fixture tests
- session fork/resume tests
- Reaper stress suite additions for package resource loading and session continuation
- 3x full coding-agent stress target once provider is stable

---

# Detailed Plan

## Task 1: Add Pi-compatible source parser tests first

**Objective:** Pin latest Pi package/repo handler behavior before implementing Reaper's equivalent.

**Files:**

- Create: `tests/unit/resource-source-parser.test.ts`
- Create: `src/resources/source-parser.ts`

**Step 1: Write failing tests**

Test cases based on Pi `0.80.2`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseResourceSource } from "../../src/resources/source-parser.js";

test("parseResourceSource parses npm packages", () => {
  assert.deepEqual(parseResourceSource("npm:@scope/pkg@1.2.3"), {
    type: "npm",
    spec: "@scope/pkg@1.2.3",
    name: "@scope/pkg",
    version: "1.2.3",
    pinned: true,
  });
});

test("parseResourceSource parses git URLs with refs", () => {
  assert.deepEqual(parseResourceSource("git:github.com/acme/reaper-tools@main"), {
    type: "git",
    repo: "https://github.com/acme/reaper-tools",
    host: "github.com",
    path: "acme/reaper-tools",
    ref: "main",
    pinned: true,
  });
});

test("parseResourceSource rejects unsafe git install parts", () => {
  assert.equal(parseResourceSource("git:github.com/acme/../evil"), null);
  assert.equal(parseResourceSource("git:github.com/acme/reaper\\evil"), null);
});

test("parseResourceSource treats file URLs and bare paths as local", () => {
  assert.equal(parseResourceSource("./.reaper/extensions/foo")?.type, "local");
  assert.equal(parseResourceSource("file:///tmp/reaper-ext")?.type, "local");
});
```

**Step 2: Run expected failing test**

```bash
cd /workspace/reapercode-main
node scripts/run-node-tests.mjs tests/unit/resource-source-parser.test.ts
```

Expected: fail because module does not exist.

**Step 3: Implement minimal parser**

`src/resources/source-parser.ts` should implement:

- `npm:` parsing
- npm scoped name/version parsing
- `git:` parsing with Pi-compatible shorthand
- `https://`, `ssh://`, `git://`, and scp-like parsing
- `file://`, `~`, relative, absolute local paths
- unsafe part rejection:
  - NUL
  - backslash
  - path starts with `/` inside git host/path parts
  - `..` path segment
  - decoded URL unsafe equivalent

**Step 4: Run tests**

```bash
node scripts/run-node-tests.mjs tests/unit/resource-source-parser.test.ts
npm run typecheck
```

---

## Task 2: Add project trust store and decision API

**Objective:** Add a unified project-level trust gate before loading project-local resources.

**Files:**

- Create: `src/resources/project-trust.ts`
- Create: `tests/unit/project-trust.test.ts`
- Modify: `src/config/model-config.ts` only if config needs a `defaultProjectTrust` field

**Design:**

Reaper already has extension/hook trust, but Pi gates *project resources as a group* before loading `.pi/settings`, `.pi/extensions`, etc. Reaper should gate `.reaper/settings.json`, `.reaper/extensions`, `.reaper/skills`, `.reaper/prompts`, `.reaper/hooks` similarly.

Add:

```ts
export type ProjectTrustDecision = "trusted" | "untrusted" | "session";

export interface ProjectTrustStoreEntry {
  workspaceRoot: string;
  trusted: boolean;
  updatedAt: number;
}

export class ProjectTrustStore {
  static create(userHome: string): ProjectTrustStore;
  get(workspaceRoot: string): boolean | null;
  set(workspaceRoot: string, trusted: boolean): void;
  setMany(entries: ProjectTrustStoreEntry[]): void;
}

export function hasTrustRequiringProjectResources(workspaceRoot: string): boolean;
```

Trust-requiring resources:

- `.reaper/settings.json`
- `.reaper/extensions/**`
- `.reaper/hooks/**`
- `.reaper/packages/**`
- `.reaper/prompts/**`
- `.reaper/skills/**` if skills can contain executable references/scripts

**Tests:**

- no `.reaper` resources => trusted by default
- project extension exists => trust required
- remembered trusted project returns true
- default `never` returns false without UI
- session-only trust does not persist

**Verification:**

```bash
node scripts/run-node-tests.mjs tests/unit/project-trust.test.ts
npm run typecheck
```

---

## Task 3: Implement Reaper resource precedence and loader

**Objective:** Load skills/extensions/prompts from project, user, and package resources with deterministic precedence.

**Files:**

- Create: `src/resources/types.ts`
- Create: `src/resources/resource-loader.ts`
- Create: `tests/unit/resource-loader.test.ts`
- Modify: `src/extensions/registry.ts`
- Modify: `src/context/skills.ts`

**Pi behavior to mirror:**

Resource precedence:

1. project settings local resource
2. project auto-discovered resource
3. user settings local resource
4. user auto-discovered resource
5. package resource

Represent as:

```ts
export type ResourceScope = "project" | "user" | "temporary";
export type ResourceKind = "extensions" | "skills" | "prompts";

export interface ResourceMetadata {
  source: string;
  scope: ResourceScope;
  origin: "package" | "top-level" | "auto";
  baseDir?: string;
}

export interface ResolvedResource {
  path: string;
  enabled: boolean;
  metadata: ResourceMetadata;
}
```

Loader should discover:

- project: `<workspaceRoot>/.reaper/extensions`, `.reaper/skills`, `.reaper/prompts`
- user: `<home>/.reaper/extensions`, `.reaper/skills`, `.reaper/prompts`
- package-installed resources from Task 5
- ancestor context files: `AGENTS.md`, `CLAUDE.md`, optionally `.reaper/APPEND_SYSTEM.md`

Collision rule:

- first resource by precedence wins
- lower-precedence resource is reported as disabled/collided, not silently hidden

**Tests:**

- project extension beats user extension with same id/name
- package skill is available only if no project/user skill shadows it
- disabled/collided diagnostics include source paths
- ignore files `.gitignore`, `.ignore`, `.fdignore` are respected for auto-discovery

---

## Task 4: Add package manager for Reaper resources

**Objective:** Match Pi's `npm:` / `git:` / local package install/update/remove/list flow for Reaper resource packages.

**Files:**

- Create: `src/resources/package-manager.ts`
- Create: `tests/unit/resource-package-manager.test.ts`
- Modify: `src/tools/types/extension-tools.schema.ts` or add `src/tools/types/package-tools.schema.ts`
- Modify: `src/tools/registry.ts`
- Modify: `src/tools/executor.ts`

**Managed install roots:**

```text
user npm:     ~/.reaper/packages/npm/node_modules/<pkg>
user git:     ~/.reaper/packages/git/<host>/<owner>/<repo>
project npm:  <workspace>/.reaper/packages/npm/node_modules/<pkg>
project git:  <workspace>/.reaper/packages/git/<host>/<owner>/<repo>
temporary:    ~/.reaper/tmp/packages/<hash>/...
```

Safety rules copied from Pi:

- project install requires project trust
- managed path resolution must reject path escape
- created install roots get `.gitignore` containing:
  ```text
  *
  !.gitignore
  ```
- parse local paths relative to user/project base depending on scope
- dedupe packages by identity:
  - npm: package name
  - git: host/path, ignoring ref for identity
  - local: resolved absolute path
- project packages beat user packages

Package manifest:

Use `package.json` field `reaper` analogous to Pi's `pi`:

```json
{
  "reaper": {
    "extensions": ["extensions/foo/index.js"],
    "skills": ["skills/reaper-dev-loop/SKILL.md"],
    "prompts": ["prompts/ship.md"]
  }
}
```

Model-callable tools to add after internal tests:

- `install_package`
- `remove_package`
- `list_packages`
- `update_packages`
- `reload_resources`

Human approval/trust:

- `install_package` project-local requires project trust or approval
- `remove_package` requires approval
- `update_packages` user-scope can run; project-scope requires trust

**Tests:**

Use fake filesystem and fake command runner rather than real npm/git.

Cases:

- `npm:@scope/pkg@1.0.0` installs to managed npm root
- `git:github.com/acme/reaper-pack@main` clones to managed git root
- local package resolves resources without copy
- package manifest filters resources
- package source dedupe works
- unsafe git path rejected
- project untrusted blocks install/load

---

## Task 5: Integrate project trust/resource loading into runtime bootstrap

**Objective:** Ensure Reaper only loads trusted project-local resources and shows diagnostics in the cockpit.

**Files:**

- Modify: `src/runtime/bootstrap.ts`
- Modify: `src/runtime/content-prep.ts`
- Modify: `src/runtime/main-agent-prompt.ts`
- Modify: `src/runtime/extension-wiring.ts`
- Add tests: `tests/integration/project-resource-trust.test.ts`

**Behavior:**

At runtime start:

1. Detect trust-requiring project resources.
2. Resolve trust decision.
3. If untrusted:
   - do not load project extensions/hooks/packages/prompts
   - still load safe context file names only if configured as safe, or include as untrusted data block
   - add cockpit warning:
     ```text
     Project resources exist but are not trusted; project extensions/hooks/packages/prompts were not loaded.
     ```
4. If trusted:
   - load resources through `ResourceLoader`
   - wire extension tools
   - append trusted prompt/context sections with source info

**Tests:**

- untrusted project extension does not add tool
- trusted project extension adds tool
- untrusted project prompt not appended to system prompt as instruction
- diagnostics appear in cockpit

---

## Task 6: Add session tree and fork/resume semantics

**Objective:** Bring Reaper closer to Pi's durable session graph and Codex-style continuation.

**Files:**

- Create: `src/session/session-manager.ts`
- Create: `src/session/session-runtime.ts`
- Create: `tests/unit/session-manager.test.ts`
- Modify: `src/runtime/run-manager.ts`
- Modify: `src/runtime/engine.ts`
- Modify: connection/request schemas if needed

**Data model inspired by Pi:**

```ts
export interface SessionEntryBase {
  id: string;
  parentId?: string | null;
  timestamp: string;
}

export type SessionEntry =
  | ({ type: "session"; version: 1; cwd: string } & SessionEntryBase)
  | ({ type: "message"; role: "user" | "assistant" | "tool" | "custom"; content: unknown } & SessionEntryBase)
  | ({ type: "compaction"; summary: string; firstKeptEntryId: string; tokensBefore: number } & SessionEntryBase)
  | ({ type: "branch_summary"; fromId: string; summary: string } & SessionEntryBase)
  | ({ type: "model_change"; provider: string; modelId: string } & SessionEntryBase);
```

Required APIs:

- `createSession(cwd)`
- `openSession(path)`
- `appendEntry(entry)`
- `buildSessionContext(leafId?)`
- `forkBefore(entryId)`
- `forkAt(entryId)`
- `importJsonl(path)`
- `exportJsonl(path)`

**Why:**

Current Reaper has run directories and session summaries, but not a first-class conversation tree. Pi's branch/fork lets a coding agent resume at a previous user prompt or fork a completed run cleanly. That directly supports Gowtham's requirement: after a final no-tool summary, the next user prompt should continue with session history rather than forcing the old task to continue.

**Tests:**

- linear context returns all entries
- fork before user message creates new leaf with selected text
- compaction entry emits summary then kept messages
- branch summary appears in context
- malformed JSONL lines are skipped, not fatal

---

## Task 7: Upgrade Reaper compaction to Pi-style model summaries

**Objective:** Replace/augment heuristic session summary with token-aware model compaction that preserves files/decisions/failures.

**Files:**

- Create: `src/context/compaction/session-compaction.ts`
- Modify: `src/context/session-summary.ts`
- Modify: `src/runtime/engine.ts`
- Add: `tests/unit/session-compaction.test.ts`

**Pi features to mirror:**

- trigger when context tokens exceed `contextWindow - reserveTokens`
- keep recent tokens window
- find valid cut points at user/assistant/custom/tool boundaries
- generate summary with:
  - user objective
  - decisions
  - files read/edited
  - commands run and verification status
  - failed attempts and why
  - open TODOs
- store `tokensBefore`, `firstKeptEntryId`, `details.readFiles`, `details.modifiedFiles`

**Reaper-specific design:**

- use existing `ModelGateway` for summary generation
- fallback to existing heuristic `summarizeSessionForCompaction` if model call fails
- render compaction summary into `Session Summary` cockpit section
- never use compaction to force graph routing

**Tests:**

- compaction triggers at threshold
- summary includes read/edited files from tool results
- recent messages retained
- failed model summary falls back to heuristic
- cockpit includes compaction summary

---

## Task 8: Expand extension lifecycle API toward Pi

**Objective:** Make Reaper extensions able to participate in lifecycle events safely.

**Files:**

- Modify: `src/extensions/types.ts`
- Modify: `src/extensions/lifecycle.ts`
- Modify: `src/extensions/hook-runner.ts`
- Modify: `src/runtime/extension-wiring.ts`
- Add: `tests/unit/extension-lifecycle.test.ts`

**Add events inspired by Pi:**

```ts
export type ReaperExtensionEvent =
  | { type: "project_trust"; workspaceRoot: string }
  | { type: "session_start"; reason: "new" | "resume" | "fork"; previousSessionFile?: string }
  | { type: "session_before_switch"; reason: "new" | "resume" | "fork"; targetSessionFile?: string }
  | { type: "session_shutdown"; reason: string; targetSessionFile?: string }
  | { type: "before_model_request"; role: string; source: string }
  | { type: "after_model_response"; role: string; source: string; usage?: unknown }
  | { type: "before_tool_call"; toolName: string; args: unknown }
  | { type: "after_tool_call"; toolName: string; result: unknown }
  | { type: "before_compaction"; tokens: number }
  | { type: "after_compaction"; summary: string };
```

Rules:

- untrusted project extensions do not receive lifecycle events
- event handler failures are logged as diagnostics, not fatal
- `project_trust` handlers may suggest trust decision only if user has configured them globally/trusted
- no extension event may silently mutate Reaper state without explicit API

**Tests:**

- events fire once per lifecycle action
- extension failure produces diagnostic
- untrusted project extension does not fire
- before_model_request can annotate metadata but not change prompt unless explicitly allowed

---

## Task 9: Add package resource filter syntax

**Objective:** Support Pi-style include/exclude filters for package resources.

**Files:**

- Modify: `src/resources/package-manager.ts`
- Modify: `src/resources/resource-loader.ts`
- Add tests: `tests/unit/resource-package-filter.test.ts`

**Filter syntax:**

- plain pattern: include matching paths
- `!pattern`: exclude matching paths
- `+path`: force include exact path
- `-path`: force exclude exact path
- empty array: disable all resources of that type

Settings shape:

```json
{
  "packages": [
    {
      "source": "npm:@acme/reaper-pack",
      "extensions": ["worker-*", "!dangerous-*", "+extensions/safe/index.js"],
      "skills": [],
      "prompts": ["ship.md"]
    }
  ]
}
```

Tests should mirror Pi's `applyPatterns` behavior.

---

## Task 10: Add per-file mutation queue for Reaper write tools

**Objective:** Prevent parallel edit/write/delete calls from racing on the same file while allowing different files to mutate concurrently.

**Files:**

- Create: `src/tools/write/file-mutation-queue.ts`
- Modify:
  - `src/tools/write/write-file.ts`
  - `src/tools/write/replace-in-file.ts`
  - `src/tools/write/edit-file.ts`
  - `src/tools/write/delete-file.ts`
  - `src/tools/write/replace-symbol.ts`
- Add: `tests/unit/file-mutation-queue.test.ts`

**Design:**

Copy Pi's pattern:

- map realpath/resolved path to a promise chain
- serializes same-file operations
- leaves different files parallel
- missing files use resolved path key
- queue entry removed after final operation

**Tests:**

- two writes to same file execute in order
- two writes to different files run concurrently
- queue cleans up after failure
- symlinked same real path serializes

---

## Task 11: Add multi-edit exact replacement compatibility

**Objective:** Give Reaper a Pi-style exact multi-edit tool to reduce model friction and patch chatter.

**Files:**

- Modify: `src/tools/types.ts` or add schema in `src/tools/types/edit-tools.schema.ts`
- Modify: `src/tools/write/replace-in-file.ts` or `src/tools/write/edit-file.ts`
- Add: `tests/unit/multi-edit.test.ts`

**Tool shape:**

```ts
{
  name: "edit_file",
  args: {
    path: "src/foo.ts",
    edits: [
      { oldText: "old one", newText: "new one" },
      { oldText: "old two", newText: "new two" }
    ]
  }
}
```

Rules:

- all `oldText` matched against original file
- each `oldText` must be unique
- no overlapping ranges
- preserve BOM and line endings
- return unified patch and first changed line
- support legacy single `oldString/newString` via argument normalization if compatible

---

## Task 12: Improve read and shell output parity

**Objective:** Borrow Pi's tool-output robustness without changing Reaper's core tool names.

**Files:**

- Modify: `src/tools/read/read-file.ts`
- Modify: `src/tools/global/run-shell-command.ts`
- Modify: `src/tools/read/get-tool-output.ts`
- Add tests:
  - `tests/unit/read-file-image.test.ts`
  - `tests/unit/shell-output-spillover.test.ts`
  - `tests/integration/shell-stream-updates.test.ts`

**Features:**

1. **Image-aware read:**
   - detect png/jpg/gif/webp
   - if current model supports images, attach image result metadata
   - if not, return clear note: image omitted because model lacks vision
2. **Large shell output spill:**
   - preserve current Reaper spillover behavior, but make path explicit and retrievable via `get_tool_output`
   - include truncation details: lines, bytes, fullOutputPath
3. **Partial shell updates:**
   - emit trajectory `tool_update` events for long-running commands
   - throttle to ~100ms like Pi
   - ensure final result includes full/spilled output
4. **Backpressure:**
   - add safe output write queue if Reaper CLI/JSON mode writes raw stdout

---

## Task 13: Add prompt/resource loading from ancestors

**Objective:** Let Reaper load context files like Pi: global then ancestor `AGENTS.md` / `CLAUDE.md`, with source attribution and trust boundaries.

**Files:**

- Create: `src/resources/context-files.ts`
- Modify: `src/runtime/content-prep.ts`
- Modify: `src/runtime/main-agent-prompt.ts`
- Add: `tests/unit/context-files.test.ts`

**Behavior:**

- load global `~/.reaper/AGENTS.md` / `CLAUDE.md`
- walk from workspace root upward to git root or filesystem root
- load `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`
- de-duplicate by real path
- project-local executable prompt append files require trust
- render with source paths and trust markers

**Important:**

This should not override current user prompt. It should be stable context in the cockpit.

---

## Task 14: Upgrade eval/stress harness for Pi-parity features

**Objective:** Prove imported features matter for Reaper as a coding agent.

**Files:**

- Modify: `reaper_eval/runtime/eval-lib.ts`
- Modify: `scripts/stress-reaper.ts`
- Add tasks to `reaper_eval/problem_sets/terminal-bench-reaper-tool-stress.json`

**New stress tasks:**

1. **Project context task**
   - repo has `AGENTS.md` with specific coding style/test command
   - Reaper should follow it
2. **Session continuation task**
   - first prompt fixes half and final summary stops
   - second prompt says "continue" and Reaper uses session history
3. **Package resource task**
   - install/use a local Reaper package providing a skill or extension
   - trust gate must be explicit in test harness
4. **Concurrent edits task**
   - model emits multiple file edits in one batch
   - per-file mutation queue prevents corruption
5. **Long-output shell task**
   - command emits huge logs
   - Reaper spills output and still uses failure evidence correctly

**Pass target:**

```text
5/5 existing stress tasks + new package/session/resource tasks pass in 3 consecutive full runs
```

---

## Implementation Order / PR Breakdown

### PR A — Source parser + project trust skeleton

Tasks: 1–2

Verification:

```bash
node scripts/run-node-tests.mjs tests/unit/resource-source-parser.test.ts tests/unit/project-trust.test.ts
npm run typecheck
git diff --check
```

### PR B — Resource loader + precedence

Task: 3

Verification:

```bash
node scripts/run-node-tests.mjs tests/unit/resource-loader.test.ts
npm run typecheck
git diff --check
```

### PR C — Package manager and package settings

Tasks: 4, 9

Verification:

```bash
node scripts/run-node-tests.mjs tests/unit/resource-package-manager.test.ts tests/unit/resource-package-filter.test.ts
npm run typecheck
git diff --check
```

### PR D — Runtime trust/resource integration

Task: 5

Verification:

```bash
node scripts/run-node-tests.mjs tests/integration/project-resource-trust.test.ts tests/unit/main-agent-prompt.test.ts
npm run typecheck
git diff --check
```

### PR E — Session tree + fork/resume

Task: 6

Verification:

```bash
node scripts/run-node-tests.mjs tests/unit/session-manager.test.ts tests/integration/main-agent-graph.test.ts
npm run typecheck
git diff --check
```

### PR F — Pi-style compaction

Task: 7

Verification:

```bash
node scripts/run-node-tests.mjs tests/unit/session-compaction.test.ts tests/unit/session-metrics.test.ts
npm run typecheck
git diff --check
```

### PR G — Extension lifecycle events

Task: 8

Verification:

```bash
node scripts/run-node-tests.mjs tests/unit/extension-lifecycle.test.ts tests/integration/project-resource-trust.test.ts
npm run typecheck
git diff --check
```

### PR H — Tool robustness parity

Tasks: 10–12

Verification:

```bash
node scripts/run-node-tests.mjs tests/unit/file-mutation-queue.test.ts tests/unit/multi-edit.test.ts tests/unit/shell-output-spillover.test.ts
npm run typecheck
git diff --check
```

### PR I — Context-file loading + stress upgrades

Tasks: 13–14

Verification:

```bash
node scripts/run-node-tests.mjs tests/unit/context-files.test.ts tests/integration/main-agent-graph.test.ts
npm run typecheck
source /workspace/.env && npx tsx scripts/stress-reaper.ts
git diff --check
```

---

## Risks and Tradeoffs

### Risk: importing Pi's platform layer could overcomplicate Reaper

Mitigation:

- keep package/resource/session systems modular
- do not wire every feature into the main loop at once
- add cockpit diagnostics rather than graph-control gates

### Risk: project trust breaks existing Reaper workflows

Mitigation:

- default to trusted only when no executable project resources exist
- provide `--approve` / config override later
- tests for untrusted diagnostics

### Risk: package manager can execute untrusted install scripts

Mitigation:

- project package installs require trust
- managed install roots are ignored and path-guarded
- use npm/git only through explicit install/update commands
- no automatic install unless user/project setting explicitly opts in and trusted

### Risk: session tree touches many runtime paths

Mitigation:

- first implement standalone manager and tests
- integrate into runtime only after stable
- keep existing run-dir result writing unchanged in first PR

### Risk: compaction summaries can hallucinate state

Mitigation:

- include structured file operation details from tool results
- preserve recent raw messages
- mark model-generated summaries as summaries, not facts
- never use compaction to decide graph routing directly

---

## Open Questions for Gowtham

1. Should Reaper package resources use `.reaper/settings.json` with a `packages` array like Pi, or should they live in the existing Reaper config schema?
2. Should project trust default be `ask`, `never`, or `always` for your Reaper dev machine?
3. Do you want Reaper to support Pi-compatible package manifests (`pi`) in addition to Reaper-native manifests (`reaper`) for reuse?
4. Should Reaper expose package management to the model as tools immediately, or keep it operator-only first?
5. Should the session tree become the primary state store, or initially only mirror existing trajectory/events?

---

## First Recommended Implementation Slice

Start with PR A:

```text
source parser + project trust skeleton
```

Why:

- directly addresses your "latest repo handler changes" concern
- low blast radius
- provides the foundation for package/resource loading
- can be verified without touching Reaper's main-agent stress loop

Then PR B/C can build resource/package resolution on top.

---

## Success Criteria

Reaper reaches Pi-parity baseline when:

1. It can install/list/update/remove resource packages from npm/git/local sources.
2. It can resolve project/user/package extensions/skills/prompts deterministically with trust and precedence.
3. It can resume/fork sessions with durable history and compact long sessions safely.
4. It can load trusted project context files and package-provided prompts without prompt-injection ambiguity.
5. It can run existing and new stress suites with package/session/context features passing.

Minimum validation target after all PRs:

```bash
npm run typecheck
node scripts/run-node-tests.mjs \
  tests/unit/resource-source-parser.test.ts \
  tests/unit/project-trust.test.ts \
  tests/unit/resource-loader.test.ts \
  tests/unit/resource-package-manager.test.ts \
  tests/unit/session-manager.test.ts \
  tests/unit/session-compaction.test.ts \
  tests/unit/file-mutation-queue.test.ts \
  tests/integration/project-resource-trust.test.ts \
  tests/integration/main-agent-graph.test.ts
source /workspace/.env && npx tsx scripts/stress-reaper.ts
```
