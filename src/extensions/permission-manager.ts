/**
 * ExtensionPermissionManager — grants / revokes / checks extension
 * permissions. The runtime denies an extension tool call when the
 * extension lacks the required permission.
 *
 * Two layers:
 *   - "permissions" are what the extension *asks* for in
 *     extension.json. They're the contract.
 *   - "grants" are what the runtime *actually allows*. The CLI's
 *     `extensions trust <id>` flips the grant set; the manifest's
 *     `permissions` field is informational.
 */

import type { ExtensionPermission } from "./types.js";

/** Permissions expressed as a string-or-object for flexibility. */
export type ExtensionPermissionLike = ExtensionPermission | { name: ExtensionPermission };

export class ExtensionPermissionManager {
  /** extensionId → set of granted permissions. */
  private readonly grants = new Map<string, Set<ExtensionPermission>>();

  /** Record that an extension may use these permissions. */
  grant(extensionId: string, permissions: ExtensionPermissionLike[]): void {
    if (!extensionId || extensionId.length === 0) return;
    const set = this.grants.get(extensionId) ?? new Set<ExtensionPermission>();
    for (const p of permissions) {
      const name = typeof p === "string" ? p : p.name;
      set.add(name);
    }
    this.grants.set(extensionId, set);
  }

  revoke(extensionId: string, permission: ExtensionPermission): void {
    const set = this.grants.get(extensionId);
    if (!set) return;
    set.delete(permission);
    if (set.size === 0) this.grants.delete(extensionId);
  }

  revokeAll(extensionId: string): void {
    this.grants.delete(extensionId);
  }

  /** Return the set of granted permissions for `extensionId`. */
  list(extensionId: string): ExtensionPermission[] {
    return [...(this.grants.get(extensionId) ?? new Set())];
  }

  /**
   * Check whether `extensionId` is allowed `permission`. Built-in
   * extensions are always allowed (caller's responsibility to mark
   * them as built-in via `grantBuiltIn`).
   */
  check(extensionId: string, permission: ExtensionPermission): boolean {
    if (this.isBuiltIn(extensionId)) return true;
    return this.grants.get(extensionId)?.has(permission) ?? false;
  }

  private builtIns = new Set<string>();
  markBuiltIn(extensionId: string): void {
    this.builtIns.add(extensionId);
  }
  isBuiltIn(extensionId: string): boolean {
    return this.builtIns.has(extensionId);
  }

  /** Test hook. */
  clear(): void {
    this.grants.clear();
    this.builtIns.clear();
  }
}
