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
import { renderTransaction } from "../../browser/runtime/transaction.js";
import { serializeBrowserResult } from "../../browser/serialize.js";
import type { BrowserUseArgs } from "./browser-use.js";
import { verifyStep } from "../../browser/verify.js";
import { looksBlocked } from "../../browser/user-agents.js";
import { scopePage } from "../../browser/scoped-page.js";
import { BROWSER_PROGRAM_PARAMS } from "../../browser/remote-page-source.js";
import { collectUnannounced } from "../../browser/downloads.js";
import { transactionalSurface } from "../../browser/runtime/control-extras.js";
import { inspectProgram, renderPolicyReport } from "../../browser/runtime/policy-guard.js";
import { renderVerification } from "../../browser/runtime/verifier.js";
import { renderInspection } from "../../browser/runtime/inspect.js";
import { classifyFailure, renderFailure } from "../../browser/runtime/failure.js";
import {
  BrowserProgramHost,
  type ControlSurface,
  type ObserveSurface,
} from "../../browser/browser-program.js";
import type { BandwidthSettings, BrowserSettings } from "../../browser/session-controls.js";
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
  setActive(selector: string | number | Page): Promise<Page>;
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
/*
 * `ObserveSurface` is imported from `browser-program.ts` rather than declared
 * here.
 *
 * It was declared in both places, and adding the control calls to one of them
 * made them disagree: the host required a `control` member the tool's copy did
 * not have, so the tool's object was rejected where it was consumed. One
 * declaration is the fix; a second copy would drift the same way again.
 */

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

/**
 * The parameter names a program can use.
 *
 * Re-exported from the sandbox's own list rather than kept beside it. It used to
 * be a second copy, with a comment saying the two must stay in step and nothing
 * making them: `recover` and `capabilities` were added here and not there, so the
 * tool description told the model to call a name the sandbox never bound, and it
 * got "recover is not defined" for its trouble. One list, imported, is what the
 * comment was trying to be.
 */
export const PROGRAM_PARAMS = BROWSER_PROGRAM_PARAMS;

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
/**
 * Whether a program dispatches a DOM event from inside page script.
 *
 * This is the question the untrusted-events note is really asking: a click made
 * with `locator.click()` is trusted because Chrome generates the event, and a
 * click made with `el.click()` inside `evaluate` is not, because the page script
 * calls it. A program that does both (read with `evaluate`, click with the real
 * API) is the common, correct shape and must not be warned about.
 *
 * Scans the argument of each `evaluate` call for a dispatching call, rather than
 * the whole program for the word `evaluate`. The scan is brace and quote aware so
 * it does not run past the end of the argument into a later `locator.click()`,
 * which is the false positive that made the note fire on almost every step of a
 * live mission and taught the model to ignore it.
 */
export function dispatchesEventFromScript(code: string): boolean {
  const opens = ["evaluate(", "evaluateHandle("];
  for (const open of opens) {
    let from = 0;
    for (;;) {
      const at = code.indexOf(open, from);
      if (at === -1) break;
      from = at + open.length;
      const body = readCallArgument(code, from);
      if (body === undefined) continue;
      if (/\b(?:click|submit|dispatchEvent)\s*\(/.test(body)) return true;
    }
  }
  return false;
}

/**
 * The text of one call argument, brace and quote aware.
 *
 * Stops at the comma or close paren that ends the first argument at depth zero,
 * so a following `locator.click()` in the same program is not swallowed into it.
 * Returns undefined when the call is never closed, which means the program does
 * not parse and the compile step will say so properly.
 */
function readCallArgument(code: string, start: number): string | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let i = start; i < code.length; i++) {
    const ch = code[i]!;
    if (quote !== undefined) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(" || ch === "{" || ch === "[") { depth++; continue; }
    if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) return code.slice(start, i);
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) return code.slice(start, i);
  }
  return undefined;
}

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
    newPage: async (name?: string) => scopePage(await runtime.newPage(name), runtime.threadId),
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
/**
 * The rendered form of a transaction result, when that is what this is.
 *
 * A `tx` call answers with `{ receipt, text }`, and `text` is already the
 * compact rendering. A model that wrote `return await tx(...)` therefore has the
 * good answer in hand and the tool was printing the JSON wrapper around it
 * instead, which is the same information at three times the size.
 *
 * Structural rather than by class, because the value crossed the sandbox
 * boundary and arrived as plain data: the prototype is gone by the time it gets
 * here.
 */
function transactionTextOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["text"] === "string" && typeof candidate["receipt"] === "object" && candidate["receipt"] !== null) {
    return candidate["text"];
  }
  /*
   * A receipt on its own, without the wrapper. `buildReceipt` produces exactly
   * these keys, and a program that returned the receipt directly gets the same
   * treatment.
   */
  if (
    typeof candidate["actionId"] === "string" &&
    typeof candidate["status"] === "string" &&
    typeof candidate["page"] === "object" &&
    typeof candidate["change"] === "object" &&
    typeof candidate["timing"] === "object"
  ) {
    return renderTransaction(value as Parameters<typeof renderTransaction>[0]);
  }
  return undefined;
}

/**
 * The failures whose fix is a different locator, or a different element.
 *
 * A closed set rather than a catch-all, so the local-context block appears on
 * the receipts it can help and nowhere else. A crash, a navigation timeout and a
 * server rejection all have nothing to do with which element was named.
 */
function isLocatorFailure(kind: string): boolean {
  return [
    "LOCATOR_NOT_FOUND",
    "LOCATOR_AMBIGUOUS",
    "ZERO_AREA",
    "NOT_VISIBLE",
    "NOT_RECEIVING_EVENTS",
    "DETACHED",
    "NOT_ENABLED",
    "NOT_EDITABLE",
  ].includes(kind);
}

/**
 * The failures a page that has stopped accepting input produces.
 *
 * A renderer that silently drops events makes a click return without
 * dispatching, so the step's effect is absent and the receipt says NO_CHANGE or
 * times out waiting for something the click would have caused. Those two shapes
 * are what this checks against: probing on a form rejection or a missing
 * element would be a CDP round trip for a cause the page cannot have.
 *
 * Deliberately not `NO_CHANGE` on its own. A click that lands on nothing is the
 * ordinary case of this, but the check is driven by the failure taxonomy because
 * a NO_CHANGE with no failure has already been through the return-value
 * reasoning in the transaction, and a live-mission probe for a page that is
 * simply quiet would be noise.
 */
