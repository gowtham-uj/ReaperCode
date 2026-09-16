/**
 * What the model reads. Not the IR, and not the page.
 *
 * Three layers, and the distinction between them is the whole design:
 *
 *     raw page truth     the four-source union, thousands of nodes
 *     BrowserIR          the semantic compile, hundreds of entities
 *     model view         this, tens of entities
 *
 * The first two never leave the runtime. Every byte of them is free because the
 * model never sees it, and the mistake this module exists to prevent is
 * collapsing that pipeline into "compile it and send the compile" — which is
 * still the same context bomb wearing a different hat.
 *
 * ## What the model actually needs
 *
 * Measured rather than assumed: on Hacker News the raw accessibility snapshot is
 * 47,683 characters and the compiled IR describes the same page in four sections
 * with 61 addressable rows. Neither number is what the model should receive. It
 * should receive the four sections as *lines*, with the rows behind the one it is
 * working on.
 *
 * So the view is:
 *
 *     REV 12
 *     https://news.ycombinator.com  (Hacker News)
 *
 *     s1 results "Stories" (61 rows)
 *       r1 "Introducing System One Models"
 *       r2 "Show HN: An e-ink frame that hears birds"
 *       ...
 *     s4 form "Form" 1 field
 *
 * Sections are summarised, rows are addressable, locators are printed for
 * anything the model is likely to act on, and everything omitted says so.
 *
 * ## What it never does
 *
 * It never drops a section's existence. Relevance reorders and collapses detail;
 * a section nobody is looking at becomes one line rather than nothing, because a
 * model cannot ask about a region it does not know exists. That rule is the one
 * the whole design is built on and it is enforced in `visibleSections` rather
 * than left to the caller.
 */

import type { BrowserIR, IrElement, IrSection } from "./ir.js";

/** Roughly 750 tokens, which is the budget a browsing step is designed around. */
export const MODEL_VIEW_MAX_CHARS = 3_000;

/** How many rows of a list to print before summarising the rest. */
export const MAX_ROWS_SHOWN = 12;

export interface ModelViewOptions {
  /** What the model is doing, for relevance ordering. */
  context?: { step?: string | undefined; goal?: string | undefined; blockers?: string[] | undefined } | undefined;
  /** Character budget. The view is trimmed to it and says so. */
  maxChars?: number;
  /**
   * Sections to expand in full, by id.
   *
   * `inspect("s2")` and a goal-relevant section both arrive here. Everything
   * else stays collapsed to a line.
   */
  expand?: string[] | undefined;
}

export interface ModelView {
  text: string;
  /** True when the budget cut the view. */
  truncated: boolean;
  /** The section ids that were expanded, so a caller can track what was shown. */
  expanded: string[];
}

/**
 * Render the IR as the model reads it.
 *
 * Ordering is by relevance when a context is given, and by document order
 * otherwise. Relevance never *removes* a section: it decides which ones are
 * expanded and which are one line, and the collapsed ones always appear.
 */
export function renderModelView(ir: BrowserIR, options: ModelViewOptions = {}): ModelView {
  const maxChars = options.maxChars ?? MODEL_VIEW_MAX_CHARS;
  const scores = new Map<string, number>();
  for (const section of ir.sections) scores.set(section.id, relevanceOf(section, options.context));

  /*
   * Sections in the order the model should consider them: what it is doing
   * first, then what a page is usually for, then everything else by size.
   */
  const ranked = [...ir.sections].sort((a, b) => priorityOf(b, scores) - priorityOf(a, scores) || a.id.localeCompare(b.id));

  /*
   * Which sections to open, decided against the budget rather than by picking
   * one.
   *
   * The first version opened exactly one section: the best-scoring, or the
   * largest when nothing scored. On a small page that is a waste of the budget
   * it was given, and on a form page it opened the *navigation*, because twelve
   * nav links outweigh six form fields by element count. The model then read a
   * view whose only named elements were menu items, on a page whose whole
   * purpose was a button labelled Continue.
   *
   * So the budget decides. Sections open in priority order for as long as there
   * is room, and the ones that do not fit stay as one line each. A small page
   * shows everything it has; a large one shows what matters most. Nothing is
   * ever removed, which is the rule the rest of this file is built on.
   */
  const budget = Math.max(200, maxChars - 200); // room for the header and the trim notice
  const collapsedLines = new Map<string, string>();
  let used = 0;
  for (const section of ir.sections) {
    const line = collapseSection(section, ir);
    collapsedLines.set(section.id, line);
    used += line.length + 1;
  }

  const expanded = new Set(options.expand ?? []);
  const asked = new Set(options.expand ?? []);
  for (const section of ranked) {
    if (asked.has(section.id)) continue;
    const cost = expandSection(section, ir).reduce((sum, line) => sum + line.length + 1, 0);
    const collapsed = (collapsedLines.get(section.id) ?? "").length + 1;
    // Opening costs the difference; a section that fits on its line already is
    // always worth opening when there is any room at all.
    if (used + (cost - collapsed) > budget) continue;
    expanded.add(section.id);
    used += cost - collapsed;
  }

  const lines: string[] = [];

  /*
   * Coverage, and only coverage.
   *
   * This used to emit its own `REV n` and URL, which the observation header
   * already carries, so every view began by saying where it was twice. Two
   * headers is not a formatting bug: it doubles the cost of the one fact every
   * look must include, and a model reading two revisions has to work out which
   * one the diff is against.
   *
   * What stays here is the caveat, and it goes first rather than last. A model
   * that reads only the top of a trimmed view must still know the view is not
   * whole; a caveat at the bottom of a trimmed view is a caveat nobody sees.
   */
  if (!ir.coverage.complete && ir.coverage.incompleteBecause !== undefined) {
    lines.push(`COVERAGE INCOMPLETE: ${ir.coverage.incompleteBecause}`, "");
  }

  /* ---- sections, expanded or collapsed, always present ---- */
  for (const section of ranked) {
    const open = expanded.has(section.id);
    const own = open ? expandSection(section, ir) : [collapsedLines.get(section.id) ?? collapseSection(section, ir)];
    const score = scores.get(section.id) ?? 0;
    if (!open && score > 0) {
      /*
       * A collapsed section that scored says so, so the model knows which line
       * to ask about rather than scanning all of them.
       */
      own[own.length - 1] = `${own[own.length - 1]}  <- possibly relevant`;
    }
    lines.push(...own);
  }

  /* ---- the footer: what was left out, so nothing is silently missing ---- */
  const hidden = [...ir.elements.values()].filter((element) => element.hidden === true);
  if (hidden.length > 0) {
    const reasons = new Set(hidden.map((element) => element.hiddenBecause ?? "not rendered"));
    lines.push("", `${hidden.length} hidden field${hidden.length === 1 ? "" : "s"} (${[...reasons].join(", ")}): ${hidden.map((element) => element.name || element.id).slice(0, 6).join(", ")}`);
  }

  const trimmed = trimToBudget(lines, maxChars);
  return { text: trimmed.text, truncated: trimmed.truncated, expanded: [...expanded] };
}

