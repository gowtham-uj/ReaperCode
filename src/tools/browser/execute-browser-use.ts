/**
 * Running one `browser_use` program, and turning it into something to read.
 *
 * The tool's whole value is in the last two words of its contract: it returns a
 * *receipt*, not a status. A model that is told "ok" after a click has no way to
 * tell a page that navigated from a page that showed an error from a click that
 * landed on nothing, and all three are the same `undefined` from Playwright.
 *
 * So the program is wrapped in the transaction: capture, act, settle, diff,
 * report. The model gets the OUTCOME, the URL transition and the lines that
 * changed, which is the smallest set of facts that lets it decide what to do
 * next without looking again.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Page } from "playwright";

import type { ThreadBrowserRuntime } from "../../browser/thread-runtime.js";
import { BrowserControlPausedError, BrowserLeaseStaleError } from "../../browser/control-lease.js";
import { renderReceipt, type StepReceipt } from "../../browser/transaction.js";
import { serializeBrowserResult } from "../../browser/serialize.js";
import type { BrowserUseArgs } from "./browser-use.js";
import { verifyStep } from "../../browser/verify.js";
import { scopePage } from "../../browser/scoped-page.js";
import { BrowserProgramHost } from "../../browser/browser-program.js";
import { runProgram } from "../../browser/run-program.js";
import { liftTrailingDeclaration, splitTrailingExpression, wrapWithTail, wrapWithoutTail } from "../code/transform.js";

export interface BrowserUseMetadata {
  runId: string;
  artifactDir: string;
  toolCallId: string;
  /**
   * The thread's workspace, which the sandbox confines a program to.
   *
   * Optional in the type only because tests build metadata by hand. In
   * production it is always set, and the runner falls back to the process's own
   * directory when it is not, which is wrong for a server and right for a test.
   */
  workspaceRoot?: string | undefined;
}

export interface BrowserUseResult {
  /** What the model reads. */
  output: string;
  /**
   * The page as structured data, for the UI pane.
   *
   * The model reads `output`; a presenter needs facts it can lay out rather
   * than prose it would have to parse. Returning both from one call is what
   * keeps the pane and the model looking at the same step rather than at two
   * readings taken at different moments.
   */
  surface?: {
    url: string;
    title: string;
    viewport?: { width: number; height: number } | undefined;
    /** How much was on the page, so the pane can say it rather than guess. */
    stats?: { lines: number; chars: number; refs: number; interactive: number } | undefined;
    /**
     * A PNG for the pane to draw, relative to the thread's workspace root.
     *
     * Relative because that is what `/api/screenshot` resolves against: an
     * absolute path is rejected as an escape. Absent when the capture failed,
     * which costs the pane an image and nothing else.
     */
    screenshotPath?: string | undefined;
    /**
     * The elements a person could act on, with boxes in viewport pixels.
     *
     * Boxes rather than a list of refs, because the pane draws them over the
     * screenshot and dividing by `viewport` is how it places them.
     */
    interactive: Array<{ ref: string; index: number; tag: string; text: string; x: number; y: number; width: number; height: number; role?: string | undefined; type?: string | undefined }>;
  } | undefined;
  /** Narrowed for presenters: the outcome alone is often all a UI needs. */
  outcome: StepReceipt["outcome"];
  /** True when the call failed in a way the model should be told about plainly. */
  isError?: boolean;
  /**
   * The revision this leaves the page at, so the model can pin its next program.
   *
   * Returned on every path including the failures, because the number is what
   * makes `STALE_REVISION` usable rather than a trap: a model that has just been
   * told the revision can pass it and be protected from acting on a page that
   * moved.
   */
  rev: number;
}

/**
 * Compile the model's code into an async function that takes `page`.
 *
 * The value-producing tail is found with the **same transform the eval tool
 * uses**, not with a guess. That is the whole reason this delegates: the rule
 * for "which expression is the result" is subtle (the longest tail that still
 * compiles, lifted out of try/catch, out of a trailing declaration, out of a
 * bare expression) and it is already written and tested in `transform.ts`. A
 * second implementation here would be a worse copy that drifts.
 *
 * The first version of this file did guess, by looking for the words `return`,
 * `await` or `async`. It was wrong in both directions, and the probe caught it:
 * `while(true){}` contains none of them and was wrapped as an expression, giving
 * "Unexpected token 'while'" for valid JavaScript, and every statement-body
 * program silently returned `undefined` because there was no `return` anywhere
 * for the model's last expression to reach.
 *
 * Built with the Function constructor rather than `eval`, so the script cannot
 * see this module's scope. Its only way out is what it returns.
 */
