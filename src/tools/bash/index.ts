
import {
  BashInputSchema,
  BashOutputSchema,
  type BashInput,
  type BashOutput,
} from "./schema.js";
import {
  executeBashCommand,
  bashCommandToModelOutput,
  isBackgroundBashResult,
  toForegroundShellResult,
  type BashExecutionResult,
  type BashExecutionContext,
} from "./execute.js";
import {
  classifyBashCommand,
  isReadOnlyBashCommand,
  type BashClassification,
  type BashCommandCategory,
} from "./classify.js";
import {
  evaluateBashPermission,
  escalateMode,
  isReadOnly,
  isConcurrencySafe,
  type SandboxMode,
  type PermissionEvaluation,
} from "./permissions.js";
import { getActivityDescription, buildBashResultOutput, persistBashOutput } from "./result.js";
import { BASH_INPUT_DEFAULTS } from "./constants.js";

export const bashTool = {
  name: "bash" as const,
  description:
    "Run a shell command in the workspace. Prefer providing a concise `description` and explicit `timeout`. Use `run_in_background: true` for long-running servers or blocking operations. If output is large, inspect the returned `persisted_output_path` with read_file.",
  parameters: BashInputSchema,
  execute: executeBashCommand,
};

export {
  BashInputSchema,
  BashOutputSchema,
  executeBashCommand,
  bashCommandToModelOutput,
  isBackgroundBashResult,
  toForegroundShellResult,
  classifyBashCommand,
  isReadOnlyBashCommand,
  evaluateBashPermission,
  escalateMode,
  isReadOnly,
  isConcurrencySafe,
  getActivityDescription,
  buildBashResultOutput,
  persistBashOutput,
  BASH_INPUT_DEFAULTS,
  type BashInput,
  type BashOutput,
  type BashExecutionContext,
  type BashExecutionResult,
  type BashClassification,
  type BashCommandCategory,
  type SandboxMode,
  type PermissionEvaluation,
};
