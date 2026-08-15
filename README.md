# ReaperCode

Reaper is a coding agent you run from the terminal. Point it at a repo, give it a task, pick a model. It reads files, edits them, runs shell commands, and keeps going until it thinks it is done.

It is built for long jobs. When the conversation gets large, Reaper trims old tool output and file reads, then summarizes only if the context budget is actually blown. The system prompt stays put. That is the whole point of the project.

This is a CLI. There is no chat UI in the repo. It is experimental. Use it on a copy of a project, or in a git repo you can revert.

## Install

You need Node 22 and npm (no build step, no `node_modules` — `reaper` is shipped as a single self-contained file).

### Install as a CLI (recommended)

The repo is public but not published to the npm registry, so install straight from the git URL — no auth needed:

```bash
npm install -g git+https://github.com/gowtham-uj/ReaperCode.git
```

Then run it anywhere:

```bash
reaper exec run --prompt "Add a README section about setup" --provider minimax --model MiniMax-M3
```

### Build from source

```bash
git clone https://github.com/gowtham-uj/ReaperCode.git
cd ReaperCode
npm install
npm run build
```

Put a provider key in `.env` in the repo root:

```bash
echo "MINIMAX_API_KEY=your_key_here" > .env
```

Reaper also reads `~/.reaper/.env` and `~/.hermes/.env`. First file that sets a key wins. Existing environment variables are not overwritten.

## Run a task

```bash
npm run reaper:exec -- "Explain how authentication works in this repo"
```

Or call the binary yourself:

```bash
node bin/reaper exec run --prompt "Add a README section about setup" \
  --provider minimax \
  --model MiniMax-M3
```

Pass the prompt after `--prompt`, with `--prompt-file path`, or as leftover words after the flags.

By default the workspace is the current directory. Point it somewhere else with `--workspace`.

```bash
node bin/reaper exec run \
  --workspace /path/to/your/project \
  --prompt "Find flaky tests and tell me which ones"
```

## Providers

`--provider` accepts:

| Provider | Put this in `.env` | Example model |
|---|---|---|
| `minimax` | `MINIMAX_API_KEY` | `MiniMax-M3` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| `openai` | `OPENAI_API_KEY` | `gpt-4.1` |
| `openai-codex` | `OPENAI_CODEX_ACCESS_TOKEN` | `gpt-5.4` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `nuralwatt` | `NURALWATT_API_KEY` | `kimi-k2.7-code` |

`ANTHROPIC_AUTH_TOKEN` also works for Anthropic-compatible proxies.

If you omit `--model`, MiniMax defaults to `MiniMax-M3`, NeuralWatt defaults to `kimi-k2.7-code`, and everything else falls back to `claude-sonnet-4-6`. For OpenAI, Codex, and DeepSeek, pass `--model` yourself.

## Useful flags

```bash
node bin/reaper exec run --prompt "..." \
  --provider anthropic \
  --model claude-sonnet-4-6 \
  --workspace . \
  --session my-task \
  --max-tokens 4096 \
  --timeout-ms 600000 \
  --reasoning-effort medium
```

| Flag | What it does |
|---|---|
| `--prompt` | The task |
| `--prompt-file` | Read the task from a file |
| `--provider` | Which API to call |
| `--model` | Which model id to use |
| `--workspace` | Directory the agent works in |
| `--session` | Keep a named journal so you can continue later |
| `--max-tokens` | Cap on the model's output tokens |
| `--timeout-ms` | Cap on the whole run |
| `--reasoning-effort` | `low`, `medium`, or `high` on OpenAI-compatible providers |
| `--thinking` | `on` or `off` for any provider (default `on`) |
| `--json` | Print the result object instead of live text |
| `--stream-events` | JSONL events on stdout, extra notes on stderr |

`--session name` writes turns to `.reaper/logs/name/session.jsonl` and reloads them the next time you use the same name.

## What it can do

On every turn the model gets file and shell tools: look at a file, search, edit a range, write or delete a file, list a directory, grep, and run bash. Extra tools exist behind `search_tools`, including git checkpoints. Browser and desktop-control tools exist but stay off unless you turn them on.

It will install packages, run tests, and change your working tree. That is the product. Keep git clean enough that you can undo it.

Long runs stay inside a 270,000-token context budget. Old reads get dropped. Old shell output gets trimmed. If that is not enough, Reaper pays for a summary and keeps going.

## Architecture

Reaper is a single agent loop with a lot of machinery around context, tools, and providers. The CLI is thin. Almost all of the design lives under `src/runtime`, `src/context`, `src/tools`, and `src/model`.

