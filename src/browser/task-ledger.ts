/**
 * Where a task has got to, kept outside the model's history.
 *
 * The problem this solves is not memory, it is attention. A browsing task runs
 * for twenty steps, and without something holding the shape of it the model
 * either re-derives its position from fifteen stale observations or loses the
 * thread entirely. Both cost more than the ledger does.
 *
 * So Reaper keeps the state and regenerates one small block every turn:
 *
 *   GOAL      Apply to AI Engineer
 *   DONE      x opened job, x application started, x contact info
 *   CURRENT   demographics
 *   NEXT      review (likely)
 *   BLOCKERS  none
 *   CHANGED   location -> Dallas (by the user)
 *
 * Three design rules, each of which is a way this could have gone wrong:
 *
 * **It is written by Reaper, not by the model.** The model may propose an entry
 * (it knows when it has finished something), but the ledger is updated by
 * observed outcomes — a postcondition that held, a user edit detected on
 * handback, a blocker the verifier found. A ledger the model maintains by
 * introspection is a ledger that drifts, and a drifted ledger is worse than no
 * ledger because the model trusts it.
 *
 * **It is bounded, and bounded by collapsing rather than by truncating.** Five
 * field fills on one form collapse into one entry, because "filled the
 * application form" is the fact and the five fields are not. Truncating instead
 * would silently drop the oldest entries, which are exactly the ones that
 * establish where the task started.
 *
 * **It distinguishes what the agent did from what the user did.** The `CHANGED`
 * line exists for the handback case, where a person edited the page and the
 * model has to continue from a state it never produced. That is the one place
 * the model cannot infer its way to the truth, so it is stated.
 */

/** What one line of the ledger records. */
export interface LedgerEntry {
  /** A short phrase, in the past tense: "opened job", "contact info". */
  text: string;
  /** Epoch ms, for ordering and for collapsing runs. */
  at: number;
  /** Which section or step this belongs to, for collapsing. */
  key?: string | undefined;
}

/** A change made by someone other than the agent, which the agent must adopt. */
export interface LedgerChange {
  /** What changed: "location", "email". */
  field: string;
  /** The new value, or undefined when the change is a removal. */
  value?: string | undefined;
  /** Who made it. Only "user" today; "operator" once the pane has controls. */
  by: "user" | "operator";
  at: number;
}

export interface LedgerState {
  goal: string | undefined;
  done: LedgerEntry[];
  current: string | undefined;
  next: string | undefined;
  blockers: string[];
  changes: LedgerChange[];
}

/**
 * How many DONE entries are kept.
 *
 * Twelve is enough for every flow we have looked at (a Greenhouse application
 * is five steps, a checkout is three) with room for the incidental work around
 * them, and short enough that the block stays around a hundred tokens. The cap
 * is on entries, not on characters, because an entry is already a collapsed
 * phrase rather than a sentence.
 */
export const LEDGER_MAX_DONE = 12;

/** How many user changes ride along. Beyond this the oldest stop mattering. */
export const LEDGER_MAX_CHANGES = 5;

/**
 * The character budget for the whole block.
 *
 * The entry cap alone is not a budget: twelve entries of forty characters is
 * four times twelve entries of ten, and how long an entry is depends on what
 * the caller wrote. Measured rather than assumed — the twelve-entry cap with
 * realistic phrasing renders around 300 characters, and with verbose phrasing
 * approaches 1000.
 *
 * 600 characters is roughly 150 tokens, which is the share of an observation
 * this is worth. A block that costs more than the page it accompanies has
 * failed at its only job, so the cap is enforced rather than hoped for.
 */
export const LEDGER_MAX_CHARS = 600;

export class TaskLedger {
  private state: LedgerState = { goal: undefined, done: [], current: undefined, next: undefined, blockers: [], changes: [] };

  /**
   * The goal, stated once.
   *
   * Setting a new goal resets everything else, because a new goal is a new task
   * and carrying the previous one's DONE list into it would have the model
   * believe work it never did is already finished.
   */
  setGoal(goal: string | undefined): void {
    if (goal === this.state.goal) return;
    this.state = { goal, done: [], current: undefined, next: undefined, blockers: [], changes: [] };
  }

  get goal(): string | undefined {
    return this.state.goal;
  }

  /**
   * Record something finished.
   *
   * `key` is what collapsing works on: two entries with the same key replace
   * rather than accumulate, which is how five `.fill()` calls on one form become
   * one line. Callers that pass no key get one entry per call, which is correct
   * for genuinely distinct steps.
   */
  complete(text: string, options: { key?: string; at?: number } = {}): void {
    const entry: LedgerEntry = { text, key: options.key, at: options.at ?? Date.now() };
    if (options.key) {
      // Same subject means the newer statement supersedes the older one, so the
      // ledger reports the current fact rather than a history of edits to it.
      this.state.done = this.state.done.filter((existing) => existing.key !== options.key);
    }
    this.state.done.push(entry);
    if (this.state.done.length > LEDGER_MAX_DONE) {
      this.state.done = this.state.done.slice(-LEDGER_MAX_DONE);
    }
    // Progress invalidates an earlier blocker: the thing that was stuck moved.
    this.state.blockers = [];
  }

