/**
 * Who is driving the browser, and which generation of the conversation that
 * answer belongs to.
 *
 * Steel gives the human a live, interactive view of the same Chromium the agent
 * drives. That is the feature; it is also a race. Steel's viewer and the
 * agent's Playwright code talk to one browser, so without a rule for who owns
 * input, a click the agent decided on before the human took over can land while
 * the human is typing, and neither side sees the other's intent.
 *
 * Steel does not arbitrate this: its docs describe the shared session and the
 * interactive viewer, and there is no "human finished" event because the browser
 * cannot know what a task means. So the ownership rule lives here, above both,
 * and both sides ask it.
 *
 * ## The shape
 *
 * A lease is `{ owner, generation }`. `owner` is who may act. `generation`
 * increments on every handoff, and it is the part that closes the race rather
 * than merely describing it: an agent action carries the generation it was
 * decided under, and is refused if the generation has moved. That covers the
 * window a plain boolean misses, where the agent has already decided and is
 * about to act.
 *
 * ## Why the human handoff also invalidates perception
 *
 * When the human returns control, the page may be nowhere near where the agent
 * left it: a different URL, a login completed, a tab opened, an MFA challenge
 * passed. The agent's cached view is not stale in the ordinary sense of a few
 * seconds behind; it describes a page that may no longer exist. So returning
 * control drops the cached view and forces a fresh read, and the agent's next
 * step is told the state may have changed rather than being left to infer it
 * from a diff it did not see happen.
 */

export type ControlOwner = "agent" | "human";

export interface ControlLease {
  owner: ControlOwner;
  /**
   * Bumped on every handoff. An action carries the generation it was decided
   * under and is refused when this has moved, which is what stops an
   * already-decided action from landing after a takeover.
   */
  generation: number;
  /** When the current owner took the lease. For the UI's status line. */
  since: number;
}

/** What the browser tool is told when it may not act. */
export class BrowserControlPausedError extends Error {
  constructor(readonly lease: ControlLease) {
    super(
      "the user has taken control of the browser, so this action was not run. Nothing is wrong with the page or your program. " +
      // The instruction is "stop this turn", not "wait". A model told to wait
      // polls: observed doing `bash sleep 8` and retrying, which spends turns
      // and tokens to learn nothing, because the browser cannot tell anyone
      // that the user has finished. Only the user can, and they do it by
      // returning control, which starts a new turn with the page already read.
      "Stop this turn and tell the user the browser is theirs while they have it. Do not sleep, retry or poll: " +
      "the browser cannot report when they are done, so waiting only spends turns. When they return control, " +
      "the next turn begins with a fresh reading of the page and you can continue.",
    );
    this.name = "BrowserControlPausedError";
  }
}

/** What the browser tool is told when its action was decided before a handoff. */
export class BrowserLeaseStaleError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(
      `this action was decided under browser control generation ${expected}, but control has moved on ` +
      `(generation ${actual}). Nothing was run, because the page may have changed underneath it. ` +
      "Look at the page again and decide the step from what is there now.",
    );
    this.name = "BrowserLeaseStaleError";
  }
}

/**
 * A record of one human handoff, for the model and the UI.
 *
 * Deliberately about the *shape* of the change rather than the input. A human
 * takes over most often to type something the agent should not hold: a
 * password, an OTP, a card number, a CAPTCHA answer. Reporting keystrokes would
 * put exactly those values in the transcript, which is the opposite of why the
 * handoff exists. What the agent needs is "the page is not where you left it",
 * and URL and title changes say that without carrying a secret.
 */
export interface HandoffSummary {
  startedAt: number;
  endedAt: number;
  startedUrl: string;
  endedUrl: string;
  urlChanged: boolean;
  startedTitle: string;
  endedTitle: string;
  titleChanged: boolean;
  /** Whether the human opened or closed tabs, as a count delta. */
  tabDelta: number;
  /**
   * What changed during the handoff, as sentences.
   *
   * Semantic consequences, not input. "the page navigated to /jobs" is useful
   * and safe; "the user typed 382941" is neither, because the reason a human
   * takes over is usually to enter something the agent should not hold. The
   * list is a summary of *effects*, derived from navigation events and the
   * before/after comparison, and it is deliberately lossy about how they were
   * produced.
   */
  changes: string[];
}