export interface BrowserInScope {
  /** The page the program's bare `page` refers to. */
  page: Page;
  /**
   * The thread's pages, so a program can open and switch between them.
   *
   * `browser` is the name Playwright itself uses, so a model that knows
   * Playwright reaches for the right thing without being taught a second API.
   * It is deliberately a small surface: `newPage`, `pages`, `page(name)` and
   * `setActive`. A model that needs the whole `Browser` object is doing
   * something this tool is not for, and handing it one would let it detach the
   * connection the runtime depends on.
   */
  browser: BrowserSurface;
}

export interface BrowserSurface {
  newPage(name?: string): Promise<Page>;
  /**
   * The thread's pages, as real pages.
   *
   * This declared a list of `{name, url, active}` records, which is what the
   * facade no longer returns and what the scope-level `pages()` used to return.
   * Both now hand back scoped Playwright pages carrying that metadata as
   * non-enumerable properties, because the documented usage is
   * `(await browser.pages())[0].url()` and a record makes that throw.
   */
  pages(): Page[] | Promise<Page[]>;
  page(selector?: string | number): Promise<Page>;
  setActive(selector: string | number): Promise<Page>;
  /**
   * Write cookies and storage now, mid-program.
   *
   * State is written after a successful step anyway, so this is for the case the
   * automatic write cannot cover: a long program that has just logged in and
   * still has work to do. Without it, a program killed halfway leaves nothing.
   */
  save(): Promise<void>;
}

/**
 * Observation, callable from inside a program.
 *
 * These are the primitives the browser skill documents, and they are here rather
 * than only in the tool's own arguments for a reason the skill makes plain: a
 * program that acts and then wants to look at the result should not have to end
 * and make a second call. `await viewChanges()` at the end of a program is the
 * shape most steps actually want.
 *
 * Each returns text rather than throwing on a page that has closed, because a
 * program that closes a page and then asks what is on it should get an answer
 * rather than an error about the thing it just did deliberately.
 */
export interface ObserveSurface {
  /** The whole page, pruned to a token budget. */
  view(target?: Page): Promise<string>;
  /** Only what changed since the model last looked. */
  viewChanges(): string;
  /** The page as an image, for canvas and sites built from divs. */
  screenshot(target?: Page): Promise<string>;
}

/**
 * Everything a program has in scope.
 *
 * Written as one type so the parameter list, the compiler and the runtime cannot
 * drift apart. They did: `pages()` was documented in the skill and missing here,
 * so a program that called it failed with "pages is not defined", which reads to
 * a model as its own mistake.
 */
export interface ProgramContext {
  (page: Page, browser: BrowserSurface, view: ObserveSurface["view"], viewChanges: ObserveSurface["viewChanges"], screenshot: ObserveSurface["screenshot"], pages: () => ReturnType<BrowserSurface["pages"]>): Promise<unknown>;
}

/** The parameter names a program can use. Kept in one place so they cannot drift. */
const PROGRAM_PARAMS = ["page", "browser", "view", "viewChanges", "screenshot", "pages"] as const;

/**
 * The program body as source, ready for whichever runtime will run it.
 *
 * Split out from `compileBrowserProgram` because there are now two runtimes: the
 * sandboxed worker, which takes source, and the in-process compiler, which takes
 * source and a parameter list. Both need the same analysis, and the analysis is
 * the part that is easy to get subtly wrong, so it happens once here and the two
 * callers only differ in how they execute the result.
 *
 * Throws on a genuine syntax error, which is the model's own and is reported as
 * such by the caller.
 */
