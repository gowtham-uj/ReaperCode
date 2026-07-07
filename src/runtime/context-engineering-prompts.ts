/**
 * Port of oh-my-pi's `compaction-summary.md` system prompt. Output
 * always uses this 8-section template — drop-in compatible with
 * `compaction-summary-context.md`'s `<summary>{{summary}}</summary>`
 * wrapper that the engine injects as a `compactionSummary`
 * message between the prior boundary marker and the re-attached
 * files.
 *
 * Section discipline (verbatim from OMP):
 *   1. Goal              — user's overarching request
 *   2. Constraints       — requirements / preferences discovered
 *   3. Progress          — Done / In Progress / Blocked checklists
 *   4. Key Decisions     — bullet list of (Decision → rationale)
 *   5. Next Steps        — ordered list of remaining actions
 *   6. Critical Context  — important data, pending questions, refs
 *   7. Additional Notes  — anything else important
 */
export const SUMMARIZATION_SYSTEM_PROMPT = `You MUST summarize the conversation above into a structured handoff summary for another LLM to resume the task.

IMPORTANT: If the conversation ends with an unanswered question or a request awaiting user response (e.g., "Please run command and paste output"), you MUST preserve that exact question/request.

You MUST use this format (sections can be omitted if not applicable):

## Goal
[User goals; list multiple if session covers different tasks.]

## Constraints & Preferences
- [Constraints or requirements mentioned]

## Progress

### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of next actions]

## Critical Context
- [Important data, pending questions, references]

## Additional Notes
[Anything else important not covered above]

You MUST output only the structured summary; you NEVER include extra text.

Sections MUST be kept concise. You MUST preserve exact file paths, function names, error messages, and relevant tool outputs or command results. You MUST include repository state changes (branch, uncommitted changes) if mentioned.`;

/**
 * Conversion prompt used by Reaper's full-summary engine when
 * compacting a session. OMP calls this `compaction-summary.md`; it
 * wraps the conversation transcript and tells the model to produce
 * ONLY the structured summary above. The model response is later
 * injected as the `summary` field of a `compactionSummary` message.
 */
export const COMPACTION_SUMMARIZATION_USER_PROMPT = (conversationJsonl: string): string => `${conversationJsonl}

You MUST produce the structured handoff summary described in the system prompt above. Output ONLY the structured summary in the exact specified format — do not include any other text.`;