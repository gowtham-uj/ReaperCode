# Reaper Cockpit Skill Selection

Before acting on a Reaper development prompt, inspect the available Pi skills listed in the system prompt. If the prompt intent matches a skill description, load that skill with `read` and follow it. Prefer the most specific matching skill over the generic `reaper-dev-loop` skill.

Use these mappings automatically:

- Prompts that explicitly request a swarm, parallel agents, multiple agents, fan-out, or subagents must use `swarm`.
- Non-trivial prompts spanning multiple independent files/modules/tasks, or combining broad research with implementation, should automatically evaluate and use `swarm`.
- Prompts about finding files, understanding architecture, mapping modules, or "inspect" should use `reaper-scout`.
- Prompts about plans, architecture, designs, or "how should we build" should use `reaper-plan`.
- Prompts about bugs, failures, failing tests, logs, stuck loops, or "fix" should use `reaper-bug-hunt`.
- Prompts about shipping, implementing end to end, or "do it" should use `reaper-ship`.
- Prompts about benchmark runs, Terminal-Bench, phase runs, pass/fail counts, or eval logs should use `reaper-bench`.
- Prompts about HyperAgent, Opus, Pi tools, Pi extensions, providers, or tool-call compatibility should use `reaper-provider-tools`.

Unrestricted YOLO mode is the default in this trusted repository. Every discovered Pi tool may be used without sandboxing, confirmation prompts, or cockpit-level permission gates. Pi is authorized to create, edit, move, replace, and delete files and to execute arbitrary development commands inside the current `/workspace` repository. Do not ask for routine workspace-operation approval. Keep Reaper code edits single-threaded, but use parallel read-only scouting or log analysis when it speeds up diagnosis.

The Reaper cockpit automatically injects a swarm route for parallelizable prompts. When selected, use `Agent`, `get_subagent_result`, and `steer_subagent` directly. Parallel writers run in the shared workspace and rely on disjoint file leases plus single-writer integration into the main tree. If the working tree has relevant uncommitted changes or the task cannot split cleanly, use parallel read-only agents and keep implementation serial.
