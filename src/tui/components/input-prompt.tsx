/**
 * InputPrompt — single- and multi-line prompt with history, slash
 * popover, and global keybinds (Esc cancel, Ctrl-C exit, Ctrl-D on
 * focused card is handled by ToolCard).
 *
 * The input is implemented on top of a local TextInput shim
 * (`./text-input-shim.tsx`) — we don't use `ink-text-input` because
 * it pins Ink 5 and we run Ink 7 for React 19 compatibility. Custom
 * keystroke handling covers:
 *   - Shift+Enter → newline
 *   - ↑ / ↓ → history walk (delegated to HistoryBuffer)
 *   - Ctrl-R → reverse-i-search popover (delegated to parent)
 *   - Tab → accept slash popover completion
 *
 * The component is intentionally synchronous — the parent's submit
 * handler is called via `onSubmit(text)` and never re-enters the
 * prompt until the user submits again.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "./text-input-shim.js";

import { theme } from "../theme.js";
import type { HistoryBuffer } from "../state/history.js";
import type { SlashEntry } from "./slash-popover.js";

export interface InputPromptProps {
  history: HistoryBuffer;
  slashEntries: SlashEntry[];
  slashSelected: number;
  placeholder?: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onSlashSelectionChange: (idx: number) => void;
  onSlashCommit: (fullCommand: string) => void;
  onAbort: () => void;
  onRequestExit: () => void;
  /** Visual focus flag — disables useInput if false. */
  isActive: boolean;
}

export function InputPrompt(props: InputPromptProps): React.ReactElement {
  const {
    history,
    slashEntries,
    slashSelected,
    placeholder,
    onChange,
    onSubmit,
    onSlashSelectionChange,
    onSlashCommit,
    onAbort,
    onRequestExit,
    isActive,
  } = props;

  const [value, setValue] = React.useState("");
  const [historyCursor, setHistoryCursor] = React.useState<number>(-1);
  const [showPopover, setShowPopover] = React.useState(false);

  React.useEffect(() => {
    setShowPopover(value.startsWith("/") && slashEntries.length > 0);
  }, [value, slashEntries]);

  useInput(
    (input, key) => {
      // Tab → accept slash completion.
      if (key.tab && showPopover && slashEntries.length > 0) {
        const sel = slashEntries[slashSelected];
        if (sel) {
          const completed = `/${sel.name} `;
          setValue(completed);
          onChange(completed);
        }
        return;
      }
      // Shift+Enter / Ctrl-J → newline (multi-line).
      if ((key.shift && key.return) || input === "\x0e") {
        setValue((v) => v + "\n");
        return;
      }
      // ↑ / ↓ → history walk (only when slash popover is closed).
      if (key.upArrow && !showPopover) {
        const next = history.up(value);
        if (next !== null) {
          setValue(next);
          setHistoryCursor(historyCursor + 1);
        }
        return;
      }
      if (key.downArrow && !showPopover) {
        const next = history.down();
        if (next !== null) {
          setValue(next);
          setHistoryCursor(historyCursor - 1);
        }
        return;
      }
      // ↑ / ↓ inside slash popover → change selection.
      if (key.upArrow && showPopover) {
        onSlashSelectionChange(Math.max(0, slashSelected - 1));
        return;
      }
      if (key.downArrow && showPopover) {
        onSlashSelectionChange(Math.min(slashEntries.length - 1, slashSelected + 1));
        return;
      }
      // Enter with popover open → commit highlighted command.
      if (key.return && showPopover && slashEntries.length > 0) {
        const sel = slashEntries[slashSelected];
        if (sel) {
          const full = `/${sel.name}${sel.description ? "" : ""}`;
          onSlashCommit(full);
          setValue("");
          onChange("");
        }
        return;
      }
      // Esc → abort in-flight.
      if (key.escape) {
        onAbort();
        return;
      }
      // Ctrl-C is owned by App (double-press exit). Don't handle
      // it here so the global keybind in App.tsx fires.
    },
    { isActive },
  );

  return (
    <Box flexDirection="row" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text>{theme.accent("▌ ")}</Text>
      <TextInput
        value={value}
        onChange={(v) => {
          setValue(v);
          onChange(v);
        }}
        onSubmit={(v) => {
          if (!v.trim()) return;
          history.push(v);
          setHistoryCursor(-1);
          onSubmit(v);
          setValue("");
        }}
        placeholder={placeholder ?? "type a prompt — Enter to send · Shift+Enter for newline · / for commands"}
      />
    </Box>
  );
}