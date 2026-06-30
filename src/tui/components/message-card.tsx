/**
 * MessageCard — one assistant / user / system / error bubble.
 * Assistant messages are rendered as Markdown via MarkdownRender.
 * User / system / error messages stay as plain text with role-
 * colored prefixes.
 *
 * Assistant messages may also carry a `reasoning` text (model
 * thinking trace); when present AND the SessionStore's
 * `hideThinkingBlock` flag is `false`, it is rendered as a
 * collapsible block above the chat bubble. Default state is
 * collapsed so the chat scroll position stays close to the latest
 * content; the user can toggle it with the `Tab` key.
 *
 * The global `Ctrl+T` keybind (in `useInputKeys`) toggles
 * `hideThinkingBlock` on the store. When `true`, the reasoning
 * block is suppressed entirely — both the chevron header and the
 * body. The user explicitly opts in to seeing the model's thinking.
 *
 * The store-backed variant (the default) subscribes to the store
 * via `useSession` so a `Ctrl+T` press re-renders the message list.
 * The unconnected variant (used by tests) accepts the flag as a
 * prop and skips the subscription.
 */

import React from "react";
import { Box, Text, useInput } from "ink";

import { theme } from "../theme.js";
import type { TuiMessage } from "../types.js";
import { MarkdownRender } from "../markdown-render.js";
import { useSession } from "../hooks/use-session.js";
import type { SessionStore } from "../state/session-store.js";

interface MessageCardProps {
  message: TuiMessage;
  /** Optional override for the thinking-hidden flag. When omitted,
   *  the component subscribes to the SessionStore and reads the
   *  flag off the snapshot — this is the path the production App
   *  takes. Tests pass the flag explicitly to avoid needing a real
   *  store. */
  hideThinkingBlock?: boolean;
  /** Required when `hideThinkingBlock` is omitted — the connected
   *  variant subscribes to this store. Production callers pass the
   *  store; tests can omit the prop by passing `hideThinkingBlock`
   *  explicitly. */
  store?: SessionStore;
}

function labelOf(kind: TuiMessage["kind"]): string {
  switch (kind) {
    case "user":      return "you";
    case "assistant": return "reaper";
    case "system":    return "system";
    case "error":     return "error";
  }
}

function colorOf(kind: TuiMessage["kind"]): (s: string) => string {
  switch (kind) {
    case "user":      return theme.user;
    case "assistant": return theme.assistant;
    case "system":    return theme.system;
    case "error":     return theme.error;
  }
}

/**
 * Format a milliseconds duration for the reasoning block header.
 * Returns "1.2s" for sub-minute values, "1m 5s" once we cross a
 * minute. Zero / undefined falls back to the empty string.
 */
function formatReasoningDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return "";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * ReasoningBlock — collapsible block for the model's thinking trace.
 * Default collapsed; the `Tab` key toggles open/closed.
 */
function ReasoningBlock({
  reasoning,
  durationMs,
}: {
  reasoning: string;
  durationMs: number | undefined;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);

  useInput((input, key) => {
    if (key.tab) {
      setOpen((o) => !o);
    }
  }, { isActive: true });

  const chevron = open ? theme.accent("▾") : theme.muted("▸");
  const duration = formatReasoningDuration(durationMs);
  const header = (
    <Box flexDirection="row">
      <Text>
        {chevron}
        {theme.muted(` thinking${duration ? ` (${duration})` : ""}`)}
      </Text>
    </Box>
  );

  if (!open) {
    return (
      <Box flexDirection="column" marginBottom={0}>
        {header}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {header}
      <Box flexDirection="column" paddingLeft={2}>
        {reasoning.split("\n").map((ln, i) => (
          <Text key={i} wrap="wrap">{theme.muted(ln)}</Text>
        ))}
      </Box>
    </Box>
  );
}

/**
 * Pure inner — given a resolved `hideThinkingBlock` flag, render
 * the chat bubble and (when allowed) the reasoning block. Used by
 * both the connected and the unconnected variants.
 */
function MessageCardInner({
  message,
  hideThinkingBlock,
}: {
  message: TuiMessage;
  hideThinkingBlock: boolean;
}): React.ReactElement {
  const label = labelOf(message.kind);
  const color = colorOf(message.kind);
  const text = message.text;

  // Reasoning block (assistant only). Suppressed entirely when the
  // user has hidden thinking blocks via Ctrl+T. The block is rendered
  // as a separate sibling above the chat bubble so the chevron and
  // the chat bubble don't fight for the same horizontal space.
  const reasoning = message.kind === "assistant" && !hideThinkingBlock ? message.reasoning : undefined;
  const reasoningDuration = message.kind === "assistant" && !hideThinkingBlock ? message.reasoningDurationMs : undefined;

  return (
    <Box flexDirection="column" marginY={0}>
      <Box flexDirection="row">
        <Text>
          {color(`▌ ${label}`)}
          {theme.muted("  ")}
        </Text>
      </Box>
      {reasoning ? (
        <Box flexDirection="column" paddingLeft={2}>
          <ReasoningBlock reasoning={reasoning} durationMs={reasoningDuration} />
        </Box>
      ) : null}
      <Box flexDirection="column" paddingLeft={2}>
        {message.kind === "assistant" ? (
          <MarkdownRender source={text} />
        ) : (
          // Split on newlines so Ink handles multi-line text correctly.
          text.split("\n").map((ln, i) => (
            <Text key={i} wrap="wrap">
              {color(ln)}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}

/**
 * MessageCard — public component. Two variants:
 *   - Unconnected (used by tests): pass `hideThinkingBlock` as a prop.
 *   - Connected (used by App): pass `store` and the component
 *     subscribes via `useSession` to read the flag from the
 *     snapshot. Re-renders fire on any `toggleThinkingBlock` call.
 */
export function MessageCard(props: MessageCardProps): React.ReactElement {
  const { message, hideThinkingBlock, store } = props;
  if (typeof hideThinkingBlock === "boolean") {
    return <MessageCardInner message={message} hideThinkingBlock={hideThinkingBlock} />;
  }
  if (!store) {
    // Defensive default — production callers always pass `store`;
    // tests always pass the flag. A bare render with neither is
    // treated as "thinking visible" so the legacy behavior is
    // preserved.
    return <MessageCardInner message={message} hideThinkingBlock={false} />;
  }
  return <MessageCardConnected message={message} store={store} />;
}

function MessageCardConnected({ message, store }: { message: TuiMessage; store: SessionStore }): React.ReactElement {
  // Subscribe to the store so the component re-renders on
  // `toggleThinkingBlock`. The flag lives on the snapshot's status.
  useSession(store);
  const hideThinkingBlock = store.snapshot().status.hideThinkingBlock;
  return <MessageCardInner message={message} hideThinkingBlock={hideThinkingBlock} />;
}
