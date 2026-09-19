/**
 * Benchmark rules the runtime enforces, rather than a sentence the model read
 * once.
 *
 * A UI-only benchmark asks the agent to do its work through the interface. The
 * instruction is a sentence in the prompt, and the prompt is long. A model that
 * read the rule at the start of a mission is 150,000 tokens away from it by the
 * time it is looking for a shortcut, and the shortcut is available: the page is
 * loaded, `page.evaluate(() => fetch("/download_invoice"))` returns the bytes,
 * and nothing stops it.
 *
 * Measured: a mission fetched an invoice with `fetch` and wrote it to disk
 * instead of clicking the download link, and another opened a tab with
 * `context.newPage()` when the task asked for a link click. Both produced the
 * right end state. Both failed the thing being measured.
 *
 * So the rule is code. The program is inspected before it runs, and the
 * inspection classifies what it is about to do by capability rather than by
 * naming a function to ban:
 *
 *   - a network request that does not come from a browser navigation
 *   - creating a page directly rather than by triggering the page's own control
 *   - reading the filesystem outside the workspace
 *
 * `evaluate` is not banned. Most of its uses are reading values, scrolling and
 * measuring geometry, which are exactly what a browser agent should do, and
 * banning the method would push the model to `evaluate` through some other door
 * while making legitimate diagnostics impossible. What is banned is a request
 * issued from inside an evaluation, because that is the capability the benchmark
 * cares about.
 *
 * Off by default. A person browsing their own bank does not want a policy
 * engine between them and the page, and the guard exists for the case where a
 * task's correctness depends on how it was done.
 */

/** What the guard is enforcing. */
export type PolicyName = "ui-only" | "none";

export interface PolicyViolation {
  rule: string;
  /** The line the program wrote, so the model can see what it did. */
  excerpt: string;
  reason: string;
  /** What to do instead, which is always a UI action. */
  instead: string;
}

export interface PolicyReport {
  policy: PolicyName;
  allowed: boolean;
  violations: PolicyViolation[];
}

/**
 * The patterns the guard looks for, and why each is a violation rather than a
 * style preference.
 *
 * Written as pairs of a matcher and an explanation so the report can say what is
 * wrong rather than which rule fired. A model told "you used fetch" learns
 * nothing; one told "the benchmark requires the file to arrive through the
 * page's own download control" learns the rule.
 */
const RULES: Array<{ name: string; pattern: RegExp; reason: string; instead: string }> = [
  {
    name: "network-request",
    pattern: /\b(?:fetch|axios(?:\.\w+)?|https?\.request|https?\.get|request\.(?:get|post|put|delete)|context\.request|page\.request)\s*\(/,
    reason: "this makes an HTTP request directly instead of driving the page.",
    instead: "click the control that performs the action, or navigate with page.goto(), so the request is the page's own.",
  },
  {
    name: "evaluate-network",
    pattern: /evaluate\s*\(\s*(?:async\s*)?(?:function|\()[\s\S]{0,400}?\b(?:fetch|XMLHttpRequest|sendBeacon)\s*\(/,
    reason: "this issues a request from inside the page's JavaScript, which the page did not do itself.",
    instead: "click the link or button the page provides. evaluate() for reading and measuring is still allowed.",
  },
  {
    name: "manual-page-creation",
    pattern: /\b(?:context|browser|page\.context\(\))\s*\.\s*newPage\s*\(/,
    reason: "this opens a tab directly, so the task's requirement that a click opened it cannot be met.",
    instead: "click the link that opens it and catch the popup: `const popup = await browser.expectPopup(page, () => page.getByText('...').click())`.",
  },
  {
    name: "filesystem-write",
    pattern: /\bwriteFile(?:Sync)?\s*\(/,
    reason: "this writes a file the browser did not produce, which is indistinguishable from a download that never happened.",
    instead: "use browser.download() so the file arrives through the page's own download event.",
  },
];

/**
 * Inspect a program against a policy.
 *
 * Static, and before the program runs, because a rule enforced after the fact is
 * a rule that has already been broken. The static check is deliberately
 * syntactic rather than a full parse: a program that reaches `fetch` by
 * refactoring `globalThis["fet" + "ch"]` would evade it, and that is a thing a
 * model does only if it is trying to evade, which the report would catch as an
 * unexplained failure anyway.
 */
export function inspectProgram(code: string, policy: PolicyName): PolicyReport {
  if (policy === "none") return { policy, allowed: true, violations: [] };
  const violations: PolicyViolation[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(code);
    if (match === null) continue;
    violations.push({
      rule: rule.name,
      excerpt: excerptAround(code, match.index),
      reason: rule.reason,
      instead: rule.instead,
    });
  }
  return { policy, allowed: violations.length === 0, violations };
}

/**
 * The line the violation is on, with a little context.
 *
 * Context because a bare `fetch(` tells the model nothing about which of its
 * lines was the problem, and a program can be forty lines long.
 */
function excerptAround(code: string, index: number): string {
  const start = code.lastIndexOf("\n", index) + 1;
  const end = code.indexOf("\n", index);
  return code.slice(start, end === -1 ? Math.min(code.length, start + 200) : end).trim().slice(0, 200);
}

/** The report as the model reads it. */
export function renderPolicyReport(report: PolicyReport): string {
  if (report.allowed) return "";
  const lines = [`POLICY VIOLATION (${report.policy}): this program was not run.`];
  for (const violation of report.violations) {
    lines.push(`  ${violation.rule}: ${violation.excerpt}`);
    lines.push(`    ${violation.reason}`);
    lines.push(`    instead: ${violation.instead}`);
  }
  return lines.join("\n");
}
