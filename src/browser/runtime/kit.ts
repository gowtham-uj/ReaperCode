/**
 * The transactional runtime, assembled.
 *
 * Every module in this directory is one concern: a failure taxonomy, a page
 * registry, a ledger, a verifier. This is where they are put together and given
 * the things only the runtime can supply: a live page, the thread's vault, the
 * recover primitive, the capability probe.
 *
 * Kept as one object rather than threaded through the runtime's own fields
 * because the pieces refer to each other. The recovery controller needs the
 * prober, the artifact manager writes to the ledger, the transaction runner
 * needs the registry and the ledger together. Assembling them here means the
 * runtime holds one thing and the wiring is in one place, which is the lesson
 * from the download vault: a value produced in one file and consumed in another
 * with nothing connecting them is this codebase's most expensive recurring bug.
 *
 * The kit does not own any Playwright objects. It is given a page when it needs
 * one, which is what makes it testable without a browser and what keeps the
 * runtime the only thing that holds a connection.
 */

import type { Page } from "playwright";

import type { DownloadVault } from "../downloads.js";
import { ArtifactManager, type Artifact } from "./artifact-manager.js";
import { inspectLocator, type ActionInspection } from "./inspect.js";
import { classifyFailure, type BrowserFailure } from "./failure.js";
import { inspectForm, probeValues, type FieldDiagnostics } from "./form-diagnostics.js";
import { HealthMonitor } from "./health-monitor.js";
import { LocatorHealer, localContext } from "./locator-healer.js";
import { MissionState } from "./mission-state.js";
import { PageRegistry } from "./page-registry.js";
import { RecoveryController } from "./recovery-controller.js";
import { RunLedger } from "./run-ledger.js";
import { findFixedSleeps } from "./wait-policy.js";
import type { Requirement } from "./verifier.js";
import { verify, type VerificationOutcome, type VerificationInput } from "./verifier.js";

/** What the kit needs from the runtime, which is the part it cannot own. */
export interface KitDeps {
  /** The thread's id, for names and for keys. */
  threadId: string;
  /** The vault, when the thread has a workspace. */
  vault?: DownloadVault | undefined;
  /**
   * Replace a page's renderer.
   *
   * Injected with a page argument rather than bound to one, because the kit
   * decides *whether* to recover and the runtime knows *how*.
   */
  recover(page: Page): Promise<unknown>;
  /** Whether a page still accepts trusted input. */
  probeInput(page: Page): Promise<{ delivered: boolean; note: string }>;
  /** The page's current outline, for the verifier. */
  outline(page: Page): Promise<string>;
}

/**
 * One thread's transactional runtime.
 *
 * The fields are public and readonly because the tool and the sandbox surface
 * read them directly: there is no behaviour worth hiding behind an accessor for
 * a registry or a ledger, and an accessor per field is how the surface and the
 * implementation drift apart.
 */
export class BrowserRuntimeKit {
  readonly registry = new PageRegistry();
  readonly ledger = new RunLedger();
  readonly health = new HealthMonitor();
  readonly mission = new MissionState();
  readonly healer = new LocatorHealer();
  readonly recovery: RecoveryController;
  readonly artifacts: ArtifactManager | undefined;

  /**
   * The action id counter.
   *
   * Short and monotonic, because the id is written into every receipt, every
   * ledger event and every provenance record, and the model reads them. A uuid
   * would be four times the tokens for the same uniqueness.
   */
  private actionCounter = 0;

  constructor(private readonly deps: KitDeps) {
    this.recovery = new RecoveryController({
      recover: (page) => this.deps.recover(page as Page),
      probeInput: (page) => this.deps.probeInput(page as Page),
    });
    this.artifacts = deps.vault === undefined ? undefined : new ArtifactManager(deps.vault, this.ledger);
  }

  /**
   * The action currently running.
   *
   * Read by the download collector, which needs to record *which* action raised
   * a file. That is the provenance a benchmark checks, and it cannot be
   * reconstructed afterwards: by the time the file is collected the action that
   * caused it has finished.
   */
  private activeActionId: string | undefined;

  /** The next action id, and mark it current so a popup is attributable to it. */
  beginAction(intent?: string): string {
    this.actionCounter += 1;
    const actionId = `a${this.actionCounter}`;
    this.activeActionId = actionId;
    this.registry.setCurrentAction(actionId);
    this.ledger.record({ kind: "action.started", actionId, ...(intent !== undefined ? { intent } : {}) });
    return actionId;
  }

  /** The action in flight, when one is. */
  currentActionId(): string | undefined {
    return this.activeActionId;
  }

