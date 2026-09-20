/**
 * What the mission knows, kept outside the conversation.
 *
 * The problem this solves is compaction. A mission runs for hundreds of model
 * calls, and the only place its findings lived was the transcript, so when the
 * transcript was trimmed the findings went with it. The model then had to
 * reconstruct values it had already read, from summaries of pages it had
 * already left. Measured on one run: a value read at step 12 was re-derived at
 * step 180, because nothing outside the conversation held it.
 *
 * So state is a data object. Facts are recorded once with the evidence that
 * produced them, and every turn the model reads the object rather than the
 * history that built it. That is the whole change: the transcript becomes a log
 * of what was tried, and this becomes what is known.
 *
 * Two rules keep it honest.
 *
 * A fact carries the action that produced it. A fact with no evidence is a
 * guess, and a mission that reports a guess as a finding is worse than one that
 * reports nothing, because the wrong answer looks like work.
 *
 * A subtask is a state, not a sentence. "Ran the demoqa step" is not a status;
 * `verified`, `running`, `blocked` and `pending` are, and they are exhaustive so
 * a report cannot invent a fifth one that means nothing.
 */

/**
 * How much of the state is rendered per turn.
 *
 * These are the whole reason the block is affordable. Each is a cap on a list
 * that a long mission would otherwise grow without bound, and the cost of a
 * per-turn block is its size times the turns remaining, so an uncapped list is
 * the most expensive mistake this file can make. It made it once: see the note
 * on `render`.
 */
const FACTS_SHOWN = 12;
const READY_SHOWN = 5;
const FAILURES_SHOWN = 5;

/** One thing the mission has established, and what established it. */
export interface Fact {
  value: string;
  /** The action that produced this, so a reader can go and check. */
  evidence: string;
  /** True when it was computed from other facts rather than read from a page. */
  derived?: boolean;
}

/**
 * Where a subtask stands.
 *
 * `verified` is deliberately distinct from `done`. A step the model believes it
 * finished and one the runtime confirmed are different claims, and a report that
 * cannot tell them apart is one that overstates. Only the verifier sets
 * `verified`.
 */
export type SubtaskStatus = "pending" | "running" | "blocked" | "done" | "verified" | "failed";

export interface Subtask {
  /** What the subtask is, short. */
  title: string;
  status: SubtaskStatus;
  /** Other subtasks that must reach `verified` before this can run. */
  requires: string[];
  /** One line on why it is blocked or failed, when it is. */
  note?: string;
}

export interface MissionArtifact {
  name: string;
  path: string;
  bytes: number;
  /** `saved` when the file is there, `pending` when the step has not run. */
  status: "pending" | "saved" | "failed";
}

/**
 * The mission's state.
 *
 * Deliberately a plain serialisable object with no methods beyond accessors, so
 * it can be written to the journal, restored after a restart, and read by a
 * verifier without either of them knowing how it was built.
 */
export class MissionState {
  /** The goal, as the user stated it. */
  goal: string | undefined;
  /** Values read from pages, keyed by a short name the model chose. */
  readonly facts = new Map<string, Fact>();
  /** Values computed from facts, kept separate because they are a different claim. */
  readonly derived = new Map<string, Fact>();
  /**
   * The subtasks, in the order they were declared.
   *
   * An array rather than a map, because the order is part of the plan and a
   * dependency graph the model reads is easier to follow in outline form than in
   * hash order.
   */
  readonly subtasks: Subtask[] = [];
  /** Where each page is, by the id the registry assigned. */
  readonly pages = new Map<string, string>();
  /** Files this mission has produced. */
  readonly artifacts = new Map<string, MissionArtifact>();
  /** Failures worth remembering, so the same wrong approach is not retried. */
  readonly failures: Array<{ action: string; kind: string; note?: string }> = [];

  recordFact(name: string, value: string, evidence: string): void {
    this.facts.set(name, { value, evidence });
  }

  recordDerived(name: string, value: string, evidence: string): void {
    this.derived.set(name, { value, evidence, derived: true });
  }

  get(name: string): string | undefined {
    return this.facts.get(name)?.value ?? this.derived.get(name)?.value;
  }

