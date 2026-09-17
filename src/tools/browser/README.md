# The browser tool, and how to take it out

This directory is the `browser_use` tool. It is written so it can be lifted into
a separate process, or an MCP server, without editing the core.

## The boundary

Everything the tool needs from Reaper arrives through **one interface** and
leaves through **one result type**. Nothing else in the tool reaches into core
state, and nothing in core reaches into the tool except the two seams below.

```
core                                   browser/
────                                   ────────
ThreadBrowsers ─────────┐
                        │  BrowserHost (the interface)
ToolRuntimeMetadata ────┴──►  executeBrowserUse(args) ──► BrowserUseResult
```

### What comes in

- **`ThreadBrowserRuntime`** from `src/browser/thread-runtime.ts`. This is the
  only handle the tool holds. It owns the attach, the pages, the settings and
  the state file, and it has no dependency on the tool.
- **`BrowserUseMetadata`** (`runId`, `artifactDir`, `toolCallId`,
  `workspaceRoot`), a plain object with no methods. A caller in another process
  can build it from JSON.

### What goes out

- **`BrowserUseResult`**: `output` (the text the model reads), an optional
  `surface` for a UI, an `outcome`, and a `rev`. All plain data except the
  `surface.screenshotPath`, which is a path the caller resolves.

## The two seams in core

There are exactly two places core mentions this tool. Both are one line.

1. **Registration** — `src/tools/registry.ts` has a `browser_use` entry, and
   `src/tools/descriptor-builder.ts` classifies it. Removing those removes the
   tool from the model's view.
2. **Dispatch** — `src/tools/executor.ts` has a `case "browser_use"` that builds
   the runtime and calls `executeBrowserUse`. Removing it removes the tool from
   execution.

A third, optional: `src/skills/built-in/browser/` is the model-facing guide. It
travels with the tool.

## Taking it out

To move this to its own process or an MCP server:

1. **Take `src/browser/`, `src/tools/browser/`, and the eval worker.** They
   depend on `playwright`, `zod`, `node:*`, and on `src/tools/code/` for the
   sandbox the model's program runs in. Verified by reading the imports: no
   `../config`, no `../app-server`, no `../adaptive`, no `../model`. The code
   dependency is real and is the one thing to carry along, listed below.
   `src/tools/code/transform.ts` is self-contained; `transport.ts` and
   `worker-source.ts` are the bubblewrap plumbing.
2. **Replace the runtime with a remote one.** `ThreadBrowserRuntime` is the only
   thing the tool holds, so a client that speaks to a browser service over a
   socket can stand in for it, as long as it answers the same methods. The tool
   never touches the runtime's internals.
3. **Keep the two seams in core, or replace them with an MCP client.** The
   registry entry becomes a tool descriptor fetched from the MCP server, and the
   executor case becomes an MCP call. Neither change touches the browser code.

## What is deliberately not here

- No imports from `src/app-server`, `src/config`, or `src/adaptive`. The tool
  does not read configuration, does not know about threads, and does not log to
  Reaper's transcript. Everything it reports comes back in `BrowserUseResult`.
- No global state. A program's sandbox, the page bridge and the observation
  helpers are all created per call.

## The one coupling to be aware of

`src/browser/run-program.ts` runs the model's program in the **same sandbox
machinery as `eval`** (`src/tools/code/`). That is deliberate: the browser
program is confined by the same bubblewrap profile, and the browser bridge is
the eval worker's browser profile. Extracting the browser tool means carrying
that worker profile along, or giving the new home its own sandbox. The seam is
`runProgram(...)`, which takes the program and a host and does not know what is
on the other side of it.

The four files involved are `transform.ts` (pure string work, no dependencies),
`types.ts` (interfaces only), `transport.ts` (spawns the sandboxed worker) and
`worker-source.ts` (the worker program). A new home needs all four, or a
replacement for the three that are not pure.

## Checking this stays true

```
grep -h 'from "\.\./' src/browser/*.ts | grep -oP 'from "\K[^"]+' | sort -u
grep -h 'from "\.\./\.\./' src/tools/browser/*.ts | grep -oP 'from "\K[^"]+' | sort -u
```

The first should print only `../tools/code/...`. The second only
`../../browser/...`. A new line in either output that is not one of those is a
new coupling, and it is worth asking whether it belongs.
