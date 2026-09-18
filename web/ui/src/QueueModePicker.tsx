import { useEffect, useId, useRef, useState } from "react";
import { CheckIcon, ChevronIcon } from "./icons.jsx";

/**
 * How the next message is delivered while the agent is working.
 *
 * This control lives beside the send button because that is where the decision
 * is actually made, and the absence of it here was the bug. The only place to
 * pick a mode used to be the queued card in the transcript, and by the time a
 * card was visible the choice was already spent: a `next-step` message is
 * steered at the agent's next tool boundary, which happens within one round
 * trip, so the card went straight to its delivered state and disabled the
 * radios. A reader who wanted "wait until the agent finishes" could not reach
 * the control before it greyed out, and changing it afterwards is deliberately
 * refused, because a message already handed to the model cannot be recalled.
 *
 * Choosing before sending removes the race entirely: the mode is known when the
 * message is queued, so the first flush routes it correctly instead of routing
 * it wrong and then being corrected too late.
 *
 * Rendered only while a turn is running. When the agent is idle a message is
 * simply sent, and a control that offered to delay that would be describing a
 * state that does not exist.
 */
export type QueueMode = "next-step" | "after-turn";

const MODES: Array<{ id: QueueMode; label: string; short: string; detail: string }> = [
  {
    id: "next-step",
    label: "After the next tool call",
    short: "Next step",
    detail: "Steer the running turn. The agent reads it at its next tool boundary.",
  },
  {
    id: "after-turn",
    label: "After the agent finishes",
    short: "After turn",
    detail: "Wait for the current prompt to end, then send this as a new turn.",
  },
];

export function QueueModePicker({ mode, running, disabled, onMode }: {
  mode: QueueMode;
  running: boolean;
  disabled?: boolean;
  onMode(mode: QueueMode): void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // Idle: no queue, no choice to make. Unmounting rather than disabling keeps a
  // dead control out of the tab order and out of the row's layout.
  if (!running) return null;

  const selected = MODES.find((entry) => entry.id === mode) ?? MODES[0]!;

  return (
    <div className="effort-picker queue-mode-picker" ref={rootRef}>
      <button
        className="effort-trigger queue-mode-trigger"
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`Delivery: ${selected.label}`}
        title={`Delivery: ${selected.label}`}
        data-mode={selected.id}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{selected.short}</span>
        <span className="model-trigger-chevron" data-open={open || undefined}><ChevronIcon /></span>
      </button>
      {open && (
        <div className="effort-menu queue-mode-menu" id={id} role="menu" aria-label="When to send this message">
          {MODES.map((entry) => (
            <button
              className="effort-option queue-mode-option"
              data-selected={entry.id === selected.id || undefined}
              role="menuitemradio"
              aria-checked={entry.id === selected.id}
              key={entry.id}
              onClick={() => { onMode(entry.id); setOpen(false); }}
            >
              <span><strong>{entry.label}</strong><small>{entry.detail}</small></span>
              <span className="model-check">{entry.id === selected.id && <CheckIcon />}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
