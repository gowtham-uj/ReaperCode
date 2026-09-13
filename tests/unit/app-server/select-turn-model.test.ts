/**
 * Which model a browser turn runs on.
 *
 * This is the precedence rule that was missing, and its absence was visible to
 * the user as a broken product: every new chat failed with a 502 about
 * `claude-sonnet-4-6` — a model they had never chosen — because a thread with
 * no provider fell through to `buildConfig`, which hardcodes Anthropic. The
 * provider catalog was correct the whole time; the turn simply never asked it.
 *
 * The two directions are opposite failure modes, so both are pinned:
 * a thread that named a model must keep it, and a thread that named none must
 * inherit the user's configured provider rather than a hardcoded one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { selectTurnModel } from "../../../src/app-server/managed-turn-runner.js";
import { ProviderCredentialStore } from "../../../src/config/provider-credentials.js";

function withStore<T>(fn: (store: ProviderCredentialStore) => T): T {
  const home = mkdtempSync(path.join(tmpdir(), "reaper-turn-model-"));
  try {
    return fn(new ProviderCredentialStore({ home }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("a thread with no provider uses the provider the user configured", () => {
  withStore((store) => {
    store.setApi({ providerId: "deepinfra", key: "test-key-not-real" });
    const selected = selectTurnModel({}, store);
    assert.equal(
      selected?.provider,
      "deepinfra",
      "an undecided thread must not run on the hardcoded anthropic default",
    );
    assert.equal(selected?.model, "zai-org/GLM-5.3-Flash");
  });
});

test("a thread pinned to a provider keeps it", () => {
  withStore((store) => {
    // A different provider is configured; the thread's own choice must win.
    store.setApi({ providerId: "deepinfra", key: "test-key-not-real" });
    const selected = selectTurnModel({ provider: "groq", model: "llama-3.1-8b-instant" }, store);
    assert.deepEqual(selected, { provider: "groq", model: "llama-3.1-8b-instant" });
  });
});

test("a pinned provider without a model defers to that provider's default", () => {
  /*
   * The model is left `undefined` rather than filled in here: `buildConfigFor-
   * Provider` resolves the catalog default for the provider it was given, and
   * duplicating that lookup would create a second place for it to disagree.
   */
  withStore((store) => {
    const selected = selectTurnModel({ provider: "deepinfra" }, store);
    assert.deepEqual(selected, { provider: "deepinfra" });
  });
});

test("nothing configured and nothing pinned yields no selection", () => {
  // The caller keeps its own error path, which names the missing credential.
  withStore((store) => {
    assert.equal(selectTurnModel({}, store), undefined);
  });
});
