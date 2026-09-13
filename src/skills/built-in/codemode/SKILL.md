# Code Mode

`eval` runs JavaScript — real JavaScript, on real Node — that can also call your
own Reaper tools. Reach for it when the *shape* of the work is programmatic: a
loop, a filter, a fan-out, a chain. Do not reach for it to wrap one call.

## The five rules

1. **The last expression is the result.** No `return`, no `console.log`, no
   `JSON.stringify` — the completion value comes back as data.
2. **`await` works at the top level.** Every `tools.*` call returns a promise.
3. **Each eval starts fresh.** A `const` you declared in the previous call is
   not here. Keep a pipeline inside one script, or persist with
   `tools.write_file`.
4. **The whole language is available.** `require`, `import`, npm packages,
   `node:*` builtins, `fetch`, and `child_process` all work. You are not
   limited, so use the right tool for the job rather than the closest available
   one.
5. **Prefer `tools.*` when both would work.** A raw `fs.readFile` skips the
   workspace check, the permission check, and the audit log; `tools.read` goes
   through all three, so the transcript shows what you did and why. Reach for
   raw Node when you need something Reaper has no tool for — parsing a
   dependency, chunking a large file, arithmetic over a data structure.

## The API

| | |
|---|---|
| `tools.file_view` / `tools.bash` / `tools.write_file` / `tools.grep_search` … | Call any Reaper tool this agent may call, keyed by its registered name. Arguments are that tool's own arguments. |
| `await tools.search_tools({ query })` | Find a tool by what it does. Returns names and one-line descriptions — the cheapest way to answer "does Reaper have a tool for this". |
| `await tools.describe("bash")` | That tool's description and JSON schema. Also answers to the short names below. |
| `await tools.list()` | Every tool name and description. Comprehensive, and the largest of the three — reach for `search_tools` first. |
| `console.log` / `info` / `warn` / `error` | Streams to the transcript live, while the script runs. Not needed for the result. |

**All of them are already here.** Every tool the agent can call is in `tools.*`
from the first line of your script — including ones whose full schema is not in
your context and that you have never called. There is nothing to unlock and no
promotion step: a tool you have only seen a name for is callable right now.
`eval` itself is the single exception, because a script calling itself nests one
timeout inside another and neither can interrupt the other.

## Calling a model from a script

`models.call()` reaches this thread's chat model, so a program can fan out over
several prompts and reduce the answers itself instead of paying a round trip
for each one:

```js
const drafts = await Promise.all([
  models.call({ messages: [{ role: "user", content: "Name this function, one word." }] }),
  models.call({ messages: [{ role: "user", content: "Name it again, differently." }] }),
  models.call({ messages: [{ role: "user", content: "And a third option." }] }),
]);
drafts;   // ["parseConfig", "readConfigFile", "loadSettings"] — the prose, not an envelope
```

- `await models.list()` — the models you can reach. `models.call` with no
  `model` uses the thread's own, which is the only one a script is offered.
- `Promise.all` is real concurrency here, exactly as it is for `tools.*`.
- A failure rejects with `ReaperModelError`, catchable like any other error.
- There is no call limit. The script's timeout is the only bound.
- Set `timeout_ms` when you fan out: model calls take tens of seconds on some
  providers, and the 2-minute default covers a few in sequence but not twenty.

**Short names work too.** `tools.read` is `tools.file_view`, `tools.write` is
`tools.write_file`, `tools.grep` is `tools.grep_search`, `tools.ls` is
`tools.list_directory`, `tools.edit` is `tools.file_edit`. They resolve to the
same tool and the result is identical, so use whichever reads better. The
transcript and the tool ledger always name the real tool, not the short one.

**Return shapes are the tools' own.** `grep_search` returns
`{ root, matches }` — not an array. `list_directory` returns `{ entries }`.
`file_view` returns `{ window, totalLines, startLine, … }`. Destructure the
field you want; `tools.describe` gives you the schema when you are unsure.

## When eval is the right tool

- The same call repeated over a list: 30 files, 12 URLs, 8 directories.
- A pipeline where each step feeds the next and you do not need to *think*
  between them.
- Filtering or aggregating results that are large in total and small in answer.
- Counting, grouping, comparing, diffing, sorting — anything a `for` loop does
  better than a sentence.
- Data too big to have in context: read it, reduce it, return the hundred bytes
  that matter.

## When it is not

One call with one obvious argument → call the tool directly. It is one round
trip either way, and the direct call is easier to read, approve, and audit.
If you need to *look* at the result before deciding what to do next, call the
tool directly and look.

## Errors are values you can handle

A rejected tool call throws an `Error` with `code`, `message`, and `toolName`
attached. A `throw` from your own code is reported with its line. Both come
back to you as the tool result, so the fix is another `eval` call — not a
retry of the same script.

- `TOOL_DISABLED` — the thread switched that tool off, so the script cannot
  call it either. Try a different tool, or ask the user to enable it.
- `TOOL_NOT_EXPOSED` — no such tool. Check `tools.list()` for the real name.
- `invalid_argument` — the arguments did not match the tool's schema; the
  message names the field and quotes the whole issue list.
