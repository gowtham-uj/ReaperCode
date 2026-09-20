/**
 * Every browser event, recorded once, with the metrics derived from the record.
 *
 * The bug this exists to prevent was visible in a mission summary that reported
 * `failure_count: 0` for a run in which fourteen browser calls had failed. The
 * count was not wrong because a counter was mis-incremented; it was wrong
 * because the counter and the browser were two different things. The runtime
 * knew a call had failed and incremented a number somewhere, and the summary
 * read a different number that nothing had incremented, and there was no way to
 * tell which of them was lying because neither was derived from anything.
 *
 * So there are no counters. There is one append-only list of events, and every
 * number in a summary is a fold over that list. A failure cannot be invisible,
 * because the event that records the failure is the same event the count reads,
 * and a count that disagrees with the list it was computed from is not a bug
 * that can be written by accident.
 *
 * The ledger also carries evidence rather than conclusions, which is what makes
 * it usable by the verifier: "an invoice artifact exists" and "a download event
 * was raised by action a117" are two separate facts, and a benchmark that
 * requires the second cannot be satisfied by the first.
 */

export type LedgerEventKind =
  | "mission.started"
  | "mission.finish_requested"
  | "mission.verified"
  | "mission.rejected"
  | "action.started"
  | "action.finished"
  | "page.created"
  | "page.closed"
  | "artifact.saved"
  | "recovery.performed"
  | "observation.made"
  | "model.call";

interface BaseEvent {
  /** Monotonic, so the list has an order independent of timestamps. */
  seq: number;
  at: number;
}

export interface ActionStarted extends BaseEvent {
  kind: "action.started";
  actionId: string;
  /** What the model said it was doing. */
  intent?: string;
  pageId?: string;
}

export interface ActionFinished extends BaseEvent {
  kind: "action.finished";
  actionId: string;
  status: "success" | "failed" | "recovered" | "blocked";
  failureKind?: string;
  durationMs: number;
  pageId?: string;
  /** The action this one retried, when it was a retry. */
  retryOf?: string;
}

export interface PageCreated extends BaseEvent {
  kind: "page.created";
  pageId: string;
  /**
   * How the page came to exist.
   *
   * This is the field a benchmark provenance check reads, and it is why it is
   * recorded rather than inferred. `popup` means a click on another page caused
   * it; `newPage` means the program asked for it. Those are different acts and
   * a task that requires the first is not satisfied by the second.
   */
  creationType: "popup" | "newPage" | "restored" | "recovery";
  parentPageId?: string;
  /** The action whose click produced this page, when a popup. */
  openedBy?: string;
  url?: string;
}

export interface PageClosed extends BaseEvent {
  kind: "page.closed";
  pageId: string;
}

export interface ArtifactSaved extends BaseEvent {
  kind: "artifact.saved";
  name: string;
  path: string;
  bytes: number;
  /** The action that triggered it, so a download can be tied to a click. */
  triggeredBy?: string;
  /** True when Playwright raised a download event rather than a file appearing. */
  announced: boolean;
}

export interface RecoveryPerformed extends BaseEvent {
  kind: "recovery.performed";
  pageId: string;
  /** The action that was retried after the recovery, when one was. */
  actionId?: string;
  attempt: number;
}

export interface ObservationMade extends BaseEvent {
  kind: "observation.made";
  /** The level of the perception ladder this observation came from. */
  level: number;
  chars: number;
  actionId?: string;
}

export interface ModelCall extends BaseEvent {
  kind: "model.call";
  inputTokens: number;
  outputTokens: number;
}

export type LedgerEvent =
  | { kind: "mission.started"; seq: number; at: number; goal?: string }
  | { kind: "mission.finish_requested"; seq: number; at: number }
  | { kind: "mission.verified"; seq: number; at: number; requirements: string[] }
  | { kind: "mission.rejected"; seq: number; at: number; missing: string[] }
  | ActionStarted
  | ActionFinished
  | PageCreated
  | PageClosed
  | ArtifactSaved
  | RecoveryPerformed
  | ObservationMade
  | ModelCall;

