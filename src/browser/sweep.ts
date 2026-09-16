/**
 * A breadth check over many real sites, for exactly the reason a fixture cannot
 * give: a page written by someone else breaks assumptions I would not think to
 * test.
 *
 * It compiles each site and reports health signals rather than assertions,
 * because the failures worth catching here are shapes rather than crashes:
 *
 *   - **zero sections**: the compile produced nothing, so the model sees no page
 *   - **one section holding everything**: the compile collapsed, and the model
 *     gets an undifferentiated blob (Hacker News did this)
 *   - **sections with no actions**: structure with nothing to do, which usually
 *     means interactions were missed
 *   - **elements with no locator**: an element the model cannot address
 *   - **very long**: the observation would blow the context budget
 *   - **duplicate labels**: two sections the model cannot tell apart
 *
 * The thresholds are deliberately loose. A blog post legitimately has one
 * section and no actions, so the report is meant to be read rather than failed:
 * what matters is which sites look structurally wrong and whether the pattern
 * is a real bug or the page being what it is.
 */

import type { Page } from "playwright";

import { collectPage, type CollectedPage } from "./collect.js";
import { compileCollected } from "./ir-tree.js";
import type { BrowserIR } from "./ir.js";

export interface SiteReport {
  url: string;
  ok: boolean;
  error?: string | undefined;
  /** How long the read and compile took, which decides whether this is usable per step. */
  collectMs: number;
  compileMs: number;
  counts: CollectedPage["counts"] & { sections: number; irElements: number; actions: number };
  frames: { total: number; unread: number };
  /** Health signals, worst first. Empty means the compile looks sane. */
  problems: string[];
  /** The first few sections, for eyeballing the shape. */
  sample: string[];
  /** The approximate size of the default observation, in characters. */
  viewCost: number;
}

/**
 * Compile one site and judge the result.
 *
 * Never throws: a site that fails to load is a data point about the site, and
 * one bad url must not end a sweep of a hundred.
 */
export async function sweepSite(page: Page, url: string, options: { timeoutMs?: number } = {}): Promise<SiteReport> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    // Give the first render a moment; a compile against a blank body measures nothing.
    await page.waitForTimeout(600);
  } catch (error) {
    return {
      url,
      ok: false,
      error: `navigation: ${(error as Error).message.slice(0, 120)}`,
      collectMs: 0,
      compileMs: 0,
      counts: { rawNodes: 0, axNodes: 0, candidates: 0, visible: 0, listenerProbed: 0, sections: 0, irElements: 0, actions: 0 },
      frames: { total: 0, unread: 0 },
      problems: ["could not load"],
      sample: [],
      viewCost: 0,
    };
  }

  let collected: CollectedPage;
  const collectStart = Date.now();
  try {
    collected = await collectPage(page);
  } catch (error) {
    return {
      url,
      ok: false,
      error: `collect: ${(error as Error).message.slice(0, 140)}`,
      collectMs: Date.now() - collectStart,
      compileMs: 0,
      counts: { rawNodes: 0, axNodes: 0, candidates: 0, visible: 0, listenerProbed: 0, sections: 0, irElements: 0, actions: 0 },
      frames: { total: 0, unread: 0 },
      problems: ["collector failed"],
      sample: [],
      viewCost: 0,
    };
  }
  const collectMs = Date.now() - collectStart;

  const compileStart = Date.now();
  let ir: BrowserIR;
  try {
    ir = compileCollected(collected);
  } catch (error) {
    return {
      url,
      ok: false,
      error: `compile: ${(error as Error).message.slice(0, 140)}`,
      collectMs,
      compileMs: Date.now() - compileStart,
      counts: { ...collected.counts, sections: 0, irElements: 0, actions: 0 },
      frames: { total: collected.frames.length, unread: collected.frames.filter((frame) => !frame.read).length },
      problems: ["compiler failed"],
      sample: [],
      viewCost: 0,
    };
  }
  const compileMs = Date.now() - compileStart;

  const problems: string[] = [];
  const actions = collected.elements.filter((element) => element.interaction.interactive).length;

  /*
   * A zero-section compile is two different findings and the sweep has to say
   * which. "The page is empty" is a fact about the site; "the page was not read"
   * is a fact about us, and reporting the second as the first is how a blocked
   * site gets filed as a site with nothing on it and never looked at again.
   */
  if (ir.sections.length === 0) {
    problems.push(ir.coverage.complete ? "no sections: the page really is empty" : `unread page: ${ir.coverage.incompleteBecause}`);
  }
  if (ir.sections.length === 1 && ir.elements.size > 200) {
    problems.push(`one section holding ${ir.elements.size} elements: the compile collapsed`);
  }
  if (actions === 0 && ir.elements.size > 20) {
    problems.push("no interactive elements: interactions are probably being missed");
  }
  const emptySections = ir.sections.filter((section) => section.elements.length === 0).length;
  if (ir.sections.length > 3 && emptySections === ir.sections.length) {
    problems.push(`all ${emptySections} sections are empty`);
  }
  const labels = ir.sections.map((section) => `${section.kind}:${section.label}`);
  const duplicateLabels = labels.length - new Set(labels).size;
  if (duplicateLabels > labels.length / 2) {
    problems.push(`${duplicateLabels} of ${labels.length} sections share a label`);
  }
  const unaddressable = [...ir.elements.values()].filter((element) => element.locators.length === 0 && !element.hidden).length;
  if (unaddressable > 0) problems.push(`${unaddressable} elements have no locator`);
  const unreadFrames = collected.frames.filter((frame) => !frame.read).length;
  if (unreadFrames > 0) problems.push(`${unreadFrames} frames could not be read`);

  /*
   * The budget the whole design is built around. A default observation has to
   * stay in the hundreds of tokens or the premise of the compile is gone, so
   * this measures the rendered cost rather than the element count.
   */
  const viewCost = estimateViewCost(ir);

  return {
    url,
    ok: problems.length === 0,
    collectMs,
    compileMs,
    counts: { ...collected.counts, sections: ir.sections.length, irElements: ir.elements.size, actions },
    frames: { total: collected.frames.length, unread: unreadFrames },
    problems,
    sample: ir.sections.slice(0, 5).map((section) => `[${section.id}] ${section.kind} "${section.label}" x${section.elements.length}${section.hiddenCount ? ` +${section.hiddenCount}h` : ""}`),
    viewCost,
  };
}

