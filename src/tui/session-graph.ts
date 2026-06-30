/**
 * session-graph — build a tree-shaped view of one session's trajectory.
 *
 * The trajectory is a JSONL file: one envelope per line, with
 * `kind` ∈ {user_prompt, assistant_message, tool_call, ...}. We
 * group envelopes into "turns" — a turn starts at a user_prompt and
 * ends at the next user_prompt (or EOF). Each turn becomes a tree
 * node; tool calls and assistant messages inside the turn become
 * children of that turn.
 *
 * The tree is rendered ASCII-style by GraphView with `├─` / `└─` /
 * `│` connectors (Pi-inspired) and color-coded by outcome.
 *
 * We keep the tree builder pure (no I/O beyond reading the
 * trajectory); the renderer is a separate React component.
 */

import { readFileSync } from "node:fs";

export type GraphNodeKind =
  | "session"
  | "turn"
  | "tool"
  | "assistant"
  | "system"
  | "error";

export interface GraphNode {
  /** Stable id derived from the source envelope id (or turn counter). */
  id: string;
  kind: GraphNodeKind;
  /** Short label shown in the graph (truncated to ~60 chars). */
  label: string;
  /** Optional secondary line (tool args / error detail). */
  detail?: string | undefined;
  /** Outcome for tool nodes. */
  outcome?: "ok" | "err" | "pending" | undefined;
  /** Wall-clock timestamp ms. */
  ts?: number | undefined;
  /** Duration in ms (for tool nodes). */
  durationMs?: number | undefined;
  /** Children in the tree. */
  children: GraphNode[];
}

export interface SessionGraph {
  root: GraphNode;
  /** Total node count (root + all descendants). */
  totalNodes: number;
  /** Total turns (children of root of kind "turn"). */
  turnCount: number;
}

/** Trim a string for the graph label; prefer word boundaries. */
function trimLabel(s: string, max = 60): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > max * 0.6) return cut.slice(0, lastSpace) + "…";
  return cut + "…";
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

interface EnvelopeLike {
  kind?: string;
  timestamp?: string;
  event_id?: string;
  turn_id?: string;
  message_type?: string;
  payload?: Record<string, unknown>;
  tool_name?: string;
  status?: string;
  args?: unknown;
  output?: unknown;
  content?: unknown;
  duration_ms?: number;
}

/** Read a trajectory JSONL file and build the session graph. */
export function buildSessionGraph(trajectoryPath: string): SessionGraph | null {
  let raw: string;
  try {
    raw = readFileSync(trajectoryPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;

  const root: GraphNode = {
    id: "root",
    kind: "session",
    label: "session",
    children: [],
  };
  let totalNodes = 1;
  let currentTurn: GraphNode | null = null;
  let turnCounter = 0;

  for (const line of lines) {
    const env = safeJson(line) as EnvelopeLike | null;
    if (!env || typeof env !== "object") continue;

    const kind = String(env.kind ?? env.message_type ?? "");
    const ts = env.timestamp ? Date.parse(env.timestamp) : Date.now();
    const turnId = env.turn_id ?? "";

    // Detect a turn boundary: any envelope whose turn_id differs from
    // the current turn's id, OR an explicit user_prompt message.
    if (kind === "user_prompt" || (turnId && (!currentTurn || turnId !== currentTurn.id))) {
      turnCounter += 1;
      const promptText = String((env.payload as { prompt?: unknown })?.prompt ?? "");
      const node: GraphNode = {
        id: turnId || `turn-${turnCounter}`,
        kind: "turn",
        label: trimLabel(promptText || `turn ${turnCounter}`, 80),
        ts,
        children: [],
      };
      root.children.push(node);
      currentTurn = node;
      totalNodes += 1;
    }

    if (!currentTurn) continue;

    if (kind === "tool_call" || env.tool_name) {
      const toolName = String(env.tool_name ?? (env.payload as { tool_name?: string })?.tool_name ?? "tool");
      const status = String(env.status ?? "completed");
      const outcome: "ok" | "err" | "pending" =
        status === "completed" ? "ok" :
        status === "failed" ? "err" : "pending";
      const detail = trimLabel(JSON.stringify(env.args ?? {}), 60);
      const node: GraphNode = {
        id: env.event_id ?? `${currentTurn.id}-${currentTurn.children.length}`,
        kind: "tool",
        label: toolName,
        detail: detail || undefined,
        outcome,
        ts,
        durationMs: typeof env.duration_ms === "number" ? env.duration_ms : undefined,
        children: [],
      };
      currentTurn.children.push(node);
      totalNodes += 1;
    } else if (kind === "assistant_message" || env.content !== undefined) {
      const text = String(env.content ?? "");
      const node: GraphNode = {
        id: env.event_id ?? `${currentTurn.id}-a${currentTurn.children.length}`,
        kind: "assistant",
        label: trimLabel(text || "(assistant reply)", 80),
        ts,
        children: [],
      };
      currentTurn.children.push(node);
      totalNodes += 1;
    } else if (kind === "state_transition" || kind === "policy_decision" || kind === "verification_summary") {
      // Surface as compact system node; only first ~80 chars.
      const detail = JSON.stringify(env.payload ?? {}).slice(0, 80);
      const node: GraphNode = {
        id: env.event_id ?? `${currentTurn.id}-s${currentTurn.children.length}`,
        kind: "system",
        label: kind,
        detail,
        ts,
        children: [],
      };
      currentTurn.children.push(node);
      totalNodes += 1;
    } else if (kind === "error") {
      const text = String((env.payload as { message?: string })?.message ?? "error");
      const node: GraphNode = {
        id: env.event_id ?? `${currentTurn.id}-e${currentTurn.children.length}`,
        kind: "error",
        label: trimLabel(text, 80),
        ts,
        children: [],
      };
      currentTurn.children.push(node);
      totalNodes += 1;
    }
  }

  return {
    root,
    totalNodes,
    turnCount: root.children.length,
  };
}

/** Flatten the tree into a depth-first pre-order array (used by the
 *  renderer to compute cursor movement). */
export function flattenGraph(graph: SessionGraph): GraphNode[] {
  const out: GraphNode[] = [];
  const walk = (n: GraphNode): void => {
    out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(graph.root);
  return out;
}