/**
 * The numbers a summary reports, all of them folds over the events.
 *
 * Named as a flat record rather than computed lazily per caller so there is one
 * definition of each metric. Two implementations of "how many calls failed" is
 * the same class of bug as the counter this replaced.
 */
export interface LedgerMetrics {
  browserCalls: number;
  successfulCalls: number;
  failedCalls: number;
  recoveredCalls: number;
  timeoutFailures: number;
  retries: number;
  recoveries: number;
  popups: number;
  pagesCreated: number;
  pagesClosed: number;
  downloads: number;
  downloadBytes: number;
  observations: number;
  observationChars: number;
  inputTokens: number;
  outputTokens: number;
  totalMs: number;
  /** Failures by kind, so a run's shape is visible without reading the list. */
  failuresByKind: Record<string, number>;
}

/** An append-only record of what the browser did. */
export class RunLedger {
  private readonly log: LedgerEvent[] = [];
  private nextSeq = 1;

  /**
   * The most events one ledger keeps.
   *
   * The log is append-only, which is what makes the metrics trustworthy, and
   * append-only is also unbounded: a mission of a hundred programs appends a few
   * hundred events, but a long-lived thread with several missions in it appends
   * indefinitely and holds every one. This is a per-thread object held for the
   * life of the thread, so that is a leak with a name.
   *
   * Ten thousand is chosen to be far above any real run rather than near it. A
   * hundred-program mission produces roughly three events each, so this is
   * thirty times the largest run measured, and the trim is a backstop against a
   * pathological thread rather than a working limit. When it does fire, the
   * oldest events go: a metric that stops being exact after ten thousand events
   * still describes the run, and losing the middle of a very long history is
   * better than dying.
   */
  private static readonly MAX_EVENTS = 10_000;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Append one event.
   *
   * The only mutation this class allows. Everything else reads. That is the
   * whole design: a ledger that can be edited is a ledger that can disagree with
   * itself, and the failure this replaced was exactly that.
   */
  record(event: DistributiveOmit<LedgerEvent, "seq" | "at">): LedgerEvent {
    const full = { ...event, seq: this.nextSeq++, at: this.now() } as LedgerEvent;
    this.log.push(full);
    /*
     * Trimmed from the front, and `seq` keeps counting rather than resetting.
     *
     * A sequence that restarted would make two different events share a number,
     * and the sequence is what the ledger uses to order events that landed in
     * the same millisecond. The count only ever grows, so a reader can still tell
     * that events were dropped and how many.
     */
    if (this.log.length > RunLedger.MAX_EVENTS) {
      this.log.splice(0, this.log.length - RunLedger.MAX_EVENTS);
      this.trimmed += 1;
    }
    return full;
  }

  /**
   * How many times the log has been trimmed.
   *
   * Reported rather than hidden. A metric computed over a trimmed log is still
   * a fold over what the ledger holds, and a reader has to know when that is
   * less than what happened, because the alternative is a number that looks
   * exact and is not.
   */
  private trimmed = 0;

  /** Whether any event has been dropped, so a caller can say so. */
  get truncated(): boolean {
    return this.trimmed > 0;
  }

  /** Every event, in order. */
  events(): readonly LedgerEvent[] {
    return this.log;
  }

  /** Events of one kind, narrowed. */
  of<K extends LedgerEvent["kind"]>(kind: K): Array<Extract<LedgerEvent, { kind: K }>> {
    return this.log.filter((event): event is Extract<LedgerEvent, { kind: K }> => event.kind === kind);
  }

  /**
   * Was a download raised by a UI action, rather than fetched by the program?
   *
   * The provenance question a benchmark asks, answered from evidence rather than
   * from the model's word. A file in the vault says a file exists; this says
   * Playwright raised a download event, and `triggeredBy` says which action
   * caused it.
   */
  downloadsFromActions(): ArtifactSaved[] {
    return this.of("artifact.saved").filter((event) => event.announced && event.triggeredBy !== undefined);
  }

