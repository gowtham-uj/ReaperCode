/**
 * What the model sees of a page, and how little of it changes between looks.
 *
 * The outline is **Playwright's own** `ariaSnapshot({ mode: "ai" })` text,
 * passed through unchanged. That is deliberate and it replaced a hand-written
 * renderer that walked the JSON tree and emitted its own format.
 *
 * The renderer existed because the 1.59 API only offered YAML text and the JSON
 * tree was a version away. When the JSON tree arrived, writing a second renderer
 * for it became the wrong move for a reason that is worth stating plainly: a
 * custom renderer is a second opinion about what a page contains, and any place
 * the two disagree is a place the model is told something Playwright would not
 * have said. The established path is verified byte-identical to Playwright's own
 * output across the fixture pages, including the iframe and shadow cases, so
 * there is nothing left for a bespoke renderer to add.
 *
 * What is not Playwright's job, and stays here: the budget, the delta, and the
 * header. Playwright renders a page; this decides how much of it to send, what
 * changed since the model last looked, and where the page is now.
 *
 * Three levels, cheapest first:
 *
 *   `view()`            the page as Playwright describes it, inside the budget
 *   `view(selector)`    one region, which is what keeps a job board's 25k-token
 *                       page down to the form the model is actually filling
 *   `viewChanges()`     only what differs from the previous look, with the URL
 *                       transition reported separately because it is the
 *                       cheapest and most load-bearing fact after an action
 *
 * Screenshots are escalation, not the default: canvas, maps, charts, drag and
 * drop, CAPTCHA, or a page whose accessibility tree is empty because the site
 * built everything from divs.
 */

/**
 * Bounds that keep one view inside a sane share of the context.
 *
 * 3,000 characters is roughly 750 tokens, which is the budget the observation
 * layer is designed around: a browsing step should cost hundreds of tokens, not
 * thousands. The default is a budget, not a ceiling: `view(selector)` scopes to
 * a region and `inspect` asks for one component in full, so a model that needs
 * more can always ask for more. What it cannot do is get the whole page by
 * accident.
 *
 * This is the only reduction applied to Playwright's output. The mode:"ai"
 * snapshot is already a curated representation, so nothing here second-guesses
 * which of its lines matter; when the text exceeds the budget the tail is cut
 * and the cut is stated.
 */
export const VIEW_MAX_CHARS = 3_000;

/**
 * The budget for a fallback tree, which is a page rather than a summary of one.
 *
 * Ten times the compiled budget, because the fallback has no named sections to
 * open by id and a model reading it needs enough of the page to act. It is a
 * bound and not a target: measured on the mission's worst page the whole tree
 * was 262,631 characters, and cutting it to this is what stops one page's output
 * being re-sent with every later call in the conversation.
 *
 * Overridable per look, up to no limit at all, because a page that genuinely
 * needs all of it can still ask.
 */
export const VIEW_FALLBACK_MAX_CHARS = 30_000;

/**
 * How deep `mode: "ai"` walks by default.
 *
 * Playwright defaults to unlimited, which on a deep page is a lot of wrappers.
 * Eight is deep enough for every real page's meaningful structure and shallow
 * enough that the budget is usually met without trimming.
 */
export const VIEW_DEFAULT_DEPTH = 8;

export interface PageViewOptions {
  /** CSS selector for the region to look at. Whole page when absent. */
  selector?: string;
  /**
   * The page to read, when it is not the active one.
   *
   * A program can hold a page it opened and look at that one without switching,
   * which is what `view(cartTab)` means. Kept as a separate field from `selector`
   * because they compose: a region of a specific page.
   */
  page?: unknown;
  /** How deep the accessibility tree is walked. */
  depth?: number;
  /** Character budget; the outline is trimmed to this and says so. */
  maxChars?: number;
}

/**
 * What a snapshot cost and contains, counted.
 *
 * Taken from browserclaw, whose snapshot reports the same numbers, because it
 * turns "the model cannot see the button" from a question into a measurement:
 * `interactive: 0` on a page with 40 elements says the interactivity detection
 * failed, where `chars: 900` says the budget cut something off. The sweep
 * computes a version of this separately today; having it on every observation
 * means a failure carries its own diagnosis instead of needing a rerun.
 */
