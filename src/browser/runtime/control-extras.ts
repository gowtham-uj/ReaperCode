/**
 * The transactional half of the program surface, wired to a live runtime.
 *
 * `controlSurface` in the tool builds the calls that only need the runtime's own
 * settings. These are the calls that need a page, the ledger and the registry
 * together: a transaction that diffs the page around a body, a download that
 * arms before its trigger, a popup that is caught and given provenance.
 *
 * Split out because both functions are long and they have nothing in common: one
 * changes how the browser presents itself, the other observes and records what
 * it did.
 *
 * ## The token table
 *
 * Three of these calls span two round trips, because the middle of each is a
 * function the sandbox owns. A transaction is `begin -> body -> end`, a download
 * is `arm -> trigger -> collect`, a popup likewise. The state between the halves
 * lives here, keyed by a short token, and it is bounded: a program that begins a
 * transaction and dies must not leave a page reference held for the rest of the
 * session.
 */

import type { Page } from "playwright";

import type { ThreadBrowserRuntime } from "../thread-runtime.js";
import { renderArtifact } from "./artifact-manager.js";
import { renderFormDiagnostics } from "./form-diagnostics.js";
import { renderInspection } from "./inspect.js";
import { buildReceipt, diffPages, renderTransaction, type TransactionStatus } from "./transaction.js";

/** How many open transactions or arms one thread may have at once. */
const MAX_PENDING = 8;
/** How long a transaction may stay open before its begin is forgotten. */
const PENDING_TTL_MS = 600_000;

interface OpenTransaction {
  token: string;
  actionId: string;
  page: Page;
  urlBefore: string;
  revision: number;
  /** A cheap content signature, for detecting a change the URL does not show. */
  signature: string;
  startedAt: number;
  name?: string;
  policy: string;
  /** Pages and their URLs before the body ran. */
  pagesBefore: Map<string, string>;
}

interface ArmedWait {
  /** Set for a popup: the page the popup is expected on. */
  page?: Page;
  settled: boolean;
  /** Resolves to the thing that arrived, or undefined. */
  promise: Promise<unknown>;
}

/**
 * A cheap content signature.
 *
 * Deliberately not a semantic capture. The outer step already captures the page
 * and diffs it for the tool's own receipt; capturing again here would move the
 * baseline the outer diff is measured from and make the outer receipt describe
 * only the tail of the program. So this reads a small, stable summary that
 * changes when the page changes and costs one evaluation: the element count, the
 * text length and the number of forms.
 *
 * A signature is a weaker signal than a diff, and it is reported as one: the
 * transaction says whether the page changed, and the tool's receipt above it
 * says what changed.
 */
async function contentSignature(page: Page): Promise<string> {
  return await page
    .evaluate(() => {
      const body = document.body;
      if (body === null) return "empty";
      return [
        body.querySelectorAll("*").length,
        (body.textContent ?? "").length,
        body.querySelectorAll("form").length,
      ].join(":");
    })
    .catch(() => "unreadable");
}

/** A url per page id, for the cross-tab change check. */
function pageUrls(runtime: ThreadBrowserRuntime): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of runtime.kit.registry.live()) {
    out.set(entry.id, entry.page.url());
  }
  return out;
}

/**
 * Build the transactional calls for one runtime.
 *
 * The returned object is spread into `controlSurface`, so the tool's surface and
 * the sandbox's list stay in step by construction rather than by a comment.
 */