  /** Finish an action, recording its outcome in the ledger. */
  endAction(input: {
    actionId: string;
    status: "success" | "failed" | "recovered" | "blocked";
    durationMs: number;
    failureKind?: string | undefined;
    pageId?: string | undefined;
    retryOf?: string | undefined;
  }): void {
    this.registry.setCurrentAction(undefined);
    if (this.activeActionId === input.actionId) this.activeActionId = undefined;
    this.ledger.record({
      kind: "action.finished",
      actionId: input.actionId,
      status: input.status,
      durationMs: input.durationMs,
      ...(input.failureKind !== undefined ? { failureKind: input.failureKind } : {}),
      ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
      ...(input.retryOf !== undefined ? { retryOf: input.retryOf } : {}),
    });
  }

  /** Register a page and record how it came to exist. */
  registerPage(name: string, page: Page, options: { parent?: Page | undefined; creationType?: "popup" | "newPage" | "restored" | "recovery" | undefined } = {}): string {
    const before = this.registry.entries().length;
    const entry = this.registry.register(name, page, {
      ...(options.parent !== undefined ? { parent: options.parent } : {}),
      ...(options.creationType !== undefined ? { creationType: options.creationType } : {}),
    });
    this.health.watch(page);
    if (this.registry.entries().length > before) {
      this.ledger.record({
        kind: "page.created",
        pageId: entry.id,
        creationType: entry.creationType,
        ...(entry.openedBy !== undefined ? { openedBy: entry.openedBy } : {}),
        ...(entry.parentId !== undefined ? { parentPageId: entry.parentId } : {}),
        ...(page.url() !== "about:blank" ? { url: page.url().slice(0, 300) } : {}),
      });
    }
    return entry.id;
  }

  /** Forget a closed page, in the registry and in the health monitor. */
  forgetPage(page: Page): void {
    const id = this.registry.idOf(page);
    this.registry.forget(page);
    this.health.forget(page);
    if (id !== undefined) this.ledger.record({ kind: "page.closed", pageId: id });
  }

  /**
   * Inspect a target before acting on it.
   *
   * A thin pass-through to `inspectLocator` except for one thing: the page's
   * health is attached, because the most common reason a perfectly good locator
   * is not actionable is that the renderer has stopped accepting input, and an
   * inspection that does not say so sends the model to rewrite a locator that
   * was never the problem.
   */
  async inspect(page: Page, target: unknown, action: "click" | "fill" | "check" | "hover" = "click"): Promise<ActionInspection & { healthNote?: string }> {
    const inspection = await inspectLocator(page, target as never, action);
    const health = this.health.of(page);
    if (health.crashed) {
      return { ...inspection, healthNote: "this page's renderer is gone; call recover() before inspecting its elements" };
    }
    return inspection;
  }

  /** Read a form's constraints, so a value is chosen rather than guessed. */
  async inspectForm(page: Page, form?: unknown): Promise<{ fields: FieldDiagnostics[]; invalid: string[] }> {
    return await inspectForm(page, form as never);
  }

  /**
   * Fill a field, and if the value is refused, say why rather than guess.
   *
   * The bounded probe only produces values when the browser's own validation is
   * clean, which is the case where the refusal came from the server and no
   * client-side read can see the reason. Three values, each tried once, and then
   * the model is told to spend its steps elsewhere rather than randomise.
   */
  async alternatives(value: string): Promise<string[]> {
    return probeValues(value);
  }

  /** The local neighbourhood of a target, for rewriting a failed locator. */
  async context(page: Page, hint: { text?: string; role?: string; name?: string }): Promise<string> {
    return await localContext(page, hint);
  }

  /**
   * Whether a page's renderer needs replacing, and replace it.
   *
   * The automated half of point 8: `probeInput()` and `recover()` are the right
   * primitives and the model should not have to discover them. Measured, a page
   * that had stopped accepting input cost thirty trace blocks of the model
   * proving the page's own JavaScript was fine, because nothing told it that a
   * renderer can silently stop dispatching.
   *
   * Safe to run automatically for a specific reason: it does not re-run the
   * program. Replacing a renderer changes the page, not the work, so a step that
   * failed cannot be double-submitted by this. Re-running the model's program
   * would be a different matter and is deliberately not done: see the note on
   * `recoveryAttempt` below.
   */
  async ensureHealthy(page: Page): Promise<{ recovered: boolean; note?: string }> {
    if (page.isClosed()) return { recovered: false };
    const health = this.health.of(page);
    if (health.crashed) {
      await this.deps.recover(page).catch(() => undefined);
      this.health.reset(page);
      this.ledger.record({ kind: "recovery.performed", pageId: this.registry.idOf(page) ?? "unknown", attempt: 1 });
      return {
        recovered: true,
        note: "this page's renderer had crashed, so it has been replaced and reloaded. Retry your step on the fresh page.",
      };
    }
    /*
     * A crash is knowable from the events the monitor already watches. A page
     * that has merely stopped *dispatching* is not: it renders, answers reads
     * and navigates, and the only way to know is to deliver an event and see.
     * That check is one CDP mouse event at a harmless point, so it costs a
     * request rather than a trace, and it is worth making on the pages where the
     * failure is consistent with it.
     */
    const probe = await this.deps.probeInput(page).catch(() => ({ delivered: true, note: "" }));
    if (probe.delivered) return { recovered: false };
    await this.deps.recover(page).catch(() => undefined);
    this.health.reset(page);
    this.ledger.record({ kind: "recovery.performed", pageId: this.registry.idOf(page) ?? "unknown", attempt: 1 });
    return {
      recovered: true,
      note:
        "this page had stopped accepting input, so its renderer has been replaced and it has been put back on the same URL. " +
        "Nothing was clicked and nothing was resubmitted: retry your step on the fresh page.",
    };
  }