export interface SnapshotStats {
  /** Lines in the outline after any trimming. */
  lines: number;
  /** Characters sent, which is what the budget actually governs. */
  chars: number;
  /** Elements carrying a `[ref=...]` handle. */
  refs: number;
  /** Refs that are actionable: a link, button, input or select. */
  interactive: number;
}

/**
 * Whether the outline should be treated as untrusted input.
 *
 * It always should, and the field exists because the failure it prevents is
 * silent. Page text is attacker-controlled on any site the agent visits, and an
 * outline is page text: a "system" line rendered inside the page arrives in
 * exactly the same channel as the real instructions. Marking it costs a boolean
 * and means anything downstream can tell the two apart by construction rather
 * than by remembering.
 */
export interface PageContentMeta {
  untrusted: true;
  /** Where it came from, so provenance survives the boundary. */
  source: "browser-page";
  url: string;
}

export interface PageView {
  url: string;
  title: string;
  /** The accessibility outline, as Playwright renders it. */
  outline: string;
  /** True when the budget trimmed the outline. */
  truncated: boolean;
  /** Counted, so a failure says what it cost rather than being a mystery. */
  stats: SnapshotStats;
  /** Always set: the outline is page content and is not instructions. */
  contentMeta: PageContentMeta;
  /** Set when the region selector matched nothing, so the model is not misled
   *  into thinking the page is empty. */
  selectorMissed?: boolean;
}

/**
 * A node from `ariaSnapshotJSON`.
 *
 * Kept for the callers that need geometry, since the text form has none. The
 * shape was read off a live snapshot rather than taken from documentation.
 */
export interface AxNode {
  role: string;
  name?: string | undefined;
  /** The snapshot-scoped handle, `e5`. Only meaningful for this snapshot. */
  ref?: string | undefined;
  /** Geometry, present only when the snapshot was taken with `boxes: true`. */
  box?: { x: number; y: number; width: number; height: number } | undefined;
  cursor?: string | undefined;
  url?: string | undefined;
  children?: AxNode[] | undefined;
}

/**
 * Trim an outline to a character budget, on line boundaries.
 *
 * Lines rather than characters because the outline is indented: a cut mid-line
 * leaves a fragment that reads as a different element than the one it came from,
 * and the model would write a locator against half a name. The drop is stated
 * for the same reason every other cap in this codebase is: a silently shortened
 * outline looks like a complete page that happens to be small, and the model
 * concludes the thing it needs is absent.
 */
export function trimOutline(outline: string, maxChars: number): { outline: string; truncated: boolean } {
  if (outline.length <= maxChars) return { outline, truncated: false };
  const lines = outline.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    // +1 for the newline that will join it.
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  /*
   * The notice names the way to see the rest, because a cut that does not say
   * how to undo it is a dead end. Three ways, all real: a region by selector, a
   * deeper walk, or `observe: "full"` for the whole page when it is warranted.
   */
  return {
    outline:
      `${kept.join("\n")}\n[... ${dropped} more line${dropped === 1 ? "" : "s"} not shown. ` +
      `To see them: view({ selector }) for one region, view({ depth }) for more levels, ` +
      `or observe: "full" for the whole page.]`,
    truncated: true,
  };
}

/**
 * A structural diff of two outlines, so a follow-up look costs lines instead of
 * a whole page.
 *
 * Set-based on trimmed lines rather than a real LCS diff. That is deliberate:
 * the outlines are small, an exact minimal diff buys nothing here, and a line
 * that moved reads correctly as "same content" under a set comparison, which is
 * what a reader wants — a form whose fields are in a different order is not a
 * change worth 200 tokens of diff to describe.
 *
 * When either side is empty the honest answer is "too much changed", and the
 * caller should send the full outline rather than a diff that omits the context
 * needed to read it.
 */
