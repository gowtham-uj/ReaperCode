# How optional tools load into the model's context — and what the check found

---

> **Superseded in one respect.** This is the record of a specific sweep run. It describes the
> tool surface as it was then — 10 core plus 20 deferred. `eval` has since been removed from
> `toolRegistry` entirely, at your request, so the surface is now 10 core and 19 deferred. The
> `eval` references below are the history of that run, not the current surface. See `tools.md`.

You asked me to give the agent tasks that need an optional tool, confirm it finds the tool through
`search_tools`, confirm it then uses it, and explain how each tool loads into context. Doing that for
all 20 optional tools turned up **eleven real defects**, because a live model drives code paths that
unit tests build by hand — including several the tests could never have caught, since nothing
hand-written exercises a provider that answers cleanly with nothing.

Nine came from the sweep. The last two came from the real browser, which is the only place they are
visible: the offline sweep runs with one pre-pass disabled and never sees a turn end empty.

## The four stages

Every tool outside the core set reaches the model the same way, in four stages:

| # | Stage | What happens | Where it lives |
| --- | --- | --- | --- |
| 1 | **Inventory** | The tool is named in `# Available tools`, appended to the system prompt, with a one-line description and **no schema**. This is how the model learns it exists. | `renderAvailableTools` |
| 2 | **Search** | The model calls `search_tools` — either capability keywords (BM25 ranking) or `select:<name>` (exact). The call itself is what promotes the tool. | `executeSearchTools` → `discoverTools` |
| 3 | **Unlock** | The full schema is added to the `tools` array on the **next** model call, and the name is dropped from the inventory — it is no longer something to go looking for. | `buildGeneralAgentTools` |
| 4 | **Use** | The model calls it and the executor runs it. | `ToolExecutor` |

Three routes can promote a tool: the model calling `search_tools` (stages 1–3 above); the
content-prep keyword pre-pass, which attaches a tool *before* turn 1 so the model never has to
discover it; and the scratchpad promotion in `selectGeneralAgentToolsForTurn`. The live sweep runs
with the pre-pass **off**, so every tool must be reached through `search_tools` — otherwise the
scenario would not be testing the mechanism.

## The tool set

**10 core** — full schema on every request, no discovery needed:

```
bash, file_view, file_edit, write_file, grep_search,
list_directory, glob, git_status, git_diff, search_tools
```

**20 deferred** — named in the inventory, schema withheld until searched:

```
activate_skill, apply_patch_edit, browser_control, create_checkpoint, delete_file,
diagnostics, edit_file, eval, extension_manager, file_find, hook_manager,
inspect_environment, job, restore_checkpoint, scratchpad, search_memory,
skill_manager, skim_file, web_fetch, web_search
```

Every one of the 20 has exactly one live scenario, and there are no scenarios for anything else. The
harness enforces that before it starts rather than leaving it to be verified by hand — see the last
section of this document for why that distinction turned out to matter.

`tools.md` in the repo root is the same set with full descriptions and a blank **Drop?** /
**Pin?** column — that is the file you asked for, to read and cut from. Regenerate it with
`node --import=tsx scripts/emit-tool-list.mts` after any tool moves between the two sets.

## What was verified

**Deterministically** (every tool, no model involved):

- All 20 deferred tools are listed in the inventory with their schemas withheld.
- All 20 are reachable by **both** search phrasings — `select:<name>` and searching by the tool's
  own description through BM25. That second one matters: it is the floor for "the model describes
  the capability without knowing the name", and if a tool cannot be found by the words it uses to
  describe itself, no phrasing will find it.
- A promoted tool gets its schema on the next call and leaves the inventory.
- The offered surface and the advertised surface never disagree — no tool is both offered and
  advertised (which would tell the model to unlock what it already has), and none is neither (which
  would make it unreachable).
- A tool disabled for a thread is not offered, not advertised, not searchable, and not promotable.
- A promotion survives the per-turn narrowing that build-like tasks apply.
- `grep_search` finds a pattern in a single named file, and its recovery-session (`WAL`) twin finds
  one in a file that exists *only* in the session. Both previously answered "nothing found".

**Live, against a real model — all 20 tools, across two independent sweeps:**

