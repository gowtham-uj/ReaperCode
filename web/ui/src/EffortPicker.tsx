import { useEffect, useId, useRef, useState } from "react";
import type { JsonRpcClient } from "@reaper/web-shared";
import { CheckIcon, ChevronIcon } from "./icons.jsx";
import type { CatalogModel } from "./models.js";

export type ReasoningEffort = "low" | "medium" | "high";

const DESCRIPTIONS: Record<string, string> = {
  minimal: "Least reasoning, fastest responses",
  low: "Faster responses for straightforward work",
  medium: "Balanced reasoning and response time",
  high: "More reasoning for difficult work",
  max: "Maximum reasoning for the hardest work",
};

/**
 * Effort levels the selected model advertises. The catalog is the source of
 * truth — a provider-name heuristic hid the control for every reasoning model
 * outside OpenAI and showed it for OpenAI models that reject the parameter.
 */
export function effortOptions(metadata: CatalogModel | undefined): string[] {
  if (!metadata?.supportsReasoning) return [];
  return metadata.reasoningOptions?.effort ?? [];
}

export function EffortPicker({ client, threadId, metadata, effort, turnActive, onError, labelled = false }: {
  client: JsonRpcClient | undefined;
  threadId: string | undefined;
  metadata: CatalogModel | undefined;
  effort: ReasoningEffort | undefined;
  turnActive: boolean;
  onError(message: string): void;
  /**
   * Whether the trigger names itself. In the composer the control sits beside
   * the model button, where "Effort medium" is the label the InputBar uses. In
   * a form field it sits under a "Reasoning effort" heading, so repeating the
   * noun is noise — but the trigger still has to carry a name of its own, which
   * is why this is an explicit prop rather than CSS-generated text.
   */
  labelled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deferred, setDeferred] = useState(false);
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

  const options = effortOptions(metadata);
  if (options.length === 0) return null;
  const selected = effort && options.includes(effort) ? effort : options[Math.floor(options.length / 2)]!;

  const change = async (next: string): Promise<void> => {
    if (!client || !threadId) return;
    setBusy(true);
    try {
      const result = await client.call<{ appliesTo?: string }>("thread/effort/set", {
        threadId,
        reasoningEffort: next,
      });
      setDeferred(result.appliesTo === "nextTurn");
      setOpen(false);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not change reasoning effort");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="effort-picker" ref={rootRef}>
      <button
        className="effort-trigger"
        type="button"
        disabled={busy || !threadId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={labelled ? `Reasoning effort: ${selected}` : undefined}
        title={`Reasoning effort: ${selected}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{labelled ? selected.slice(0, 1).toUpperCase() + selected.slice(1) : `Effort ${selected}`}</span>
        <span className="model-trigger-chevron" data-open={open || undefined}><ChevronIcon /></span>
      </button>
      {open && (
        <div className="effort-menu" id={id} role="menu" aria-label="Reasoning effort">
          {options.map((entry) => (
            <button
              className="effort-option"
              data-selected={entry === selected || undefined}
              role="menuitemradio"
              aria-checked={entry === selected}
              disabled={busy}
              key={entry}
              onClick={() => void change(entry)}
            >
              <span><strong>{entry.slice(0, 1).toUpperCase()}{entry.slice(1)}</strong>{DESCRIPTIONS[entry] && <small>{DESCRIPTIONS[entry]}</small>}</span>
              <span className="model-check">{entry === selected && <CheckIcon />}</span>
            </button>
          ))}
        </div>
      )}
      {deferred && turnActive && <span className="model-note" role="status">Effort applies next turn</span>}
    </div>
  );
}
