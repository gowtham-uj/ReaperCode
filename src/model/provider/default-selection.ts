/**
 * Which provider and model a turn runs on when nothing more specific names one.
 *
 * There are three places a selection can come from, and before this module
 * only the first two existed:
 *
 *   1. the thread's own metadata, set by the model picker;
 *   2. `~/.reaper/settings.json`, the user-global default;
 *   3. **the credentials the user actually configured.**
 *
 * The third is what this module supplies, and its absence was a real failure
 * rather than a missing nicety. A fresh thread carries no provider, so the
 * turn path fell through to `buildConfig()`, which hardcodes `anthropic` and
 * `claude-sonnet-4-6` and demands `ANTHROPIC_AUTH_TOKEN`. A user whose only
 * configured provider was DeepInfra watched every new chat fail with a 502
 * about a model they had never selected — the catalog resolved their provider
 * correctly in Settings and then the turn never consulted it.
 *
 * The rule is deliberately narrow, because quietly inventing a model is only
 * defensible when the alternative is a guaranteed failure:
 *
 *   - only providers with a usable credential are considered, and an expired
 *     OAuth token does not count — `secretFor` withholds it, which is exactly
 *     the check that keeps an expired account from becoming an unauthenticated
 *     request;
 *   - only providers this build actually ships a transport for are considered,
 *     so the choice is one that can run rather than one that merely exists;
 *   - the model is the provider's catalog default, never an invented id.
 *
 * Credential-file order breaks ties. It is append order, so it is stable
 * across restarts, and it means the provider a user connected first keeps
 * winning rather than the choice changing as they add more.
 */

import type { ProviderCredentialStore } from "../../config/provider-credentials.js";
import { findProviderDescriptor } from "./catalog.js";
import { isTransportInstalled } from "./transports.js";

export interface DefaultSelection {
  provider: string;
  model: string;
}

/**
 * Test seams.
 *
 * The transport guard below exists for catalogs that advertise a package this
 * build has no loader for — a real state after a refresh, and one the shipped
 * snapshot cannot reproduce, since every provider in it resolves. Without a
 * way to present such a catalog the guard would be untestable, and an
 * untestable guard is one that quietly stops working. Production callers pass
 * nothing and get the real lookup and the real check.
 */
export interface DefaultSelectionDeps {
  descriptorFor(id: string): { id: string; defaultModel?: string; npm?: string } | undefined;
  transportInstalled(input: { providerNpm?: string | undefined }): boolean;
}

/**
 * The provider and model to use when neither the thread nor the user's
 * settings name one, or `undefined` when the user has configured nothing that
 * this build can send to.
 *
 * Returning `undefined` rather than guessing is the point: the caller keeps
 * its existing error path, which names the missing credential, instead of
 * getting a selection that fails later and less legibly.
 */
export function resolveDefaultSelection(
  credentials: Pick<ProviderCredentialStore, "list" | "secretFor">,
  deps: DefaultSelectionDeps = {
    descriptorFor: (id) => findProviderDescriptor(id),
    transportInstalled: (input) => isTransportInstalled(input),
  },
  /**
   * Providers the user switched off. The picker withholds them, and this must
   * agree or the composer would label the thread with a model the user cannot
   * choose and did not ask for — a disabled provider showing up as the fallback
   * is the switch appearing not to work. It is a skip, not an error: with every
   * provider disabled the result is `undefined`, the same as having configured
   * none, which is the honest thing to report.
   */
  disabledProviders: readonly string[] = [],
): DefaultSelection | undefined {
  const disabled = disabledProviders.length > 0 ? new Set(disabledProviders) : undefined;
  for (const credential of credentials.list()) {
    if (disabled?.has(credential.providerId)) continue;
    if (!credentials.secretFor(credential.providerId)) continue;
    const descriptor = deps.descriptorFor(credential.providerId);
    if (!descriptor?.defaultModel) continue;
    if (!deps.transportInstalled({ providerNpm: descriptor.npm })) continue;
    return { provider: descriptor.id, model: descriptor.defaultModel };
  }
  return undefined;
}
