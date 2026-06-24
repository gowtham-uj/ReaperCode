import type { SubTaskContract } from "./contracts.js";

// `delegate_to_plan` is a delegation trigger (mode + reason). The generated
// plan lives in the engine's plan store, not in the call args. This module
// is the orchestration-side parser for plans that already exist; the
// engine-side trigger recognition is in `execution/planner.ts` and
// `tools/write/delegate-to-planner.ts`. No caller needs a function here, so
// this file is intentionally a re-export shim for downstream imports.
export type { SubTaskContract };
