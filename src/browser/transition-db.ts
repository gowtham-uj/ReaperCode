/**
 * The site state machine, learned from browsing and then reused.
 *
 * A login wall, a Greenhouse application and a Workday application are the same
 * five screens for everybody, every time. Rediscovering that per session is the
 * most repeated work an agent does, and it is the work a model is worst at doing
 * consistently: the same form produces a slightly different program each run.
 *
 * So every successful step yields a tuple:
 *
 *     (state_before, action_program, state_after, success, successes, failures)
 *
 * Accumulated, that is a graph of the site. Three properties make it more than a
 * cache, and each is a decision worth stating:
 *
 * **The action program is the valuable half.** An edge does not just say where
 * you are going; it hands back the program that got there, already written and
 * already known to have worked. That is where the "one model call per step
 * instead of several" saving comes from, and it is why the program is stored
 * rather than a description of it.
 *
 * **Success is decided by the verifier, never by the model's opinion.** An edge
 * is only recorded when the step's checks passed. A graph built from what the
 * model believed it did fills with transitions that never happened, and a model
 * following those is worse off than one exploring.
 *
 * **States come from the page, not the URL.** A state is a signature of the page
 * as the compiler saw it, so `application_form` is recognised on a site whose
 * URLs carry a tenant id or a session token. A URL-keyed graph is useless on
 * every site worth automating.
 *
 * Nothing here knows what Greenhouse is. It knows that a form leads to another
 * form when a Continue button is clicked and the postcondition held.
 *
 * Storage is per host and shared across threads, because a site's shape is not
 * per task. Values never are: the action program is a recipe, and anything typed
 * stays in the thread's own browser state.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** One learned transition. */
export interface Transition {
  from: string;
  to: string;
  /**
   * The program that made the transition, with its literals removed.
   *
   * Stored stripped of any typed values, because this file is shared across
   * threads and a program is a recipe rather than a record. See
   * `generaliseProgram`.
   */
  program: string;
  /** How many times this edge has been taken successfully. */
  successes: number;
  /** How many times it was attempted and the checks did not pass. */
  failures: number;
  /** When it was last confirmed, so a stale edge can be recognised as stale. */
  lastSeen: string;
}

/** The learned graph for one host. */
export interface HostFlows {
  host: string;
  transitions: Transition[];
  /**
   * The most recent path through the graph, for the model to read.
   *
   * A graph is the right storage and the wrong thing to show a model. What it
   * needs is "you are here, and these are the steps this site has", which is the
   * most recent successful path flattened.
   */
  lastPath: string[];
}

/** How many times an edge must fail before it stops being offered. */
export const EDGE_DEMOTE_THRESHOLD = 2;

/** A graph larger than this is pruned, oldest-failing first. */
export const MAX_TRANSITIONS = 400;

/**
 * A page's identity for the graph.
 *
 * Built from what the compiler saw rather than from the URL, for the reason the
 * header gives: URLs carry tenant ids, session tokens and pagination, so a
 * URL-keyed graph recognises nothing twice.
 *
 * The section kinds and labels are the stable part. A form with the same fields
 * is the same state on two different tenants, which is the whole point.
 */
export function stateSignature(sections: Array<{ kind: string; label: string }>): string {
  /*
   * Sorted and de-duplicated, so two pages whose sections are in a different
   * order are the same state. A site that reorders its navigation between
   * requests is not a site in two states.
   */
  const parts = [...new Set(sections.map((section) => `${section.kind}:${normaliseLabel(section.label)}`))].sort();
  /*
   * Counts are deliberately excluded. "Results (30)" and "Results (12)" are the
   * same page with different data, and treating them as different states makes
   * the graph useless on any list that changes.
   */
  return parts.slice(0, 12).join("|") || "empty";
}

