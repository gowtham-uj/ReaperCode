/**
 * tools/write/delegate-to-planner.types.ts — type re-exports for the
 * `delegate_to_planner` tool, kept in a separate file so the executor
 * can `import type` without pulling the full handler (and its
 * transitive planner/model deps) into a typecheck dependency chain.
 */

import type { z } from "zod";
import { DelegateToPlanArgsSchema } from "../types.js";
import type {
  DelegateToPlannerContext,
  DelegateToPlannerResult,
} from "./delegate-to-planner.js";

export type DelegateToPlanArgs = z.infer<typeof DelegateToPlanArgsSchema>;

export type {
  DelegateToPlannerContext,
  DelegateToPlannerResult,
};