```text
prompt + workspace
        |
        v
   exec runner          builds provider/model config, checks the API key
        |
        v
   runtime engine       state machine for one task
        |
        +-- model gateway ---- Anthropic messages API
        |                   +- OpenAI-compatible chat API
        |
        +-- tool dispatch ----- file tools, bash, search_tools, ...
        |
        +-- context hooks ----- prune, shake, microcompact, full summary
        |
        v
   stop when the model returns no more tool calls
```

### The loop

The engine is a graph, not a `while (true)` with a pile of special cases. A run starts by bootstrapping the workspace and writing down a short task contract. Then it prepares content once: a workspace sketch, the skill catalog, and the tool shortlist. After that it enters the live loop.

Each turn does the same four things:

1. Call the model with a stable system prompt, a "cockpit" user message, the compacted history, and the current tool list.
2. Take the streamed tool calls and run them through validation, policy, and optional PreToolUse hooks.
3. Execute independent calls in parallel. Conflicting calls wait. File edits go through a write-ahead log so a half-finished mutation can roll back.
4. Fold the results back into history, drop reads that a later read replaced, and maybe compact.

The model stops the run. If it returns a final message with no tool calls, the engine summarizes metrics and exits. Reaper does not run a separate judge on the main path. If the model ran tests or a typecheck, that output is treated as evidence. That is a deliberate choice: the expensive verification stack exists for delegated sub-agents, not for every local `exec run`.

### Why the system prompt never changes

Providers cache prefixes. If you rewrite the system prompt every turn, you pay for it every turn. Reaper builds `MAIN_AGENT_SYSTEM_PROMPT_TEXT` once and leaves it alone. What the model needs to know about *this* run goes in a cockpit user message: workspace, skills, tool shortlist, the task.

When context gets tight, Reaper compresses history. It does not touch the system prompt. A resumed `--session` reloads a journal and any saved summary. It does not rebuild the prompt from scratch and hope the cache still hits.

### Tools are small on purpose

Dumping whole files into the model is how long runs die. The default file tools are bounded:

- `file_view` / `file_scroll` give line-numbered windows
- `file_find` searches inside a file
- `file_edit` replaces an exact range

`write_file`, `delete_file`, `list_directory`, `grep_search`, and `bash` stay on every turn because the agent cannot work without them. Everything else, including git checkpoints, is hidden behind `search_tools`, which is BM25 over the tool catalog. The model asks for a capability when it needs one instead of carrying fifty schemas forever.

Independent reads and shells run at the same time. The scheduler keys each tool by the resource it touches, so two reads of different files proceed and two writes to the same file do not.

### Context budget

The hard cap is 270,000 tokens. Soft cap defaults to that. Counts are `chars / 4`. That is crude and good enough to decide when to spend money on a summary.

Cheap passes run first, on every turn:

- a later read of the same file version replaces the earlier one
- old tool output outside a protect window gets shaken out
- bash output can spill to disk so only a head and tail stay in context

Only when those passes are not enough does Reaper pay for an LLM full summary. That summary replaces old conversation, writes a checkpoint, and becomes what a later session rehydrates. A provider "context length exceeded" error does the same path, or truncates the head if a summary is not ready.

The design bias is: do not summarize until you have to. Summaries lose detail. Pruning a stale `cat` does not.

### Providers

The loop does not speak Anthropic or OpenAI. It speaks one gateway. Streams come back as the same tool-call events. A stuck stream dies on an idle timeout instead of hanging the run.

Two wire families exist: Anthropic `/v1/messages` and OpenAI-compatible `/chat/completions`. MiniMax, DeepSeek, NeuralWatt, and Codex hang off the second family with different base URLs and keys. Adding a vendor is a catalog entry unless they need a custom client.

### Recovery and the things that are not shipped

Edits are journaled. A failed mid-file mutation should not leave the workspace half-written. Named sessions persist turns so you can continue tomorrow.

There is a sub-agent runner with depth limits, sandbox workspaces, and file leases. It is not exposed as a user tool. Parallel agents multiply context bugs. The context layer has to be boringly correct first.

MCP was removed. Skills, hooks, and extensions are the supported way to change behavior without forking the runtime.

## Other commands

`node bin/reaper --help` prints the groups.

```text
reaper skill list
reaper memory list
reaper extensions list
```

Skills are extra instructions Reaper can load for things like debugging or repo exploration. Memory and extensions are optional. You do not need them for a first run.

## Tests

```bash
npm test
npm run typecheck
```

`npm run reaper:dev` watches the CLI while you hack on it. `npm run stress` is a context-budget harness, not a user command.

## What to expect

- No interactive TUI and no web app. You start a run, it works, it exits.
- No MCP servers. That path was removed.
- No multi-agent swarm you can invoke. Parallel tool calls exist. A user-facing delegate tool does not.
- Several scripts under `scripts/` are old eval harnesses. Use `bin/reaper` or `npm run reaper:exec`.

## License

MIT. See `LICENSE`.