export function compileBrowserSource(code: string): string {
  const verify = (source: string): boolean => {
    try {
      new Function(...PROGRAM_PARAMS, `return ${source};`);
      return true;
    } catch {
      return false;
    }
  };

  /*
   * Longest tail first, which is what `splitTrailingExpression` already does.
   * A script that is one value-producing expression has no prefix, and that is
   * the most common shape of a read.
   */
  const split = splitTrailingExpression(code, verify);
  if (split) {
    const wrapped = wrapWithTail(split.prefix, split.tail, { awaitTail: true });
    if (verify(wrapped)) return wrapped;
  }

  /*
   * A declaration with nothing after it, `const rows = await page.locator(…)`,
   * is the shape a model writes when it means to return the binding and forgot
   * to name it. Lifting it is what turns a silent `undefined` into the value.
   */
  const lifted = liftTrailingDeclaration(code, verify);
  if (lifted !== undefined && verify(lifted)) return lifted;

  /*
   * No tail at all: the program acts and returns nothing, which is the normal
   * shape of a click or a fill. Compiling it plainly is correct rather than a
   * fallback.
   *
   * Verified like every other candidate, and the check is not a formality. This
   * is where a genuine syntax error lands, and without the check the source is
   * shipped to the worker, fails inside `vm.compileFunction`, and comes back as
   * a *runtime* failure after the transaction has already captured the page. The
   * model is then told the step failed against a page it never touched, when the
   * truth is that nothing ran. Throwing here keeps the two apart:
   * `compileBrowserSource` throws for "your program is not JavaScript" and the
   * caller answers SYNTAX_ERROR with the page explicitly unchanged.
   */
  const plain = wrapWithoutTail(code);
  if (!verify(plain)) {
    // Compile it once more outside `verify` so the syntax error escapes with
    // its own message, rather than being replaced by this throw.
    new Function(...PROGRAM_PARAMS, `return ${plain};`);
    throw new Error("the program could not be compiled");
  }
  return plain;
}

export function compileBrowserProgram(code: string): ProgramContext {
  return new Function(...PROGRAM_PARAMS, `return ${compileBrowserSource(code)};`) as ProgramContext;
}

/**
 * The browser surface a program gets.
 *
 * Small on purpose. The runtime owns the connection, the contexts and the
 * active page, and a program that could reach the raw `Browser` object could
 * close the connection the runtime is holding, which would break every later
 * call in the thread with no error that names the cause.
 */
function browserSurface(runtime: ThreadBrowserRuntime): BrowserSurface {
  return {
    /*
     * A page this program opens is scoped, like the one it started with.
     *
     * Without this the new page is a raw Playwright page, so a program could
     * open a tab and then walk out of its thread through `newTab.context()
     * .browser().contexts()`. The scoping has to cover every page a program can
     * hold, not just the first one.
     */
    newPage: async (name?: string) => scopePage(await runtime.newPage(name)),
    pages: () => runtime.describePages(),
    page: async (selector?: string | number) => (selector === undefined ? (await runtime.ensureReady()).page : runtime.setActive(selector)),
    setActive: (selector: string | number) => runtime.setActive(selector),
    save: () => runtime.save(),
  };
}

/**
 * Observation as a program sees it.
 *
 * `view` with no argument is the active page, which is what a program almost
 * always means. Passing a `Page` scopes it, which is how a program looks at one
 * region without a selector.
 */
function observeSurface(runtime: ThreadBrowserRuntime): ObserveSurface {
  return {
    view: async (target?: Page) => (await runtime.view(target ? { page: target } : {})).text,
    viewChanges: () => runtime.viewChanges().text,
    screenshot: async (target?: Page) => {
      const page = target ?? (await runtime.ensureReady()).page;
      const buffer = await page.screenshot({ fullPage: false });
      /*
       * Returned as a data URL rather than a path.
       *
       * A path would be a file the model cannot see and a cleanup problem for
       * the runtime. A data URL goes straight back as the program's return value
       * and lands in the receipt, which is where an image is useful.
       */
      return `data:image/png;base64,${buffer.toString("base64")}`;
    },
  };
}

/**
 * Run one program against the thread's page and report what happened.
 *
 * Every failure path produces a receipt rather than a thrown error, because the
 * model needs to see the page in each of those cases. A click that timed out
 * because a dialog is covering the button has told the model something real, and
 * a stack trace would throw that away.
 */
