/**
 * `browser_use`: the model writes Playwright, Reaper runs it against a real page.
 *
 * This replaces `browser_control`, a verb-per-action tool where one call meant
 * one `navigate`, `click` or `type` and positional `e0` refs pointed into a live
 * DOM and silently retargeted after any re-render. Two things were wrong with
 * that shape, and both are fixed by the same change:
 *
 *   - **One action per call** makes a model do its browser reasoning in single
 *     steps, paying a round trip and a fresh snapshot for each. A program that
 *     fills six fields and clicks Continue is one decision; expressed as seven
 *     tool calls it is seven decisions with six chances to lose the thread.
 *   - **A ref is not an identity.** `e0` is a position in a snapshot, and after
 *     a framework re-render it can point at a different element. The model then
 *     acts on the wrong thing while every number it was shown looked right.
 *
 * The model writes the Playwright it already knows, and Reaper supplies the two
 * things a bare Playwright script cannot have: the page is already open and
 * already logged in, and what comes back is a *receipt* describing what changed
 * rather than whether the call threw.
 *
 * ## Why a program and not a selector
 *
 * A tool that takes "the model's intent" as a selector has to guess. A tool that
 * takes a program does not: the model has already resolved every ambiguity the
 * moment it wrote `getByRole("button", { name: "Apply" })` against the specific
 * row it meant. The compiler in this repo exists to make that possible cheaply,
 * by showing the model a page small enough to reason about.
 */

import { z } from "zod";

/** How long a browser program may run by default. */
export const BROWSER_USE_DEFAULT_TIMEOUT_MS = 120_000;
export const BROWSER_USE_MAX_TIMEOUT_MS = 600_000;

export const BrowserUseArgsSchema = z
  .object({
    /**
     * The program to run. Optional, because looking is a legitimate call.
     *
     * A tool that only acts forces the model to write Playwright against a page
     * it has not seen, which is the failure this whole layer exists to avoid. So
     * the same tool observes: omit `code` and it returns the page.
     */
    code: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Playwright code to run against the open page. `page` is already bound and the browser is already connected: do not launch or connect to anything. Top-level `await` works, and the value of the last expression is returned. Write one program per step rather than one action per call — six fills and a click in one script is one decision, not seven. Omit this to just look at the page.",
      ),
    /**
     * Look at the page instead of, or after, acting.
     *
     * `auto` is the one to reach for: it returns the page when the program did
     * not already report a change, which is exactly when the model is most
     * likely to be blind. `full` forces the whole page, `changes` only the
     * delta, and `none` suppresses it for a program that already returned what
     * it needed.
     */
    observe: z
      .enum(["none", "auto", "full", "changes"])
      .optional()
      .describe(
        "What to show of the page. omit and it defaults to `auto`: the whole page when you did not send code, the changed lines after a program. Use `full` for a fresh look at a page you have not seen, `changes` for a delta, `none` when your program already returned what you needed.",
      ),
    /** Scope the look to one region, which is what keeps a huge page small. */
    selector: z
      .string()
      .min(1)
      .optional()
      .describe("CSS selector to scope the view to one region. The cheapest way to look at a job board without paying for the whole page."),
    /**
     * What the model believes it is doing, for the journal and the ledger.
     *
     * Not required, and worth the tokens when present: it is what turns a
     * session log from a list of clicks into a record of what was being
     * attempted, which is the difference between debugging a failure and reading
     * a stack trace.
     */
    intent: z
      .string()
      .max(200)
      .optional()
      .describe("One short sentence: what this step is for. Recorded in the session journal."),
    /**
     * What this step is supposed to achieve, so Reaper can check it.
     *
     * The free checks already catch a step that did nothing. This catches the
     * step that did *something else*: the page changed, but not to the page the
     * model intended, which is a failure no structural check can see.
     *
     * Stating it is optional and cheap, and it is the difference between the
     * model being told SUCCESS and being told SUCCESS-but-not-what-you-expected.
     */
    expect: z
      .object({
        urlIncludes: z.string().optional(),
        urlChanged: z.boolean().optional(),
        textPresent: z.string().optional(),
        textAbsent: z.string().optional(),
        pageChanged: z.boolean().optional(),
        expectFailure: z.boolean().optional(),
      })
      .strict()
      .optional()
      .describe(
        "What this step should achieve, e.g. {urlIncludes: '/dashboard'} after signing in, or {textPresent: 'Application submitted'} after submitting. Checked against the page and reported, so a step that changed the page in the wrong way is visible rather than reported as success.",
      ),
    /**
     * The revision the program was written against.
     *
     * Supplying it turns "the page moved and I clicked anyway" into a refusal.
     * A model that has just been shown REV 12 and asks for an action at REV 9 is
     * about to act on a page it has not seen, which on a list with a Delete
     * button is how the wrong row is destroyed.
     */
    expected_revision: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("The REV number this program was written against. If the page has moved on, the step is refused with STALE_REVISION instead of acted on."),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(BROWSER_USE_MAX_TIMEOUT_MS)
      .optional()
      .describe(`How long the program may run. Defaults to ${BROWSER_USE_DEFAULT_TIMEOUT_MS}ms.`),
  })
  .strict();

export type BrowserUseArgs = z.infer<typeof BrowserUseArgsSchema>;

/**
 * What the model is told about the tool.
 *
 * Written as decisions rather than as an API list, in the same voice the eval
 * tool's description uses, because the failure it prevents is a model that
 * installs its own browser or launches one instead of using the page it was
 * given.
 *
 * Kept short on purpose, though not because anything enforces it: there is no
 * character cap on a tool description anywhere in this codebase, and an earlier
 * version of this comment claimed the eval description was at one. That was
 * wrong, and worth recording so nobody budgets against a limit that does not
 * exist. Every tool description is sent on every turn, so the real constraint is
 * the turn's context rather than a validator, and the detail belongs in the
 * browser skill where it is loaded only when the model is actually browsing.
 */
export const BROWSER_USE_DESCRIPTION =
  "Drive the browser with Playwright code, which runs in the same sandbox `eval` uses. The page is already open, already logged in, and already connected: `page` is bound, so write Playwright directly and never launch or connect to a browser. " +
  "In scope: `page` (the thread's own page), `browser` (open, switch and close pages: `browser.newPage(name)`, `browser.pages()`, `browser.setActive(name)`, `browser.closePage(p)`), `view()`, `viewChanges()`, `screenshot()`, and `pages()`. " +
  "Two things differ from Playwright in your own process, and both matter. **Await every call**, including ones you expect to be synchronous: `await tabs.url()`, not `tabs.url()`. And a `.` chain that has not been awaited is a pending call rather than a value, so `if (others.length === 0)` on an unawaited chain is never true. " +
  "Write one program per step, not one action per call: six fills and a click in a single script is one decision. " +
  "The result is a receipt with an OUTCOME (SUCCESS, NO_CHANGE, STALE_REVISION, and so on), the URL transition, and the lines that changed, so a click that did nothing is visible as NO_CHANGE rather than reported as success. " +
  "Before acting, look at the page with the browser view; after acting, read the receipt rather than guessing what happened.";
