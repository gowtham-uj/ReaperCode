/**
 * Completion as a state transition, not a sentence.
 *
 * A model that says "mission complete" has said nothing the runtime can check.
 * WebArena was built around programmatic validators for exactly this reason: a
 * browser agent's own report of success is not evidence, and a benchmark that
 * accepts it is measuring the agent's confidence rather than its work.
 *
 * So finishing is a request, and a request is answered by a verifier. The
 * states are exhaustive and the one that matters is `completed_verified`:
 *
 *     running -> finish_requested -> verifying
 *                                       |
 *                                       +-- PASS -> completed_verified
 *                                       +-- FAIL -> running, with what is missing
 *
 * There is no `completed_unverified`. A run that asked to finish and failed
 * verification is a run that is still going, and telling it what is missing is
 * the whole value of the transition.
 *
 * ## Provenance
 *
 * The second job is checking that a requirement was met *by the interaction the
 * task asked for*, not merely that its end state exists. Two violations from a
 * measured mission are the reason this is here:
 *
 *   - a tab the task wanted opened by clicking a link was opened with
 *     `context.newPage()`
 *   - a file the task wanted downloaded was fetched with `fetch()` and written
 *     to disk
 *
 * Both produce the right end state and neither performs the interaction. A
 * benchmark's whole point is the interaction, so the requirement is written
 * against the evidence rather than against the outcome, and the ledger is what
 * holds the evidence.
 */

import type { RunLedger } from "./run-ledger.js";

/**
 * What a requirement can be checked against.
 *
 * Deliberately small and declarative, because the verifier has to be able to
 * answer "can I check this at all" before it answers yes or no. A requirement it
 * cannot evaluate is reported as unevaluable rather than silently passed, which
 * is the failure mode that makes a verifier worse than none.
 */
export type Requirement =
  /** The page's URL matches. */
  | { kind: "url"; pattern: string }
  /** Text is present in the page's current outline. */
  | { kind: "text"; value: string }
  /** An artifact with a matching name exists in the vault. */
  | { kind: "artifact"; name: string }
  /** An artifact was produced by a download event raised by a UI action. */
  | { kind: "artifactFromAction"; name: string }
  /** A page exists whose URL matches, and it was opened by a click. */
  | { kind: "popup"; pattern: string }
  /**
   * A fact the mission recorded, optionally with the value it must have.
   *
   * `value` is `string | undefined` rather than optional because the tool's
   * schema produces it that way and an exact-optional type would refuse the
   * object the parser hands over. `undefined` means "recorded, whatever it
   * says", which is the useful reading of a requirement with no value.
   */
  | { kind: "fact"; name: string; value?: string | undefined }
  /** A subtask reached `verified`. */
  | { kind: "subtask"; title: string }
  /** No failed action of this kind was recorded after the requirement was set. */
  | { kind: "noFailure"; failureKind: string };

export interface VerificationInput {
  ledger: RunLedger;
  /** The current page's URL, read at verification time. */
  url?: string | undefined;
  /** The current page's outline text, read at verification time. */
  outline?: string | undefined;
  /** Facts the mission recorded, by name. */
  facts?: Map<string, string> | undefined;
  /** Subtasks that reached verified. */
  verifiedSubtasks?: Set<string> | undefined;
}

export interface RequirementResult {
  requirement: Requirement;
  passed: boolean;
  /** Why, in one sentence, for the model to act on. */
  detail: string;
}

export interface VerificationOutcome {
  passed: boolean;
  results: RequirementResult[];
  /** The requirements that failed, phrased as what is still needed. */
  missing: string[];
}

/**
 * Run one requirement against the evidence.
 *
 * Every branch reads the ledger or the page; none of them reads the model's
 * claim. That is the property that makes this a verifier.
 */
