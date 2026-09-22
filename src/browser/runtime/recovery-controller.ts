/**
 * The one place that decides whether a failed action is worth trying again.
 *
 * Two failure modes pull in opposite directions and both were present in the
 * measured mission.
 *
 * The model retried things that could not work. It re-ran an identical click
 * thirteen consecutive times, each time writing that the failure was probably
 * transient, and nothing ever told it the last twelve had been the same call on
 * the same page in the same state. A retry of an action that failed for a
 * structural reason is not a retry, it is a loop.
 *
 * The model also failed to retry the one thing that would have worked. A page
 * whose renderer had stopped accepting input failed an action, and the fix
 * (replace the renderer, retry once) took thirty trace blocks to discover by
 * hand because the runtime knew it was possible and never did it.
 *
 * So the decision is made here, from the failure kind and the page's health,
 * rather than by the model and rather than by a generic "retry 3 times" wrapper
 * that would repeat a server rejection three times and call it resilience.
 *
 * The rules, and why each is what it is:
 *
 *   DETACHED                 the page re-rendered under the action; retry once
 *   NOT_RECEIVING_EVENTS     often transient; wait for actionability, retry once
 *   PAGE_CRASHED             recover the renderer, retry once
 *   page unhealthy           recover, retry once, whatever the error said
 *   NAVIGATION_TIMEOUT       retry once; a dead host fails twice and stops
 *   LOCATOR_NOT_FOUND        never: the element is not there, and waiting again
 *                            does not put it there
 *   LOCATOR_AMBIGUOUS        never: the same locator matches the same two nodes
 *   NOT_VISIBLE, ZERO_AREA,
 *   NOT_ENABLED, NOT_EDITABLE
 *                            never: the element's own state, unchanged by time
 *
 * Every retry is fingerprinted, so the same action in the same page state is
 * refused the second time it is asked for rather than the fifth. That check is
 * what turns "the model is looping" from a thing an observer notices into a
 * thing the runtime reports.
 *
 * The page state is the URL plus a signature of the content, not an observation
 * counter. The counter was the first key and it was wrong: an observation moves
 * the counter and not the page, so the refusal was released by the model looking,
 * which is the one thing a model in a loop does between attempts.
 */

import { classifyFailure, type BrowserFailure, type BrowserFailureKind } from "./failure.js";

export interface RecoveryDeps {
  /**
   * Whether the page is still accepting trusted input.
   *
   * Injected rather than imported because it needs a real page and a real CDP
   * connection, and because a test wants to answer it without either.
   */
  probeInput(page: unknown): Promise<{ delivered: boolean; note: string }>;
  /** Replace the page's renderer. The runtime's `recover`. */
  recover(page: unknown): Promise<unknown>;
}

export interface AttemptOptions {
  page: unknown;
  /** The model's intent, for the ledger. */
  intent?: string | undefined;
  /**
   * What the page looked like when the action was decided.
   *
   * Either of these makes a fingerprint a statement about a page state rather
   * than about a program, which is what lets the same call after a real change be
   * a different attempt.
   *
   * `state` is the URL plus a signature of the content, and it is preferred.
   * `revision` is an observation counter, and it is a poor key: it moves every
   * time the model looks, so two identical attempts separated by a look got two
   * fingerprints and the second was allowed even though the page had not changed.
   * It is kept for a caller that has only a counter, and `attempt` falls back to
   * it when no state is given.
   */
  state?: string | undefined;
  revision?: number | undefined;
  /** The action's source or a stable description of it, for the fingerprint. */
  actionKey: string;
}

export interface AttemptOutcome<T> {
  value?: T;
  error?: unknown;
  failure?: BrowserFailure;
  /** How many times the action actually ran. */
  attempts: number;
  recovered: boolean;
  /** Set when the action was refused before running because it had already failed. */
  blocked?: BrowserFailure;
}

/**
 * Which failures are worth one more try.
 *
 * A table rather than a chain of conditions so the policy is readable in one
 * place and reviewable as a whole. `recover` means the renderer is replaced
 * before the retry; `probe` means the page's input health is checked first and
 * the retry only happens if the page is alive or was recovered.
 */
