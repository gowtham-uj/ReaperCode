/**
 * text-input-shim.tsx — minimal in-house replacement for
 * `ink-text-input`. The upstream package pins Ink 5 as a peer
 * dependency and Ink 7 (which we use for React 19 compatibility)
 * broke its internals; rather than fork it we ship a tiny shim that
 * covers the only API surface the TUI uses:
 *
 *   <TextInput
 *     value={string}
 *     onChange={(next: string) => void}
 *     onSubmit={(value: string) => void}
 *     placeholder={string}
 *   />
 *
 * Behaviour:
 *   - Printable characters are appended at the cursor (end of value).
 *   - Backspace deletes the trailing character.
 *   - Enter calls `onSubmit(value)` — multi-line insertion is owned by
 *     the parent (Shift+Enter / Ctrl-J handler in InputPrompt).
 *   - All other keys (arrows, ctrl combos, escape) are ignored here so
 *     the parent's `useInput` handler can react to them first.
 *
 * Cursor positioning is intentionally simple (always at end). The
 * TUI prompt is single-line at rest; multi-line uses literal `\n`
 * characters and re-renders the full value via Ink's <Text>.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";

export interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  /** Visual focus flag — disables key handling if false. */
  isActive?: boolean;
}

export default function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  isActive = true,
}: TextInputProps): React.ReactElement {
  useInput(
    (input, key) => {
      // Enter → submit (parent decides what counts as multi-line).
      if (key.return) {
        onSubmit(value);
        return;
      }
      // Backspace → delete last char. Ink 7 reports key.backspace=true;
      // we ignore the printable input character when backspace fires.
      if (key.backspace) {
        if (value.length > 0) {
          onChange(value.slice(0, -1));
        }
        return;
      }
      // Printable character → append. Skip control chars (length 0 or
      // non-printable); Ink 7 surfaces the printable string in `input`
      // for typing and the key flags for special keys.
      if (input && input.length > 0 && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.escape && !key.tab && !key.return && !key.backspace && !key.delete) {
        // Filter out C0 control bytes except newline (handled by parent).
        if (input.charCodeAt(0) >= 0x20 || input === "\t") {
          onChange(value + input);
        }
      }
    },
    { isActive },
  );

  if (value.length === 0 && placeholder) {
    return (
      <Box>
        <Text>{theme.muted(placeholder)}</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text>{value}</Text>
    </Box>
  );
}