/**
 * How early a section should be considered for opening.
 *
 * Relevance first, because a section the current step mentions is the one worth
 * spending characters on. Then the shape of the section, because that is what a
 * page is usually for: a form to fill, a list to pick from, a dialog to answer.
 * Navigation and footers come last and are never opened unless there is room
 * left over, which on a page of any size there will not be.
 *
 * The ordering is a preference rather than a filter. Every section is printed
 * either way; this only decides which ones get their contents.
 */
function priorityOf(section: IrSection, scores: Map<string, number>): number {
  const score = scores.get(section.id) ?? 0;
  if (score > 0) return 1000 + score;
  switch (section.kind) {
    case "form":
    case "search":
      return 500;
    case "dialog":
      return 450;
    case "results":
      return section.items !== undefined ? 400 : 300;
    case "product":
    case "article":
      return 250;
    case "list":
    case "main":
      return 200;
    case "unknown":
      return 100;
    /*
     * Header, footer and navigation last, and below zero so that a page which is
     * nothing but a nav still opens something rather than showing a list of
     * section names with no contents anywhere.
     */
    default:
      return -100;
  }
}

/**
 * One section, in full.
 *
 * A list prints its rows rather than its elements, because the rows are what the
 * model addresses: `s1:r3` rather than a hundred and forty element ids. Elements
 * that are not in a row are printed directly, so a form still shows its fields.
 */
function expandSection(section: IrSection, ir: BrowserIR): string[] {
  const out: string[] = [];
  const rows = section.items ?? [];

  out.push(`${section.id} ${section.kind} "${section.label}"  ${describe(section, ir)}`);

  if (rows.length > 0) {
    for (const row of rows.slice(0, MAX_ROWS_SHOWN)) {
      const label = row.label.length > 0 ? row.label : "(no name)";
      out.push(`  ${row.id} "${truncate(label, 60)}"`);
    }
    if (rows.length > MAX_ROWS_SHOWN) {
      out.push(`  ... ${rows.length - MAX_ROWS_SHOWN} more rows. Address one as ${section.id}:r${MAX_ROWS_SHOWN + 1}, or use browser_use to read them all in one program.`);
    }
    /*
     * The elements inside the first row are printed, because that is how the
     * model learns what a row contains without expanding every one.
     */
    const first = rows[0];
    if (first) {
      for (const elementId of first.elements.slice(0, 4)) {
        const element = ir.elements.get(elementId);
        if (element) out.push(...elementLines(element, "      "));
      }
    }
    out.push(...proseLines(section));
    return out;
  }

  const rowIds = new Set(rows.flatMap((row) => row.elements));
  for (const elementId of section.elements) {
    if (rowIds.has(elementId)) continue;
    const element = ir.elements.get(elementId);
    if (element) out.push(...elementLines(element, "  "));
  }
  out.push(...proseLines(section));
  return out;
}

/**
 * What the section says, as opposed to what it offers.
 *
 * Rendered after the elements because that is the order the model reads in:
 * find the control, then read the result it produced. Quoted so it is visibly
 * page text rather than something Reaper is asserting, which matters because
 * this is the one part of the view that is prose rather than structure and the
 * part a hostile page has the most room to write a lie in.
 *
 * Capped at three lines. A section with a status line, an error and a result
 * count is worth all three; a section with forty paragraphs is a content page
 * whose prose the model should read with a program, and printing all of it
 * would spend the whole budget on the least actionable part of the page.
 */
