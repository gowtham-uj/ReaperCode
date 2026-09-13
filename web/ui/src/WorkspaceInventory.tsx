import { useEffect, useState } from "react";
import type { JsonRpcClient } from "@reaper/web-shared";
import type { ExtensionEntry, SettingsStore, SkillEntry } from "./settings.js";

export function WorkspaceInventory({ store, client }: { store: SettingsStore; client: JsonRpcClient | undefined }) {
  const [filter, setFilter] = useState("");
  useEffect(() => {
    if (!client) return;
    const value = filter.trim();
    const handle = window.setTimeout(() => {
      void store.refreshSkills(client, value || undefined);
      void store.refreshExtensions(client, value || undefined);
    }, value ? 250 : 0);
    return () => window.clearTimeout(handle);
  }, [client, filter, store.refreshExtensions, store.refreshSkills]);

  return (
    <section className="settings-section">
      <div className="settings-section-heading"><div><h2>Capabilities</h2><p>Built-in, user, project, and extension skills. Type <code className="inline-code">/&lt;name&gt;</code> at the start of a message to load one into that turn; the model can also load any skill with the activate_skill tool. This inventory is read-only and does not activate code.</p></div></div>
      <label className="sr-only" htmlFor="inventory-filter">Filter skills and extensions</label>
      <input id="inventory-filter" className="settings-search" type="search" placeholder="Filter by name…" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} />
      <h3 className="inventory-heading">Skills <span>{store.skills.length}</span></h3>
      {store.skillErrors.length > 0 && <p className="field-error" role="alert">{store.skillErrors.length} skill(s) could not be read: {store.skillErrors.map((entry) => entry.path).join(", ")}</p>}
      {store.skills.length > 0 ? <ul className="inventory-list">{store.skills.map((skill) => <SkillRow skill={skill} key={`${skill.scope}:${skill.name}`} />)}</ul> : <p className="empty">No installed skills match.</p>}
      <h3 className="inventory-heading">Extensions <span>{store.extensions.length}</span></h3>
      {store.extensionErrors.length > 0 && <p className="field-error" role="alert">{store.extensionErrors.length} extension(s) could not be read: {store.extensionErrors.map((entry) => entry.path).join(", ")}</p>}
      {store.extensions.length > 0 ? <ul className="inventory-list">{store.extensions.map((extension) => <ExtensionRow extension={extension} key={extension.id} />)}</ul> : <p className="empty">No extensions match.</p>}
    </section>
  );
}

function SkillRow({ skill }: { skill: SkillEntry }) {
  return (
    <li className="inventory-row" data-disabled={skill.disabled || undefined}>
      <div className="inventory-row-head"><span className="inventory-name">{skill.name}</span><span className="trust-badge" data-trust={skill.trust}>{skill.trust}</span>{skill.disabled && <span className="status-badge" data-status="disabled">disabled</span>}{skill.validated && <span className="status-badge" data-status="enabled">validated</span>}</div>
      <p className="inventory-description">{skill.description}</p>
      <div className="inventory-meta"><span>{skill.scope}</span><span>{skill.category}</span>{skill.extensionId && <span>from {skill.extensionId}</span>}{skill.disabledReason && <span>{skill.disabledReason}</span>}</div>
    </li>
  );
}

function ExtensionRow({ extension }: { extension: ExtensionEntry }) {
  return (
    <li className="inventory-row" data-disabled={extension.status === "disabled" || undefined}>
      <div className="inventory-row-head"><span className="inventory-name">{extension.id}</span><span className="inventory-version">v{extension.version}</span><span className="trust-badge" data-trust={extension.trust}>{extension.trust}</span><span className="status-badge" data-status={extension.status}>{extension.status}</span></div>
      <p className="inventory-description">{extension.description}</p>
      {extension.permissions.length > 0 && <div className="inventory-meta"><span>requests: {extension.permissions.join(", ")}</span></div>}
      {extension.error && <p className="field-error" role="alert">{extension.error}</p>}
    </li>
  );
}