  /** Where the task is now. */
  setCurrent(step: string | undefined): void {
    this.state.current = step;
  }

  /** Where it is likely to go next, from the flow memory. A hint, not a claim. */
  setNext(step: string | undefined): void {
    this.state.next = step;
  }

  /** Something blocking progress. Replaces any previous blocker. */
  addBlocker(blocker: string): void {
    if (!this.state.blockers.includes(blocker)) this.state.blockers.push(blocker);
  }

  clearBlockers(): void {
    this.state.blockers = [];
  }

  /**
   * A change the user made, to be adopted rather than re-derived.
   *
   * Keyed by field so a second edit to the same field replaces the first: the
   * model needs the current value of `location`, not the sequence of values it
   * has had.
   */
  recordUserChange(field: string, value: string | undefined, by: "user" | "operator" = "user", at?: number): void {
    const change: LedgerChange = { field, value, by, at: at ?? Date.now() };
    this.state.changes = this.state.changes.filter((existing) => existing.field !== field);
    this.state.changes.push(change);
    if (this.state.changes.length > LEDGER_MAX_CHANGES) {
      this.state.changes = this.state.changes.slice(-LEDGER_MAX_CHANGES);
    }
  }

  /**
   * Drop the oldest DONE entries until the block fits its budget.
   *
   * Called from `render` rather than from every mutator, because the character
   * count depends on the whole block: a goal line and a CHANGED line both take
   * room that an entry's text does not know about. Doing it at render time is
   * also idempotent, so rendering twice cannot shrink the ledger twice.
   *
   * Dropping the oldest rather than the newest is the only sensible direction.
   * The newest entries are what the model is about to build on; the oldest are
   * where it started, which the goal line already says.
   */
  private fitToBudget(): void {
    while (this.state.done.length > 1 && this.build().length > LEDGER_MAX_CHARS) {
      this.state.done = this.state.done.slice(1);
    }
  }

  /**
   * Fold a user edit back into the ledger as finished work.
   *
   * Called on handback: the model was driving, the user took over, edited
   * something, and handed it back. The edit is now part of the task's history,
   * so it belongs in DONE as well as in CHANGED — CHANGED tells the model what
   * is different, DONE tells it not to redo it.
   */
  adoptUserChanges(): void {
    /*
     * The blockers are saved and restored rather than left to `complete`.
     * `complete` clears them because finishing a step is evidence the thing
     * that was stuck moved; adopting a user edit is not, and a handback in the
     * middle of a CAPTCHA would otherwise silently lose the blocker.
     */
    const blockers = this.state.blockers;
    for (const change of this.state.changes) {
      this.complete(`you set ${change.field} to ${change.value ?? "(cleared)"}`, { key: `user:${change.field}`, at: change.at });
    }
    this.state.blockers = blockers;
  }

  get changes(): readonly LedgerChange[] {
    return this.state.changes;
  }

  /** Whether anything at all is worth saying. */
  get isEmpty(): boolean {
    return (
      this.state.goal === undefined &&
      this.state.done.length === 0 &&
      this.state.current === undefined &&
      this.state.blockers.length === 0 &&
      this.state.changes.length === 0
    );
  }

  /** The raw state, for persistence and for tests. */
  snapshot(): LedgerState {
    return structuredClone(this.state);
  }

  /**
   * The block the model reads.
   *
   * Every line is omitted when it has nothing to say, so a fresh task renders as
   * a single GOAL line rather than six lines of "none". That matters more than
   * it looks: a block that always occupies the same height trains the reader to
   * skip it, and the one time it says something it gets skipped too.
   *
   * `pending` is the goal name of the flow step from the flow memory, passed in
   * rather than held, because the flow is per-host and this is per-task.
   */
  render(): string {
    if (this.isEmpty) return "";
    this.fitToBudget();
    return this.build();
  }

  /** The block as it stands, without touching the ledger. */
  private build(): string {
    const lines: string[] = [];
    if (this.state.goal) lines.push(`GOAL      ${this.state.goal}`);
    if (this.state.done.length > 0) {
      // One line, comma-joined. A DONE list that wraps costs more than it says.
      const done = this.state.done.map((entry) => `x ${entry.text}`).join(", ");
      lines.push(`DONE      ${done}`);
    }
    if (this.state.current) lines.push(`CURRENT   ${this.state.current}`);
    if (this.state.next) lines.push(`NEXT      ${this.state.next}`);
    if (this.state.blockers.length > 0) lines.push(`BLOCKERS  ${this.state.blockers.join("; ")}`);
    if (this.state.changes.length > 0) {
      const changes = this.state.changes
        .map((change) => `${change.field} -> ${change.value ?? "(cleared)"} (by the ${change.by})`)
        .join(", ");
      lines.push(`CHANGED   ${changes}`);
    }
    return lines.join("\n");
  }
}
