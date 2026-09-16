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

import type { Page } from "playwright";

import type { ThreadBrowserRuntime } from "../../browser/thread-runtime.js";
import { renderReceipt, type StepReceipt } from "../../browser/transaction.js";
import { serializeBrowserResult } from "../../browser/serialize.js";
import type { BrowserUseArgs } from "./browser-use.js";
import { liftTrailingDeclaration, splitTrailingExpression, wrapWithTail, wrapWithoutTail } from "../code/transform.js";

export interface BrowserUseMetadata {
  runId: string;
  artifactDir: string;
  toolCallId: string;
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
  pages(): Array<{ name: string | undefined; url: string; active: boolean }>;
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

export function compileBrowserProgram(code: string): ProgramContext {
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
    const wrapped = wrapWithTail(split.prefix, split.tail);
    if (verify(wrapped)) return new Function(...PROGRAM_PARAMS, `return ${wrapped};`) as ProgramContext;
  }

  /*
   * A declaration with nothing after it, `const rows = await page.locator(…)`,
   * is the shape a model writes when it means to return the binding and forgot
   * to name it. Lifting it is what turns a silent `undefined` into the value.
   */
  const lifted = liftTrailingDeclaration(code, verify);
  if (lifted !== undefined && verify(lifted)) {
    return new Function(...PROGRAM_PARAMS, `return ${lifted};`) as ProgramContext;
  }

  /*
   * No tail at all: the program acts and returns nothing, which is the normal
   * shape of a click or a fill. Compiling it plainly is correct rather than a
   * fallback, and a genuine syntax error surfaces from here as itself.
   */
  const plain = wrapWithoutTail(code);
  return new Function(...PROGRAM_PARAMS, `return ${plain};`) as ProgramContext;
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
    newPage: (name?: string) => runtime.newPage(name),
    pages: () => runtime.pagesForDisplay().map((entry) => ({ name: entry.name, url: entry.url, active: entry.active })),
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
export async function executeBrowserUse(runtime: ThreadBrowserRuntime, args: BrowserUseArgs, _metadata: BrowserUseMetadata): Promise<BrowserUseResult> {
  /*
   * A look with no program: the model's first call on a page, and the one it
   * makes again whenever the receipt tells it something changed that it does not
   * understand. Looking is not a lesser operation than acting; writing Playwright
   * against a page you have not seen is how an agent clicks the wrong thing.
   */
  if (args.code === undefined || args.code.trim().length === 0) {
    const view = await runtime.view({ ...(args.selector !== undefined ? { selector: args.selector } : {}) });
    return {
      output: `${view.text}\n\n[${view.stats.lines} lines, ${view.stats.chars} chars, ${view.stats.refs} refs, ${view.stats.interactive} interactive]\n(REV ${runtime.observer.revision} - pass expected_revision with your next program)`,
      outcome: "SUCCESS",
      rev: runtime.observer.revision,
    };
  }

  let program: ProgramContext;
  try {
    program = compileBrowserProgram(args.code);
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

  let outcome: StepReceipt["outcome"];
  let receipt: StepReceipt;
  let result: unknown;
  try {
    const observe = observeSurface(runtime);
    const surface = browserSurface(runtime);
    const stepped = await runtime.step(
      (page) => program(page, surface, observe.view, observe.viewChanges, observe.screenshot, surface.pages),
      {
      ...(args.expected_revision !== undefined ? { expectedRevision: args.expected_revision } : {}),
      ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
    });
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
  const surface = await pageSurface(runtime);
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

  return {
    output: lines.join("\n"),
    outcome,
    ...(outcome === "SUCCESS" || outcome === "NO_CHANGE" ? {} : { isError: true }),
    rev: runtime.observer.revision,
    ...(surface ? { surface } : {}),
  };
}

/**
 * The page as facts a presenter can use.
 *
 * A failure here is not a failure of the step: the program already ran and its
 * receipt is real. The pane simply gets no update, which is better than the
 * step being reported as failed because a title could not be read.
 */
async function pageSurface(runtime: ThreadBrowserRuntime): Promise<BrowserUseResult["surface"]> {
  try {
    const { page } = await runtime.ensureReady();
    const viewport = page.viewportSize();
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      ...(viewport ? { viewport } : {}),
    };
  } catch {
    return undefined;
  }
}