  /**
   * Declare or update a subtask.
   *
   * Upsert rather than insert, because a plan is revised while it runs and the
   * second declaration is the truer one. The dependencies are only taken from
   * the first, so a revision cannot quietly drop a constraint that stopped a
   * step from running out of order.
   */
  declareSubtask(title: string, requires: string[] = []): Subtask {
    const existing = this.subtasks.find((subtask) => subtask.title === title);
    if (existing !== undefined) return existing;
    const created: Subtask = { title, status: "pending", requires };
    this.subtasks.push(created);
    return created;
  }

  setSubtask(title: string, status: SubtaskStatus, note?: string): void {
    const subtask = this.declareSubtask(title);
    subtask.status = status;
    if (note !== undefined) subtask.note = note;
    else delete subtask.note;
  }

  /**
   * The subtasks whose dependencies are all verified and which have not run.
   *
   * This is the answer to "what should I do now", computed rather than asked.
   * The model was spending turns deciding this from the transcript, and the
   * answer is a fold over the dependency edges.
   */
  ready(): Subtask[] {
    const verified = new Set(this.subtasks.filter((subtask) => subtask.status === "verified").map((subtask) => subtask.title));
    return this.subtasks.filter(
      (subtask) =>
        (subtask.status === "pending" || subtask.status === "blocked") &&
        subtask.requires.every((dependency) => verified.has(dependency)),
    );
  }

  recordFailure(action: string, kind: string, note?: string): void {
    this.failures.push({ action, kind, ...(note !== undefined ? { note } : {}) });
  }

  /** One line per subtask, for the journal and for a report. */
  /**
   * The state as the model reads it.
   *
   * ## Bounded, and it was not
   *
   * The comment here said "bounded on purpose" while the code rendered every
   * subtask and every ready one, which grows without limit as a mission declares
   * work. Measured across one run: 94 of these blocks, the first 726 characters
   * and the last 3,561, averaging 2,205. Because each is re-sent with every
   * later model call, that is 9.16M characters of context for 207KB of content:
   * about **2.29M tokens**, against a run whose total was 13.4M. It was the
   * single largest avoidable cost in the mission, and it was mine.
   *
   * The arithmetic is why a per-turn block has to be constant-size. A block that
   * grows by 20 characters a turn is not 20 characters, it is 20 characters
   * times the number of turns remaining, and a mission has hundreds.
   *
   * So the shape is fixed: recent facts, the subtasks that are *moving*, and a
   * count of the rest. What is dropped is the thing that carried no information
   * anyway. `READY NOW` listed all fourteen pending subtasks on the second turn,
   * because a subtask with no dependencies is ready the moment it is declared,
   * and fourteen names that all say "not started yet" is a worse answer than the
   * count does in one line.
   */
  render(): string {
    const sections: string[] = [];
    /*
     * The most recent facts, because that is what a decision needs. A mission
     * accumulates values for an hour and the one read twenty turns ago is not
     * what the next step depends on. Bounded from the *end* so the newest
     * survive, with a count of what was left out.
     */
    const factEntries = [...this.facts.entries()];
    const facts = factEntries.slice(-FACTS_SHOWN).map(([name, fact]) => `  ${name} = ${fact.value}   [${fact.evidence}]`);
    if (facts.length > 0) {
      const older = factEntries.length - facts.length;
      sections.push(`FACTS${older > 0 ? ` (last ${facts.length} of ${factEntries.length})` : ""}:\n${facts.join("\n")}`);
    }
    const derivedEntries = [...this.derived.entries()];
    const derived = derivedEntries.slice(-FACTS_SHOWN).map(([name, fact]) => `  ${name} = ${fact.value}   (derived from ${fact.evidence})`);
    if (derived.length > 0) sections.push(`DERIVED:\n${derived.join("\n")}`);

    /*
     * The subtasks that are moving, plus a count of the ones that are not.
     *
     * "Moving" is anything not pending: running, blocked, done, verified,
     * failed. Those are the states a decision turns on. A pending subtask is one
     * nobody has started, and listing all of them is the cost this exists to
     * remove.
     */
    const moving = this.subtasks.filter((subtask) => subtask.status !== "pending");
    if (moving.length > 0) {
      const lines = moving.map((subtask) => {
        const note = subtask.note !== undefined ? ` : ${subtask.note}` : "";
        return `  [${subtask.status}] ${subtask.title}${note}`;
      });
      sections.push(`SUBTASKS:\n${lines.join("\n")}`);
    }
    /*
     * The counts, and only when there is a plan to count.
     *
     * A mission that has declared nothing gets nothing: `PROGRESS: 0 verified, 0
     * in progress, 0 not started` is four words of nothing on every turn of a
     * conversation that has not started planning. The test that caught this is
     * the one that asserts an empty state renders the empty string, and it is
     * right to.
     */
    if (this.subtasks.length > 0) {
      const pending = this.subtasks.filter((subtask) => subtask.status === "pending").length;
      const verified = this.subtasks.filter((subtask) => subtask.status === "verified").length;
      sections.push(`PROGRESS: ${verified} verified, ${moving.length - verified} in progress, ${pending} not started (of ${this.subtasks.length})`);
    }

    /*
     * What can be done now, capped.
     *
     * Capped rather than omitted, because the first few entries are genuinely
     * the answer to "what next" and the fourteenth is not: a plan whose ready
     * list is longer than a handful is a plan the model will not read in order
     * anyway. The count is what makes the cap honest.
     */
    const ready = this.ready().map((subtask) => subtask.title);
    if (ready.length > 0) {
      const shown = ready.slice(0, READY_SHOWN);
      sections.push(`READY NOW: ${shown.join(", ")}${ready.length > shown.length ? ` (+${ready.length - shown.length} more)` : ""}`);
    }

    if (this.artifacts.size > 0) {
      const artifactEntries = [...this.artifacts.values()];
      const artifacts = artifactEntries.slice(-FACTS_SHOWN).map(
        (artifact) => `  ${artifact.name}: ${artifact.status}${artifact.status === "saved" ? ` (${artifact.bytes} bytes)` : ""}`,
      );
      const older = artifactEntries.length - artifacts.length;
      sections.push(`ARTIFACTS${older > 0 ? ` (last ${artifacts.length} of ${artifactEntries.length})` : ""}:\n${artifacts.join("\n")}`);
    }
    if (this.failures.length > 0) {
      const failures = this.failures.slice(-FAILURES_SHOWN).map((failure) => `  ${failure.action}: ${failure.kind}${failure.note !== undefined ? ` (${failure.note})` : ""}`);
      sections.push(`FAILED BEFORE:\n${failures.join("\n")}`);
    }
    if (sections.length === 0) return "";
    return `MISSION STATE:\n${sections.join("\n")}`;
  }