export async function executeBrowserUse(runtime: ThreadBrowserRuntime, args: BrowserUseArgs, metadata: BrowserUseMetadata): Promise<BrowserUseResult> {
  /*
   * A look with no program: the model's first call on a page, and the one it
   * makes again whenever the receipt tells it something changed that it does not
   * understand. Looking is not a lesser operation than acting; writing Playwright
   * against a page you have not seen is how an agent clicks the wrong thing.
   */
  if (args.code === undefined || args.code.trim().length === 0) {
    const view = await runtime.view({ ...(args.selector !== undefined ? { selector: args.selector } : {}) });
    /*
     * What is known about this site, before the model writes anything.
     *
     * A flow is worth more than a description: an edge carries the program that
     * worked last time, already verified, which is the difference between the
     * model writing a step and the model reusing one. Offered rather than
     * applied, because a learned program replayed without being read is how an
     * agent clicks a button that moved.
     */
    const flows = await flowHint(runtime, view.url);
    /*
     * The counts come from the runtime, not from counting the rendered text.
     *
     * They used to be derived from the outline by counting `[ref=` lines, which
     * was right when the outline was Playwright's snapshot and is wrong now that
     * it is the compiled view: the compiled view has no `ref=` markers, so every
     * count would have reported zero refs on a page with hundreds of addressable
     * elements. A wrong number here is worse than no number, because it reads as
     * "this page has nothing on it".
     */
    const stats = runtime.lastStats();
    return {
      output:
        `${view.text}\n\n[${stats.lines} lines, ${stats.chars} chars, ${stats.elements} elements]` +
        `\n(REV ${runtime.observer.revision} - pass expected_revision with your next program)` +
        (flows.length > 0 ? `\n\n${flows.join("\n")}` : ""),
      outcome: "SUCCESS",
      rev: runtime.observer.revision,
    };
  }

  let programSource: string;
  try {
    /*
     * Compiled here, run in the sandbox. The analysis is shared with the old
     * in-process path so the two cannot disagree about what a program means;
     * only the execution differs.
     */
    programSource = compileBrowserSource(args.code);
  } catch (error) {
    /*
     * A syntax error is the model's own, and it must be told plainly: the
     * transaction never ran, so there is no page state to report and saying
     * "the page did not change" would be true and useless.
     */
    return {
      output:
        `OUTCOME: SYNTAX_ERROR\n\nYour program did not compile: ${(error as Error).message.split("\n")[0]}\n\n` +
        `Nothing ran and the page is unchanged.`,
      outcome: "PRECONDITION_FAILED",
      isError: true,
      rev: runtime.observer.revision,
    };
  }

  /*
   * The state this step starts from, captured before anything runs.
   *
   * Recorded now rather than read back afterwards, because by then the page has
   * moved and the "from" state is gone.
   */
  const urlAtStart = (await runtime.ensureReady().catch(() => undefined))?.page.url();
  const stateBefore = signatureOf(urlAtStart, args.expect);

  let outcome: StepReceipt["outcome"];
  let receipt: StepReceipt;
  let result: unknown;
  try {
    const observe = observeSurface(runtime);
    const active = await runtime.ensureReady();
    /*
     * The program drives the SCOPED page, and it drives it from inside the
     * sandbox.
     *
     * The scoping is what stops one agent reaching another's tabs, and it now
     * travels with the object rather than with the process: the sandboxed
     * program holds proxies, the host replays every call against this page, and
     * `page.context().browser().contexts()` still dead-ends at this thread's
     * context. A program with its own CDP connection would have none of that,
     * which is why it does not get one.
     */
    /*
     * Rooted at the SCOPED page, not the raw one, and this is the line the
     * isolation tests exist for.
     *
     * The proxy replays every call against the object a handle roots at, so
     * rooting at the raw page means the program's `page.context().browser()
     * .contexts()` reaches the real connection and comes back with every
     * thread's contexts. It did: the test that counts them got 2 where it must
     * get 1. `scopePage` is what dead-ends that chain, and it has to be applied
     * here rather than somewhere downstream, because every call the program
     * makes starts from this object.
     */
    const programHost = new BrowserProgramHost(runtime, scopePage(active.page), observe);
    const stepped = await runtime.step(
      async () => {
        const ran = await runProgram({
          compiled: programSource,
          host: programHost,
          workspace: metadata.workspaceRoot ?? process.cwd(),
          ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
        });
        /*
         * The runner reports rather than throws, and the transaction reads a
         * throw as the failure signal. So the two are translated here, and both
         * halves are load-bearing.
         *
         * Returning the outcome object instead of the value was the first
         * version and it broke the tool's most important answer: `producedValue`
         * is `result !== undefined`, an object is never undefined, so every step
         * reported SUCCESS. A click that landed on nothing and a program that
         * threw both came back as success with the error sitting inside the
         * value where nothing looked for it. The model would have read "ok" for
         * a step that did nothing and for one that failed.
         */
        if (ran.error !== undefined) {
          const failure = new Error(ran.error.message);
          failure.name = ran.error.name;
          throw failure;
        }
        return ran.value;
      },
      {
        ...(args.expected_revision !== undefined ? { expectedRevision: args.expected_revision } : {}),
        ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
      },
    );
    receipt = stepped.receipt;
    result = stepped.result;
    outcome = receipt.outcome;
  } catch (error) {
    /*
     * A throw here is a throw from the *harness*, not from the model's program:
     * the program's own failures come back as receipts inside `runtime.step`.
     * That leaves two real cases, and both must produce a readable answer rather
     * than escaping the tool.
     *
     *   - the page was closed by the program, so the settle has nothing to read
     *   - the browser is gone
     *
     * This is the case the probe caught: `await page.close()` threw out of the
     * tool entirely, so the model got a stack trace instead of "you closed the
     * page you were driving".
     */
    /*
     * The control-lease refusals are answered before the generic cases, and
     * they are not errors in the ordinary sense: nothing about the page or the
     * program is wrong. The user took the browser, or the step was decided
     * before they did. Both need to reach the model as a state to wait on
     * rather than a failure to retry, so they get their own OUTCOME and a
     * message that says what to do next.
     */
    if (error instanceof BrowserControlPausedError || error instanceof BrowserLeaseStaleError) {
      return {
        output: `OUTCOME: BROWSER_HUMAN_CONTROL\n\n${(error as Error).message}`,
        outcome: "BROWSER_HUMAN_CONTROL",
        isError: false,
        rev: runtime.observer.revision,
      };
    }
    const message = (error as Error).message.split("\n")[0] ?? "unknown error";
    const closed = /closed|Target page, context or browser has been closed|disconnected/i.test(message);
    return {
      output:
        `OUTCOME: ${closed ? "BROWSER_DISCONNECTED" : "POSTCONDITION_FAILED"}\n\n` +
        (closed
          ? `The page or browser is no longer available, so the result could not be observed. ` +
            `If your program closed the page, open a new one with browser_use before continuing.`
          : `The step could not be completed: ${message}`),
      outcome: closed ? "BROWSER_DISCONNECTED" : "POSTCONDITION_FAILED",
      isError: true,
      rev: runtime.observer.revision,
    };
  }

  const lines = [renderReceipt(receipt)];

  /*
   * The checks, when there is something to check against or something to report.
   *
   * Level 0 runs whether or not an expectation was given, because a page that
   * shows an error after a successful click is a rejection the model would
   * otherwise walk past. Level 1 only runs when the model said what it expected,
   * which is why stating it is worth the tokens.
   */
  let verification: ReturnType<typeof verifyStep> | undefined;
  if (args.expect !== undefined || receipt.outcome === "SUCCESS") {
    const outline = await runtime.currentOutline().catch(() => "");
    verification = verifyStep(receipt, args.expect, outline);
    if (!verification.passed) lines.push("", `VERIFICATION: ${verification.summary}`);
  }

  /*
   * The program's own value, when it produced one.
   *
   * This is how a model reads data out of a page: the program's last expression
   * is the answer, serialized with the same walker the eval tool uses so a
   * returned `Page` or a huge array cannot blow the context.
   */
  if (result !== undefined) {
    const serialized = serializeBrowserResult(result);
    lines.push("", "RETURNED:", typeof serialized.value === "string" ? serialized.value : JSON.stringify(serialized.value));
    if (serialized.truncated) lines.push("(truncated)");
  }

  /*
   * The page, when the model would otherwise be blind.
   *
   * `auto` decides with one rule: if the receipt already says what changed, the
   * model has its feedback and does not need the page again. If it does not
   * (NO_CHANGE, a failure, a stale revision), the model is about to guess, and
   * that is precisely when the page is worth the tokens.
   */
  const surface = await pageSurface(runtime, metadata.workspaceRoot);
  const observe = args.observe ?? "auto";
  const alreadyTold = receipt.outcome === "SUCCESS" && !receipt.wholesale;
  const shouldObserve = observe === "full" || observe === "changes" || (observe === "auto" && !alreadyTold);
  if (shouldObserve && !runtime.observer.isPageGone()) {
    try {
      const view = observe === "changes" ? { text: renderReceipt(receipt) } : await runtime.view({ ...(args.selector !== undefined ? { selector: args.selector } : {}) });
      lines.push("", "PAGE:", view.text);
    } catch {
      /*
       * A page that cannot be read after a step is a fact, not a failure of the
       * step. Saying so beats an empty section that reads as an empty page.
       */
      lines.push("", "PAGE: could not be read (the page may have closed or navigated)");
    }
  }

  /*
   * Learn the edge, but only when it was confirmed.
   *
   * The transition database is a shared file, and the rule that keeps it useful
   * is that an edge exists only where the checks passed. A graph built from what
   * the model believed it did fills with transitions that never happened, and a
   * model following those is worse off than one exploring.
   *
   * `verification.passed` is the whole gate. No verification ran (because there
   * was nothing to check and no error appeared) counts as passed, since the
   * alternative is a graph that never records anything on a site with no
   * expectations stated.
   */
  if (stateBefore !== undefined && runtime.flows !== undefined) {
    const stateAfter = signatureOf(surface?.url, args.expect);
    await runtime.flows
      .record({
        host: hostOf(surface?.url),
        from: stateBefore,
        to: stateAfter,
        program: args.code,
        succeeded: verification?.passed ?? true,
      })
      .catch(() => undefined);
  }

  return {
    output: lines.join("\n"),
    outcome,
    ...(outcome === "SUCCESS" || outcome === "NO_CHANGE" ? {} : { isError: true }),
    rev: runtime.observer.revision,
    ...(surface ? { surface } : {}),
  };
}

