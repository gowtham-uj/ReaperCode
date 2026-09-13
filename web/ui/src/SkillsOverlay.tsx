import { useEffect, useMemo, useRef, useState } from "react";
import type { JsonRpcClient } from "@reaper/web-shared";

import { CheckIcon, CloseIcon } from "./icons.jsx";
import type { SettingsStore, SkillEntry } from "./settings.js";
import { describeSkillCost, pinBlockReason } from "./skills-command.js";

/**
 * The `/skills` overlay.
 *
 * Opened by typing `/skills` at the head of a message. It answers the two
 * questions a skill list is actually for — "what have I got?" and "which of
 * these should be simply true all the time?" — and nothing else. There is no
 * activate button, because activation is already the `/skillname` prefix and a
 * second way to do it would be a second thing to keep correct.
 *
 * The one write it performs is pinning, through the same `settings/write` RPC
 * the Settings screen uses. A pin is a *name*; the body is resolved server-side
 * against the skills that already passed the project-trust gate, so this
 * overlay can never widen what a turn can reach — only choose from what the
 * turn was going to be offered anyway.
 */
/** How many rows the unfiltered list shows before offering the rest. */
const LIST_CAP = 60;

export function SkillsOverlay({
  store,
  client,
  initialFilter,
  onClose,
  onUse,
  onError,
}: {
  store: SettingsStore;
  client: JsonRpcClient | undefined;
  initialFilter?: string | undefined;
  onClose(): void;
  /** Put `/<name> ` in the composer, so the next message loads this skill. */
  onUse(name: string): void;
  onError(message: string | undefined): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [filter, setFilter] = useState(initialFilter ?? "");
  const [busy, setBusy] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const titleId = "skills-overlay-title";

  useEffect(() => {
    const element = dialogRef.current;
    if (!element || element.open) return;
    element.showModal();
  }, []);

  // Skills are loaded once per opening rather than held live: the list changes
  // when someone edits a file on disk, and a dialog that is only ever open for
  // a few seconds is the wrong place to run a subscription.
  useEffect(() => {
    void store.refreshSkills(client);
  }, [client, store.refreshSkills]);

  const query = filter.trim().toLowerCase();
  const { shown, hiddenCount } = useMemo(() => {
    const matches = query
      ? store.skills.filter((skill) =>
        skill.name.toLowerCase().includes(query)
        || skill.description.toLowerCase().includes(query)
        || skill.category.toLowerCase().includes(query))
      : store.skills;
    /*
     * A cap on the unfiltered list, not on search. Opening the overlay on a
     * machine with two hundred skills should offer a starting point rather
     * than a wall; but once the user has typed, they have said which one they
     * want, and hiding the thing they just described would be absurd.
     */
    if (query || showAll || matches.length <= LIST_CAP) return { shown: matches, hiddenCount: 0 };
    return { shown: matches.slice(0, LIST_CAP), hiddenCount: matches.length - LIST_CAP };
  }, [store.skills, query, showAll]);

  const pinned = store.settings?.pinnedSkills ?? [];
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const offList = store.settings?.disabledSkills ?? [];
  const offSet = useMemo(() => new Set(offList), [offList]);

  /**
   * The switch, and the one interaction rule it carries.
   *
   * Switching a skill off and leaving it pinned would be a state that reads as
   * contradictory on screen and resolves silently one way on the server — the
   * pin is dropped, because a disabled skill's body is never injected. So the
   * pin is cleared in the same write. Doing it here rather than server-side
   * keeps the rule where the user can see it happen rather than discovering it
   * later; `resolvePinnedSkills` drops it regardless, so this is about the
   * screen agreeing with the turn, not about safety.
   */
  const writeDisabled = async (nextOff: string[], name: string, wasOff: boolean): Promise<void> => {
    if (!client) return;
    setBusy(name);
    setStatus(undefined);
    try {
      const nextPins = wasOff ? pinned : pinned.filter((entry) => entry !== name);
      await store.saveSettings(client, {
        disabledSkills: nextOff,
        ...(nextPins.length !== pinned.length ? { pinnedSkills: nextPins } : {}),
      });
      await store.refreshSkills(client);
      onError(undefined);
      setStatus(wasOff
        ? `“${name}” is on again — it is offered to the model and can be loaded by name.`
        : `“${name}” is off. It is not offered to the model and cannot be loaded by name.`);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not change this skill");
    } finally {
      setBusy(undefined);
    }
  };

  const writePins = async (next: string[], name: string): Promise<void> => {
    if (!client) return;
    setBusy(name);
    setStatus(undefined);
    try {
      await store.saveSettings(client, { pinnedSkills: next });
      onError(undefined);
      setStatus(next.includes(name)
        ? `“${name}” is always on — its body now rides in every turn.`
        : `“${name}” is no longer always on.`);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not change always-on skills");
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <dialog
      className="skills-dialog"
      ref={dialogRef}
      aria-labelledby={titleId}
      // Escape, the close button, and a backdrop click all land here, so React
      // state and the element's own `open` cannot disagree.
      onClose={onClose}
      onClick={(event) => { if (event.target === dialogRef.current) onClose(); }}
    >
      <div className="skills-panel">
        <header className="skills-header">
          <div>
            <h2 id={titleId}>Skills</h2>
            <p>
              Type <code className="inline-code">/name</code> at the start of a message to load one into that turn.
              A skill marked <em>always on</em> loads by itself, every turn.
            </p>
          </div>
          <button className="icon-button" type="button" aria-label="Close skills" onClick={onClose}><CloseIcon /></button>
        </header>

        <div className="skills-toolbar">
          <label className="sr-only" htmlFor="skills-filter">Filter skills</label>
          <input
            id="skills-filter"
            className="settings-search skills-filter"
            type="search"
            autoFocus
            placeholder="Filter by name, description, or category…"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filter) {
                // First Escape clears the filter; a second closes. Losing the
                // whole overlay to a typo in the filter would be annoying.
                event.preventDefault();
                event.stopPropagation();
                setFilter("");
              }
            }}
          />
          <span className="skills-count" aria-live="polite">
            {store.skills.length === 0 ? "none" : `${store.skills.length} installed`}
          </span>
        </div>

        {status && <p className="skills-status" role="status">{status}</p>}
        {store.skillErrors.length > 0 && (
          <p className="field-error" role="alert">
            {store.skillErrors.length} skill file(s) could not be read: {store.skillErrors.map((entry) => entry.path).join(", ")}
          </p>
        )}

        <div className="skills-body">
          {store.skills.length === 0 ? (
            <p className="empty">No skills are installed. Add one under Settings → Capabilities.</p>
          ) : shown.length === 0 ? (
            <p className="empty">Nothing matches “{filter.trim()}”.</p>
          ) : (
            <ul className="skills-list">
              {shown.map((skill) => (
                <SkillRow
                  key={`${skill.scope}:${skill.name}`}
                  skill={skill}
                  pinned={pinnedSet.has(skill.name)}
                  off={offSet.has(skill.name)}
                  busy={busy === skill.name}
                  disabled={!client || busy !== undefined}
                  onToggle={() => void writePins(
                    pinnedSet.has(skill.name)
                      ? pinned.filter((entry) => entry !== skill.name)
                      : [...pinned, skill.name],
                    skill.name,
                  )}
                  onToggleOff={() => void writeDisabled(
                    offSet.has(skill.name)
                      ? offList.filter((entry) => entry !== skill.name)
                      : [...offList, skill.name],
                    skill.name,
                    offSet.has(skill.name),
                  )}
                  onUse={() => onUse(skill.name)}
                />
              ))}
            </ul>
          )}
          {hiddenCount > 0 && (
            <button className="skills-more" type="button" onClick={() => setShowAll(true)}>
              Show {hiddenCount} more
            </button>
          )}
        </div>

        <footer className="skills-footer">
          <span className="skills-footer-hint">
            {pinned.length > 0
              ? <><strong>{pinned.length}</strong> always on: {pinned.join(", ")}</>
              : "No skills are always on."}
          </span>
          <button className="skills-done" type="button" onClick={onClose}>Done</button>
        </footer>
      </div>
    </dialog>
  );
}

