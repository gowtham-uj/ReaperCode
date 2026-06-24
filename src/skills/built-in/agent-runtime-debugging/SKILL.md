# agent-runtime-debugging

Debug agent / runtime / orchestrator issues.

## Steps

1. Capture the trajectory: the last N tool calls + their outputs.
2. Identify the divergence: where did the agent stop making progress?
3. Check the prompt / context — was it truncated, dropped, or contradicted?
4. Check the tool wiring — was a tool denied, missing metadata, or routed wrong?
5. Check the policy gate — was a benign call rejected for an unrelated reason?
6. Propose a targeted fix (router, prompt, tool metadata, or trajectory shape).

## When NOT to use

- The agent's outputs are correct and the user is unsatisfied with tone.
- The failure is in the model provider, not the runtime.

## Validation

Replay the trajectory through the fix and confirm the agent now progresses.