const INPUT_CONSISTENT_FAILURES = new Set(["ACTION_TIMEOUT", "NOT_RECEIVING_EVENTS", "ZERO_AREA", "UNKNOWN"]);

/**
 * Re-test an element that would not respond, and say why when that is knowable.
 *
 * Returns an empty string when the trial adds nothing: either the locator cannot
 * be rebuilt from the program, or the element passes the trial and the cause is
 * somewhere else (input delivery, which the health check covers).
 */
async function clarifyUnclickable(runtime: ThreadBrowserRuntime, page: Page, code: string | undefined): Promise<string> {
  if (code === undefined) return "";
  const target = rebuildLocator(page, lastLocatorCallIn(code));
  if (target === undefined) return "";
  const { inspectLocator } = await import("../../browser/runtime/inspect.js");
  const inspection = await inspectLocator(page, target).catch(() => undefined);
  if (inspection === undefined || inspection.actionable) return "";
  /*
   * `renderInspection` already prints the children that have a real box, which
   * is the answer for a zero-area element. Prefixed so it reads as the reason
   * the click failed rather than as an unrelated observation.
   */
  return `WHY: this is why the click could not land.\n${inspection.failure?.kind ?? "blocked"}: ${inspection.failure?.diagnostic ?? ""}\n${renderInspection(inspection)}`;
}

/**
 * The last locator expression a program built, as `method(args)` text.
 *
 * The last one, because the failure is on the action that came last and that
 * action is chained to the locator just above it. Best effort by design: a
 * locator built from a variable returns undefined and nothing is printed, which
 * is better than naming an element the model did not mean.
 */
function lastLocatorCallIn(code: string): string | undefined {
  let best: { at: number; text: string } | undefined;
  for (const method of ["getByRole", "getByTestId", "getByText", "getByLabel", "getByPlaceholder", "getByTitle", "getByAltText", "locator"]) {
    const pattern = new RegExp(`\\b${method}\\((?:[^()]|\\([^()]*\\))*\\)`, "g");
    for (const match of code.matchAll(pattern)) {
      if (match.index === undefined) continue;
      if (best === undefined || match.index > best.at) best = { at: match.index, text: match[0] };
    }
  }
  return best?.text;
}

/**
 * Turn `getByTestId("x")` back into a real Locator, using the page's own methods.
 *
 * Parsed rather than evaluated, and that is the whole reason this is safe. The
 * program is model-written, and running it a second time to recover a locator
 * would run its side effects twice. Nothing here is executed: the text is matched
 * against a fixed shape, the strings inside it are unquoted as data, and the
 * result is built by calling Playwright directly.
 *
 * Only the forms a locator is actually written in are accepted, and anything
 * else returns undefined. A locator this cannot read costs the model one
 * diagnostic block; a locator this read wrongly would cost it a wrong element,
 * which is the failure the whole revision scheme exists to prevent.
 */
function rebuildLocator(page: Page, call: string | undefined): ReturnType<Page["locator"]> | undefined {
  if (call === undefined) return undefined;
  const parsed = /^(getBy[A-Za-z]+|locator)\((.*)\)$/s.exec(call.trim());
  if (parsed === null) return undefined;
  const method = parsed[1]!;
  const args = parsed[2]!;

  /* One string literal, optionally followed by `{ name: "..." }`. */
  const literal = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?:\s*,\s*\{\s*name:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\})?$/.exec(args.trim());
  if (literal === null) return undefined;
  const first = unquote(literal[1]!);
  const name = literal[2] !== undefined ? unquote(literal[2]) : undefined;

  switch (method) {
    case "getByTestId":
      return page.getByTestId(first);
    case "getByText":
      return page.getByText(first);
    case "getByLabel":
      return page.getByLabel(first);
    case "getByPlaceholder":
      return page.getByPlaceholder(first);
    case "getByTitle":
      return page.getByTitle(first);
    case "getByAltText":
      return page.getByAltText(first);
    case "locator":
      return page.locator(first);
    case "getByRole":
      /*
       * A role with no name is legal and common. With one, the name is passed as
       * the exact string it was written as, never as a pattern: a model that
       * wrote a literal meant that element.
       */
      return name !== undefined
        ? page.getByRole(first as Parameters<Page["getByRole"]>[0], { name })
        : page.getByRole(first as Parameters<Page["getByRole"]>[0]);
    default:
      return undefined;
  }
}

/** The text inside a JS string literal, with the escapes a locator uses. */
function unquote(literal: string): string {
  const body = literal.slice(1, -1);
  return body.replace(/\\(.)/g, "$1");
}

function observeSurface(runtime: ThreadBrowserRuntime, intern: (value: unknown) => number | undefined): ObserveSurface {
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
    control: controlSurface(runtime, intern),
  };
}

/**
 * The settings a program can change, wired to the runtime.
 *
 * Each call goes through `setSettings`, so the live-vs-next-launch distinction
 * and the "apply to every open page" step happen in one place and every spelling
 * of a setting gets the same answer. Parsing is deliberately forgiving about the
 * shape and strict about the value: a viewport of `"wide"` is refused rather
 * than silently coerced to `NaN`, because a program that asked for something
 * impossible should hear about it.
 */