const RETRY_POLICY: Record<BrowserFailureKind, { retry: boolean; recover: boolean; probe: boolean }> = {
  DETACHED: { retry: true, recover: false, probe: false },
  NOT_RECEIVING_EVENTS: { retry: true, recover: false, probe: true },
  PAGE_CRASHED: { retry: true, recover: true, probe: false },
  RENDERER_UNRESPONSIVE: { retry: true, recover: true, probe: false },
  NAVIGATION_TIMEOUT: { retry: true, recover: false, probe: false },
  DOWNLOAD_FAILED: { retry: true, recover: false, probe: false },
  ACTION_TIMEOUT: { retry: false, recover: true, probe: true },
  LOCATOR_NOT_FOUND: { retry: false, recover: false, probe: false },
  LOCATOR_AMBIGUOUS: { retry: false, recover: false, probe: false },
  NOT_VISIBLE: { retry: false, recover: false, probe: false },
  ZERO_AREA: { retry: false, recover: false, probe: false },
  NOT_ENABLED: { retry: false, recover: false, probe: false },
  NOT_EDITABLE: { retry: false, recover: false, probe: false },
  PAGE_CLOSED: { retry: false, recover: false, probe: false },
  POPUP_NOT_CREATED: { retry: false, recover: false, probe: false },
  POSTCONDITION_FAILED: { retry: false, recover: false, probe: false },
  FORM_VALIDATION: { retry: false, recover: false, probe: false },
  SERVER_REJECTION: { retry: false, recover: false, probe: false },
  POLICY_VIOLATION: { retry: false, recover: false, probe: false },
  /*
   * The runtime's own refusals. None is retryable, and that is the point: a page
   * that is not open does not open by being asked again, and an argument that is
   * the wrong shape is not fixed by time.
   */
  PAGE_NOT_FOUND: { retry: false, recover: false, probe: false },
  INVALID_ARGUMENT: { retry: false, recover: false, probe: false },
  MISSING_AWAIT: { retry: false, recover: false, probe: false },
  UNKNOWN: { retry: false, recover: false, probe: false },
};

/**
 * The identity of one attempt: the page state and the program.
 *
 * `state` is the URL plus a signature of the page content, and it is preferred
 * wherever a caller has one. What it replaces is an observation counter, and the
 * difference was a real hole: `revision` increments on every look at the page, so
 * a model that glanced at the page between two identical attempts was handed a
 * fresh fingerprint and ran the same failing program again. Looking is not
 * progress, and a key that says it is turns the refusal into something a loop
 * can shed by doing the one thing a stuck model does constantly.
 *
 * The action key is still in the fingerprint, so the same program against a
 * genuinely new state is allowed and a different program against the same state
 * is a different attempt.
 */
function fingerprintOf(actionKey: string, state: string): string {
  return `${state}::${actionKey.slice(0, 300)}`;
}

export class RecoveryController {
  /**
   * Attempts that already failed, keyed by fingerprint.
   *
   * Bounded, because a long mission makes many attempts and this is a guard
   * against loops rather than a history. Old entries are dropped from the front,
   * which is the right end: a loop is always local in time, and forgetting the
   * beginning of a mission cannot hide one.
   */
  private readonly failed = new Map<string, BrowserFailure>();
  private static readonly MAX_FINGERPRINTS = 200;

  constructor(private readonly deps: RecoveryDeps) {}

