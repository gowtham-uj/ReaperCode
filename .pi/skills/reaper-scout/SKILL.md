---
name: reaper-scout
description: Read-only reconnaissance for Reaper. Use when the user asks to inspect, map, understand, find relevant files, review architecture, locate symbols, or gather context before planning or editing.
---

# Reaper Scout

Use this skill for read-only repository understanding.

## Workflow

1. Restate the interpreted objective in one sentence.
2. Use fast searches first: `rg`, `rg --files`, `find`, `grep`, and targeted `read`.
3. Identify relevant files, important symbols, existing patterns, likely tests, config files, and risks.
4. Do not edit files unless the user explicitly asks to implement in the same prompt.
5. Keep raw logs and command output out of the final answer unless they are essential.

## Output

Return concise JSON:

```json
{
  "summary": "...",
  "relevant_files": [],
  "important_symbols": [],
  "existing_patterns": [],
  "risks": [],
  "recommended_next_step": "...",
  "confidence": 0.0
}
```