/** A label without the parts that change between runs. */
function normaliseLabel(label: string): string {
  return label
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * A program with its literals removed, so it can be shared.
 *
 * This is the line between a recipe and a record. The recipe is "fill the first
 * field, then click Continue" and it is the same for everybody; the record
 * contains an email address and belongs to one person. Only the recipe is
 * stored, and the model substitutes its own values when it follows the edge.
 *
 * Deliberately textual and deliberately conservative: a string literal that
 * cannot be confidently classified is replaced rather than kept. Losing a
 * constant costs a model call to work out again; keeping somebody's password in
 * a file shared across threads is not recoverable.
 */
export function generaliseProgram(code: string): string {
  let out = "";
  let index = 0;
  while (index < code.length) {
    const char = code[index]!;
    if (char !== '"' && char !== "'" && char !== "`") {
      out += char;
      index += 1;
      continue;
    }
    const quote = char;
    let literal = "";
    index += 1;
    while (index < code.length && code[index] !== quote) {
      if (code[index] === "\\") {
        literal += code[index]! + (code[index + 1] ?? "");
        index += 2;
        continue;
      }
      literal += code[index]!;
      index += 1;
    }
    index += 1; // the closing quote

    out += `${quote}${placeholderFor(literal)}${quote}`;
  }
  return out;
}

/**
 * What a literal becomes.
 *
 * A CSS selector, a role name, a URL path or a test id is part of the recipe and
 * survives. Anything else is a value somebody typed, and becomes a placeholder
 * the model fills in.
 *
 * The keep-list is narrow on purpose, and the first version was not narrow
 * enough: it kept any short hyphenated word, which passed `secret-value` through
 * to the shared file. The test asserting a password never reaches disk is what
 * caught it, and it is the reason this is a keep-list rather than a deny-list.
 * It is easier to justify keeping a selector than to justify keeping something
 * that turned out to be a credential.
 *
 * The distinguishing property of a role name is that it is a word: lowercase,
 * letters only, no digits and no separators. A hyphenated token has the shape of
 * a generated password, so hyphens are out.
 */
function placeholderFor(literal: string): string {
  if (literal.length === 0) return literal;
  const trimmed = literal.trim();

  // Selectors, test ids and paths: structural, and unambiguous.
  if (/^[#.\[/][^\s]*$/.test(trimmed)) return literal;

  /*
   * An ARIA role or a single control word: letters only, short. `button`,
   * `textbox`. No digits, hyphens or underscores, because those are what a
   * generated token looks like.
   */
  if (/^[a-z]+$/i.test(trimmed) && trimmed.length <= 20) return literal;

  // An absolute URL is a destination, and describing it is the point of a flow.
  if (/^https?:\/\//.test(trimmed)) return literal;

  return "<value>";
}

/**
 * The graph for one host, plus what it takes to keep it honest.
 *
 * Reads are synchronous once loaded because the model's next step usually needs
 * the flow immediately; the file is loaded at first use and written after a
 * change rather than on every read.
 */
export class TransitionDb {
  private readonly hosts = new Map<string, HostFlows>();
  private loaded = false;
  private writeQueued: Promise<void> | undefined;

  constructor(private readonly options: { path: string }) {}

  /** Load from disk once, on first use. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.options.path, "utf8");
      const parsed = JSON.parse(raw) as { hosts?: HostFlows[] };
      for (const host of parsed.hosts ?? []) this.hosts.set(host.host, host);
    } catch {
      /*
       * A missing or unreadable file is a first run, not an error. Losing the
       * learned flows costs a few extra model calls; refusing to browse costs
       * the task.
       */
    }
  }

  /**
   * Record a transition that the verifier confirmed.
   *
   * Called with the *outcome* of the checks rather than with an opinion, which
   * is what keeps the graph from filling with transitions the model believed it
   * made. A failed attempt increments the failure count instead, which is what
   * lets a site that changed be relearned rather than refused.
   */
  async record(input: { host: string; from: string; to: string; program: string; succeeded: boolean }): Promise<void> {
    await this.ensureLoaded();
    const host = this.hosts.get(input.host) ?? { host: input.host, transitions: [], lastPath: [] };
    this.hosts.set(input.host, host);

    const program = generaliseProgram(input.program);
    const existing = host.transitions.find((edge) => edge.from === input.from && edge.to === input.to && edge.program === program);
    const now = new Date().toISOString();

    if (existing) {
      if (input.succeeded) existing.successes += 1;
      else existing.failures += 1;
      existing.lastSeen = now;
    } else if (input.succeeded) {
      /*
       * Only a success creates an edge. Recording a failure as a new transition
       * would fill the graph with paths that do not work, and a model following
       * those is worse off than one exploring from scratch.
       */
      host.transitions.push({ from: input.from, to: input.to, program, successes: 1, failures: 0, lastSeen: now });
    }

    if (input.succeeded) {
      host.lastPath = [...host.lastPath.filter((state) => state !== input.from), input.from, input.to].slice(-12);
    }
    prune(host);
    this.queueWrite();
  }

  /**
   * The programs known to lead out of a state, best first.
   *
   * Demoted rather than deleted: an edge that has failed repeatedly is one the
   * site probably changed, and it is offered last rather than removed, so a site
   * that changed can be relearned through the same path.
   */
  async edgesFrom(host: string, state: string): Promise<Transition[]> {
    await this.ensureLoaded();
    const flows = this.hosts.get(host);
    if (!flows) return [];
    return flows.transitions
      .filter((edge) => edge.from === state && edge.failures < EDGE_DEMOTE_THRESHOLD + edge.successes)
      .sort((a, b) => b.successes - b.failures - (a.successes - a.failures) || b.lastSeen.localeCompare(a.lastSeen));
  }

  /** The flow line for the model, when this host has been seen before. */
  async describe(host: string): Promise<string | undefined> {
    await this.ensureLoaded();
    const flows = this.hosts.get(host);
    if (!flows || flows.transitions.length === 0) return undefined;
    const total = flows.transitions.reduce((sum, edge) => sum + edge.successes, 0);
    const path = flows.lastPath.length > 0 ? `\nPath: ${flows.lastPath.join(" -> ")}` : "";
    return `This site has been browsed before: ${flows.transitions.length} known step${flows.transitions.length === 1 ? "" : "s"} across ${total} confirmed transition${total === 1 ? "" : "s"}.${path}`;
  }

  /** Everything learned about a host, for the UI and the CLI to show and clear. */
  async flowsFor(host: string): Promise<HostFlows | undefined> {
    await this.ensureLoaded();
    return this.hosts.get(host);
  }

  /** Forget one host, or all of them. */
  async clear(host?: string): Promise<void> {
    await this.ensureLoaded();
    if (host === undefined) this.hosts.clear();
    else this.hosts.delete(host);
    this.queueWrite();
  }

  /**
   * Write, coalesced.
   *
   * A browsing step can record several times, and each write is a file
   * operation. Only one write is ever in flight and the last request wins, which
   * is safe because every write serialises the whole in-memory map.
   *
   * Atomic, so a process that dies mid-write leaves the previous file intact
   * rather than a truncated one: a half-written graph is a graph that fails to
   * parse on the next run, which costs every flow rather than the last one.
   */
  private queueWrite(): void {
    if (this.writeQueued) return;
    this.writeQueued = this.write().finally(() => {
      this.writeQueued = undefined;
    });
  }

  private async write(): Promise<void> {
    try {
      const path = this.options.path;
      await mkdir(dirname(path), { recursive: true });
      const body = JSON.stringify({ version: 1, hosts: [...this.hosts.values()] }, null, 2);
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, path);
    } catch {
      // Best-effort for the same reason the read is: a lost flow costs calls,
      // and a failed write must not fail the browsing step that caused it.
    }
  }

  /** Wait for any queued write, for tests and for shutdown. */
  async flush(): Promise<void> {
    await this.writeQueued;
  }
}

/**
 * Keep the graph bounded.
 *
 * A graph that grows forever is a file that grows forever and a lookup that
 * slows down. The ones dropped are the least useful: never confirmed and
 * repeatedly failing, which is what an edge from a site redesign looks like.
 */
function prune(host: HostFlows): void {
  if (host.transitions.length <= MAX_TRANSITIONS) return;
  host.transitions.sort((a, b) => b.successes - b.failures - (a.successes - a.failures));
  host.transitions.length = MAX_TRANSITIONS;
}