export function transactionalSurface(runtime: ThreadBrowserRuntime, intern: (value: unknown) => number | undefined) {
  const kit = runtime.kit;
  const open = new Map<string, OpenTransaction>();
  const armed = new Map<string, ArmedWait>();
  let counter = 0;

  /** Drop stale entries, so a program that dies mid-transaction leaks nothing. */
  const sweep = (): void => {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [token, entry] of open) if (entry.startedAt < cutoff) open.delete(token);
    while (open.size > MAX_PENDING) {
      const oldest = open.keys().next();
      if (oldest.done) break;
      open.delete(oldest.value);
    }
    while (armed.size > MAX_PENDING) {
      const oldest = armed.keys().next();
      if (oldest.done) break;
      armed.delete(oldest.value);
    }
  };

  return {
    /**
     * Open a transaction: record where the page is, and give the body a token.
     *
     * The policy check happens here rather than at `txEnd`, because a rule
     * enforced after the body has run is a rule that has already been broken. The
     * body's source is not available at this point, so the check is done by the
     * tool before the program is compiled, and this records which policy was in
     * force for the receipt.
     */
    txBegin: async (options: Record<string, unknown>): Promise<Record<string, unknown>> => {
      sweep();
      /*
       * The page, named or not, resolved the same way `setActive` resolves one.
       *
       * A transaction that names a tab is the common case for a mission working
       * several sites, and resolving it here rather than in the sandbox is what
       * keeps the body's `page` on the tab the transaction named instead of
       * drifting to whatever is active.
       */
      const wanted = options["page"];
      const page =
        wanted === undefined
          ? (await runtime.ensureReady()).page
          : await runtime.setActive(wanted as string | number).catch(async () => (await runtime.ensureReady()).page);
      const name = typeof options["name"] === "string" ? options["name"] : undefined;
      /*
       * The policy is enforced by the tool, against the whole program, before any
       * of this runs. A transaction cannot relax it, which is the point: a rule a
       * nested call could switch off is not a rule. What is recorded here is
       * which policy was in force, so a receipt says the run was governed.
       */
      const policy = typeof options["policy"] === "string" ? options["policy"] : "none";

      const token = `t${++counter}`;
      const actionId = kit.beginAction(name);
      const entry: OpenTransaction = {
        token,
        actionId,
        page,
        urlBefore: page.isClosed() ? "" : page.url(),
        revision: runtime.observer.revision,
        signature: page.isClosed() ? "closed" : await contentSignature(page),
        startedAt: Date.now(),
        ...(name !== undefined ? { name } : {}),
        policy,
        pagesBefore: pageUrls(runtime),
      };
      open.set(token, entry);
      const pageId = kit.registry.idOf(page);
      /*
       * The handle is what makes the body's `page` the transaction's page.
       *
       * The sandbox roots the body's page at this handle, so every Playwright
       * call the body makes replays here against this exact tab. Handing back
       * nothing would leave the body with the bare global `page`, which is the
       * active tab, which is the drift the whole thing exists to prevent.
       */
      const handle = intern(page);
      return {
        token,
        actionId,
        ...(pageId !== undefined ? { pageId } : {}),
        ...(handle !== undefined ? { pageHandle: handle } : {}),
        url: entry.urlBefore,
        revision: entry.revision,
      };
    },

    /** Close a transaction and answer with its receipt. */
    txEnd: async (token: string, outcome: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const entry = open.get(token);
      open.delete(token);
      if (entry === undefined) {
        /*
         * A transaction that was never opened, or whose open was swept. Answering
         * with a receipt rather than throwing, because the body already ran and
         * its value is the thing the model needs; the loss is the change flags,
         * and saying so is more useful than a stack trace.
         */
        return {
          status: "success",
          actionId: "unknown",
          note: "this transaction's open record was not found, so its page changes could not be measured",
          result: outcome["value"],
        };
      }

      const page = entry.page;
      const alive = !page.isClosed();
      const urlAfter = alive ? page.url() : "";
      const signatureAfter = alive ? await contentSignature(page) : "closed";
      const observedChange =
        signatureAfter !== entry.signature || urlAfter !== entry.urlBefore || runtime.observer.revision !== entry.revision;

      const change = diffPages(entry.pagesBefore, pageUrls(runtime), {
        urlBefore: entry.urlBefore,
        urlAfter,
        observedChange,
      });

      /*
       * The body's own failure is classified, not forwarded as a stack trace.
       *
       * A program that throws inside a transaction is a program whose action
       * failed, and the model needs the taxonomy rather than the message: a
       * detached element and a missing one want different next steps, and
       * Playwright's message does not distinguish them.
       */
      const ok = outcome["ok"] === true;
      const errorShape = outcome["error"];
      const failure =
        ok || errorShape === undefined || typeof errorShape !== "object"
          ? undefined
          : kit.classify(new Error(String((errorShape as Record<string, unknown>)["message"] ?? "the action failed")));

      const status: TransactionStatus = ok ? "success" : "failed";
      const pageId = kit.registry.idOf(page) ?? "unknown";
      const receipt = buildReceipt({
        actionId: entry.actionId,
        status,
        ...(entry.name !== undefined ? { action: entry.name } : {}),
        pageId,
        urlBefore: entry.urlBefore,
        urlAfter,
        changed: change,
        ...(ok ? { result: outcome["value"] } : {}),
        ...(failure !== undefined ? { failure } : {}),
        totalMs: Date.now() - entry.startedAt,
        waitingMs: 0,
      });

      kit.endAction({
        actionId: entry.actionId,
        status: ok ? (change.changed ? "success" : "success") : "failed",
        durationMs: receipt.timing.totalMs,
        ...(failure !== undefined ? { failureKind: failure.kind } : {}),
        pageId,
      });
      if (failure !== undefined) kit.mission.recordFailure(entry.actionId, failure.kind);

      /*
       * The receipt as the model reads it, not the object.
       *
       * A transaction's whole purpose is that a step's answer is small, and a
       * structured object crossing the bridge is the same size as a rendered one.
       * The text is what the model reasons over, so the text is what it gets.
       */
      return { receipt, text: renderTransaction(receipt) };
    },

    /** Whether a locator can actually be acted on, and why not when it cannot. */
    inspect: async (target: unknown, action?: string): Promise<Record<string, unknown>> => {
      const page = (await runtime.ensureReady()).page;
      const wanted = action === "fill" || action === "check" || action === "hover" ? action : "click";
      const inspection = await kit.inspect(page, target, wanted);
      kit.observed(1, JSON.stringify(inspection).length);
      return { ...inspection, text: renderInspection(inspection) };
    },

    /** A form's constraints, so a value is chosen rather than guessed. */
    inspectForm: async (form: unknown): Promise<Record<string, unknown>> => {
      const page = (await runtime.ensureReady()).page;
      const result = await kit.inspectForm(page, form);
      return { ...result, text: renderFormDiagnostics(result) };
    },

    /**
     * Wait until the page changes, or a specific condition holds.
     *
     * The replacement for `waitForTimeout`. Polls a cheap signature and a URL
     * comparison, and returns as soon as either moves, so a slow page costs what
     * it costs and a fast one costs a poll.
     */
    waitForChange: async (options: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const page = (await runtime.ensureReady()).page;
      const timeoutMs = typeof options["timeoutMs"] === "number" ? options["timeoutMs"] : 5_000;
      const wantUrl = typeof options["urlIncludes"] === "string" ? options["urlIncludes"] : undefined;
      const wantText = typeof options["textPresent"] === "string" ? options["textPresent"] : undefined;
      const started = Date.now();
      const urlBefore = page.url();
      const signatureBefore = await contentSignature(page);

      while (Date.now() - started < timeoutMs) {
        await page.waitForTimeout(120).catch(() => undefined);
        if (page.isClosed()) return { changed: true, reason: "the page was closed", waitedMs: Date.now() - started };
        const url = page.url();
        if (wantUrl !== undefined && url.includes(wantUrl)) return { changed: true, reason: `the URL now includes ${wantUrl}`, waitedMs: Date.now() - started };
        if (wantText !== undefined) {
          const found = await page.getByText(wantText).count().catch(() => 0);
          if (found > 0) return { changed: true, reason: `the page now shows ${wantText}`, waitedMs: Date.now() - started };
        }
        if (wantUrl === undefined && wantText === undefined) {
          if (url !== urlBefore || (await contentSignature(page)) !== signatureBefore) {
            return { changed: true, reason: url !== urlBefore ? `the URL changed to ${url}` : "the page content changed", waitedMs: Date.now() - started };
          }
        }
      }
      return {
        changed: false,
        reason: wantUrl !== undefined ? `the URL never came to include ${wantUrl}` : wantText !== undefined ? `the page never showed ${wantText}` : "nothing changed",
        waitedMs: Date.now() - started,
      };
    },

    /** Arm a download listener before the trigger runs. */
    armDownload: async (timeoutMs?: number): Promise<Record<string, unknown>> => {
      sweep();
      const page = (await runtime.ensureReady()).page;
      const token = await kit.armDownload(page, typeof timeoutMs === "number" ? timeoutMs : 30_000);
      return { token };
    },

    /** Wait for the armed download and store it in the thread's workspace. */
    collectDownload: async (token: string): Promise<Record<string, unknown> | undefined> => {
      /*
       * The action id goes into the ledger with the artifact, which is what makes
       * "this file was downloaded by a click" a recorded fact rather than an
       * inference from timing. Without it the provenance check has a file and no
       * cause, and a file fetched over HTTP would be indistinguishable from one
       * the page offered.
       */
      const actionId = kit.currentActionId();
      const file = await kit.collectDownload(token, actionId);
      if (file === undefined) return undefined;
      kit.mission.artifacts.set(file.name, { name: file.name, path: file.path, bytes: file.bytes, status: "saved" });
      return { ...file, text: renderArtifact(file) };
    },

    /**
     * Arm a popup listener on a page, before the trigger runs.
     *
     * Playwright's own guidance is to arm the listener first, and the reason is
     * mechanical: the event fires during the click, so a listener attached
     * afterwards has already missed it.
     */
    armPopup: async (target: unknown, timeoutMs?: number): Promise<Record<string, unknown>> => {
      sweep();
      const page = (target as Page | undefined) ?? (await runtime.ensureReady()).page;
      const token = `p${++counter}`;
      const promise = page.waitForEvent("popup", { timeout: typeof timeoutMs === "number" ? timeoutMs : 15_000 });
      const record: ArmedWait = { page, settled: false, promise };
      promise.catch(() => {
        record.settled = true;
      });
      armed.set(token, record);
      return { token };
    },

    /**
     * Collect the armed popup, register it, and hand it to the program.
     *
     * Registered as a `popup` with the page it was raised from, which is what
     * makes the provenance real rather than inferred: the runtime saw the event,
     * on a page this thread owns, while an action was running. A task that asks
     * "was this opened by a click" now has an answer that came from the browser.
     */
    collectPopup: async (token: string): Promise<Record<string, unknown> | undefined> => {
      const record = armed.get(token);
      armed.delete(token);
      if (record === undefined) return undefined;
      const popup = (await record.promise.catch(() => undefined)) as Page | undefined;
      if (popup === undefined) return undefined;

      await runtime.adoptPopup(popup, record.page).catch(() => undefined);
      const handle = intern(popup);
      if (handle === undefined) {
        return {
          error: "the browser bridge is holding too many live page objects to hand this popup back",
        };
      }
      const id = kit.registry.idOf(popup);
      return { handle, pageId: id, url: popup.url() };
    },

    /*
     * The mission's memory, outside the conversation.
     *
     * Every write reaches the host, which is what makes it survive compaction: a
     * fact recorded at step 12 is still there at step 180, when the transcript
     * that held the page it came from has long been trimmed.
     */
    state: {
      get: async (): Promise<Record<string, unknown>> => ({ ...kit.mission.toJSON(), text: kit.mission.render() }),
      fact: async (name: string, value: string, evidence?: string): Promise<Record<string, unknown>> => {
        if (name.trim().length === 0) throw new Error("a fact needs a name");
        kit.mission.recordFact(name, value, evidence ?? "stated by the program");
        return { recorded: name, value };
      },
      derive: async (name: string, value: string, from?: string): Promise<Record<string, unknown>> => {
        if (name.trim().length === 0) throw new Error("a derived value needs a name");
        kit.mission.recordDerived(name, value, from ?? "other facts");
        return { recorded: name, value };
      },
      subtask: async (title: string, status?: string, requires?: string[]): Promise<Record<string, unknown>> => {
        if (title.trim().length === 0) throw new Error("a subtask needs a title");
        if (status === undefined) {
          const created = kit.mission.declareSubtask(title, requires ?? []);
          return { subtask: created.title, status: created.status, requires: created.requires };
        }
        const known = ["pending", "running", "blocked", "done", "verified", "failed"];
        if (!known.includes(status)) throw new Error(`subtask status must be one of ${known.join(", ")}, got "${status}"`);
        /*
         * `verified` is not a status a program may set.
         *
         * It is the verifier's word, and a model that could set it would be
         * marking its own homework, which is the exact failure the state machine
         * exists to prevent. A program asking to verify gets the instruction to
         * request a finish instead.
         */
        if (status === "verified") {
          throw new Error(
            "a program cannot mark its own subtask verified. Record it as `done` and request the mission be finished; " +
            "the verifier decides whether it is verified.",
          );
        }
        kit.mission.setSubtask(title, status as never);
        return { subtask: title, status };
      },
      ready: async (): Promise<Record<string, unknown>> => ({
        ready: kit.mission.ready().map((subtask) => subtask.title),
        text: kit.mission.render(),
      }),
      /**
       * Track a file in the mission's own record.
       *
       * This is a note, not evidence, and the distinction is load-bearing: the
       * verifier reads the *ledger*, which only a real save writes to, so a
       * program that declares a file it never downloaded satisfies no
       * requirement. That matters because the alternative is a model passing an
       * artifact check by asserting the artifact exists, which is the same
       * failure as a program marking its own subtask verified.
       *
       * It is still worth having: a mission that moves a file between sites
       * wants to know which file it is carrying, and the record is what appears
       * in the state the model reads each turn.
       */
      artifact: async (name: string, path: string, bytes?: number): Promise<Record<string, unknown>> => {
        kit.mission.artifacts.set(name, { name, path, bytes: bytes ?? 0, status: "saved" });
        return { recorded: name, path, note: "noted in the mission record; this is not evidence that a download happened" };
      },
    },

    /** The browsing metrics, folded from the ledger rather than counted. */
    metrics: async (): Promise<Record<string, unknown>> => ({ ...kit.ledger.metrics(), text: kit.ledger.render() }),
  };
}
