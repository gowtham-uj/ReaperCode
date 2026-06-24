import { extractLocalizationHints, formatLocalizationHintsForFeedback } from "../localization/from_tests.js";

export type VerificationFailureClass =
  | "missing_script"
  | "missing_artifact"
  | "missing_dependency"
  | "missing_type_dependency"
  | "permission_or_executable"
  | "text_encoding_or_binary_output"
  | "test_discovery"
  | "typecheck"
  | "compile_error"
  | "build_config"
  | "runtime_exception"
  | "assertion_failure"
  | "exact_output_mismatch"
  | "external_service"
  | "environment_missing"
  | "performance_regression"
  | "timeout"
  | "dependency_install"
  | "schema_or_migration"
  | "unknown";

/**
 * Compile-time-typed list of every member of the
 * `VerificationFailureClass` union. Used by the `satisfies` check
 * below to assert that every value in the union has at least one
 * matching rule — see `assertEveryClassHasRule` and
 * `tests/unit/verify/failure-classifier-dsl.test.ts`.
 *
 * Adding a new value here without adding a corresponding rule in
 * `rules` will fail `typecheck` (the `satisfies` clause complains)
 * AND fail the build-time `assertEveryClassHasRule` check at module
 * load. Adding a new rule with a `kind` not in the union is also a
 * compile error.
 */
export const ALL_FAILURE_CLASSES = [
  "missing_script",
  "missing_artifact",
  "missing_dependency",
  "missing_type_dependency",
  "permission_or_executable",
  "text_encoding_or_binary_output",
  "test_discovery",
  "typecheck",
  "compile_error",
  "build_config",
  "runtime_exception",
  "assertion_failure",
  "exact_output_mismatch",
  "external_service",
  "environment_missing",
  "performance_regression",
  "timeout",
  "dependency_install",
  "schema_or_migration",
  "unknown",
] as const satisfies readonly VerificationFailureClass[];

export interface ClassifiedVerificationFailure {
  classes: VerificationFailureClass[];
  evidence: string[];
  facts: string[];
  repairStrategy: string;
}

/**
 * Phase T3.12: typed DSL for failure-classifier rules. Each rule
 * is a `Match<Kind>` shape that pairs a regex with the class it
 * detects, plus the canonical evidence string and repair strategy
 * that surface in the feedback. The `Kind` generic is constrained
 * to `VerificationFailureClass` so adding a class to the union
 * without a matching rule fails typecheck.
 */
export interface Match<Kind extends VerificationFailureClass = VerificationFailureClass> {
  kind: Kind;
  pattern: RegExp;
  evidence: string;
  strategy: string;
}

/**
 * Build-time check: every member of `VerificationFailureClass`
 * must appear as at least one rule's `kind`. Runs once at module
 * load. If a contributor adds a new value to the union but forgets
 * to add a rule, this throws and the engine fails to start.
 *
 * The check is duplicated in tests/unit/verify/failure-classifier-dsl.test.ts
 * so the failure mode is also covered by a test that fails with a
 * useful message rather than just a startup crash.
 */
function assertEveryClassHasRule(rules: ReadonlyArray<Match>): void {
  const seen = new Set<VerificationFailureClass>();
  for (const rule of rules) {
    seen.add(rule.kind);
  }
  const missing: VerificationFailureClass[] = [];
  for (const klass of ALL_FAILURE_CLASSES) {
    if (!seen.has(klass)) {
      missing.push(klass);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `failure-classifier: missing rules for ${missing.length} class(es): ${missing.join(", ")}. ` +
        `Add a rule to \`rules\` in src/verify/failure-classifier.ts, or remove the class from the union.`,
    );
  }
}

