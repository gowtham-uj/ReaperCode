/**
 * Swarm public surface — model-driven subagents.
 *
 * Re-exports the per-instance subagent runtime plus the two tools
 * the main agent uses to delegate:
 *
 *   - `AgentTool`        — single subagent delegation
 *   - `AgentSwarmTool`   — parallel fan-out via a prompt template
 *
 * The runtime consists of:
 *   - `LaborMarket`           — registry of built-in subagent types
 *   - `SubagentStore`         — per-instance persistence
 *   - `SubagentOutputWriter`  — tee'd wire file writer
 *   - `ForegroundSubagentRunner` — the model-call loop for one subagent
 *   - `prepareSoul`           — system-prompt + tool-list resolver
 *
 * The main agent decides when to delegate. There are no hardcoded
 * orchestration roles; the model's tool calls drive the swarm.
 */

export * from "./types.js";
export { LaborMarket, parseAgentTypeYaml } from "./labor-market.js";
export type { WireEventLike, SubagentModelFn } from "./prepare.js";
export { SubagentStore, readContextMessages } from "./store.js";
export { SubagentOutputWriter } from "./output-writer.js";
export { ForegroundSubagentRunner } from "./runner.js";
export type { ForegroundRunnerOptions, SubagentHookEngine, SubagentHookEvent } from "./runner.js";
export { AgentTool } from "./agent-tool.js";
export type { AgentToolParams, AgentToolOptions, AgentToolResult } from "./agent-tool.js";
export { AgentSwarmTool, MAX_AGENT_SWARM_SUBAGENTS, DEFAULT_MAX_CONCURRENCY } from "./agent-swarm-tool.js";
export type {
  AgentSwarmToolParams,
  AgentSwarmToolOptions,
  AgentSwarmToolResult,
  AgentSwarmItemOutcome,
} from "./agent-swarm-tool.js";

export {
  buildSystemPrompt,
  resolveTools,
  prepareSoul,
  getStoredContext,
  buildLaunchSpec,
} from "./prepare.js";

export {
  setSwarmLogSink,
  logSwarmEvent,
  type SwarmLogEvent,
  type SwarmLogSink,
} from "./logger.js";
