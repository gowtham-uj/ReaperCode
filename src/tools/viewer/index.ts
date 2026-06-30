/**
 * Public surface of the viewer module.
 *
 * Phase 1: types + pure registry classes
 * Phase 3: dispatch glue (per-run viewer/linter registries live on the
 *          ToolExecutor and get wired into `dispatchViewerTool`).
 */

export * from "./types.js";
export {
  FileViewerRegistry,
  clampWindow,
  numberLines,
} from "./viewer-registry.js";
export type { FileViewState, ViewWindow } from "./viewer-registry.js";
export { LinterRegistry } from "./linter-registry.js";
export type { DispatchOptions, DispatchResult } from "./linter-registry.js";
export { dispatchViewerTool } from "./dispatch.js";
export type { ViewerDispatchContext } from "./dispatch.js";
