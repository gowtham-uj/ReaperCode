import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PROJECT_PROMPT_DIRECTORY = path.join(".reaper", ".config");
export const SYSTEM_PROMPT_FILE = "system.md";
export const SUMMARIZE_PROMPT_FILE = "summarizePrompt.md";

export const DEFAULT_SUMMARIZE_PROMPT_TEXT = `Respond with text only. Do not call any tools.
Return exactly one concise <summary>...</summary> block with the nine numbered sections below.
Do not emit analysis, hidden reasoning, a transcript, JSONL, or commentary outside the summary.
Prefer verified facts and current state. Remove repetition and stale superseded details.

{{MODE_INSTRUCTIONS}}

<summary>
1. Primary Request and Intent
   Preserve the user's actual goal, constraints, exact markers, and acceptance criteria.

2. Key Technical Concepts
   Record only durable decisions, invariants, versions, and architectural constraints.

3. Files and Code Sections
   List critical paths, symbols, and observed state. Do not invent line numbers or file contents.

4. Errors and fixes
   Record concrete failures, root causes, fixes, and verification evidence.

5. Problem Solving
   Keep only approaches whose outcome changes the next action.

6. All user messages
   Preserve user-authored requirements and corrections without reproducing generated cockpit wrappers.

7. Pending Tasks
   List only unfinished work in priority order. Never resurrect completed work.

8. Current Work
   State the latest completed action, current state, and verified evidence.
9. Optional Next Step
   Give one concrete next action, or "None" when the task is complete.
</summary>

{{CHECKPOINT_SECTION}}

{{PRIOR_SUMMARY_SECTION}}

## Conversation to summarize

\`\`\`jsonl
{{CONVERSATION}}
\`\`\`

{{RETRY_SECTION}}
{{PREVIOUS_ATTEMPT_SECTION}}
`;

export function projectPromptPath(workspaceRoot: string, fileName: string): string {
  return path.join(workspaceRoot, PROJECT_PROMPT_DIRECTORY, fileName);
}

export function ensureProjectPromptFile(
  workspaceRoot: string,
  fileName: string,
  defaultText: string,
): string {
  const directory = path.join(workspaceRoot, PROJECT_PROMPT_DIRECTORY);
  const filePath = projectPromptPath(workspaceRoot, fileName);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(filePath)) {
    try {
      writeFileSync(filePath, defaultText.endsWith("\n") ? defaultText : `${defaultText}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }
  }
  return filePath;
}

export function loadProjectPrompt(
  workspaceRoot: string,
  fileName: string,
  defaultText: string,
): string {
  try {
    const filePath = ensureProjectPromptFile(workspaceRoot, fileName, defaultText);
    return readFileSync(filePath, "utf8").replace(/\r\n/g, "\n").trimEnd();
  } catch {
    return defaultText.trimEnd();
  }
}

export function renderSummarizePrompt(
  template: string,
  values: {
    checkpointSection: string;
    modeInstructions: string;
    priorSummarySection: string;
    conversation: string;
    retrySection: string;
    previousAttemptSection: string;
  },
): string {
  const replacements: Record<string, string> = {
    "{{MODE_INSTRUCTIONS}}": values.modeInstructions,
    "{{CHECKPOINT_SECTION}}": values.checkpointSection,
    "{{PRIOR_SUMMARY_SECTION}}": values.priorSummarySection,
    "{{CONVERSATION}}": values.conversation,
    "{{RETRY_SECTION}}": values.retrySection,
    "{{PREVIOUS_ATTEMPT_SECTION}}": values.previousAttemptSection,
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.split(placeholder).join(value);
  }
  return rendered;
}