/**
 * The leases, one per thread.
 *
 * Per-thread rather than one global, because the handoff is per-thread: the
 * user takes over the tab they are watching, and another thread's agent must
 * keep working. Keying by thread id is what makes "take control" a statement
 * about one conversation rather than about the browser process.
 */
export class BrowserControlRegistry {
  private readonly leases = new Map<string, ControlLease>();

  /** The lease for a thread, defaulting to agent control at generation 0. */
  lease(threadId: string): ControlLease {
    const existing = this.leases.get(threadId);
    if (existing) return existing;
    const fresh: ControlLease = { owner: "agent", generation: 0, since: Date.now() };
    this.leases.set(threadId, fresh);
    return fresh;
  }

  /**
   * Hand control to the human, and return the new lease.
   *
   * Idempotent in effect but not in generation: taking control twice while
   * already in human control bumps the generation again, because the second
   * request may arrive after an agent action was already admitted and the
   * cheapest safe answer is to invalidate anything in flight.
   */
  takeControl(threadId: string): ControlLease {
    const next: ControlLease = {
      owner: "human",
      generation: this.lease(threadId).generation + 1,
      since: Date.now(),
    };
    this.leases.set(threadId, next);
    return next;
  }

  /**
   * Return control to the agent, and return the new lease.
   *
   * The generation bump is the whole point: every action decided while the
   * human had control, or decided just before they took it, refers to an older
   * generation and is refused rather than replayed against a page that moved.
   */
  returnControl(threadId: string): ControlLease {
    const next: ControlLease = {
      owner: "agent",
      generation: this.lease(threadId).generation + 1,
      since: Date.now(),
    };
    this.leases.set(threadId, next);
    return next;
  }

  /**
   * Whether an agent action may run, and why not when it may not.
   *
   * Split from throwing so the caller can decide how to surface it: the tool
   * turns a refusal into a `tool_error` the model reads, and a test wants the
   * reason without catching.
   */
  checkAgentAction(threadId: string, expectedGeneration?: number): { ok: true } | { ok: false; reason: string } {
    const lease = this.lease(threadId);
    if (lease.owner === "human") return { ok: false, reason: "human-control" };
    if (expectedGeneration !== undefined && expectedGeneration !== lease.generation) {
      return { ok: false, reason: "stale-generation" };
    }
    return { ok: true };
  }

  /** Drop a thread's lease, for when its browser is closed. */
  forget(threadId: string): void {
    this.leases.delete(threadId);
  }
}

/**
 * Render a handoff as the message the model reads when control comes back.
 *
 * The important property is that it says two things and in this order: the
 * state may not be what you left, and here is what it actually is now. A model
 * given only the first guesses; one given only the second may not realise its
 * plan was built against a different page and act on a stale intention. Both,
 * with the fresh read last and labelled authoritative, is what makes the next
 * step correct.
 *
 * The current perception is included verbatim rather than summarised, because
 * it *is* the page: the same text a `view()` would return, so the model reads it
 * the same way it reads any other look at the page.
 */
export function renderHandoffEvent(summary: HandoffSummary, currentPerception: string): string {
  const lines: string[] = [
    "HUMAN CONTROL RETURNED: the user was driving the browser, so the page may not be where you left it.",
    "",
    `before: ${summary.startedUrl}${summary.startedTitle ? ` ("${summary.startedTitle}")` : ""}`,
    `after:  ${summary.endedUrl}${summary.endedTitle ? ` ("${summary.endedTitle}")` : ""}`,
  ];
  if (summary.changes.length > 0) {
    lines.push("", "what changed while the user had control:");
    for (const change of summary.changes) lines.push(`- ${change}`);
  }
  lines.push(
    "",
    "The browser below is authoritative: re-read it and decide your next step from this state rather than from the plan you had before.",
    "",
    currentPerception,
  );
  return lines.join("\n");
}
