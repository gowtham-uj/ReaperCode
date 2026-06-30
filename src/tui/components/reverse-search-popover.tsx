/**
 * reverse-search-popover — Codex-style incremental history search.
 *
 * Appears above the input when the user presses Ctrl-R. The first
 * Ctrl-R shows the most recent history entry that contains the empty
 * needle (i.e. the most recent prompt). Subsequent keystrokes update
 * the needle; arrow up/down moves through the matches.
 *
 * Enter commits the highlighted match (replaces the input value);
 * Esc cancels; backspace on empty needle cancels.
 */

import React from "react";
import { Box, Text, useInput } from "ink";

import { theme } from "../theme.js";
import type { HistoryBuffer } from "../state/history.js";

interface ReverseSearchPopoverProps {
  history: HistoryBuffer;
  visible: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

export function ReverseSearchPopover(props: ReverseSearchPopoverProps): React.ReactElement | null {
  const { history, visible, onCommit, onCancel } = props;
  const [needle, setNeedle] = React.useState("");
  const [matches, setMatches] = React.useState<string[]>([]);
  const [matchIdx, setMatchIdx] = React.useState(0);

  // Recompute matches when the needle changes.
  React.useEffect(() => {
    if (!visible) return;
    const found = history.search(needle);
    setMatches(found);
    setMatchIdx(0);
  }, [needle, visible, history]);

  useInput((input, key) => {
    if (!visible) return;
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const sel = matches[matchIdx];
      if (sel !== undefined) onCommit(sel);
      else onCancel();
      return;
    }
    if (key.upArrow) {
      setMatchIdx((i) => Math.min(matches.length - 1, i + 1));
      return;
    }
    if (key.downArrow) {
      setMatchIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.backspace) {
      if (needle.length === 0) {
        onCancel();
      } else {
        setNeedle((n) => n.slice(0, -1));
      }
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      // Append printable characters to the needle.
      setNeedle((n) => n + input);
    }
  }, { isActive: visible });

  if (!visible) return null;

  const current = matches[matchIdx];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Box flexDirection="row">
        <Text>{theme.warning("(reverse-i-search) ")}</Text>
        <Text>{theme.accent("`")}</Text>
        <Text>{needle}</Text>
        <Text>{theme.accent("`:  ")}</Text>
        <Text wrap="wrap">{theme.toolHeader(current ?? "(no match)")}</Text>
      </Box>
      {matches.length > 1 ? (
        <Box flexDirection="row">
          <Text>{theme.muted(`  match ${matchIdx + 1}/${matches.length} — ↑/↓ to navigate, Enter to commit, Esc to cancel`)}</Text>
        </Box>
      ) : (
        <Box flexDirection="row">
          <Text>{theme.muted(`  Enter to commit, Esc to cancel`)}</Text>
        </Box>
      )}
    </Box>
  );
}