  /**
   * Run an action, and decide what a failure means.
   *
   * Returns rather than throws, with the failure attached, because the caller
   * needs to build a receipt either way and a thrown error loses the attempts
   * count that explains what happened.
   */
  async attempt<T>(run: () => Promise<T>, options: AttemptOptions): Promise<AttemptOutcome<T>> {
    const fingerprint = this.fingerprint(options);
    /*
     * The refusal is checked first, before the action runs.
     *
     * That is the point of it: the model asked for a call it has already made
     * and which already failed in this exact state, and the useful answer is the
     * one from last time rather than the one from a wait that will end the same
     * way. Reported as `blocked` rather than as a failure so the receipt can say
     * "you have tried this" instead of "this failed".
     */
    const previous = this.failed.get(fingerprint);
    if (previous !== undefined) {
      return {
        attempts: 0,
        recovered: false,
        failure: previous,
        blocked: {
          ...previous,
          diagnostic: `${previous.diagnostic} This exact call already failed in this page state.`,
          retryable: false,
          recommendedNext: "Change something before retrying: a different locator, a step to reveal the element, or a different part of the page.",
        },
      };
    }

    /*
     * Two attempts at most, and the second is only reached when a retry is
     * allowed.
     *
     * The loop runs at most twice because one retry covers the three things a
     * retry can fix: a re-render, a transient obstruction, and a renderer that
     * has been replaced. A third would be the loop this exists to stop.
     */
    let attempts = 0;
    let recovered = false;
    let lastError: unknown;

    for (let round = 0; round < 2; round++) {
      attempts += 1;
      try {
        const value = await run();
        return { value, attempts, recovered };
      } catch (error) {
        lastError = error;
      }

      const failure = classifyFailure(lastError);
      const policy = RETRY_POLICY[failure.kind];

      /*
       * Nothing further happens on the last round.
       *
       * The health probe, the recovery and the fingerprint all exist to serve a
       * retry that is about to run. On the final round there is no retry, so
       * probing and recovering would be work done for nobody, and recovering a
       * healthy page whose action simply failed is a real cost: it replaces the
       * renderer and loses every piece of in-page state the program has built.
       * Measured by the test below, which caught this recovering a page twice.
       */
      if (!policy.retry || round === 1) {
        const finalFailure: BrowserFailure = {
          ...failure,
          ...(recovered ? { recommendedNext: "The page's renderer was replaced; try the next step on the fresh page." } : {}),
        };
        this.store(fingerprint, finalFailure);
        return { error: lastError, failure: finalFailure, attempts, recovered };
      }

      /*
       * Health first, then the policy. A page whose renderer has stopped
       * accepting input fails everything regardless of what the error said, and
       * replacing it is the fix for the whole class rather than for the reported
       * symptom. `recover` with no probe is for the failures where the cause is
       * already known: a crash, or a timeout on an action the page never
       * acknowledged.
       */
      if (policy.probe) {
        const probe = await this.deps.probeInput(options.page).catch(() => ({ delivered: true, note: "" }));
        if (!probe.delivered) {
          await this.deps.recover(options.page).catch(() => undefined);
          recovered = true;
        }
      } else if (policy.recover) {
        await this.deps.recover(options.page).catch(() => undefined);
        recovered = true;
      }
    }

    /*
     * Unreachable: the loop returns on every final-round path. Kept as a real
     * return rather than a throw so a future edit to the loop bounds cannot turn
     * a resolved outcome into an exception.
     */
    const failure = classifyFailure(lastError);
    this.store(fingerprint, failure);
    return { error: lastError, failure, attempts, recovered };
  }

  /**
   * The identity of one attempt.
   *
   * The page state plus the action, preferring the state string and falling back
   * to the revision for a caller that has only that. Deliberately not the
   * timestamp, because the same call a minute later is the same call.
   */
  private fingerprint(options: AttemptOptions): string {
    return fingerprintOf(options.actionKey, options.state ?? `r${options.revision ?? 0}`);
  }

  /**
   * The failure this exact program already produced in this page state.
   *
   * Exposed separately from `attempt` so a caller that runs model code itself,
   * rather than handing it here to be retried, can still refuse a repeat. That
   * is the tool's case: it cannot let `attempt` re-run a program, because the
   * program may have submitted something, but refusing to run the same failing
   * thing again is both safe and the thing that stops the loop.
   */
  previousFailure(actionKey: string, state: string): BrowserFailure | undefined {
    return this.failed.get(fingerprintOf(actionKey, state));
  }

  /** Remember a failure against its fingerprint, for `previousFailure`. */
  remember(actionKey: string, state: string, failure: BrowserFailure): void {
    this.store(fingerprintOf(actionKey, state), failure);
  }

  /**
   * The one write to the failure table.
   *
   * Private, and the public `remember` above is the way in with the parts rather
   * than the fingerprint: two callers computing their own key is how a table
   * ends up with entries nothing can look up.
   */
  private store(fingerprint: string, failure: BrowserFailure): void {
    /*
     * Only failures that repeating cannot fix are remembered.
     *
     * A timeout or a detached element may genuinely work next time, and blocking
     * those would be the runtime overruling a correct retry. What gets
     * remembered is the class where the same call in the same state will fail
     * the same way, which is exactly what the model needs to be told rather than
     * discover.
     */
    if (failure.retryable) return;
    if (failure.kind === "UNKNOWN") return;
    this.failed.set(fingerprint, failure);
    if (this.failed.size > RecoveryController.MAX_FINGERPRINTS) {
      const oldest = this.failed.keys().next();
      if (!oldest.done) this.failed.delete(oldest.value);
    }
  }

  /** Forget the failed-attempt history, when the page state genuinely changed. */
  reset(): void {
    this.failed.clear();
  }

  /** How many attempts are currently refused as already-tried. */
  blockedCount(): number {
    return this.failed.size;
  }
}
