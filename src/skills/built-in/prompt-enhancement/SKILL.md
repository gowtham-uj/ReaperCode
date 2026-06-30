# prompt-enhancement

Improve prompts for clarity, completeness, and reliability.

## Steps

1. Identify the failure mode: vague output, missed steps, hallucinated APIs.
2. Add concrete constraints (what to do, what not to do, what to cite).
3. Tighten the desired output shape (schema, length, format).
4. Add anti-examples if the failure is pattern-level.
5. Re-test on the original bad cases; confirm they now succeed.
6. Do not bloat: every line must justify its place.

## When NOT to use

- The prompt is fine and the model is the problem.
- The change is purely cosmetic.

## Validation

A representative set of bad inputs must now produce good outputs.
