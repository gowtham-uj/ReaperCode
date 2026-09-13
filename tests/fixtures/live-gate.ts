/**
 * The single gate for tests that talk to a real model provider.
 *
 * The deterministic suite must not depend on the network. It also must not
 * depend on a shell being configured a particular way — and the previous gate
 * did, because it keyed off the *presence of a provider key*. `/work/.env`
 * supplies those keys, and more than one test loads that file itself so its
 * `skip` condition evaluates against populated environment variables. The
 * result was that a suite advertised as deterministic would, on a machine with
 * credentials, reach out to a vendor: slow, non-reproducible, and capable of
 * failing for reasons that have nothing to do with the change under test.
 *
 * So the gate is an explicit opt-in that no `.env` file can supply by accident.
 * `REAPER_LIVE_TESTS=1` is a deliberate act; `DEEPINFRA_API_KEY` in a dotfile is
 * not. Credentials are still *required* — the key check stays — but they are no
 * longer *sufficient*.
 *
 * Setting `REAPER_LIVE_TESTS=0` forces the tests off even when `1` is also
 * present in the environment, which is what a developer wants when they
 * inherit an exported variable from a previous session.
 */

/** True when live provider tests have been explicitly opted into. */
export function liveTestsEnabled(): boolean {
  return process.env.REAPER_LIVE_TESTS === "1";
}

/**
 * The long-horizon benchmark gets a second gate of its own.
 *
 * It is a real evaluation — a multi-phase build against a live model — and it
 * carries a 15-minute timeout. The serial suite kills its child after 10, so
 * turning live tests on would still leave this one test able to run the whole
 * suite into the watchdog and lose the results of everything before it. A
 * benchmark belongs in a run of its own.
 */
export function skipLongHorizonTest(): boolean {
  return skipLiveTest("DEEPINFRA_API_KEY") || process.env.REAPER_LIVE_LONGHORIZON !== "1";
}

export function longHorizonSkipReason(): string {
  if (!liveTestsEnabled()) return liveTestSkipReason("DEEPINFRA_API_KEY");
  if (!process.env.DEEPINFRA_API_KEY) return "DEEPINFRA_API_KEY is not set";
  return "the long-horizon benchmark runs on its own; set REAPER_LIVE_LONGHORIZON=1 to include it";
}

/**
 * Skip condition for a live test that needs `keyEnv` to be set.
 *
 * Returns `true` (skip) unless live tests were opted into *and* the named key
 * is present, so a missing credential fails safe rather than producing a test
 * that reaches a provider with an empty bearer token.
 */
export function skipLiveTest(keyEnv?: string | readonly string[]): boolean {
  if (!liveTestsEnabled()) return true;
  if (keyEnv === undefined) return false;
  const names = typeof keyEnv === "string" ? [keyEnv] : keyEnv;
  return !names.some((name) => Boolean(process.env[name]));
}

/**
 * Reason text for a skipped live test, so a skip is legible in the run output
 * rather than looking like the test was never written.
 */
export function liveTestSkipReason(keyEnv?: string): string {
  if (!liveTestsEnabled()) {
    return "live provider tests are off; set REAPER_LIVE_TESTS=1 to run them";
  }
  return keyEnv ? `${keyEnv} is not set` : "provider credentials are not set";
}

/**
 * Build the `skip` option for a live test in one step.
 *
 * `node:test` renders a *string* `skip` as the skip reason and `false` as "run
 * it". Every live test here needs exactly that value, and every one of them
 * previously wrote it as two options —
 * `{ skip, description: liveTestSkipReason(...) }` — because `description`
 * reads like the reason field. It is not: `TestOptions` has no `description`,
 * so the reason was silently discarded and the run reported a bare "skipped".
 *
 * The gates note above explains why `skipLiveTest`'s boolean and the reason are
 * two calls rather than one; this folds them back together at the call site.
 */
export function liveSkipOption(keyEnv?: string): string | false {
  return skipLiveTest(keyEnv) ? liveTestSkipReason(keyEnv) : false;
}