/**
 * What this site has taught us, as lines for the model.
 *
 * Rendered for reading, not for copying: the model is shown that a step is known
 * and what it did, and writes its own program from the current page. Handing
 * back a stored program to run unread is how an agent clicks a control that
 * moved, so the program is shown as a hint and not as a payload.
 */
async function flowHint(runtime: ThreadBrowserRuntime, url: string): Promise<string[]> {
  const flows = runtime.flows;
  if (!flows) return [];
  const host = hostOf(url);
  const line = await flows.describe(host).catch(() => undefined);
  if (line === undefined) return [];

  const edges = await flows.edgesFrom(host, signatureOf(url, undefined)).catch(() => []);
  if (edges.length === 0) return [line];

  const known = edges.slice(0, 3).map((edge: { to: string; successes: number; program: string }) => `  ${edge.to} (worked ${edge.successes}x): ${edge.program.replace(/\s+/g, " ").slice(0, 120)}`);
  return [line, "Known steps from here:", ...known];
}

/** The host a URL belongs to, for keying the learned graph. */
function hostOf(url: string | undefined): string {
  if (url === undefined) return "unknown";
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

/**
 * A state identifier for the graph.
 *
 * The compiler's section signature is the right one and is not available here
 * without a compile on every step. What is available is the page's own shape as
 * the outline describes it, which is the same information one layer up: the url
 * for what kind of page it is, without the query string that carries the tenant
 * and the session.
 */
function signatureOf(url: string | undefined, expectation: BrowserUseArgs["expect"]): string {
  const path = (() => {
    if (url === undefined) return "unknown";
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  /*
   * The expectation is part of the signature when there is one, because two
   * steps on the same path that expect different things are different
   * transitions: "submit the form" and "check the form for errors" land on the
   * same URL and are not the same edge.
   */
  const expect = expectation ? Object.keys(expectation).sort().join(",") : "";
  return expect.length > 0 ? `${path}#${expect}` : path;
}

/**
 * The page as facts a presenter can use.
 *
 * A failure here is not a failure of the step: the program already ran and its
 * receipt is real. The pane simply gets no update, which is better than the
 * step being reported as failed because a title could not be read.
 */
async function pageSurface(runtime: ThreadBrowserRuntime, workspaceRoot: string | undefined): Promise<BrowserUseResult["surface"]> {
  try {
    const { page } = await runtime.ensureReady();
    const viewport = page.viewportSize();
    /*
     * The screenshot, written where the gateway can serve it.
     *
     * The UI's browser pane has always rendered `surface.screenshotPath` through
     * `/api/screenshot`, and the field stopped being produced somewhere before
     * this, so the pane could only ever say "No screenshot for the latest
     * browser action" — a control that is built, wired and permanently empty.
     * The route reads a `.png` relative to the thread's workspace root, so that
     * is what this writes.
     *
     * Best-effort, like everything else here: a page that has closed, a viewport
     * that is huge, or a workspace that is not writable costs the pane an image
     * and must not fail the step whose receipt is already real.
     */
    const shot = await captureScreenshot(page, workspaceRoot).catch(() => undefined);
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      ...(viewport ? { viewport } : {}),
      ...(shot !== undefined ? { screenshotPath: shot.path } : {}),
      /*
       * The interactive elements, which the pane draws as boxes over the
       * screenshot. Read from the live page rather than from a stored
       * accessibility tree, because the tree this used to come from is gone and
       * the page is right here.
       */
      interactive: await interactiveElements(page).catch(() => []),
    };
  } catch {
    return undefined;
  }
}

/** Where screenshots for a thread live, relative to its workspace root. */
const SCREENSHOT_DIR = ".reaper/screenshots";

/** How many interactive elements the pane is given, so an overlay stays legible. */
const MAX_INTERACTIVE_BOXES = 200;

/**
 * Capture the page and return the path the gateway can serve it from.
 *
 * The path is relative to the workspace, because that is what `resolveInsideRoot`
 * expects and an absolute one would be rejected as an escape rather than
 * resolved.
 */
async function captureScreenshot(page: Pick<Page, "screenshot">, workspaceRoot: string | undefined): Promise<{ path: string } | undefined> {
  if (workspaceRoot === undefined || workspaceRoot.length === 0) return undefined;
  const name = `shot-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}.png`;
  const relative = `${SCREENSHOT_DIR}/${name}`;
  /*
   * The directory is created before the write, and the first version of this
   * did not do that: `writeFile` failed with `ENOENT` on a workspace that had
   * never held a screenshot, the catch swallowed it, and the pane kept saying it
   * had no screenshot while the capture itself worked perfectly. A best-effort
   * path needs its own failure to be visible, or it hides a hard error behind a
   * soft one.
   */
  await mkdir(path.join(workspaceRoot, SCREENSHOT_DIR), { recursive: true });
  const buffer = await page.screenshot({ fullPage: false, type: "png" });
  await writeFile(path.join(workspaceRoot, relative), buffer);
  return { path: relative };
}

/**
 * The elements a person could act on, with their boxes.
 *
 * Measured from the live DOM in one `evaluate`, because that is one round trip
 * and the alternative is a call per element. Only what is on screen is reported:
 * a box for an element scrolled out of view would be drawn somewhere it is not,
 * which is worse than no box.
 */
async function interactiveElements(page: Page): Promise<NonNullable<BrowserUseResult["surface"]>["interactive"]> {
  const found = await page.evaluate((limit: number) => {
    const selector = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[contenteditable="true"]';
    const out: Array<{ ref: string; index: number; tag: string; text: string; x: number; y: number; width: number; height: number; role?: string; type?: string }> = [];
    let index = 0;
    for (const element of Array.from(document.querySelectorAll(selector))) {
      if (out.length >= limit) break;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      if (rect.right < 0 || rect.left > window.innerWidth) continue;
      index += 1;
      const role = element.getAttribute("role");
      const type = element.getAttribute("type");
      out.push({
        ref: `i${index}`,
        index,
        tag: element.tagName.toLowerCase(),
        text: ((element as HTMLElement).innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").trim().slice(0, 80),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        ...(role !== null ? { role } : {}),
        ...(type !== null ? { type } : {}),
      });
    }
    return out;
  }, MAX_INTERACTIVE_BOXES);
  return found;
}
