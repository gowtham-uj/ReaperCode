---
name: reaper-provider-tools
description: HyperAgent Opus, Pi extension, provider, model routing, and tool-call compatibility workflow. Use when changing Pi tools/extensions/providers or testing Opus tool calls.
---

# Reaper Provider Tools

Use this skill for Pi provider/tool work.

## Required Checks

After changing `.pi/extensions/hyperagent-provider.ts`, Pi tools, provider routing, or cockpit extensions:

1. Run `npm run typecheck`.
2. Run `pi --list-models hyperagent`.
3. Test Opus with `pi --mode json --provider hyperagent --model claude-opus-4-8`.
5. Use unique marker files.
6. Verify real structured events: `toolcall_start`, `tool_execution_start`, and `tool_execution_end`.

## Protocol

- Opus uses schema-driven `PI_CALL` requests converted into structured Pi tool calls.
- Verify Opus receives tool results, analyzes them, and continues normally.

## Output

Include exact commands, model used, structured event evidence, continuation behavior, and remaining risk.