| | |
| --- | --- |
| Conclusive (searched *and* called) in **both** sweeps | **10 of 20** |
| Conclusive in **at least one** sweep | **20 of 20** |
| Never exercised in either sweep | **0** |
| Tools that passed one sweep and made no claim in the other | 8 |

That last row is the useful number, and it is why the sweep was run twice rather than once. Eight
tools were exercised in full by one run and never reached by the next, on identical code: `skim_file`,
`inspect_environment`, `web_search`, `delete_file`, `file_find`, `job`, `search_memory`, `eval`. A
single run would have reported half the tool set as untested and read like a coverage hole. The
mechanism is not flaky — the *scenario* is: whether a model decides it needs a tool depends on how it
happens to plan the task that time. So the harness now labels a run that never reached the mechanism
`NOCLAIM` rather than `UNMET`, prints a per-stage table regardless of route, and says plainly that
one sweep is not evidence either way.

The row that did **not** move across sweeps is the inventory: all 20 tools were listed with schemas
withheld on the first call of every scenario, in both runs. That is a property of the harness's
bookkeeping rather than of the model's judgement, and it is the one thing a single run can settle.

**In a real browser, against the shipped app** — one clean run, screenshotted, with both halves of
the discovery path visible in the transcript:

```
user          The page at https://example.com has a heading. Tell me the exact words of it.
search_tools  select:web_fetch                                     ✓
web_fetch     https://example.com                                  ✓
assistant     The heading on https://example.com reads exactly: "Example Domain".
```

The model asked for the tool by name rather than describing the capability, which exercises the
`select:` route, and the answer is the real `<h1>` — so the tool ran and its result came back into
the conversation rather than merely being offered. This is the one check that runs against the
product as shipped; the sweep above deliberately disables the pre-pass, and the browser is the only
place that difference is visible.

Re-run after the fixes in #10 and #11, twice, unchanged both times — same two tool rows and the real
heading. One of those runs failed first and passed on retry, which is the provider behaviour described
in #10 rather than the discovery path: `zai-org/GLM-5.3-Flash` answered three times running with
nothing, the turn correctly closed as failed with an alert saying so, and the harness now re-sends
the prompt the alert asks the user to send. Before the fixes that same run would have looked like a
hang, because there was nothing on screen to read.

## The eleven defects

These are the reason the exercise was worth running. All eleven were invisible to the existing tests,
and each was found because a real model — or the text a real model reads — did something a hand-written test would not.

Three are worth calling out for what they say about the method. **#8** (`delete_file` removing a
directory tree) is the most serious bug found in the whole product, and it was not found by the
scenario that exists to exercise `delete_file` — that scenario passed. It was found by following
the *class* of defect #7 to its worst case, which is only possible once you have a name for the
class. **#9**, the inventory truncation, was found by printing the exact text the model reads
rather than by any test or any sweep: the sweep cannot see it, because a mangled description does
not stop a tool from being found. It just makes the model less able to decide it should look. And
**#10**, the silent turn, came from the real browser — the last section of this document — where a
run simply produced no reply, which is a state no offline harness reaches and no assertion here
would have caught.

### 1–4. `diagnostics` reported a confident answer it had not earned

Four separate defects in one file, all of the same shape:

1. It ran `npx tsc`. `npx` is a *download*, not a lookup — there is an unrelated package on the
   public registry literally named `tsc`. With no local install it fetched that stub, which accepts
   the flags, exits zero, prints nothing, and reports a file full of type errors as clean.
2. It read only `stderr`. `tsc` writes diagnostics to **stdout**, so even with the real compiler
   every finding was discarded.
3. With no `tsconfig.json`, `tsc --noEmit <file>` falls back to ES5 defaults and reports errors in
   correct modern code. The opposite failure: confidently dirty when clean.
4. Every path that could not run returned `ok: true` with no diagnostics. eslint was never invoked
   at all and still reported a clean file. **"I could not check" and "I checked and it is clean"
   were the same answer**, which is the root cause the other three are instances of.

The model found these itself: it was told `src/broken.ts` had no problems, did not believe it
*because the file was named broken.ts*, installed TypeScript by hand, and diagnosed the tool
correctly in its own report.