  /**
   * Whether this exact program has already failed on this page state.
   *
   * The valuable half of the retry controller, and the half that is safe to run
   * automatically. Auto-retrying a model program is not: the runtime cannot see
   * what the program did, and re-running one that submitted a form is exactly
   * the double-submit a retry policy must never cause. What it *can* do is
   * refuse to run the same thing again, which is the measured failure this
   * addresses: thirteen consecutive identical clicks, each written believing the
   * failure was transient, with nothing ever telling the model the previous
   * twelve had been the same call on the same page in the same state.
   *
   * The comparison is by program and page revision, so a genuinely different
   * attempt, or the same attempt after the page moved, is a different action and
   * is allowed.
   */
  refusesRepeat(actionKey: string, revision: number): BrowserFailure | undefined {
    return this.recovery.previousFailure(actionKey, revision);
  }

  /** Remember that this program failed this way, for `refusesRepeat`. */
  rememberFailure(actionKey: string, revision: number, failure: BrowserFailure): void {
    this.recovery.remember(actionKey, revision, failure);
  }

  /**
   * Check a program's fixed sleeps, and record what was observed.
   *
   * Called with the program's source so the warnings are about the code the
   * model wrote. Returns the rendered block, or an empty string, so the caller
   * can append it without a branch.
   */
  sleepWarnings(code: string): string[] {
    const warnings = findFixedSleeps(code);
    return warnings.map((warning) => `${warning.call} sleeps ${warning.ms ?? "?"}ms; instead ${warning.instead}`);
  }

  /** Record that the model looked at the page. */
  observed(level: number, chars: number, actionId?: string): void {
    this.ledger.record({ kind: "observation.made", level, chars, ...(actionId !== undefined ? { actionId } : {}) });
  }

  /** Record a model call's token usage, so the ledger owns the totals. */
  modelCall(inputTokens: number, outputTokens: number): void {
    this.ledger.record({ kind: "model.call", inputTokens, outputTokens });
  }

  /**
   * Run the verifier against the live page.
   *
   * The page's URL and outline are read here rather than passed in, because a
   * verifier that is handed the page state by its caller can be handed a
   * convenient one. The model cannot influence what this reads.
   */
  async check(requirements: Requirement[], page?: Page | undefined): Promise<VerificationOutcome> {
    const url = page !== undefined && !page.isClosed() ? page.url() : undefined;
    const outline = page !== undefined && !page.isClosed() ? await this.deps.outline(page).catch(() => "") : undefined;
    const verifiedSubtasks = new Set(this.mission.subtasks.filter((subtask) => subtask.status === "verified").map((subtask) => subtask.title));
    const facts = new Map<string, string>();
    for (const [name, fact] of this.mission.facts) facts.set(name, fact.value);
    for (const [name, fact] of this.mission.derived) facts.set(name, fact.value);

    const input: VerificationInput = {
      ledger: this.ledger,
      ...(url !== undefined ? { url } : {}),
      ...(outline !== undefined ? { outline } : {}),
      facts,
      verifiedSubtasks,
    };
    const outcome = verify(requirements, input);
    if (outcome.passed) {
      this.ledger.record({ kind: "mission.verified", requirements: requirements.map((requirement) => requirement.kind) });
    } else {
      this.ledger.record({ kind: "mission.rejected", missing: outcome.missing });
    }
    return outcome;
  }

  /** The metrics, as the model or a report reads them. */
  report(): string {
    return this.ledger.render();
  }

  /** The failure a thrown error represents, for a caller that must render one. */
  classify(error: unknown, geometry?: { width: number; height: number }): ReturnType<typeof classifyFailure> {
    return classifyFailure(error, geometry);
  }

  /** Start listening before a click, so a download is not missed. */
  async armDownload(page: Page, timeoutMs?: number): Promise<string> {
    if (this.artifacts === undefined) throw new Error("this thread has no download vault, so downloads cannot be captured");
    return await this.artifacts.arm(page, timeoutMs);
  }

  /** Wait for an armed download and store it. */
  async collectDownload(token: string, actionId?: string): Promise<Artifact | undefined> {
    if (this.artifacts === undefined) return undefined;
    return await this.artifacts.collect(token, actionId !== undefined ? { actionId } : {});
  }
}