export function diffOutlines(
  before: string | undefined,
  after: string,
): { text: string; full: boolean } {
  if (!before || before.trim().length === 0) return { text: after, full: true };
  const beforeLines = new Set(before.split("\n").map((l) => l.trim()).filter(Boolean));
  const afterLines = after.split("\n").map((l) => l.trim()).filter(Boolean);
  const afterSet = new Set(afterLines);

  const added = afterLines.filter((line) => !beforeLines.has(line));
  const removed = [...beforeLines].filter((line) => !afterSet.has(line));

  if (added.length === 0 && removed.length === 0) return { text: "(no change)", full: false };
  /*
   * A diff bigger than the thing it describes is worse than the thing itself.
   * If most of the outline is new the page effectively changed wholesale —
   * navigation, a login, a fresh render — and the model needs the whole view to
   * act, not a list of every line that differs.
   */
  if (added.length > afterLines.length * 0.6) return { text: after, full: true };

  const parts: string[] = [];
  if (removed.length > 0) parts.push("Removed:", ...removed.map((l) => `  - ${l}`));
  if (added.length > 0) parts.push("Added:", ...added.map((l) => `  + ${l}`));
  return { text: parts.join("\n"), full: false };
}

/**
 * Count what an outline contains, cheaply.
 *
 * Line-based rather than tree-based because this runs on every observation and
 * the outline is already text: a ref is `[ref=...]`, and a line naming an
 * actionable role is an actionable element. Counting the tree would mean
 * parsing the YAML back, which is the work the JSON snapshot exists to avoid.
 *
 * The interactive set is deliberately the same roles Playwright considers
 * actionable, so `interactive: 0` on a page the model says has buttons is a real
 * signal that the accessibility tree is not describing the page, rather than a
 * difference of opinion about what counts.
 */
const INTERACTIVE_ROLES_IN_OUTLINE = ["link", "button", "textbox", "checkbox", "radio", "combobox", "menuitem", "option", "searchbox", "slider", "switch", "tab", "spinbutton", "file"];