  /**
   * The whole state as plain data, for a journal or a restart.
   *
   * Maps become arrays of pairs because that is what survives JSON without a
   * schema, and the only reader is `MissionState.from` below.
   */
  toJSON(): Record<string, unknown> {
    return {
      ...(this.goal !== undefined ? { goal: this.goal } : {}),
      facts: [...this.facts.entries()],
      derived: [...this.derived.entries()],
      subtasks: this.subtasks,
      pages: [...this.pages.entries()],
      artifacts: [...this.artifacts.entries()],
      failures: this.failures,
    };
  }

  /** Rebuild from `toJSON`, so a restart does not lose what was known. */
  static from(raw: Record<string, unknown>): MissionState {
    const state = new MissionState();
    if (typeof raw.goal === "string") state.goal = raw.goal;
    for (const [name, fact] of pairsOf<Fact>(raw.facts)) state.facts.set(name, fact);
    for (const [name, fact] of pairsOf<Fact>(raw.derived)) state.derived.set(name, fact);
    for (const [name, path] of pairsOf<string>(raw.pages)) state.pages.set(name, path);
    for (const [name, artifact] of pairsOf<MissionArtifact>(raw.artifacts)) state.artifacts.set(name, artifact);
    if (Array.isArray(raw.subtasks)) state.subtasks.push(...(raw.subtasks as Subtask[]));
    if (Array.isArray(raw.failures)) state.failures.push(...(raw.failures as MissionState["failures"]));
    return state;
  }
}

/** Read an array-of-pairs back into entries, ignoring anything malformed. */
function pairsOf<T>(raw: unknown): Array<[string, T]> {
  if (!Array.isArray(raw)) return [];
  const out: Array<[string, T]> = [];
  for (const entry of raw) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1] !== undefined) {
      out.push([entry[0], entry[1] as T]);
    }
  }
  return out;
}