export function checkRequirement(requirement: Requirement, input: VerificationInput): RequirementResult {
  switch (requirement.kind) {
    case "url": {
      /*
       * An empty pattern is refused, and this was the verifier's own hole.
       *
       * `matchPattern` is an `includes`, so `pattern: ""` matched every string:
       * a run that did nothing answered `finish: [{kind:"url", pattern:""}]` and
       * got `VERIFIED: all 1 requirements are met.` on `about:blank`. The same
       * held for `text` with `value: ""` and `artifact` with `name: ""`. The file
       * whose whole docblock is "a model that says 'mission complete' has said
       * nothing the runtime can check" was satisfied by one empty character.
       *
       * A requirement with nothing to match is not a weak requirement, it is not
       * a requirement: it cannot fail, so passing it says nothing. It is refused
       * here rather than at the schema, because the schema is also what a stored
       * plan is read through and a stored empty pattern must fail the same way.
       */
      const pattern = requirement.pattern.trim();
      if (pattern.length === 0) {
        return { requirement, passed: false, detail: "this requirement has no URL pattern, so it cannot be checked; give the pattern you actually expect" };
      }
      const url = input.url ?? "";
      const passed = matchPattern(url, pattern);
      return { requirement, passed, detail: passed ? `${url} matches ${pattern}` : `the page is at ${url || "(unknown)"}, which does not match ${pattern}` };
    }
    case "text": {
      const value = requirement.value.trim();
      if (value.length === 0) {
        return { requirement, passed: false, detail: "this requirement has no text to look for, so it cannot be checked; give the text you actually expect" };
      }
      const outline = input.outline ?? "";
      const passed = outline.includes(value);
      return { requirement, passed, detail: passed ? `the page contains "${value}"` : `the page does not contain "${value}"` };
    }
    case "artifact": {
      const name = requirement.name.trim();
      if (name.length === 0) {
        return { requirement, passed: false, detail: "this requirement names no file, so it cannot be checked; name the file you actually expect" };
      }
      const artifacts = input.ledger.of("artifact.saved");
      const found = artifacts.find((artifact) => artifact.name.includes(name));
      return {
        requirement,
        passed: found !== undefined,
        detail: found !== undefined ? `${found.name} is saved at ${found.path} (${found.bytes} bytes)` : `no saved file matches "${name}"`,
      };
    }
    case "artifactFromAction": {
      /*
       * The provenance check, and the reason the ledger records `announced` and
       * `triggeredBy` separately from the file's existence. A file that appeared
       * without a download event was produced some other way, and the task asked
       * for the interaction.
       */
      const fromAction = input.ledger.downloadsFromActions().filter((artifact) => artifact.name.includes(requirement.name));
      return {
        requirement,
        passed: fromAction.length > 0,
        detail:
          fromAction.length > 0
            ? `${fromAction[0]!.name} came from a download event raised by ${fromAction[0]!.triggeredBy}`
            : `no download event matches "${requirement.name}"; a file that merely exists on disk does not satisfy this`,
      };
    }
    case "popup": {
      const popups = input.ledger.popupsFromActions().filter((popup) => popup.url !== undefined && matchPattern(popup.url, requirement.pattern));
      return {
        requirement,
        passed: popups.length > 0,
        detail:
          popups.length > 0
            ? `page ${popups[0]!.pageId} was opened by ${popups[0]!.openedBy} and is at ${popups[0]!.url}`
            : `no page matching ${requirement.pattern} was opened by a click; browser.newPage() does not satisfy this`,
      };
    }
    case "fact": {
      const value = input.facts?.get(requirement.name);
      const passed = value !== undefined && (requirement.value === undefined || value === requirement.value);
      return {
        requirement,
        passed,
        detail: passed ? `${requirement.name} is recorded as ${value}` : `the mission has not recorded ${requirement.name}${requirement.value !== undefined ? ` as ${requirement.value}` : ""}`,
      };
    }
    case "subtask": {
      const passed = input.verifiedSubtasks?.has(requirement.title) === true;
      return { requirement, passed, detail: passed ? `${requirement.title} is verified` : `${requirement.title} has not been verified` };
    }
    case "noFailure": {
      const failures = input.ledger.of("action.finished").filter((event) => event.status === "failed" && event.failureKind === requirement.failureKind);
      return {
        requirement,
        passed: failures.length === 0,
        detail: failures.length === 0 ? `no ${requirement.failureKind} failures recorded` : `${failures.length} ${requirement.failureKind} failures recorded, the last on ${failures[failures.length - 1]!.actionId}`,
      };
    }
  }
}

/** Run every requirement. Any failure means the mission is not finished. */
export function verify(requirements: Requirement[], input: VerificationInput): VerificationOutcome {
  const results = requirements.map((requirement) => checkRequirement(requirement, input));
  const missing = results.filter((result) => !result.passed).map((result) => `${describeRequirement(result.requirement)}: ${result.detail}`);
  return { passed: missing.length === 0, results, missing };
}

/**
 * The verifier's answer as the model reads it.
 *
 * On a pass it is short, because a model that has finished does not need a
 * report. On a failure it lists exactly what is missing, because that list is
 * the model's next plan.
 */
export function renderVerification(outcome: VerificationOutcome): string {
  if (outcome.passed) return `VERIFIED: all ${outcome.results.length} requirements are met.`;
  const lines = [`VERIFICATION FAILED: ${outcome.missing.length} of ${outcome.results.length} requirements are not met.`];
  for (const missing of outcome.missing) lines.push(`  - ${missing}`);
  lines.push("", "The mission is not finished. Address these and request finish again.");
  return lines.join("\n");
}

/** A requirement in words, for a report or a missing-list. */
function describeRequirement(requirement: Requirement): string {
  switch (requirement.kind) {
    case "url":
      return `the page is at ${requirement.pattern}`;
    case "text":
      return `the page shows "${requirement.value}"`;
    case "artifact":
      return `a file named ${requirement.name} was saved`;
    case "artifactFromAction":
      return `${requirement.name} was downloaded by clicking`;
    case "popup":
      return `a page matching ${requirement.pattern} was opened by a click`;
    case "fact":
      return `${requirement.name} was established`;
    case "subtask":
      return `${requirement.title} was completed`;
    case "noFailure":
      return `no ${requirement.failureKind} failures occurred`;
  }
}

/**
 * Match a URL against a pattern.
 *
 * A substring when the pattern has no regex syntax, otherwise a regular
 * expression. The substring case is the common one and it is the one that must
 * not throw: `new RegExp("/dashboard")` would be a mistake nobody notices until
 * a path has a bracket in it.
 */
function matchPattern(value: string, pattern: string): boolean {
  if (/[\\^$*+?()[\]{}|]/.test(pattern)) {
    try {
      return new RegExp(pattern).test(value);
    } catch {
      return value.includes(pattern);
    }
  }
  return value.includes(pattern);
}