**Fixed:** the check now runs the TypeScript compiler API in process (no subprocess, no PATH lookup,
no registry fetch — and it is the only option that works in the single-file `bin/reaper.mjs`
bundle, which inlines TypeScript and has no `tsc` on disk to spawn). It honors a project's
`tsconfig.json` when one exists, falls back to modern defaults when it does not, and adds an
`unavailable` field so "could not check" is distinguishable from "checked and clean".

### 5. `file_find` ignored its own `start_line`

The schema accepted `start_line`, dispatch parsed it, and then dropped it — the search ran from the
stored viewport with wraparound. So a model that asked for the next match after line 200 got the one
at line 51, *above* the line it asked to search from. Silently returning a match from outside the
requested range is worse than returning nothing, because the model has no way to notice.

Verified: `start_line: 200` returned `matchedLine: 51`.

### 6. Three advertised tools could never run

`skill_manager`, `extension_manager`, and `hook_manager` are dispatched through
`ToolExecutorOptions.authoringTools`. **Nothing in `src/` ever supplied that option.** All three were
advertised to the model, promotable by `search_tools`, returned a schema, and then answered every
call with `"not wired for this run"` — from the day they were added, because the wiring and the
tools landed in the same commit and were never connected.

Adjacent to it: the executor's `PreToolUse` / `PostToolUse` / `PreSkillInvoke` gates read
`options.hooks`, and **no caller set that either**. So a hook authored and approved through
`hook_manager` was registered on a runner that no gate ever consulted — it would appear to work and
fire for nothing.

Both halves passed their own tests the entire time, because each test built by hand what the other
was supposed to supply. No test stood at the join.

**Fixed:** the engine now builds the three lifecycles once and passes them at its single
`ToolExecutor` construction site; the same `HookRunner` the authoring manager writes to is the one
the executor's gates dispatch through, via a forwarder that **keeps the veto** — an `enforce: true`
hook is exactly the hook whose answer must not be discarded. Eight new tests stand at the join,
including one that drives a real `ToolExecutor` and asserts the call no longer comes back
"not wired for this run".

### 7. `grep_search` refused to search a single file

`path` is typed as any non-empty string and the tool's whole description was three words —
"Search text across files" — so nothing the model could see said a *file* path was wrong. `walk()`
called `readdir` on it regardless, and the call died with the raw errno:

```
ENOTDIR: not a directory, scandir '/…/src/legacy.ts'
```

A live run showed the cost. Tracing a call chain, the model called `grep_search` with a file path,
read that as a broken tool, reasoned *"grep_search fails because it treats path as dir?"*, and
abandoned the call. **A valid request failing with an unreadable error costs more than the call —
it teaches the model the tool is unreliable**, and the model then routes around it.

The recovery (`WAL`) copy of the same function had the identical bug with a *worse* symptom: its
`walk` did `readdir(dir).catch(() => [])`, so a file path produced zero matches and `ok: true`. A
file full of matches answered exactly like a genuine miss — the same "confident answer it had not
earned" shape as the `diagnostics` defects, four sections up.

Two more argument-shape defects came out with it, both leaking engine text the model could not act
on: a malformed pattern surfaced as `Invalid regular expression: /(/gm: Unterminated group` (the
model never chose `gm`, and nothing says which argument was rejected), and a missing path surfaced
as a bare `ENOENT` errno.

Following the class rather than the instance found the same leaking in two more tools. Refusing a
*file* to `list_directory` is correct — a file has no entries — but the answer was still
`ENOTDIR: not a directory, scandir '…'`. And `skim_file` leaked both directions:
`EISDIR: illegal operation on a directory, read` for a directory and a raw `ENOENT` for a missing
file. Neither said which argument was wrong or what to use instead.