- `REAPER_REFUSED` — Code Mode declined the *operation* (see below). Your code
  is fine; a different approach will work.
- `timeout` / `memory` / `tool_call_limit` — you hit a resource ceiling. Return
  less, or in pieces.

## The one restriction

This is not a sandbox. `fs`, `child_process`, `fetch`, and npm packages are all
real, and a write from a script is a write. Two things are refused, and only
these: writing to system directories, reading credential stores like `~/.ssh`
or `~/.aws`, and commands like `rm -rf /`, `mkfs`, `dd of=/dev/sda`, and fork
bombs. A refusal is thrown as a `REAPER_REFUSED` error — catchable, and it
means the operation, not your code.

Everything else works normally. Because of that:

- **Writes are permanent.** No undo, and no approval prompt between your code
  and the filesystem.
- **`tools.*` is still the better path for anything Reaper has a tool for.**
  It goes through the workspace check, the permission checks, and the audit
  log; a raw `fs.writeFileSync` skips all three. The transcript will show the
  tool call and not the raw write, which matters when someone reads back what
  you did.
- **Reach for raw Node when Reaper has no tool for it** — parsing, arithmetic,
  chunking, a package the project already has.

## Budgets

Timeout 120 s per call unless you pass `timeout_ms`, memory 64 MB, 200 inner
tool calls, 256 KB returned result, 128 KB captured console. Hitting one ends
the call with a readable error; it does not corrupt anything. A script that
loops forever is stopped rather than hung.

**Set `timeout_ms` when your script waits on something slow.** The two-minute
default exists because a model call on some providers takes 45–60 seconds to
return its first token, so a script that awaits one — or awaits several in
sequence — can legitimately need longer than that. `timeout_ms` is per call:
it applies to the script that asks for it and does not affect any later script.

---

## Shapes worth knowing

Argument names differ per tool — `bash` takes `cmd`, `file_view` takes `path`,
`grep_search` takes `pattern`. When unsure, ask: `await tools.describe("bash")`
returns the tool's JSON schema. The shapes below are the real ones.

**Loop over files, return the summary.** The forty file bodies never leave the
script. You get the count and the paths that mattered.

```js
const { entries } = await tools.list_directory({ path: "src" });   // ["a.ts", "sub/"]
const offenders = [];
for (const entry of entries.filter((e) => e.endsWith(".ts"))) {
  const { window } = await tools.file_view({ path: "src/" + entry });
  if (window.join("\n").includes("console.log")) offenders.push(entry);
}
({ checked: entries.length, offenders });
```

**Fan out, then aggregate.** `Promise.all` is genuine concurrency here — these
run at the same time, not one after another.

```js
const { files } = await tools.glob({ pattern: "**/*.test.ts" });   // [{path, relativePath}]
const reads = await Promise.all(files.map((f) => tools.file_view({ path: f.relativePath })));
reads.map((r) => ({ path: r.relativePath ?? r.path, lines: r.totalLines }));
```

**Chain dependent steps.** Each call's output is the next call's input, with
nothing crossing back to the model in between.

```js
const { matches } = await tools.grep_search({ pattern: "TODO", include: "*.ts" });   // [{path, line, text}]
const byFile = {};
for (const match of matches) (byFile[match.path] ??= []).push(match.line);
Object.entries(byFile).map(([path, lines]) => ({ path, count: lines.length }));
```

**Survive a bad item.** One failure should not lose the other forty results —
catch per item and collect the failures.

```js
const { entries } = await tools.list_directory({ path: "." });
const ok = [], failed = [];
for (const entry of entries.filter((e) => e.endsWith(".json"))) {
  try {
    const { window } = await tools.file_view({ path: entry });
    ok.push({ entry, name: JSON.parse(window.join("\n")).name });
  } catch (error) {
    failed.push({ entry, reason: error.message });
  }
}
({ ok, failed });
```

**Reach for a package when it is the right tool.** A dependency the project
already has is available, and so is the whole standard library.

```js
const { createHash } = require("node:crypto");
const { window } = await tools.file_view({ path: "src/index.ts" });
const text = window.join("\n");
({ sha256: createHash("sha256").update(text).digest("hex"), lines: window.length });
```

**Find a tool you have never used.** You do not need its schema in your context
to call it — search for the capability, ask what it takes, then use it. All of
this is one call, and only the last line comes back.

```js
const found = await tools.search_tools({ query: "find files matching a pattern" });
const { input } = await tools.describe("glob");          // -> { pattern, path }
const { files } = await tools.glob({ pattern: "src/**/*.ts" });
({ candidates: found.matches.map((m) => m.name), globArgs: Object.keys(input.properties), count: files.length });
```

**Or skip the tools entirely.** Nothing says a step has to go through Reaper.
If the work is arithmetic, parsing, or a package the project already has, plain
Node is the shorter path — and mixing the two in one script is normal.

```js
const { entries } = await tools.list_directory({ path: "coverage" });   // Reaper reads
const totals = entries
  .filter((e) => e.endsWith(".json"))
  .map((e) => require(`./coverage/${e}`).total)                          // Node parses
  .reduce((a, b) => a + b, 0);
({ files: entries.length, totals });                                     // the reduction
```
