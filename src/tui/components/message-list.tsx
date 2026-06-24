/**
 * Message list — scrollable viewport over the SessionStore's
 * messages (tool cards are rendered separately by App because they
 * need workspaceRoot for diff capture).
 *
 * Today this is a simple sequential render with hard truncation
 * to `maxLines`; the virtualized scrollable viewport lands in
 * Phase 4.
 *
 * The store is passed through to each MessageCard so the connected
 * variant can subscribe to `hideThinkingBlock` toggles. When the
 * store is omitted the list falls back to "thinking visible"
 * (defensive default).
 */

import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import type { TuiMessage } from "../types.js";
import type { SessionStore } from "../state/session-store.js";
import { MessageCard } from "./message-card.js";

interface MessageListProps {
  messages: TuiMessage[];
  maxLines: number;
  debugMode?: boolean;
  /** Optional store — when provided, MessageCard uses the connected
   *  variant that subscribes to `hideThinkingBlock`. Tests can omit
   *  this and pass `hideThinkingBlock` directly to MessageCard
   *  instead. */
  store?: SessionStore;
}

export function MessageList({ messages, maxLines, debugMode = false, store }: MessageListProps): React.ReactElement {
  const items = debugMode
    ? messages
    : messages.filter((msg) => msg.kind === "user" || msg.kind === "assistant" || msg.kind === "error");
  const hiddenCount = messages.length - items.length;

  if (items.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Text>{theme.muted("(empty conversation — type a prompt and press Enter)")}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      {items.slice(-maxLines).map((msg) => (
        <MessageCard
          key={msg.id}
          message={msg}
          {...(store ? { store } : {})}
        />
      ))}
      {!debugMode && hiddenCount > 0 ? (
        <Text>{theme.muted(`(internal logs hidden — /logs to inspect ${hiddenCount} item${hiddenCount === 1 ? "" : "s"})`)}</Text>
      ) : null}
    </Box>
  );
}