export function countOutline(outline: string, truncated: boolean): SnapshotStats {
  const lines = outline.split("\n").filter((line) => line.trim().length > 0);
  let refs = 0;
  let interactive = 0;
  for (const line of lines) {
    if (!/\[ref=/.test(line)) continue;
    refs += 1;
    const role = /^-\s+([a-zA-Z]+)\b/.exec(line.trim())?.[1]?.toLowerCase();
    if (role !== undefined && INTERACTIVE_ROLES_IN_OUTLINE.includes(role)) interactive += 1;
  }
  return { lines: lines.length, chars: outline.length, refs, interactive };
}

/**
 * The browser's state, held on this side of the boundary and never sent whole.
 *
 * The model does not watch the browser. It sees only what an observation
 * primitive returns, and the complete picture lives here so a follow-up look
 * can be a delta instead of another page. `previous` is the outline the model
 * was last *told about* — not the last one captured — because the diff the
 * model reads should describe what changed since it last formed a mental model
 * of the page, not since some internal tick.
 *
 * Deliberately owns no DOM and no Playwright handle: it works on outline text,
 * which is what makes it testable without a browser and what keeps the state
 * cheap to hold. The caller snapshots; this remembers and compares.
 */
export class PageObserver {
  private previous: string | undefined;
  private current: string | undefined;
  private lastUrl: string | undefined;
  private lastTitle: string | undefined;
  private rev = 0;

  /** The revision the model has been shown. Increments on each observation. */
  get revision(): number {
    return this.rev;
  }

  /**
   * Record the page's current outline, pruned.
   *
   * Pruning happens here rather than at each call site so every observation
   * compares like with like: a diff between a pruned and an unpruned outline
   * would report every noise line as a change.
   */
  capture(input: {
    url: string;
    title: string;
    snapshot: string;
    maxChars?: number;
    note?: string | undefined;
    /**
     * What the snapshot cost, when the caller already counted it.
     *
     * Needed because `countOutline` reads Playwright's text: it finds elements
     * by `[ref=` markers, and the compiled view has none. Counting a compiled
     * view would report zero refs and zero interactive elements on a page with
     * hundreds of them, which reads to a model as "this page is empty" and is
     * worse than reporting nothing. The compiler knows the real numbers, so it
     * passes them and the line-based count stays for the snapshot path.
     */
    stats?: SnapshotStats | undefined;
    /**
     * Send the snapshot whole, with no budget applied.
     *
     * Set by the fallback and by nothing else. The budget exists because the
     * compiled view is a summary that a model may need to ask more of, and
     * trimming it is safe: every section is still named and can be opened by id.
     * A fallback is not a summary. It is Playwright's own accessibility tree,
     * unsummarised, and cutting it at 3,000 characters does not withhold detail
     * the model can ask for later, it removes whole regions with no id, no
     * count, and no way to reach them. The model would be reading a partial tree
     * believing it was the page.
     *
     * So the fallback is delivered as it comes, however large. It is expensive
     * by design and it should be rare; when it fires, the model needs the page
     * more than it needs the budget.
     */
    untrimmed?: boolean | undefined;
  }): void {
    /*
     * The fallback is bounded too, and this was a reversal.
     *
     * It used to be delivered whole, on the argument that cutting it removes
     * regions with no id and no way to ask for them again. The argument is sound
     * and the consequence was measured to be worse: on a real mission the whole
     * tree ran to 262,631 characters on one page, and because a tool result
     * enters the conversation it is re-sent on every later call until something
     * compacts it. One page of output was paid for tens of times.
     *
     * A bounded tree that says it was cut, and how to see more, is strictly
     * better than an unbounded one that is silently re-billed. The way to see
     * more exists and is named in the cut notice: `view({ selector })` for a
     * region, `view({ depth })` for more levels, and `observe: "full"` when the
     * whole thing really is needed.
     */
    const budget = input.maxChars ?? (input.untrimmed === true ? VIEW_FALLBACK_MAX_CHARS : VIEW_MAX_CHARS);
    const trimmed = trimOutline(input.snapshot, budget);
    this.current = trimmed.outline;
    this.wasTrimmed = trimmed.truncated;
    this.lastUrl = input.url;
    this.lastTitle = input.title;
    this.note = input.note;
    this.stats = input.stats;
  }

  /** The stats the last capture supplied, when it supplied them. */
  private stats: SnapshotStats | undefined;

  /**
   * Whether the budget cut the last capture.
   *
   * Recorded at capture time rather than re-derived from the text by looking for
   * the trim notice. The string match worked and was the wrong shape: page text
   * is attacker-controlled, so a page containing the words "more line" would
   * have reported itself as truncated, and the flag is what a caller uses to
   * decide whether to go and look at the region that was cut.
   */
  private wasTrimmed = false;

  /**
   * A line the next header carries, when the view is not the ordinary one.
   *
   * Used for the fallback: when the compiler could not read the page and the
   * model is being shown Playwright's own accessibility snapshot instead, that
   * has to be said before the content rather than after it. The two
   * representations do not address elements the same way, so a model that reads
   * a fallback without knowing it is one will write `s1:r3` against a page whose
   * only handles are `aria-ref=e74`.
   *
   * Cleared on every capture, so it describes the view the reader is holding and
   * not the last time something went wrong.
   */
  private note: string | undefined;

  /** The goal the model is working toward, for relevance scoring. */
  get goal(): string | undefined {
    return this.goalValue;
  }

  /** The step the model says it is on, for relevance scoring. */
  get step(): string | undefined {
    return this.stepValue;
  }

  /**
   * The whole page as the model should read it.
   *
   * Acknowledges the observation: the next `viewChanges()` diffs against this,
   * because the model has now seen the full picture and no longer needs a
   * description of how it got here.
   */
  view(selectorNote?: string): { text: string; truncated: boolean; stats: SnapshotStats; contentMeta: PageContentMeta } {
    const outline = this.current ?? "(nothing captured yet)";
    this.previous = outline;
    this.rev += 1;
    const truncated = this.wasTrimmed;
    return {
      text: `${this.header(selectorNote)}\n\n${outline}`,
      truncated,
      stats: this.stats ?? countOutline(outline, truncated),
      contentMeta: { untrusted: true, source: "browser-page", url: this.lastUrl ?? "" },
    };
  }

  /**
   * The header every observation carries.
   *
   * The revision number is what lets a model tell one observation from the next
   * when two of them look similar — "REV 24" after "REV 23" says the action was
   * seen, where identical outlines would otherwise read as a lost update. The
   * URL is the cheapest and most load-bearing fact about a page; a model that
   * has to call `page.url()` to learn where it is spends a round trip on
   * something the observation already knew.
   *
   * A caller-supplied goal and step ride along when they are set, because a
   * browsing task is a sequence of steps and the model's hardest question is
   * usually "where am I in this" rather than "what is on screen".
   */
  private header(selectorNote?: string): string {
    const lines = [
      `REV ${this.rev}`,
      `URL: ${this.lastUrl ?? "(unknown)"}`,
      ...(this.lastTitle ? [`Title: ${this.lastTitle}`] : []),
      /*
       * The fallback notice sits here, above the content and below the
       * revision, because it changes how everything after it must be read.
       */
      ...(this.note ? [this.note] : []),
    ];
    if (this.goalValue) lines.push(`Goal: ${this.goalValue}`);
    if (this.stepValue) lines.push(`Current step: ${this.stepValue}`);
    if (selectorNote) lines.push(`Scope: ${selectorNote}`);
    return lines.join("\n");
  }

  /** What the model is trying to do, carried on every observation. */
  setGoal(goal: string | undefined): void {
    this.goalValue = goal;
  }

  /** The step the model says it is on, carried on every observation. */
  setStep(step: string | undefined): void {
    this.stepValue = step;
  }

  private goalValue: string | undefined;
  private stepValue: string | undefined;

  /**
   * Only what differs from the last thing the model saw.
   *
   * The point of the whole design: after a click, the model needs to know the
   * URL moved and a panel opened, not to re-read 3,000 characters of page it
   * already has. When the change is wholesale — navigation, a login, a fresh
   * render — this returns the full outline instead, because a diff that lists
   * most of the page is more expensive to read than the page.
   *
   * The URL transition is always reported, and separately: it is the cheapest
   * and most load-bearing fact after any action, and it is not visible in an
   * outline that happens to look similar on both sides.
   */
  viewChanges(): { text: string; full: boolean } {
    const after = this.current ?? "";
    const before = this.previous;
    const urlBefore = this.urlSeenByModel;
    this.previous = after;
    this.rev += 1;

    const lines: string[] = [this.header()];
    if (urlBefore !== undefined && urlBefore !== this.lastUrl) {
      lines.push(`URL:\n  ${urlBefore}\n  -> ${this.lastUrl ?? "(unknown)"}`);
    }

    const diff = diffOutlines(before, after);
    if (diff.full) {
      // A wholesale change: the outline *is* the answer, and it carries enough
      // context to be read on its own.
      lines.push(after);
    } else {
      lines.push(diff.text);
      if (urlBefore === undefined || urlBefore === this.lastUrl) {
        lines.push(`URL unchanged: ${this.lastUrl ?? "(unknown)"}`);
      }
    }
    this.urlSeenByModel = this.lastUrl;
    return { text: lines.join("\n\n"), full: diff.full };
  }

  /** The URL as the model last saw it, for reporting a transition. */
  private urlSeenByModel: string | undefined;

  /**
   * True when the last read produced nothing that can be shown.
   *
   * Used by the tool to decide whether showing the page again would tell the
   * model anything. A page that closed, or one whose snapshot came back empty,
   * is not a page with nothing on it, and rendering it as an empty section is
   * exactly the silent-coverage failure this layer exists to prevent.
   */
  /**
   * The outline as it stands, for a checker that needs to look at it.
   *
   * Distinct from `view()`, which acknowledges what the model has now seen and
   * advances the delta baseline. A verifier reading the page must not change what
   * the model is told on its next look, or the verification would silently
   * consume the change it was checking for.
   */
  currentOutline(): string {
    return this.current ?? "";
  }

  isPageGone(): boolean {
    const current = this.current;
    return current === undefined || current.trim().length === 0;
  }

  /** Reset, so a fresh conversation does not diff against a stale page. */
  reset(): void {
    this.previous = undefined;
    this.current = undefined;
    this.lastUrl = undefined;
    this.lastTitle = undefined;
    this.urlSeenByModel = undefined;
    this.note = undefined;
    this.rev = 0;
  }
}
