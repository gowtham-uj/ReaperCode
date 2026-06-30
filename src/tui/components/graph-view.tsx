/**
 * GraphView — render a SessionGraph as an ASCII tree (Pi-inspired).
 *
 * Each turn becomes a `▌ turn N` header. Children branch off with
 * `├─` / `└─` connectors that show parent-child relationships.
 * Tool nodes are color-coded by outcome (green ok, red err, yellow
 * pending). The currently-selected node gets a highlighted gutter.
 *
 * Keyboard navigation:
 *   ↑ / ↓        move selection up/down within the visible window
 *   ← / →        collapse/expand the focused node (hides children)
 *   Enter        jump to the focused node's detail (passed via onActivate)
 *   Esc / q      close the graph view
 *
 * The renderer is a pure function of the graph + cursor; the parent
 * (App) owns the cursor state and passes it via props.
 */

import React from "react";
import { Box, Text, useInput } from "ink";

import { theme } from "../theme.js";
import type { GraphNode, GraphNodeKind, SessionGraph } from "../session-graph.js";

interface GraphViewProps {
  graph: SessionGraph;
  /** Index into the flattened pre-order list. */
  selected: number;
  /** Maximum width for the label column. Defaults to 70. */
  maxLabelWidth?: number;
  /** Window of nodes to render (set by parent based on viewport). */
  windowStart: number;
  windowSize: number;
  onSelect: (idx: number) => void;
  onActivate?: (node: GraphNode) => void;
  onClose: () => void;
  onToggleCollapse?: (node: GraphNode) => void;
}

function nodeColor(kind: GraphNodeKind, outcome?: GraphNode["outcome"]): (s: string) => string {
  if (kind === "tool") {
    if (outcome === "err") return theme.error;
    if (outcome === "pending") return theme.warning;
    if (outcome === "ok") return theme.success;
    return theme.muted;
  }
  switch (kind) {
    case "session":   return theme.toolHeader;
    case "turn":      return theme.accent;
    case "assistant": return theme.assistant;
    case "system":    return theme.system;
    case "error":     return theme.error;
    default:          return theme.muted;
  }
}

function nodeGlyph(kind: GraphNodeKind, outcome?: GraphNode["outcome"]): string {
  if (kind === "tool") {
    if (outcome === "err") return "✗";
    if (outcome === "pending") return "…";
    if (outcome === "ok") return "✓";
    return "·";
  }
  switch (kind) {
    case "session":   return "▌";
    case "turn":      return "▶";
    case "assistant": return "💬";
    case "system":    return "·";
    case "error":     return "✗";
    default:          return "·";
  }
}

interface RenderLine {
  /** Pre-rendered connector (e.g. "│  ├─ "). */
  connector: string;
  /** Glyph for the node. */
  glyph: string;
  /** Label text. */
  label: string;
  /** Detail line (optional second line). */
  detail?: string | undefined;
  /** Color function. */
  color: (s: string) => string;
  /** Kind — used by cursor logic. */
  kind: GraphNodeKind;
  /** Depth — used for the connector. */
  depth: number;
}

/** Walk the tree once and produce RenderLine[] in pre-order.
 *  Each line carries its depth so the renderer can pick the right
 *  connector. Collapsed nodes appear with one line and no children. */
function buildLines(
  graph: SessionGraph,
  collapsed: Set<string>,
): RenderLine[] {
  const lines: RenderLine[] = [];

  const walk = (n: GraphNode, depth: number, isLast: boolean, ancestorPrefix: string): void => {
    const connector = depth === 0 ? "" : ancestorPrefix + (isLast ? "└─ " : "├─ ");
    const glyph = nodeGlyph(n.kind, n.outcome);
    const color = nodeColor(n.kind, n.outcome);
    lines.push({
      connector,
      glyph,
      label: n.label,
      detail: n.detail,
      color,
      kind: n.kind,
      depth,
    });
    if (collapsed.has(n.id)) return;
    const childCount = n.children.length;
    n.children.forEach((child, i) => {
      const isLastChild = i === childCount - 1;
      const nextPrefix = depth === 0 ? "" : ancestorPrefix + (isLast ? "   " : "│  ");
      walk(child, depth + 1, isLastChild, nextPrefix);
    });
  };

  walk(graph.root, 0, true, "");
  return lines;
}