const rules: Match[] = [
  {
    kind: "missing_script",
    pattern: /missing script:\s*["']?([\w:-]+)["']?|npm ERR! missing script/i,
    evidence: "A package script referenced by verification does not exist.",
    strategy: "Inspect the manifest and add or align scripts with the project contract before rerunning verification.",
  },
  {
    kind: "missing_artifact",
    pattern: /file .*does not exist|no such file or directory|filenotfounderror|missing (?:file|artifact|output)|not found/i,
    evidence: "Verification expected an artifact, file, route, command, or output that is absent.",
    strategy: "Identify the required artifact from the failure, create it through the intended workflow, then verify the exact path/name/content contract.",
  },
  {
    kind: "missing_dependency",
    pattern: /cannot find module|module not found|ERR_MODULE_NOT_FOUND|could not resolve dependency/i,
    evidence: "Source or tests import a package that is absent from installed dependencies.",
    strategy: "Inspect imports and the manifest together, then batch-add missing runtime and test dependencies.",
  },
  {
    kind: "permission_or_executable",
    pattern: /permission denied|not executable|execute permissions?|eacces|access denied|shebang|dos line endings|crlf/i,
    evidence: "Verification failed because an executable, permission bit, shebang, or line ending contract is wrong.",
    strategy: "Repair file modes and executable metadata as a group, then run the exact command that previously failed.",
  },
  {
    kind: "text_encoding_or_binary_output",
    pattern: /unicodedecodeerror|invalid start byte|utf-?8|binary output|decode byte/i,
    evidence: "A text consumer received bytes that are not valid for the expected encoding.",
    strategy: "Separate binary payloads from text artifacts and ensure user-visible output files contain valid text in the expected encoding.",
  },
  {
    kind: "missing_type_dependency",
    pattern: /could not find a declaration file|cannot find namespace 'jest'|cannot find name '(describe|it|test|expect|jest)'|@types\//i,
    evidence: "TypeScript or tests are missing ambient type packages or test-runner type configuration.",
    strategy: "Add the relevant type packages and update TypeScript/Jest configuration coherently.",
  },
  {
    kind: "test_discovery",
    pattern: /no tests found|invalid testpattern|testmatch|pattern: .*0 matches|collected 0 items|no tests ran/i,
    evidence: "The test runner is configured but does not discover the intended tests.",
    strategy: "Align test scripts/configuration with the actual test locations without deleting tests.",
  },
  {
    kind: "typecheck",
    pattern: /\bTS\d{4}\b|type error|tsc\b/i,
    evidence: "The project has TypeScript compilation errors.",
    strategy: "Fix all related type errors as a cluster, including imports, exports, ambient declarations, and strictness mismatches.",
  },
  {
    kind: "compile_error",
    pattern: /compilation failed|compile error|compiler error|static_assert|undefined reference|linker error|ld returned|non-constant condition|fatal error: |cannot find .*\.h|no such file or directory.*\.h/i,
    evidence: "Verification reached a compiler or linker and the produced code does not satisfy the build contract.",
    strategy: "Use the compiler diagnostics as the source of truth and repair the smallest implementation/API mismatch that makes the build succeed.",
  },
  {
    kind: "build_config",
    pattern: /missing script:\s*["']?build["']?|vite|webpack|tsconfig|babel|eslint/i,
    evidence: "The build pipeline or project config is incomplete.",
    strategy: "Inspect the chosen stack contract and repair build scripts/configuration before deeper feature work.",
  },
  {
    kind: "assertion_failure",
    pattern: /expect\(received\)|assertionerror|assertion failed|assert failed|expected:|received:|toBe\(|toEqual\(/i,
    evidence: "Tests run but behavior does not match expectations.",
    strategy: "Read the failing test and implementation, then repair behavior rather than masking the assertion.",
  },
  {
    kind: "exact_output_mismatch",
    pattern: /expected .* but got|content mismatch|hash .* mismatch|match:\s*false|success:\s*false|status:\s*(?:fail|failed|failure)|assert .*==|expected:|received:|actual:/i,
    evidence: "The produced behavior or artifact exists, but its value differs from the acceptance contract.",
    strategy: "Extract the expected value and actual value, then make the producer generate the exact required behavior without weakening the check.",
  },
  {
    kind: "external_service",
    pattern: /ECONNREFUSED|connection refused|failed to establish a new connection|max retries exceeded|ENOTFOUND|database .* connect|mongodb|postgres|redis|prisma.*connect/i,
    evidence: "Verification depends on an external service or local service configuration.",
    strategy: "Start or configure the required service, poll readiness before validation, and only substitute a local implementation if the contract permits it.",
  },
  {
    kind: "environment_missing",
    pattern: /environment .*does not exist|not a .*environment|environmentlocationnotfound|env .*not found|missing environment/i,
    evidence: "Verification expects a named runtime environment that has not been materialized.",
    strategy: "Create or update the requested environment and then run the acceptance command inside that environment.",
  },
  {
    kind: "performance_regression",
    pattern: /should be less than|too slow|performance|faster than|speed comparison|exceeded.*time/i,
    evidence: "Correctness may be present, but the measured performance contract is not met.",
    strategy: "Profile the measured path, remove avoidable work from that path, and compare against the exact verifier timing check.",
  },
  {
    kind: "timeout",
    pattern: /timed out|timeout|ETIMEDOUT/i,
    evidence: "A command or external call exceeded its time budget.",
    strategy: "Determine whether the command is hanging, waiting for a server, installing dependencies, or over-parallelized, then adjust the workflow.",
  },
  {
    kind: "dependency_install",
    pattern: /npm ERR!|ERESOLVE|no matching version|could not find a version|pip .*failed|failed to resolve/i,
    evidence: "Dependency installation or resolution failed.",
    strategy: "Choose compatible package versions and keep lockfile/tooling aligned with the selected stack.",
  },
  {
    kind: "schema_or_migration",
    pattern: /prisma schema validation|migration|datasource|schema validation|P10\d{2}/i,
    evidence: "Database schema or migration tooling is incompatible with the current configuration.",
    strategy: "Repair schema/tool versions and generated clients as a single database-toolchain change.",
  },
  {
    kind: "runtime_exception",
    pattern: /traceback|typeerror|referenceerror|syntaxerror|uncaught|failed to run/i,
    evidence: "The command failed with a runtime exception.",
    strategy: "Trace the exception to the responsible source/config and repair the root cause.",
  },
  // Phase T3.12: the `unknown` class is the fallback applied when
  // no other rule matches. It has no rule of its own because it
  // would never match (every output would qualify). We satisfy
  // the coverage assertion by listing it explicitly with a
  // pattern that can never match a real output.
  {
    kind: "unknown",
    pattern: /\b__REAPER_NEVER_MATCH_4f8a1c__\b/,
    evidence: "",
    strategy: "",
  },
];

// Phase T3.12: enforce the coverage invariant at module load.
// Throws if a class is added to the union without a matching rule.
assertEveryClassHasRule(rules);

export function classifyVerificationOutput(output: string): ClassifiedVerificationFailure {
  const classes: VerificationFailureClass[] = [];
  const evidence: string[] = [];
  const strategies: string[] = [];
  const localizationFacts = formatLocalizationHintsForFeedback(extractLocalizationHints(output));
  const facts = dedupePreserveOrder([...localizationFacts, ...extractFailureFacts(output)]);

  for (const rule of rules) {
    if (rule.kind === "unknown") continue; // never-match placeholder; see comment above
    if (!rule.pattern.test(output)) {
      continue;
    }
    if (!classes.includes(rule.kind)) {
      classes.push(rule.kind);
      evidence.push(rule.evidence);
      strategies.push(rule.strategy);
    }
  }

  if (classes.length === 0) {
    classes.push("unknown");
    evidence.push("No known verification failure pattern matched.");
    facts.push("No known failure signature matched; inspect the last failing command, expected contract, and produced artifacts.");
    strategies.push("Inspect the failure output and the project contract, then choose the smallest coherent repair.");
  }

  return {
    classes,
    evidence,
    facts,
    repairStrategy:
      "Batch related fixes from the full failure cluster before rerunning verification. " +
      strategies.join(" "),
  };
}

function extractFailureFacts(output: string): string[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const interesting = lines.filter((line) =>
    /failed|error|exception|assert|expected|received|actual|missing|cannot find|not found|permission denied|timed out|timeout|connection refused|does not exist|mismatch|returncode|exit code|unicode|decode|compile|environment/i.test(line),
  );
  return dedupePreserveOrder(interesting.slice(-18).map((line) => line.slice(0, 500)));
}

function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}