/**
 * The size of the default observation.
 *
 * Deliberately an estimate: it counts the header, one line per section, and a
 * few lines per element in the top sections, which is the shape the compact
 * view renders. Measuring the real renderer would be better and is the next
 * step once that exists; this is enough to notice a page that would cost ten
 * thousand tokens.
 */
function estimateViewCost(ir: BrowserIR): number {
  const header = 120;
  let cost = header;
  for (const section of ir.sections.slice(0, 8)) {
    cost += section.label.length + section.summary.length + 24;
    for (const elementId of section.elements.slice(0, 6)) {
      const element = ir.elements.get(elementId);
      if (!element) continue;
      cost += element.name.length + (element.locators[0]?.expression.length ?? 0) + 30;
    }
  }
  return cost;
}

/** Render a sweep report for reading. */
export function formatSweep(reports: SiteReport[]): string {
  const lines: string[] = [];
  const healthy = reports.filter((report) => report.ok).length;
  lines.push(`${healthy}/${reports.length} sites compile cleanly`);

  const worst = reports.filter((report) => !report.ok).sort((a, b) => b.problems.length - a.problems.length);
  for (const report of worst) {
    lines.push("");
    lines.push(`FAIL ${report.url}`);
    for (const problem of report.problems) lines.push(`  - ${problem}`);
    if (report.error) lines.push(`  ! ${report.error}`);
    lines.push(
      `  counts: raw=${report.counts.rawNodes} ax=${report.counts.axNodes} actions=${report.counts.actions} ` +
        `sections=${report.counts.sections} elements=${report.counts.irElements} viewCost=${report.viewCost}`,
    );
    for (const sample of report.sample) lines.push(`  ${sample}`);
  }

  const slow = [...reports].sort((a, b) => b.collectMs - a.collectMs).slice(0, 5);
  lines.push("");
  lines.push("slowest collects:");
  for (const report of slow) lines.push(`  ${report.collectMs}ms + ${report.compileMs}ms  ${report.url}`);

  const expensive = [...reports].sort((a, b) => b.viewCost - a.viewCost).slice(0, 5);
  lines.push("");
  lines.push("most expensive views:");
  for (const report of expensive) lines.push(`  ~${report.viewCost} chars  ${report.url}`);
  return lines.join("\n");
}