export function GraphView(props: GraphViewProps): React.ReactElement {
  const { graph, selected, windowStart, windowSize, onSelect, onActivate, onClose, onToggleCollapse, maxLabelWidth = 70 } = props;
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set());

  const allLines = React.useMemo(() => buildLines(graph, collapsed), [graph, collapsed]);

  // Clamp selected.
  React.useEffect(() => {
    if (selected >= allLines.length) onSelect(Math.max(0, allLines.length - 1));
  }, [allLines.length, selected, onSelect]);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onClose();
      return;
    }
    if (key.upArrow) {
      onSelect(Math.max(0, selected - 1));
      return;
    }
    if (key.downArrow) {
      onSelect(Math.min(allLines.length - 1, selected + 1));
      return;
    }
    if (key.return) {
      const line = allLines[selected];
      if (line && onActivate) {
        // Re-resolve the GraphNode from the line is awkward; we
        // approximate by walking the graph by depth/preorder.
        onActivate(resolveNode(graph, selected, collapsed));
      }
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      const line = allLines[selected];
      if (line && onToggleCollapse) {
        onToggleCollapse(resolveNode(graph, selected, collapsed));
      } else if (line) {
        // Internal default: collapse/expand by id.
        const node = resolveNode(graph, selected, collapsed);
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (next.has(node.id)) next.delete(node.id);
          else next.add(node.id);
          return next;
        });
      }
      return;
    }
  }, { isActive: true });

  const end = Math.min(allLines.length, windowStart + windowSize);
  const visible = allLines.slice(windowStart, end);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Box flexDirection="row">
        <Text>{theme.toolHeader(`Session graph — ${graph.totalNodes} nodes · ${graph.turnCount} turns`)}</Text>
      </Box>
      <Box flexDirection="row">
        <Text>{theme.muted("↑/↓ navigate · ←/→ collapse · Enter activate · q/Esc close")}</Text>
      </Box>
      <Box flexDirection="column">
        {visible.map((line, i) => {
          const realIdx = windowStart + i;
          const isSelected = realIdx === selected;
          const prefix = isSelected ? theme.accent("▌ ") : "  ";
          const labelTrunc = line.label.length > maxLabelWidth
            ? line.label.slice(0, maxLabelWidth - 1) + "…"
            : line.label;
          return (
            <Box key={`gl-${realIdx}`} flexDirection="column">
              <Box flexDirection="row">
                <Text>{prefix}</Text>
                <Text>{theme.muted(line.connector)}</Text>
                <Text>{line.color(line.glyph + " ")}</Text>
                <Text wrap="wrap">{line.color(labelTrunc)}</Text>
                {line.kind === "tool" && line.detail ? (
                  <Text>{theme.muted("  " + truncate(line.detail, 32))}</Text>
                ) : null}
              </Box>
              {line.kind === "turn" && isSelected ? (
                <Box flexDirection="row">
                  <Text>{theme.muted("    └ prompt context line")}</Text>
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {allLines.length > windowSize ? (
        <Box flexDirection="row">
          <Text>{theme.muted(`... ${allLines.length - windowSize} more (↑/↓ to scroll)`)}</Text>
        </Box>
      ) : null}
      <SelectedNodeFooter graph={graph} selected={selected} collapsed={collapsed} />
    </Box>
  );
}

function SelectedNodeFooter({ graph, selected, collapsed }: { graph: SessionGraph; selected: number; collapsed: Set<string> }): React.ReactElement {
  const node = resolveNode(graph, selected, collapsed);
  const color = nodeColor(node.kind, node.outcome);
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text>{theme.muted("selected: ")}</Text>
      <Text>{color(`${node.kind} `)}</Text>
      <Text>{color(node.label)}</Text>
      {typeof node.durationMs === "number" ? (
        <Text>{theme.muted(`  ${node.durationMs}ms`)}</Text>
      ) : null}
    </Box>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/** Walk the tree in pre-order (respecting collapsed set) and return
 *  the node at the given index. */
export function resolveNode(graph: SessionGraph, index: number, collapsed: Set<string>): GraphNode {
  let i = 0;
  let found: GraphNode = graph.root;
  const walk = (n: GraphNode): boolean => {
    if (i === index) {
      found = n;
      return true;
    }
    i += 1;
    if (collapsed.has(n.id)) return false;
    for (const c of n.children) {
      if (walk(c)) return true;
    }
    return false;
  };
  walk(graph.root);
  return found;
}