function controlSurface(runtime: ThreadBrowserRuntime, intern: (value: unknown) => number | undefined): ControlSurface {
  const requireString = (value: string, name: string): string => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${name} must be a non-empty string`);
    }
    return value.trim();
  };
  const requireSize = (value: number, name: string): number => {
    if (!Number.isFinite(value) || value < 1) {
      throw new Error(`${name} must be a positive number, got ${String(value)}`);
    }
    return Math.round(value);
  };

  return {
    set: async (settings) => {
      const patch: BrowserSettings = {};
      if (settings["userAgent"] !== undefined) patch.userAgent = requireString(String(settings["userAgent"]), "userAgent");
      if (settings["timezone"] !== undefined) patch.timezone = requireString(String(settings["timezone"]), "timezone");
      if (settings["blockAds"] !== undefined) patch.blockAds = settings["blockAds"] === true;
      if (settings["fullscreen"] !== undefined) patch.fullscreen = settings["fullscreen"] === true;
      if (settings["mobile"] !== undefined) patch.mobile = settings["mobile"] === true;
      if (settings["proxy"] !== undefined && typeof settings["proxy"] === "object" && settings["proxy"] !== null) {
        const proxy = settings["proxy"] as Record<string, unknown>;
        patch.proxy = {
          server: requireString(String(proxy["server"] ?? ""), "proxy.server"),
          ...(typeof proxy["username"] === "string" ? { username: proxy["username"] } : {}),
          ...(typeof proxy["password"] === "string" ? { password: proxy["password"] } : {}),
        };
      }
      const width = settings["width"];
      const height = settings["height"];
      if (width !== undefined || height !== undefined) {
        patch.viewport = {
          width: requireSize(Number(width), "width"),
          height: requireSize(Number(height), "height"),
        };
      }
      if (settings["bandwidth"] !== undefined && typeof settings["bandwidth"] === "object") {
        patch.bandwidth = settings["bandwidth"] as BandwidthSettings;
      }
      if (settings["userPreferences"] !== undefined && typeof settings["userPreferences"] === "object") {
        patch.userPreferences = settings["userPreferences"] as Record<string, unknown>;
      }
      return await runtime.setSettings(patch);
    },
    setUserAgent: async (userAgent) => await runtime.setSettings({ userAgent: requireString(userAgent, "userAgent") }),
    setTimezone: async (timezone) => await runtime.setSettings({ timezone: requireString(timezone, "timezone") }),
    setViewport: async (width, height) =>
      await runtime.setSettings({ viewport: { width: requireSize(width, "width"), height: requireSize(height, "height") } }),
    setFullscreen: async (enabled) => await runtime.setSettings({ fullscreen: enabled }),
    setMobile: async (enabled) => await runtime.setSettings({ mobile: enabled }),
    blockAds: async (enabled) => await runtime.setSettings({ blockAds: enabled }),
    bandwidth: async (options) => await runtime.setSettings({ bandwidth: options as BandwidthSettings }),
    settings: async () => runtime.currentSettings(),
    /*
     * What this browser can actually do right now.
     *
     * The mission showed why this matters: the model spent thirteen calls working
     * out whether downloads were possible, and it had no way to ask. That is not
     * a reasoning problem, it is a missing fact, and a fact the runtime already
     * holds. So it is one call rather than an experiment.
     *
     * Reported from live state rather than as a static list, because the answer
     * genuinely changes: downloads depend on whether the command was accepted on
     * this connection, and `attached` depends on the connection being up.
     */
    capabilities: async () => {
      /*
       * The one call that answers "will this work here", which is what the model
       * needed and did not have.
       *
       * A mission spent twenty minutes on a single invoice because the only way
       * to learn that downloads were unavailable was to attempt one and read a
       * message about the page. Asking first is one call, and the answer is
       * specific enough to change what the model does next: `downloads: false`
       * with `downloadNote` naming the cause means the upload phase cannot work,
       * which is a fact to report rather than a bug to debug.
       *
       * `downloadNote` is the browser's own words, recorded at attach time rather
       * than reconstructed from a later failure, because that is where the cause
       * is knowable.
       */
      const note = runtime.takeDownloadNote();
      const downloads = runtime.downloadsAreEnabled;
      return {
        attached: runtime.isAttached(),
        downloads,
        /** Trusted input is available; `recover()` is the fix when a page ignores it. */
        trustedInput: true,
        /** Settings that take effect on the live page. */
        liveSettings: ["userAgent", "timezone", "viewport", "fullscreen", "mobile", "blockAds", "bandwidth"],
        /** Settings that apply only when the browser next starts. */
        nextLaunchSettings: ["proxy", "userPreferences"],
        /** Files persist in this thread's workspace and can be uploaded later. */
        downloadVault: downloads,
        /**
         * Where a downloaded file goes, so the model can read it without asking.
         *
         * Inside the thread's own workspace, which is the sandbox root, so a file
         * tool and an upload can both reach it. Named here rather than discovered
         * because the discovery is what costs a model its time: a file whose
         * location is unknown is a file it searches the filesystem for.
         */
        ...(downloads ? { downloadVaultPath: runtime.downloadVault.path } : {}),
        /** Why downloads are off, when they are off. Absent when they work. */
        ...(!downloads && note !== undefined ? { downloadNote: note } : {}),
        recoverable: true,
      };
    },
    rotateUserAgent: async () => await runtime.rotateUserAgent(),
    /*
     * The argument is a page the program may hold, so it is resolved through the
     * same revive path any Playwright handle takes; a bare call recovers the
     * active page, which is what a program that did not name one means.
     */
    recover: async (target?: unknown) => await runtime.recover(target as never),
    probeInput: async (target?: unknown) => await runtime.probeInput(target as never),
    /*
     * The transactional half, which needs a live page, the registry and the
     * ledger together.
     *
     * It is built in its own module and spread here rather than inlined, because
     * the two halves have nothing in common and this function is already long.
     * The `intern` callback is what lets `expectPopup` hand a real Page back to
     * the program: the bridge owns the handle table, so the helper that produces
     * a new live object has to be able to add one.
     */
    ...transactionalSurface(runtime, intern),
    downloads: async () =>
      runtime.downloadedFiles.map((file) => ({ name: file.name, bytes: file.bytes, ...(file.url ? { url: file.url } : {}) })),
    download: async (name) => {
      /*
       * Resolved against the files actually on the vault, never against a path a
       * program supplied. A bare name is the whole input, so a program cannot
       * ask for a path outside this thread's downloads even by accident.
       */
      const wanted = name.trim();
      const match = runtime.downloadedFiles.find((file) => file.name === wanted)
        ?? (await runtime.vaultFiles()).find((file) => file.name === wanted);
      return match === undefined ? undefined : { name: match.name, path: match.path, bytes: match.bytes };
    },
    downloadAfter: async (target) => {
      /*
       * Arm the listener, click the thing, and hand back the file.
       *
       * The pair is one host call because it cannot be two. Through the bridge a
       * `waitForEvent` is a call that does not return until the event fires, and
       * the event can only fire once the *next* call of the same program runs,
       * which cannot start until this one returns. Measured: both
       * `Promise.all([waitForEvent, click])` and the sequential wait-then-click
       * form timed out at 30s with no error.
       *
       * The argument is the element to click, resolved from the program's own
       * locator, so the call reads as `downloadAfter(page.getByText("Invoice"))`
       * and no selector has to be re-derived on this side.
       */
      const page = (await runtime.ensureReady()).page;
      const before = runtime.downloadedFiles.length;
      /*
       * The argument is validated BEFORE the wait is armed, and the wait carries
       * its own handler from the moment it exists. Both halves are the fix for a
       * crash that took the whole app-server down, and neither is decoration.
       *
       * Measured on a live mission: the agent called
       * `downloadAfter(page.locator('a[href$="/download_invoice/..."]'))`, the
       * click did not produce a download, and thirty-three seconds later the
       * server logged
       *
       *   unhandledRejection: page.waitForEvent: Timeout 30000ms exceeded while
       *   waiting for event "download"
       *
       * and exited. The UI went to "reconnecting", every thread vanished from the
       * sidebar, and the mission kept running as a zombie because its two gauges
       * do not go through this process.
       *
       * The shape of the bug is a promise whose rejection has no handler at the
       * moment it rejects. `page.waitForEvent(...)` was created here, the
       * argument check could throw before anything caught it, and the click was
       * awaited before `download.catch(...)` was attached. Either a rejected
       * argument or a click slower than the 30s timeout left that promise
       * unhandled, and in this codebase an unhandled rejection is fatal by
       * design. Attaching the handler at creation removes the window entirely:
       * once this promise exists, its rejection is always handled, whatever
       * happens to the click.
       */
      const clickable = target as unknown as { click?: () => Promise<void> };
      if (typeof clickable?.click !== "function") {
        throw new Error("downloadAfter takes the element that starts the download, for example page.getByRole(\"link\", { name: \"Invoice\" })");
      }
      const download = page.waitForEvent("download", { timeout: 30_000 }).then(
        () => true,
        () => false,
      );
      /*
       * A click that fails is not the interesting fact here: the click is
       * allowed to throw (a detached element, a page that navigated), and what
       * the caller needs is whether a file arrived. Its error is swallowed on
       * purpose, and the download wait below is what decides the outcome.
       */
      await clickable.click().catch(() => undefined);
      /*
       * The event is awaited, and so is the copy into the vault, which happens
       * asynchronously in the download handler. Waiting for the file to appear
       * rather than for the event alone is what stops a caller from being handed
       * a name for a file that is still being written.
       *
       * `download` is already a resolved boolean by now: it was created with both
       * handlers attached, so this await cannot reject and the timeout arrives
       * here as `false` rather than as an unhandled rejection that kills the
       * server.
       */
      const arrived = await download;
      /*
       * The vault copy is asynchronous, so the file is polled for. Bounded by the
       * event: a download that never fired is not waited on for six more seconds,
       * because there is nothing to wait for and the refusal below is the honest
       * answer.
       */
      for (let i = 0; i < (arrived ? 60 : 5) && runtime.downloadedFiles.length === before; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      /*
       * The directory is checked as well as the event, and this is what makes a
       * download work when the notification does not arrive.
       *
       * The event is Playwright's, and it depends on this process owning the
       * browser's download configuration. Steel sets that at launch with its own
       * directory, so a client re-setting it is racing the platform. When the race
       * is lost the file still lands on disk and nothing announces it: measured on
       * a live mission, the vault went empty while the browser had written the
       * file, and the model spent twenty minutes proving the page was fine when
       * the page always was.
       *
       * Reading the directory is the fix because the file's presence is the fact
       * that matters, and it is observable without the event.
       */
      const unannounced = await collectUnannounced(runtime.downloadVault, runtime.downloadedFiles).catch(() => []);
      void unannounced;
      let file = runtime.downloadedFiles[runtime.downloadedFiles.length - 1];
      if (file === undefined) {
        /*
         * Nothing arrived, so the cause is stated rather than guessed at. The
         * three cases need different responses and only one of them is about the
         * page:
         *
         *   - the browser refused the download command: nothing about this page
         *     can be fixed by trying again, and the model must stop.
         *   - the command was accepted and no file came: the click or a dialog on
         *     the page is the likely cause, which is the only case worth a retry.
         *
         * The first case used to be reported as the second, which is what sent a
         * model round a twenty-minute loop of page inspection.
         */
        const note = runtime.takeDownloadNote();
        throw new Error(
          runtime.downloadsAreEnabled
            ? /*
               * The command was accepted, so the page is the remaining suspect.
               * A `note` here means the handler recorded a copy failure, which is
               * a different problem and worth saying so: the browser downloaded
               * the file and this process could not keep it.
               */
              `no file reached the vault. ${
                note ?? "The click landed but the page produced no download: check that it hit a real download control, and that the page does not want a dialog answered first."
              }`
            : `downloads are not enabled on this browser, so clicking cannot produce a file, and no amount of retrying on the page will change that. ` +
              `${note ?? "The browser did not accept the download configuration."} ` +
              "Report this rather than investigating the page; use download() to check the vault in case a file is already there.",
        );
      }
      /*
       * Where it landed, and that the model can read it.
       *
       * The path is inside the thread's own workspace, which is the sandbox root,
       * so `file_view` and `setInputFiles` can both reach it. Saying so is not
       * decoration: a model that does not know a file's location will search for
       * it, and the search is what turns one download into twenty minutes of
       * work. The vault path is stated relative to the workspace, because that is
       * how every other path in this tool is expressed.
       */
      return {
        name: file.name,
        path: file.path,
        bytes: file.bytes,
        note: `saved to this thread's download vault and readable from a program or a file tool at ${file.path}`,
      };
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
  /*
   * A finish request, answered before anything else.
   *
   * It is checked against the ledger and the live page rather than against
   * anything the model said, and a failure returns the missing conditions with
   * the mission still running. `completed_verified` is the only state that means
   * done; there is deliberately no way to be finished without passing.
   */
  if (args.finish !== undefined) {
    const page = runtime.activePage;
    const outcome = await runtime.kit.check(args.finish, page);
    return {
      output: renderVerification(outcome),
      outcome: outcome.passed ? "SUCCESS" : "POSTCONDITION_FAILED",
      isError: !outcome.passed,
      rev: runtime.observer.revision,
    };
  }

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
    /*
     * The health note is drained here as well as on the code path, because a
     * look is the first call a model makes after a reconnect, and it is exactly
     * when a closed tab needs explaining. Drained rather than read: leaving it
     * set would repeat it on every later step until something else tripped it.
     */
    const health = runtime.takeHealthNote();
    const created = runtime.takePageCreationNote();
    /*
     * The thread's pages, with the handles that address them.
     *
     * This is the change that removes the largest measured waste in a long
     * mission: fifty-two calls that existed only to find a tab the model had
     * already found. `browser.pages()` returns objects, so a model that wanted
     * "the parabank tab" had to fetch every tab and match on its URL, every
     * time, because nothing carried the answer forward.
     *
     * Printed only when there is more than one page. A single-tab session
     * already knows which tab it is on, and a list of one on every look is
     * tokens spent on nothing.
     */
    const pages = runtime.kit.registry.live();
    const listing = pages.length > 1 ? await runtime.kit.registry.render(runtime.activePage) : "";
    return {
      output:
        `${view.text}\n\n[${stats.lines} lines, ${stats.chars} chars, ${stats.elements} elements]` +
        `\n(REV ${runtime.observer.revision} - pass expected_revision with your next program)` +
        (listing.length > 0 ? `\n\n${listing}` : "") +
        (flows.length > 0 ? `\n\n${flows.join("\n")}` : "") +
        (health !== undefined ? `\n\nBROWSER: ${health}` : "") +
        (created !== undefined ? `\n\nPAGES: ${created}` : ""),
      outcome: "SUCCESS",
      rev: runtime.observer.revision,
    };
  }

  /*
   * The policy, checked against the source before anything is compiled or run.
   *
   * Before, not after, and that is the whole point: a rule enforced once the
   * program has fetched the file has already been broken. The check is static
   * and syntactic, which is the right strength for this: it catches the model
   * reaching for a shortcut it has used before, not a deliberate evasion, and a
   * deliberate evasion produces a run that fails verification anyway.
   */
  const policy = args.policy ?? "none";
  const policyReport = inspectProgram(args.code, policy);
  if (!policyReport.allowed) {
    return {
      output: `${renderPolicyReport(policyReport)}\n\nNothing ran, and the page is unchanged. Do this through the page instead.`,
      outcome: "PRECONDITION_FAILED",
      isError: true,
      rev: runtime.observer.revision,
    };
  }

  /*
   * A program that already failed in this page state is refused, not re-run.
   *
   * The measured failure: thirteen consecutive identical clicks, each written
   * believing the failure was transient, with nothing ever telling the model the
   * previous twelve had been the same call. The refusal is reported with the
   * original failure, so the model gets the diagnosis it already earned rather
   * than a new wait that ends the same way.
   *
   * Checked after the policy and before the compile, so a refused program costs
   * nothing to reject. A genuinely different program, or the same program after
   * the page moved, is a different fingerprint and runs normally.
   */
  const repeat = runtime.kit.refusesRepeat(args.code, runtime.observer.revision);
  if (repeat !== undefined) {
    return {
      output:
        `OUTCOME: REPEATED_FAILURE\n\n` +
        renderFailure({
          ...repeat,
          kind: repeat.kind,
          diagnostic: `${repeat.diagnostic} You already ran this exact program on this page state and it failed the same way.`,
          retryable: false,
          recommendedNext:
            "Change something before retrying: a different locator, inspect() on the target, waitForChange(), or a different route to the goal.",
        }) +
        `\n\nNothing ran and the page is unchanged.`,
      outcome: "PRECONDITION_FAILED",
      isError: true,
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
  const readyAtStart = await runtime.ensureReady().catch(() => undefined);
  const urlAtStart = readyAtStart?.page.url();
  /*
   * The page this step is about, held for the diagnostics below.
   *
   * `lastCapturedPage()` is NOT this, and the difference is a real bug that
   * showed up the moment a diagnostic depended on it. That ref is set by the
   * step's own label callback, and the callback runs only on the success path:
   * a *failed* step returns before it, so the ref still holds whatever the last
   * successful step captured.
   *
   * Measured: a click that timed out on `/zero-area` was diagnosed against a
   * page another test had left active, and the answer was `matches: 0` for a
   * locator that matches one element on the page the step actually used. Every
   * diagnostic that reaches for "the page the step was about" had this wrong on
   * exactly the steps diagnostics exist for.
   */
  const stepPage = readyAtStart?.page;
  const stateBefore = signatureOf(urlAtStart, args.expect);

  let outcome: StepReceipt["outcome"];
  let receipt: StepReceipt;
  let result: unknown;
  /*
   * The step is an action, and it is recorded as one before the program runs.
   *
   * This is what gives a bare program the identity that provenance needs. Without
   * it, `download()` inside a plain program stored its artifact with no
   * `triggeredBy`, so a `finish` check for `artifactFromAction` could never pass
   * outside a `tx`: the file arrived, the ledger recorded the event, and nothing
   * tied it to the click that caused it.
   *
   * It also puts the step in the metrics, which the ledger now owns: a bare
   * program is a browser call like any other and was previously invisible to the
   * counts.
   */
  const stepActionId = runtime.kit.beginAction(args.intent);
  try {
    /*
     * The observe surface needs the handle table, and the handle table is the
     * host's, and the host is constructed with the observe surface. The cycle is
     * broken with a mutable reference that is filled in on the next line: the
     * `intern` callback is only ever invoked while a program is running, which is
     * strictly after the host exists. Nothing races it.
     */
    let hostRef: BrowserProgramHost | undefined;
    const observe = observeSurface(runtime, (value) => hostRef?.intern(value));
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
    const programHost = new BrowserProgramHost(runtime, runtime.scopeForProgram(active.page), observe);
    hostRef = programHost;
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
    /*
     * Closed with the outcome the receipt reports, so the ledger's failure
     * counts and the receipt cannot disagree. `NO_CHANGE` is a success here: the
     * program ran cleanly and the page did not move, which is a fact about the
     * page rather than a failed action.
     */
    runtime.kit.endAction({
      actionId: stepActionId,
      status: receipt.outcome === "SUCCESS" || receipt.outcome === "NO_CHANGE" ? "success" : "failed",
      durationMs: receipt.elapsedMs,
      ...(receipt.failure !== undefined ? { failureKind: receipt.failure.kind } : {}),
    });
    /*
     * A structural failure is remembered against the program and the revision,
     * so the next identical attempt is refused. Only the kinds repeating cannot
     * fix: a timeout or a detached element may genuinely work next time, and
     * refusing those would be the runtime overruling a correct retry.
     */
    if (receipt.failure !== undefined && !receipt.failure.retryable) {
      runtime.kit.rememberFailure(args.code, runtime.observer.revision, {
        kind: receipt.failure.kind as never,
        diagnostic: receipt.failure.diagnostic,
        retryable: false,
        ...(receipt.failure.recommendedNext !== undefined ? { recommendedNext: receipt.failure.recommendedNext } : {}),
      });
    }
    /*
     * A locator that worked is remembered, against the site it worked on.
     *
     * After the step rather than before, because what is worth remembering is a
     * locator that resolved *and* was acted on. A locator that merely resolves
     * can be the wrong element, and caching that is how a healer learns to click
     * the wrong thing reliably.
     *
     * Only on a clean step. A program that failed may have reached its locator
     * and been refused by it, and remembering that would teach the cache the one
     * expression the next failure should distrust.
     */
    if ((receipt.outcome === "SUCCESS" || receipt.outcome === "NO_CHANGE") && stepPage !== undefined && !stepPage.isClosed()) {
      const worked = lastLocatorCallIn(args.code);
      if (worked !== undefined) runtime.kit.rememberLocator(worked, stepPage.url());
    }
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
    /*
     * The action is closed on this path too.
     *
     * A throw from the harness leaves the action open in the ledger, which makes
     * every later metric wrong by one and leaves a fingerprint that never
     * resolves. `blocked` rather than `failed` because neither the page nor the
     * program was at fault: the runtime could not observe the step.
     */
    runtime.kit.endAction({
      actionId: stepActionId,
      status: "blocked",
      durationMs: 0,
    });
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
   * A step whose failure is consistent with a dead page gets the page checked.
   *
   * `probeInput` and `recover` are exactly the primitives the model kept
   * rebuilding by hand, and the runtime can run them itself because neither
   * re-runs the program: replacing a renderer changes the page, not the work, so
   * there is no way for this to double-submit a form.
   *
   * Run only for the failure kinds a dead renderer actually produces. A form
   * rejection, a missing element or a policy refusal has nothing to do with
   * input delivery, and probing on those would be a CDP round trip per failure
   * for no reason.
   */
  if (receipt.failure !== undefined && INPUT_CONSISTENT_FAILURES.has(receipt.failure.kind)) {
    const about = stepPage;
    if (about !== undefined && !about.isClosed()) {
      const health = await runtime.kit.ensureHealthy(about).catch(() => ({ recovered: false, note: undefined }));
      if (health.recovered && health.note !== undefined) lines.push("", `RECOVERED: ${health.note}`);
    }
  }

  /*
   * A locator failure gets the neighbourhood, not the page.
   *
   * The model derived the locator that broke from the page it had, so handing it
   * the page again hands back the same information that produced the wrong
   * answer, at forty thousand characters. What it does not have is which
   * elements are near where it was looking, what they are called, and which of
   * them can actually be clicked. That is what this adds, and it is bounded to
   * eight candidates.
   *
   * Only for the failures where the target is the problem. A timeout with a good
   * locator, a crash, a policy refusal: none of those are helped by a list of
   * nearby elements, and adding one would make the receipt longer for nothing.
   */
  /*
   * A claim that could not be clicked is re-tested with its geometry read.
   *
   * `NOT_VISIBLE` is the one classification the transaction cannot finish on its
   * own, and the shortfall is not cosmetic. It is reported both for an element
   * hidden by CSS and for one whose box is zero-sized, and the two want opposite
   * responses: a hidden element should be revealed, and a zero-area one cannot
   * be, because there is nothing to reveal. The advice printed for it ("reveal
   * it first") is therefore wrong half the time, and it was wrong for the
   * measured case, a delete button sized to nothing with a clickable icon
   * inside.
   *
   * The transaction has the error and no locator; `inspect()` has the trial and
   * the geometry, and distinguishing those two is precisely what it does. So the
   * trial runs here, against the locator rebuilt from the program's own source,
   * and when it can say more than the classifier could, it replaces the advice
   * rather than adding to it.
   *
   * The same run of a mission never called `inspect()` once. A check the model
   * does not reach for is one the runtime should make.
   */
  if (receipt.failure?.kind === "NOT_VISIBLE" || receipt.failure?.kind === "ACTION_TIMEOUT") {
    /*
     * The step's page, falling back to the active one.
     *
     * `lastCapturedPage()` is set by the step's own labelling callback, so it is
     * the right answer when it exists. The fallback is for the case where the
     * step never labelled one, which is not hypothetical: a program that fails
     * before touching an element leaves the ref unset, and that is exactly the
     * failure this block exists to explain.
     */
    const about = stepPage;
    if (about !== undefined && !about.isClosed()) {
      const better = await clarifyUnclickable(runtime, about, args.code).catch(() => "");
      if (better.length > 0) lines.push("", better);
    }
  }

  if (receipt.failure !== undefined && isLocatorFailure(receipt.failure.kind) && receipt.failure.target !== undefined) {
    const about = stepPage;
    if (about !== undefined && !about.isClosed()) {
      const context = await runtime.kit.context(about, { text: receipt.failure.target }).catch(() => "");
      if (context.length > 0) lines.push("", context);
    }
  }

  /*
   * What this thread already knows about the locator that just failed.
   *
   * The question a failed step raises is "is my target wrong, or is something
   * else wrong", and the model cannot answer it without spending a step. The
   * cache can, when the same ask worked here before:
   *
   *   live   the ask still resolves to an actionable element, so the target is
   *          not the problem and rewriting the locator is wasted work. Measured:
   *          a step failed for an unrelated reason and the model re-derived an
   *          element that had never been broken.
   *   stale  it worked here and does not now, so the page moved under a locator
   *          that used to be right. That is a different repair from "your
   *          selector was never correct", and the model cannot tell them apart.
   *
   * Nothing is printed when there is no history, which is the one case where the
   * locator itself is the prime suspect. Silence there is the correct answer
   * rather than a gap.
   *
   * The locator is taken from the program's own source, the same way the
   * neighbourhood lookup above does, so a locator built from a variable simply
   * has no history and prints nothing.
   */
  if (receipt.failure !== undefined && isLocatorFailure(receipt.failure.kind)) {
    const about = stepPage;
    const asked = lastLocatorCallIn(args.code);
    if (about !== undefined && !about.isClosed() && asked !== undefined) {
      const recall = await runtime.kit.recallLocator(asked, about.url(), about).catch(() => undefined);
      if (recall?.state === "live") {
        lines.push(
          "",
          `SEEN BEFORE: \`${asked}\` resolved and was acted on this site before, and it still resolves to an actionable element now. ` +
          "The target is probably not the problem: check whether the step failed for another reason before rewriting the locator.",
        );
      } else if (recall?.state === "stale") {
        lines.push(
          "",
          `CHANGED: \`${asked}\` resolved and was acted on this site ${recall.hits} time(s) before, and it does not now. ` +
          "The page has changed under a locator that used to be right, so re-derive it from what the page shows rather than from what you wrote last time.",
        );
      }
    }
  }

  /*
   * Fixed sleeps, named where the model can act on them.
   *
   * A warning rather than a refusal. There are real cases where a short wait is
   * correct code, and the value here is that a model which wrote
   * `waitForTimeout(3000)` learns what to write instead in the same turn. A
   * build error would cost it a turn and it would reach for an evaluated sleep
   * next, which is the same guess behind a worse door.
   */
  for (const warning of runtime.kit.sleepWarnings(args.code)) lines.push("", `SLOW: ${warning}`);

  /*
   * The mission's memory, when the program has recorded anything.
   *
   * Printed after the receipt rather than before it, because the receipt is the
   * answer to what just happened and this is context. Absent entirely for a
   * program that recorded nothing, so a short step pays nothing for it.
   */
  const mission = runtime.kit.mission.render();
  if (mission.length > 0) lines.push("", mission);

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
    /*
     * A transaction's result is rendered as a receipt, not as JSON.
     *
     * `return await tx(...)` is the shape the tool's description recommends, and
     * the point of it is that the answer is a few hundred tokens of prose. It
     * was arriving as a JSON blob with the receipt inside it, which is the same
     * size as the object and harder to read, so the compact form was being
     * thrown away at the last step.
     *
     * The detection is structural: the fields a transaction returned are the
     * fields this checks for. A program that returns an unrelated object with a
     * `status` and a `note` is not misrenderable, because the shape it would
     * need to collide is six specific keys.
     */
    const asReceipt = transactionTextOf(result);
    if (asReceipt !== undefined) {
      lines.push("", asReceipt);
    } else {
      const serialized = serializeBrowserResult(result);
      lines.push("", "RETURNED:", typeof serialized.value === "string" ? serialized.value : JSON.stringify(serialized.value));
      if (serialized.truncated) lines.push("(truncated)");
    }
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
  /*
   * A program that answered its own question does not also get the page.
   *
   * This is the single largest source of waste the mission measured. A program
   * that ends with `return { registered: true, url }` has told the model exactly
   * what it asked for, and appending the accessibility tree after it is the tool
   * answering a question nobody asked, at tens of thousands of characters, on
   * every step. The tree then enters the conversation and is re-sent with every
   * later call until something compacts it: measured, one page's output ran to
   * 262,631 characters and was paid for many times over.
   *
   * So a returned value suppresses the page unless the model asks for it. Asking
   * is one word (`observe: "full"`), and the model that wants the page after a
   * program is usually the model that did not get the answer it wanted, which is
   * exactly the failure case below, where the page is still sent.
   */
  const producedValue = result !== undefined;
  /*
   * One rule: send the page unless the program answered the question itself.
   *
   * Every other case wants the page. A failure is where the model is most likely
   * to guess, and a NO_CHANGE is a step that did nothing.
   *
   * ## The `wholesale` clause, and why it was wrong
   *
   * This used to read `SUCCESS && !wholesale && producedValue`, so a step whose
   * page changed wholesale got the whole tree *even when the program returned a
   * value*. The reasoning was that a wholesale change leaves the receipt with no
   * usable diff, so the model needs the page instead.
   *
   * It does not, and the measurement is unambiguous. A navigation is always
   * wholesale, so every navigation dumped the page whether or not the program
   * had already answered. Across one 66-program mission: **17 of 67 results were
   * full page dumps totalling 408,424 characters, 57% of all tool output**, and
   * 51 of them carried a `RETURNED:` value the model had asked for. The single
   * largest was 49,476 characters of WebDriverUniversity's navigation, returned
   * by a program that had already said what it wanted.
   *
   * The receipt still names the URL transition, so a model that navigated and
   * did not return anything still learns where it landed. What it no longer gets
   * is a tree it did not ask for.
   */
  const answeredItself = receipt.outcome === "SUCCESS" && producedValue;
  const shouldObserve =
    observe === "full" || observe === "changes" || (observe === "auto" && !answeredItself);
  if (shouldObserve && !runtime.observer.isPageGone()) {
    try {
      /*
       * Read the page the receipt is about, not the active one.
       *
       * A program can drive a named tab without switching to it, and this block
       * was rendered from the active page while the receipt above it described
       * the captured one. Read from a live mission: a receipt reported the page
       * at `/ajax` and the block below it showed `/dynamicid`, and the agent
       * spent a trace working out which tab it was on. `view` already accepted a
       * page; nothing was passing one.
       */
      const about = runtime.lastCapturedPage();
      const view = observe === "changes"
        ? { text: renderReceipt(receipt) }
        : await runtime.view({
            ...(args.selector !== undefined ? { selector: args.selector } : {}),
            ...(about !== undefined ? { page: about } : {}),
          });
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
   * The thread's pages, on the code path too.
   *
   * This was written for the look-only branch and left there, so a model that
   * always sends a program never saw it. Measured on a run of 101 programs:
   * `PAGES:` reached the model **zero** times, while 18 of its 104 thinking
   * blocks were spent working out which tab it was on. The answer was written on
   * every turn and shown on none of them.
   *
   * The names and ids are the whole point of the registry: a model that can read
   * `p3 "github"` addresses that tab instead of fetching the list and matching on
   * a URL it half remembers. That work was the largest single category of
   * reasoning in the run, and it was avoidable.
   *
   * Costed rather than assumed, because adding a block to every turn is exactly
   * what made the previous run 19% more expensive: twelve lines is about 700
   * characters, which over a hundred turns is roughly 18K tokens against a 13.4M
   * total. Printed only when there is more than one page.
   *
   * ## The suppression that was wrong
   *
   * This first skipped the block when the program called `browser.pages()`,
   * on the theory that the model had just fetched the list and did not need it
   * printed too. That is backwards, and a live run showed it immediately: a model
   * opening ten sites calls `browser.pages()` in *every* program, because that is
   * the only way it knows how to find a tab. The condition was therefore always
   * true, the block never printed once in five programs, and the fix was inert
   * while looking correct.
   *
   * A program that lists pages is the program that most needs the names and ids,
   * because it is the one doing the finding. Nothing suppresses it now; the
   * `> 1` test is the only condition, and that is about relevance rather than
   * about what the model just did.
   */
  const livePages = runtime.kit.registry.live();
  if (livePages.length > 1) {
    const listing = await runtime.kit.registry.render(runtime.activePage).catch(() => "");
    if (listing.length > 0) lines.push("", listing);
  }

  /*
   * A page that refused us is named, and the user agent is rotated.
   *
   * This is the "rotate when one is blocked" behaviour, and the retry is left to
   * the model on purpose. Reloading automatically would hide the block from the
   * model that has to reason about it, and a site that blocks usually wants a
   * different approach rather than the same request again. So the block is
   * reported, the user agent changes so the next attempt looks different, and
   * the model is told what to do about it.
   *
   * Checked after the program rather than inside `view()`, because a block is a
   * property of the step and not of the reading: rotating on every look at a
   * block page would change the user agent several times for one page.
   */
  /*
   * A program that dispatched its own DOM event from page script.
   *
   * The events such a program creates are untrusted, and a site that checks
   * `event.isTrusted` ignores them: the click lands, nothing happens, and the
   * receipt says the step succeeded. That is the worst shape a failure can take,
   * so it is named here rather than left for the model to discover when a form
   * mysteriously does not submit.
   *
   * What is checked is the argument to `evaluate`, not the presence of the word.
   * The first version tested the whole program for `evaluate` and for `.click(`,
   * which meant any program that read a value with `evaluate` and then clicked
   * with the real API was told its click was untrusted. Measured in a live
   * mission: the note fired on most steps, so the model learned to skip it, and
   * the one note that matters had lost its meaning by the time it was needed.
   *
   * Inside an `evaluate` call there is no Playwright input API to dispatch with,
   * so any click or submit there is necessarily a DOM event. That is the
   * distinction the warning is actually about, and it is what this matches.
   */
  const syntheticAction = dispatchesEventFromScript(args.code ?? "");
  if (syntheticAction) {
    lines.push(
      "",
      "NOTE: this program acted through `evaluate`, so the events it dispatched are untrusted (`isTrusted: false`).",
      "Pages that check for that ignore them, and the step can look successful while nothing happened.",
      "Use the real input API next time: `locator.click()`, `locator.fill()`, `locator.press()` and `locator.check()` are trusted because Chrome generates the events itself.",
    );
  }

  /*
   * The circuit breaker for a page that has stopped accepting input.
   *
   * The failure it catches is indistinguishable from a broken page or from a
   * wrong locator: a click returns without error, dispatches nothing, and the
   * step reports NO_CHANGE. Measured on a live mission, that cost thirty trace
   * blocks, because the model had no way to tell "my click was wrong" from "this
   * page no longer accepts clicks" and tested the first hypothesis over and over.
   *
   * So when a program tried to interact and nothing happened anywhere on the
   * page, the note says what to try instead, names the named fix, and says to
   * stop. It is not a diagnosis: the click may simply have missed. It is a bound
   * on how long the model may spend on the one hypothesis it cannot test.
   */
  const attemptedInput = /\.\s*(click|fill|type|press|check|selectOption|tap|hover|setInputFiles)\s*\(/.test(args.code ?? "");
  /*
   * "Nothing happened anywhere" is the condition, and the second half is
   * load-bearing.
   *
   * A program may drive a tab it selected by URL while the receipt describes the
   * active page. That shape produced `NO_CHANGE` on a step that had in fact
   * navigated another tab, and firing the breaker there would have told the
   * model to call `recover()` — sending it to fix a page that was working. With
   * `otherTabsMoved` the two are distinguishable, and the breaker speaks only
   * to the case it was written for.
   */
  const nothingHappened = receipt.outcome === "NO_CHANGE" && receipt.otherTabsMoved !== true;
  if (attemptedInput && nothingHappened && !syntheticAction) {
    lines.push(
      "",
      "NOTE: the page did not change at all after that interaction.",
      "Two causes look identical from here: the action missed its target, or the page has stopped accepting input",
      "(clicks that succeed but dispatch no event, typing into a focused field that stays empty). Look once at the",
      "element, and if it is the one you meant, call `recover()` to replace the page's renderer and retry.",
      "If that does not fix it within two attempts, treat the page as unable to do this and move on.",
    );
  }

  if (outcome === "SUCCESS" && surface !== undefined) {
    const blocked = looksBlocked({ title: surface.title, url: surface.url });
    if (blocked.blocked) {
      const rotation = await runtime.rotateUserAgent(blocked.reason).catch(() => undefined);
      lines.push(
        "",
        `BLOCKED: ${blocked.reason}.`,
        `This is a refusal rather than a page, so reading it further will not help.`,
        rotation === undefined
          ? `Rotate the user agent with rotateUserAgent() and try a different route.`
          : `${rotation.note ?? ""} The user agent is now ${String(rotation.current["userAgent"] ?? "")}. ` +
            `Reload to retry, or navigate somewhere else if this site is determined to refuse.`,
      );
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

  /*
   * A page the runtime had to close to keep the browser attachable.
   *
   * This is the one thing about a step that the model cannot discover for
   * itself: a tab it was using is gone, and nothing else in the receipt
   * explains why. Reporting it once, with the URL, turns "my tab disappeared"
   * into "the page wedged and was closed, reopen it" instead of a hunt for a
   * cause that is not on the page.
   */
  const health = runtime.takeHealthNote();
  if (health !== undefined) lines.push("", `BROWSER: ${health}`);
  const created = runtime.takePageCreationNote();
  if (created !== undefined) lines.push("", `PAGES: ${created}`);
  /*
   * The loop warning, recorded here because this is the first place the outcome
   * is known. The runtime keeps the history across steps and answers with a
   * sentence only when the same program has produced the same result three
   * times, which is where a person would stop and say so.
   */
  const loop = runtime.noteStepOutcome(args.code ?? "", outcome);
  if (loop !== undefined) lines.push("", loop);

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

  /*
   * Historical, and said to be.
   *
   * These lines used to read `(worked 2x)`, which a model reads as a fact about
   * now. Read from a live mission: the agent was watching a Dynamic Controls
   * click fail on the page in front of it while the hint said that step had
   * "worked 2x", and it spent a trace reconciling the two before deciding the
   * page was broken. The record is real, but it is a record of past runs on this
   * host, quite possibly in another session, and the page may have changed since.
   * Saying so costs one line and removes a contradiction the model otherwise has
   * to resolve by guessing which source to trust.
   */
  const known = edges.slice(0, 3).map((edge: { to: string; successes: number; program: string }) =>
    `  ${edge.to} (succeeded ${edge.successes}x previously): ${edge.program.replace(/\s+/g, " ").slice(0, 120)}`);
  return [
    line,
    "Previously working steps from this state on this site (a record of past runs, not the current page; verify before reusing):",
    ...known,
  ];
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