function proseLines(section: IrSection): string[] {
  const prose = section.prose ?? [];
  if (prose.length === 0) return [];
  const shown = prose.slice(0, 3);
  const out = shown.map((line) => `  text: ${truncate(line, 120)}`);
  if (prose.length > shown.length) out.push(`  text: ... ${prose.length - shown.length} more text block${prose.length - shown.length === 1 ? "" : "s"}`);
  return out;
}

/**
 * One section as one line.
 *
 * Carries the label, the shape and the size, because those are the three facts
 * that decide whether the model wants to look: "s3 list \"Tags\" 25 rows" tells
 * it there is a list of twenty-five things, and "s7 form \"Apply\" 6 fields"
 * tells it there is a form. Both are enough to ask for the right one.
 */
function collapseSection(section: IrSection, ir: BrowserIR): string {
  return `${section.id} ${section.kind} "${section.label}"  ${describe(section, ir)}`;
}

/** The shape of a section in a few words: what is in it and how much. */
function describe(section: IrSection, ir: BrowserIR): string {
  const rows = section.items?.length ?? 0;
  if (rows > 0) return `${rows} row${rows === 1 ? "" : "s"}`;
  const parts: string[] = [];
  const counts = new Map<string, number>();
  for (const elementId of section.elements) {
    const element = ir.elements.get(elementId);
    if (!element) continue;
    counts.set(element.role, (counts.get(element.role) ?? 0) + 1);
  }
  /*
   * Grouped by role rather than listed, because "6 textboxes" is one fact and
   * six lines of textbox names is six. The names come when the section expands.
   */
  for (const [role, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    parts.push(count === 1 ? role : `${count} ${plural(role, count)}`);
  }
  /*
   * Text is mentioned even when collapsed, because a section that says
   * something is a different proposition from a section that only offers
   * controls. A model reading "s5 results "Results" 12 rows" and "s9 main
   * "Main" text, 2 links" can tell at a glance which one is likely to hold the
   * answer to its last action, without opening either.
   */
  if ((section.prose?.length ?? 0) > 0) parts.unshift("text");
  if (section.hiddenCount !== undefined && section.hiddenCount > 0) parts.push(`${section.hiddenCount} hidden`);
  return parts.length > 0 ? parts.join(", ") : "empty";
}

function plural(role: string, count: number): string {
  if (count === 1) return role;
  if (role.endsWith("x")) return `${role}es`;
  return `${role}s`;
}

/**
 * An element as the model reads it.
 *
 * The locator goes on the next line, indented, because it is longer than the
 * description and putting it on the same line pushes the names out of alignment
 * on every row. It is printed for anything actionable, since a model that has to
 * invent a locator invents a worse one.
 */
function elementLines(element: IrElement, indent: string): string[] {
  if (element.stub === true) {
    /*
     * A stubbed element still appears, with its id, so the model can ask about
     * it. That is the point of a stub: less detail, same existence.
     */
    return [`${indent}${element.id} ${element.role} "${truncate(element.name, 40)}"`];
  }
  const value = element.value !== undefined && element.value.length > 0 ? ` = "${truncate(element.value, 40)}"` : "";
  const states = element.states.length > 0 ? ` [${element.states.join(" ")}]` : "";
  const lines = [`${indent}${element.id} ${element.role} "${truncate(element.name, 50)}"${states}${value}`];
  const best = element.locators[0];
  if (best !== undefined) lines.push(`${indent}    ${best.expression}`);
  return lines;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** How much this section matters to the current step. Mirrors the compiler's own. */
function relevanceOf(section: IrSection, context: ModelViewOptions["context"]): number {
  if (!context) return 0;
  const haystack = `${section.label} ${section.heading ?? ""} ${section.summary}`.toLowerCase();
  let score = 0;
  const step = context.step?.toLowerCase() ?? "";
  const goal = context.goal?.toLowerCase() ?? "";
  for (const word of [...step.split(/\W+/), ...goal.split(/\W+/)]) {
    if (word.length > 4 && haystack.includes(word)) score += 2;
  }
  for (const blocker of context.blockers ?? []) {
    for (const word of blocker.toLowerCase().split(/\W+/)) {
      if (word.length > 4 && haystack.includes(word)) score += 3;
    }
  }
  return score;
}

/**
 * Cut the view to the budget, on line boundaries, and say what was dropped.
 *
 * The drop is always stated. A silently shortened view reads as a complete page
 * that happens to be small, and the model concludes the thing it needs is not
 * there rather than that it was not shown.
 */
function trimToBudget(lines: string[], maxChars: number): { text: string; truncated: boolean } {
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return { text: joined, truncated: false };

  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars - 80) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  kept.push("", `[view trimmed: ${dropped} more line${dropped === 1 ? "" : "s"}, each a collapsed section or a row. Ask for one by id to see it.]`);
  return { text: kept.join("\n"), truncated: true };
}