  /** Popups that a click on another page caused, with the page that caused them. */
  popupsFromActions(): PageCreated[] {
    return this.of("page.created").filter((event) => event.creationType === "popup" && event.openedBy !== undefined);
  }

  /** Every metric, folded from the events. */
  metrics(): LedgerMetrics {
    const finished = this.of("action.finished");
    const artifacts = this.of("artifact.saved");
    const observations = this.of("observation.made");
    const calls = this.of("model.call");
    const start = this.log.find((event) => event.kind === "mission.started");
    const last = this.log[this.log.length - 1];

    const failuresByKind: Record<string, number> = {};
    let timeoutFailures = 0;
    for (const event of finished) {
      if (event.status !== "failed") continue;
      const kind = event.failureKind ?? "UNKNOWN";
      failuresByKind[kind] = (failuresByKind[kind] ?? 0) + 1;
      if (kind === "ACTION_TIMEOUT" || kind === "NAVIGATION_TIMEOUT") timeoutFailures++;
    }

    return {
      browserCalls: finished.length,
      successfulCalls: finished.filter((event) => event.status === "success").length,
      failedCalls: finished.filter((event) => event.status === "failed").length,
      recoveredCalls: finished.filter((event) => event.status === "recovered").length,
      timeoutFailures,
      retries: finished.filter((event) => event.retryOf !== undefined).length,
      recoveries: this.of("recovery.performed").length,
      popups: this.popupsFromActions().length,
      pagesCreated: this.of("page.created").length,
      pagesClosed: this.of("page.closed").length,
      downloads: artifacts.length,
      downloadBytes: artifacts.reduce((sum, event) => sum + event.bytes, 0),
      observations: observations.length,
      observationChars: observations.reduce((sum, event) => sum + event.chars, 0),
      inputTokens: calls.reduce((sum, event) => sum + event.inputTokens, 0),
      outputTokens: calls.reduce((sum, event) => sum + event.outputTokens, 0),
      totalMs: start !== undefined && last !== undefined ? last.at - start.at : 0,
      failuresByKind,
    };
  }

  /** The metrics as the model or a report reads them. */
  render(): string {
    const m = this.metrics();
    const kinds = Object.entries(m.failuresByKind)
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => `${kind} x${count}`)
      .join(", ");
    const lines = [
      `CALLS: ${m.browserCalls} (${m.successfulCalls} ok, ${m.failedCalls} failed, ${m.recoveredCalls} recovered)`,
      `RETRIES: ${m.retries}   RECOVERIES: ${m.recoveries}   TIMEOUTS: ${m.timeoutFailures}`,
      `PAGES: ${m.pagesCreated} created (${m.popups} from a click), ${m.pagesClosed} closed`,
      `ARTIFACTS: ${m.downloads} (${m.downloadBytes} bytes)`,
      `OBSERVATIONS: ${m.observations} (${m.observationChars} chars)`,
      /*
       * Token counts, printed only when something recorded one.
       *
       * The browser layer cannot know what the model was sent: that is core's
       * business, and this layer is deliberately extractable, so it must not
       * reach into the model layer to find out. Nothing in this directory
       * records a `model.call`, which means an unconditional line would read
       * `TOKENS: 0 in / 0 out` on every run, whatever the run cost.
       *
       * That is the same shape as the bug the ledger replaced. A summary that
       * said `failure_count: 0` for a run with fourteen failures was not wrong
       * because a counter mis-incremented; it was wrong because the number came
       * from somewhere that did not know. A zero that means "nobody told me" is
       * worse than no line, because it reads as a cheap run.
       *
       * So the fold stays (a host that does know can record `model.call` and the
       * number becomes real), and the line appears only when a call has been
       * recorded.
       */
      ...(m.inputTokens > 0 || m.outputTokens > 0 ? [`TOKENS: ${m.inputTokens} in / ${m.outputTokens} out`] : []),
      `ELAPSED: ${Math.round(m.totalMs / 1000)}s`,
    ];
    if (kinds.length > 0) lines.push(`FAILURES: ${kinds}`);
    return lines.join("\n");
  }
}

/** Omit that distributes over a union, so each member keeps its own fields. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
