/**
 * Status bar — fixed footer at the bottom of the screen. Shows
 * phase glyph (animated spinner for active phases) · model · provider
 * · ctx% · tokens · session-id · active-tool-count · last-tool-
 * outcome · thinking-block indicator · transient hint.
 *
 * The spinner animates via ink-spinner for `streaming` and
 * `tool-running` phases. Idle / verifying / done use static glyphs.
 *
 * The "think=on / think=off" segment is a small affordance that
 * makes the `Ctrl+T` toggle visible — without it the user has no
 * way to tell which mode the TUI is currently in.
 */

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

import { theme } from "../theme.js";
import type { TuiStatus } from "../types.js";

interface StatusBarProps {
  status: TuiStatus;
}

function phaseColor(phase: TuiStatus["phase"]): (s: string) => string {
  switch (phase) {
    case "idle":         return theme.muted;
    case "streaming":    return theme.warning;
    case "tool-running": return theme.accent;
    case "verifying":    return theme.system;
    case "done":         return theme.success;
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 12) return sessionId;
  return `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`;
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function StatusBar({ status }: StatusBarProps): React.ReactElement {
  const ctxPctStr = `${Math.round(status.ctxPct * 100)}%`;
  const color = phaseColor(status.phase);
  const isActive = status.phase === "streaming" || status.phase === "tool-running";
  const activeTools = status.activeToolCount ?? 0;
  const outcomeGlyph = status.lastToolOutcome === "ok" ? theme.success("✓") :
                       status.lastToolOutcome === "err" ? theme.error("✗") :
                       theme.muted("·");
  const sessionId = shortSessionId(status.sessionId);
  const segments = [
    <Text key="phase">{isActive ? <Spinner type="dots" /> : color(status.phase === "idle" ? "○" : "●")} {color(status.phase)}</Text>,
    <Text key="model">{theme.muted(status.model)}</Text>,
    <Text key="provider">{theme.muted(status.provider)}</Text>,
    <Text key="ctx">{theme.muted(`ctx ${ctxPctStr}`)}</Text>,
    <Text key="session">{theme.muted(sessionId)}</Text>,
  ];
  if (typeof status.elapsedMs === "number" && status.elapsedMs > 0) {
    segments.push(<Text key="elapsed">{theme.muted(formatElapsed(status.elapsedMs))}</Text>);
  }
  if (activeTools > 0) {
    segments.push(<Text key="tools">{theme.muted(`tools ${activeTools}`)}</Text>);
  }
  if (status.debugMode) {
    segments.push(<Text key="debug">{theme.warning("debug")}</Text>);
  }
  // Phase T2.7: per-turn token usage segment. Renders after the
  // canonical `ctx NN%` segment so users see both the budget signal
  // (ctx% of model window) and the spend signal (tokens spent on
  // the just-finished turn). Hidden when the engine hasn't reported
  // any turn usage yet — first turn is always a no-op display.
  if (status.tokensLastTurn) {
    const inTok = status.tokensLastTurn.input;
    const outTok = status.tokensLastTurn.output;
    if (inTok > 0 || outTok > 0) {
      segments.push(
        <Text key="turn-tokens">{theme.muted(`turn ${formatTokenCount(inTok)}↑${formatTokenCount(outTok)}↓`)}</Text>,
      );
    }
  }

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      width="100%"
    >
      <Box flexDirection="row">
        {segments.map((segment, i) => (
          <React.Fragment key={i}>
            {i > 0 ? <Text>{theme.muted(" · ")}</Text> : null}
            {segment}
          </React.Fragment>
        ))}
        <Text>{theme.muted(" · ")}</Text>
        <Text>{outcomeGlyph}</Text>
        <Text>{theme.muted(" · /logs")}</Text>
      </Box>
      {status.hint ? (
        <Box flexDirection="row">
          <Text>{theme.warning(status.hint)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
