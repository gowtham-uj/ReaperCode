/**
 * A new chat has to run on the provider the user configured.
 *
 * It did not. A thread created without an explicit model carried no provider,
 * and the turn path fell through to `buildConfig()`, which hardcodes
 * `anthropic` / `claude-sonnet-4-6`. A user whose only configured provider was
 * DeepInfra watched every fresh chat fail with a 502 about a model they had
 * never picked — the catalog resolved their provider correctly in Settings and
 * the turn never consulted it.
 *
 * The tests below pin the three properties that make falling back safe: it
 * prefers a provider that is actually authenticated, it refuses one this build
 * cannot send to, and it reports "nothing configured" rather than inventing a
 * choice.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProviderCredentialStore } from "../../../../src/config/provider-credentials.js";
import { resolveDefaultSelection } from "../../../../src/model/provider/default-selection.js";

function withStore<T>(fn: (store: ProviderCredentialStore) => T): T {
  const home = mkdtempSync(path.join(tmpdir(), "reaper-default-selection-"));
  try {
    return fn(new ProviderCredentialStore({ home }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("a configured provider becomes the default selection", () => {
  withStore((store) => {
    store.setApi({ providerId: "deepinfra", key: "test-key-not-real" });
    const selected = resolveDefaultSelection(store);
    assert.ok(selected, "a configured provider should resolve to a selection");
    assert.equal(selected.provider, "deepinfra");
    // The model is the catalog's own default, never an invented id.
    assert.equal(selected.model, "zai-org/GLM-5.3-Flash");
  });
});

test("nothing configured yields no selection rather than a guess", () => {
  withStore((store) => {
    assert.equal(
      resolveDefaultSelection(store),
      undefined,
      "with no credentials the caller must keep its own error path",
    );
  });
});

test("an expired OAuth credential is not a default", () => {
  /*
   * `secretFor` withholds an expired access token, which is the same check
   * that stops an expired account becoming an unauthenticated request. The
   * selection must not resurrect it by reading the store directly.
   */
  withStore((store) => {
    store.setOAuth({
      providerId: "github-copilot",
      access: "expired-access",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
    });
    assert.equal(resolveDefaultSelection(store), undefined);
  });
});

test("a provider whose transport is not installed is skipped", () => {
  /*
   * Being connectable is not the same as being runnable. A catalog refresh can
   * advertise a package this build has no loader for, and selecting it would
   * produce exactly the failure this module exists to remove: a turn that
   * resolves, starts, and then dies importing a missing module.
   *
   * The seam is required here, and that is the point of it. Every provider in
   * the shipped snapshot resolves to an installed transport, so a test written
   * against the real catalog cannot reach this branch at all — it would pass
   * on the descriptor lookup and assert nothing about the transport guard.
   * An earlier version of this test did exactly that.
   */
  withStore((store) => {
    store.setApi({ providerId: "deepinfra", key: "test-key-not-real" });
    const selected = resolveDefaultSelection(store, {
      descriptorFor: () => ({ id: "deepinfra", defaultModel: "zai-org/GLM-5.3-Flash", npm: "@future/sdk" }),
      transportInstalled: ({ providerNpm }) => providerNpm === "@ai-sdk/deepinfra",
    });
    assert.equal(
      selected,
      undefined,
      "a provider this build cannot send to must not become the default",
    );
  });
});

test("the transport installed for the provider is the one consulted", () => {
  // The other direction, so the guard cannot pass by always returning false.
  withStore((store) => {
    store.setApi({ providerId: "deepinfra", key: "test-key-not-real" });
    const seen: Array<string | undefined> = [];
    const selected = resolveDefaultSelection(store, {
      descriptorFor: () => ({ id: "deepinfra", defaultModel: "zai-org/GLM-5.3-Flash", npm: "@ai-sdk/deepinfra" }),
      transportInstalled: ({ providerNpm }) => { seen.push(providerNpm); return true; },
    });
    assert.deepEqual(seen, ["@ai-sdk/deepinfra"], "the provider's own package must be the one checked");
    assert.equal(selected?.provider, "deepinfra");
  });
});

test("an unknown provider id is skipped without throwing", () => {
  withStore((store) => {
    store.setApi({ providerId: "invalid-provider-id", key: "nope" });
    assert.equal(resolveDefaultSelection(store), undefined);
  });
});

test("the first configured provider wins, and stays winning", () => {
  /*
   * Credential-file order is append order, so it is stable across restarts.
   * Without that, a user who connected one provider would see the default
   * change as they added another, with no way to predict which one a new chat
   * would use.
   */
  withStore((store) => {
    store.setApi({ providerId: "deepinfra", key: "first-key" });
    store.setApi({ providerId: "groq", key: "second-key" });
    const first = resolveDefaultSelection(store);
    const second = resolveDefaultSelection(store);
    assert.deepEqual(first, second, "the same store must resolve to the same selection");
    assert.equal(first?.provider, "deepinfra");
  });
});