**Fixed:** `path` accepts a directory *or* a file for `grep_search`; a malformed pattern reports
`invalid_argument` with the cause and the fix ("Unterminated group… escape metacharacters such as
( ) [ ] { } + * ?"); a missing path reports `not_found` naming the path; a wrong-kind path reports
`invalid_argument` naming the tool that would have worked. A workspace escape is still
`path_escape`, asserted explicitly so the new error handling cannot become a way around the
sandbox.

Two pieces are deliberately shared rather than copied, because the copy is what went wrong:

- The match loop, by `grep_search` and its WAL twin. They were separate implementations of the same
  function, which is exactly how the WAL copy kept the bug after the direct one would have been
  fixed.
- `src/tools/read/file-errors.ts`, which every file-reading tool now routes through. One place
  decides how an errno becomes a sentence.

Fifteen tests cover `grep-search.ts`, which had none, and the three tools that share the helper.

### 8. `delete_file` silently deleted an entire directory tree

Found by following defect #7's class — "a tool that accepts an argument shape it cannot actually
honour" — to its logical worst case, and it is the most serious finding of the exercise.

`delete_file({ path: "src" })` ran `rm(filePath, { force: true, recursive: true })`. The tool is
named `delete_file` and its entire description is "Delete a file". Nothing in its schema offers
recursive deletion, so a model passing a directory is making a mistake — not requesting a tree
removal it has no way to know is available.

What it did instead, reproduced:

```
workspace/src/a.ts           ← deleted
workspace/src/nested/b.ts    ← deleted; never named in the call, never mentioned in the result
result: { path: ".../src", deleted: true }
```

The nested file was removed, and the reply was indistinguishable from deleting one file. `src/` is
now a 1-byte regular file in my scratch directory from the reproduction, which is how I found it:
a later probe wrote to `src` and *succeeded*, because `src` was no longer a directory.

The guard that did exist, `assertDeletablePath`, checked the workspace root and three protected
basenames. Both protect the *sandbox*. Neither protects the user's work, and the one property that
mattered — is this a file? — was never checked. **The largest irreversible action in the tool set
had the weakest guard.**

Two things made it survive. There was no test for `delete-file.ts` at all. And the same guard
function is called from two places — the direct path and the WAL-staged path — so a fix applied to
one would have left the bug live in the other, exactly as happened with `grep_search` and its
recovery twin.

**Fixed:** a directory is refused by name, with `list_directory` offered as the next step. The check
is `stat`-based and shared by both routes, so the two cannot diverge. Eight tests assert on **what
survives on disk**, not only on the returned envelope — the defect was precisely a return value
saying "fine" while the disk said otherwise. The pre-fix behaviour was re-run against the same
fixture to confirm those tests fail without the fix.

The executor route was not enough. `stageDelete` is called by the executor, but the `rm` it feeds
runs **inside the WAL at flush time** — so the guard sat one file away from the code that does the
damage, which is the same arrangement that let `grep_search`'s bug outlive its own fix in this
identical recovery twin. Reaching `stageDelete` by any other route destroyed the tree with no
executor involved:

```
stageDelete("src") → flush() → {"written":0,"deleted":1}
src/a.ts survives?         false
src/nested/b.ts survives?  false
```

The guard now lives in `stageDelete` itself, where the deletion is planned, and refuses before
anything is recorded — so a flush has nothing to run. Two tests cover the WAL directly.

### 9. Every inventory line was cut mid-word

Found by printing the inventory block instead of testing it — which is the only way it could have
been found, because a mangled description does not stop a tool from working. It just makes the model
less able to decide it should go and find it.

The lines the model reads to learn a tool exists were built with `slice(0, 110)`. That severed a
word in **17 of the 20** entries:

```
  - inspect_environment: … Reaper scratchpad/cache paths be
  - create_checkpoint: … before a risky mutation batch. Stores met
  - hook_manager: … `<id>.json`; drafts are NOT regis
  - apply_patch_edit: … Supports new file creation (--- /d
```

These 110 characters are the *entire* basis on which the model decides whether to spend a discovery
call. `hook_manager`'s complete description is 527 characters; the model saw the first 110 and,
crucially, **no indication that the rest existed**. A line that stops mid-word and a line that stops
because that is the whole description look identical from the model's side, and one of those
misleads.

**Fixed:** the line is cut on a word boundary and ends with `…` when anything was withheld, so a
shortened description always announces itself. Trailing articles and conjunctions are dropped, since
`…to the current git workspace. This resets …` reads fine but `paths be …` does not. One test now
asserts that any line shorter than its description ends with the marker, that the retained text is a
verbatim opening of the real description, and that nothing was truncated without saying so — the
first version of that test passed against the broken code, which is why it now checks the marker
rather than only checking for damage.

## Why some scenarios make no claim, and why that is the scenario's fault

A scenario makes **no claim** when the model solved the task with core tools and never needed to
search. Reporting that as a failure would misattribute a test-design problem to the product, so it
gets its own verdict — and the verdict is not stable per tool, which is the single most important
thing two sweeps bought.

Concretely: `delete_file`'s scenario *passed* in the first sweep and made no claim in the second.
`inspect_environment` did the reverse. Both runs were on identical code, same model, same prompts.
The mechanism never failed either time; what varied was whether the model chose to reach for a
tool at all. So a run's no-claim list tells you almost nothing, and the harness now says so in
those words instead of leaving a reader to infer a defect from a column of `UNMET`s.

There is also a shorter answer available for the whole question. The four tools below are the ones
where the naive route is genuinely competitive, so for those the scenario cannot separate "found it"
from "wanted it" without a directive. Everything else can be tested cleanly, and is.

Four tools genuinely overlap with core tools, and for each the naive route is *not worse*:

- **`edit_file`** — two `file_edit` calls (core) beat `search_tools` + `edit_file`. Making the file
  longer changes nothing, because the cost of the naive route is "one call per value" and no file
  size changes that.
- **`skim_file`** — `grep_search` plus a one-line `bash` read answers "what went wrong in this log"
  for any file size. A bigger file cannot create a capability gap.
- **`job`** — `cmd &` plus reading the redirect file is a complete substitute at identical cost.
- **`file_find`** — see below, because getting this one wrong twice is the most instructive result
  of the whole exercise.

For those, the prompt now states the requirement ("use the tool built for pruning large files",
"both in a single pass using the multi-block edit tool"). That is not cheating the test: the
hypothesis is whether a model that has been *told it must use* a capability can find it, search for
it, and receive its schema. Without the directive the scenario measures the model's appetite for a
different tool, and appetite is not what is being verified.

### The `file_find` arithmetic, and the assumption that broke it

This scenario was redesigned twice, and the second attempt is the one worth reading, because a
plausible argument was **disproved by a live run** rather than by a test.

**Attempt 1 — a single declaration.** Unwinnable. `grep_search` takes a `path`, so locating
something in one file costs one call and `file_view` recentres in a second: two calls. The discovery
route is `search_tools` + `file_find`: also two. Tied at one lookup, and tied at every number of
lookups, since discovery costs exactly one call and `file_find` saves exactly one per lookup.

**Attempt 2 — a five-hop chain.** The theory: hop N+1 is unknown until hop N is read, so nothing
batches, core tools cost two calls per hop (locate, then view), and the discovery route wins 6 to
10. It seemed airtight, and it was wrong.

The live run traced all five hops in **seven** core calls — one `grep_search` and six `file_view` —
and the model narrated its own method: *"I grepped for `function |=>|handleRequest`."* That is the
assumption that broke. **`grep_search` takes a regular expression, not a literal.** One alternation
returns every function declaration *and* every call edge in the file in a single call, so the whole
chain topology arrives at once; the `file_view` windows only confirm it, and calls batched into one
turn cost one turn, not one call each.

The general lesson is larger than this scenario: **`grep_search` (a regex over a path) plus
`file_view` (a bounded window — confirmed to cap at 600 lines with an explicit note) is a strict
substitute for `file_find` on any static question about a single file.** There is no task shape that
makes the naive route cost more, so no arithmetic rescues the scenario. `file_find` is only ever
one discovery call *slower* to reach.

So `file_find` now gets the same treatment as `job` and `skim_file`: the prompt states the
requirement. With that, it passes — the trace shows the model reasoning *"Need to discover its
schema? I can call `search_tools select:file_find`"*, searching, receiving the schema, and calling
the tool five times to trace every hop.

The honest summary is that for these four tools the question "can the model find and use a tool it
needs?" cannot be separated from "does the model want this tool?", and only the directive isolates
the first.

## The real browser chat, which the sweep cannot reach

Everything above runs a headless harness with one deliberate difference from the product: it sets
`REAPER_DISABLE_TOOL_PREPASS=1` so that every promotion must come from the model calling
`search_tools`. That is the right call for measuring discovery, and it means the sweep is
structurally blind to what the shipped app does. Driving an actual chat in a real browser is the
only way to see the difference, and it showed two things plus a third one that had nothing to do
with discovery at all.

### The pre-pass runs by default, and it changes what a screenshot means

With the pre-pass on, `searchTools` matches keywords across every tool description *before the first
model call* and attaches what it finds, so a deferred tool can be on the wire before the model has
decided it wants anything. A run phrased "Fetch https://… and use the network" therefore shows
`web_fetch` in the transcript while proving nothing about discovery — it looks exactly like a pass
and is not one. The first version of the browser test used a prompt that fired the pre-pass on
`browser_control`, and the run was uninformative in a way only the raw request dump revealed.

Phrasing that names the URL but no capability verbs attaches nothing, which is what makes the run a
discovery test. That this is narrow is worth stating plainly: **"What does the page at
`https://example.com` say in its first heading?"** is *not* clean (it scores `browser_control`), and
appending "as they are on the page right now" to a clean prompt breaks it again. The only reliable
way to choose a prompt is to run it through `searchTools` first.

### The run that worked

Clean prompt, fresh app-server, real Chromium, real model:

```
user       The page at https://example.com has a heading. Tell me the exact words of it.
search_tools  select:web_fetch                                        ✓
web_fetch     https://example.com                                     ✓
assistant  The heading on https://example.com reads exactly: "Example Domain".
```

Two things there are the actual claim. The model asked for the tool **by name** — `select:web_fetch`
— which is the `search_tools` promotion route working in the shipped app rather than in a harness.
And the answer is right: `Example Domain` is the real `<h1>` on that page, so the tool genuinely
ran and its result genuinely came back into the conversation. The two tool rows are rendered
collapsed in the transcript and were read out of the DOM after expanding them.

One operational note for anyone rerunning it: **`web_fetch` is approval-gated.** A script that
does not click the approval card watches the call time out and reports a failure that is really an
unattended prompt, and the card has to be clicked backwards through the list, since clicking one
removes it from the DOM.

### The tenth defect, found here

The chat test also produced a run with **no reply at all** — the user's message, and then nothing.
No error, no spinner, permanently. That is the worst state a chat UI can be in, and it is why the
defect is worth more than the passing run that came after it.

The cause was two separate pieces of code each doing the reasonable-looking thing:

1. When a provider returns an empty completion, the engine retries three times, then stops — leaving
   `assistantMessage` empty. It *did* know something had gone wrong: it raised a `runtimeBlockers`
   entry for the condition. But `RuntimeEngineResult` never carried `runtimeBlockers`, so the field
   was built, passed through graph state, and dropped at the result boundary.
2. `managed-thread` decided the turn's status from the abort signal and hardcoded `"completed"`
   otherwise. With the blocker unavailable and the message empty, a failed run closed as a success.

The engine had the diagnosis the whole time; nothing between it and the screen carried it. And the
UI was already ready to show it — `Transcript.tsx` renders `turn.error` as an alert, and the
projection already knew how to populate it from a `turn.failed` event. Nothing raised one.

The provider side deserves its own line, because it is not a bug and it is not rare. DeepInfra's
`zai-org/GLM-5.3-Flash` answers **byte-identical** requests with `finish_reason: "stop"`, a bare
`role` delta and no `content` or `tool_calls` about **four times in six** — measured directly
against the endpoint, streaming, replaying the exact request Reaper sent. Sometimes the tokens are
a `reasoning_content` fragment with nothing after it; often there is nothing at all but the role.
Reaper was not dropping a response. The provider was sending an empty one, from a request identical
to ones it answered correctly.

**Fixed:** the exhausted ladder now records an `empty_model_response` blocker; `RuntimeEngineResult`
carries blockers; the engine suppresses its own `turn.completed` for a run that stopped short, so
the transcript cannot flash "completed" and then flip to an error; and `managed-thread` closes those
turns as `failed` with the blocker's message. Because it is a real state rather than a theoretical
one, the message names the cause and offers a next step — retry, or switch models — instead of
restating the symptom.

Two test files cover it and both were checked by reverting the fix and watching them fail. The
second drives the real engine and the real thread manager and reads the notification the browser
would receive, because the first draft of it stubbed the runner with a hand-written error message
and then asserted on that same text — which passed while proving nothing.

### The eleventh defect, found by screenshotting the tenth one's fix

Fixing #10 gave the browser something to render, so I screenshotted it — and the screenshot showed a
different failure entirely. The turn was failing for a reason #10 did not cover, and it was still
closing as `completed`.

The pod this runs in exports `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` for Claude Code. Reaper
picks those up as a configured provider, so a brand-new thread defaults to the `anthropic` profile
with model `claude-sonnet-4-6`, and that proxy answers **HTTP 502 — `unknown provider for model
claude-sonnet-4-6`**. A real provider outage, on the default path, with no configuration required.

Three separate holes let it through:

1. **The error was not recognised as a transport error.** `classifyMainAgentTransportError` read
   `error.status`, but `src/model/providers/anthropic.ts` builds a plain `Error` with the status
   baked into the text — `Anthropic stream failed: HTTP 502 - {...}`. So the 502 was classified as
   "not transport", which meant no retry ladder and no transport blocker.
2. **`gateway.streamWithFallback` replaced the error and threw the cause away.** It caught the real
   error, wrote it to stderr for debugging, and then threw a new `Error` saying only "primary
   provider 'anthropic' failed and no fallback profile is configured". Everything downstream
   classifies by reading the message, so the status was gone by the time anything looked for it.
3. **The engine's `catch` treated a thrown model call as a reply.** It wrote the error text into
   `assistantMessage` as though the model had said it and raised no blocker. Its own comment claimed
   the error would be "picked up on the next pass" — there is no next pass, because
   `plannedToolCalls: []` routes straight to `summarize`. The error was surfaced to nobody.

The result was identical to #10 and reached the screen the same way: the user's message, then
nothing. The thread record said `completed`, with the provider's failure as the assistant's reply.

Fixing it also required fixing the fix. With the failure finally arriving as an alert, the screenshot
showed the same paragraph **twice** — once as an assistant message, once as the error. The
runtime's note ("Your last model call failed… you decide what to do next") is written *to the model*
and was being emitted to the transcript as an assistant reply, because the synthetic fallback turn
goes through the same emit path as a real one. A user was being shown a note addressed to a machine,
in the machine's voice.

So the note was split in two. The model keeps its instructions — it still needs them to decide
whether to stop or keep working — and the sentence built for a person names the provider, the status
and the cause, and says what to do:

> ✕ The model provider failed with a 502 transport error, and the run was stopped after retrying.
> Primary streaming provider 'anthropic' failed and no fallback profile is configured. Cause:
> Anthropic stream failed: HTTP 502 - {"type":"error","error":{"type":"api_error","message":"unknown
> provider for model claude-sonnet-4-6"}}
> Send the message again, or switch models in the composer.

One more thing the screenshot caught, which no test would have. The alert reused `.tool-status`, the
13px column that holds "✓" and "⋯" — so a sentence inside it wrapped at roughly one character per
line and the failure appeared on screen as a vertical ribbon of single words. It carries its own
class now.

**A note on why this was reachable at all.** The three places that decide whether a run failed —
whether to publish `turn.completed`, whether to publish `task_completed`, and what status the turn
closes with — each repeated the same `||` chain over the same two codes. Adding a third code to the
engine updated none of them, which is exactly how #10's fix arrived incomplete. That set now has one
definition, `STOPPED_SHORT_BLOCKER_CODES`, and all three sites ask.

## Coverage is now enforced rather than calculated

The claim in this document — that every one of the 20 deferred tools has a scenario — was checked once,
by hand, with a `node -e` one-liner. That is a fact about the day it was checked, not a property of
the harness: `verify-tool-discovery.mts` built its denominators from its own scenario list, so a tool
added to the registry with no scenario would simply shrink the denominator, and a sweep covering
nineteen tools would print a clean summary indistinguishable from one covering twenty.

The harness now refuses to start unless `ON_DEMAND_TOOL_NAMES` and the scenario list are the same set —
in both directions, so a scenario naming a core tool (which would pass vacuously, since core tools are
on the wire from the first call) fails too. The check reads the full list rather than the filtered one,
because a named run selects a subset and would otherwise report the other nineteen as uncovered.
