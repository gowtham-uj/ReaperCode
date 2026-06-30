/**
 * HelpOverlay — full-screen modal listing every keybind and slash
 * command. Toggled with F1 / ? (input is forwarded from the parent).
 */

import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";

interface HelpOverlayProps {
  visible: boolean;
}

const KEYBINDS: Array<[string, string]> = [
  ["Enter", "send prompt / commit highlighted slash command"],
  ["Shift+Enter", "newline (multi-line input)"],
  ["↑ / ↓", "walk input history"],
  ["Tab", "accept slash popover completion"],
  ["Esc", "abort the in-flight run"],
  ["Ctrl-C", "exit the TUI"],
  ["Ctrl-D", "toggle focused tool card: inline ↔ side-by-side diff"],
  ["Ctrl-L", "clear the message buffer"],
  ["F1 / ?", "toggle this help overlay"],
];

const SLASH_HINTS: Array<[string, string]> = [
  ["/help", "show slash command list"],
  ["/reload", "reload skills, extensions, and hooks"],
  ["/skills list", "list installed skills"],
  ["/extensions list", "list installed extensions"],
  ["/hooks list", "list hooks"],
];

export function HelpOverlay({ visible }: HelpOverlayProps): React.ReactElement | null {
  if (!visible) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text>{theme.accent("Reaper TUI — keyboard shortcuts")}</Text>
      <Text> </Text>
      {KEYBINDS.map(([k, v]) => (
        <Text key={k}>
          {theme.muted(k.padEnd(20, " "))}
          {v}
        </Text>
      ))}
      <Text> </Text>
      <Text>{theme.accent("Common slash commands")}</Text>
      <Text> </Text>
      {SLASH_HINTS.map(([k, v]) => (
        <Text key={k}>
          {theme.muted(k.padEnd(24, " "))}
          {v}
        </Text>
      ))}
      <Text> </Text>
      <Text>{theme.muted("press F1 or ? to dismiss")}</Text>
    </Box>
  );
}