function SkillRow({
  skill,
  pinned,
  off,
  busy,
  disabled,
  onToggle,
  onToggleOff,
  onUse,
}: {
  skill: SkillEntry;
  pinned: boolean;
  off: boolean;
  busy: boolean;
  disabled: boolean;
  onToggle(): void;
  onToggleOff(): void;
  onUse(): void;
}) {
  const blocked = pinBlockReason(skill);
  const label = pinned ? `Turn off always-on for ${skill.name}` : `Make ${skill.name} always on`;

  return (
    <li className="skills-row" data-pinned={pinned || undefined} data-off={off || undefined} data-disabled={skill.disabled || undefined}>
      <div className="skills-row-main">
        <div className="skills-row-head">
          <span className="skills-name">{skill.name}</span>
          <span className="trust-badge" data-trust={skill.trust}>{skill.trust}</span>
          {pinned && <span className="status-badge" data-status="enabled">always on</span>}
          {off && <span className="status-badge" data-status="disabled">off</span>}
        </div>
        <p className="skills-description">{skill.description}</p>
        <div className="skills-meta">
          <span>{skill.scope}</span>
          <span>{skill.category}</span>
          {skill.extensionId && <span>from {skill.extensionId}</span>}
          {skill.disabled && <span>{skill.disabledReason ?? "disabled"}</span>}
        </div>
      </div>

      <div className="skills-row-actions">
        {/*
          * Both actions are always present, so the row's width does not jump
          * as the pointer moves down the list — a list where the second button
          * appears only on hover is a list you cannot scan with the keyboard.
          */}
        <button className="skills-action" type="button" onClick={onUse} aria-label={`Use ${skill.name} in the next message`}>
          Use
        </button>
        <button
          className="skills-action skills-pin"
          type="button"
          aria-pressed={pinned}
          aria-label={label}
          title={blocked && !pinned ? blocked : label}
          /*
           * Pinning a skill that is switched off is refused on purpose, and the
           * button says why rather than silently doing nothing. A skill you
           * have switched off cannot ride in every turn — that is what off
           * means — so the pin would be stored and then dropped at resolution
           * time, which is the worst of both: the screen says always on and the
           * prompt has never heard of it.
           */
          disabled={disabled || off || (blocked !== undefined && !pinned)}
          onClick={onToggle}
        >
          {pinned ? <CheckIcon /> : null}
          <span>{busy ? "…" : pinned ? "On" : "Always on"}</span>
        </button>
        <button
          className="skills-action skills-off"
          type="button"
          aria-pressed={off}
          aria-label={off ? `Switch ${skill.name} on` : `Switch ${skill.name} off`}
          title={off ? `Offer ${skill.name} to the model again` : `Keep ${skill.name} out of this workspace`}
          disabled={disabled}
          onClick={onToggleOff}
        >
          <span>{busy ? "…" : off ? "Off" : "Switch off"}</span>
        </button>
      </div>
    </li>
  );
}
