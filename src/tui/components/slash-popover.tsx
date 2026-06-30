/**
 * SlashPopover — floating list of `SlashCommandRegistry.complete()`
 * matches above the input. Pure presentational: the parent owns the
 * selected index and the registry; this component just renders.
 */

import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";

export interface SlashEntry {
  name: string;
  description?: string;
}

interface SlashPopoverProps {
  entries: SlashEntry[];
  selected: number;
  visible: boolean;
}

const VISIBLE_ROWS = 8;

export function SlashPopover({ entries, selected, visible }: SlashPopoverProps): React.ReactElement | null {
  if (!visible || entries.length === 0) return null;

  const start = Math.max(0, Math.min(selected - Math.floor(VISIBLE_ROWS / 2), entries.length - VISIBLE_ROWS));
  const end = Math.min(entries.length, start + VISIBLE_ROWS);
  const windowed = entries.slice(start, end);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box flexDirection="row">
        <Text>{theme.accent("slash commands")} {theme.muted(`(${entries.length})`)}</Text>
      </Box>
      {windowed.map((e, i) => {
        const realIdx = start + i;
        const isSelected = realIdx === selected;
        const name = `/${e.name}`;
        const padded = name.padEnd(24, " ");
        const desc = e.description ?? "";
        return (
          <Box key={e.name} flexDirection="row">
            <Text>{isSelected ? theme.accent("> ") : theme.muted("  ")}</Text>
            <Text>{isSelected ? theme.accent(padded) : padded}</Text>
            <Text>{theme.muted(desc)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}