import { useEffect, useState } from "react";
import type { JsonRpcClient } from "@reaper/web-shared";
import type { PolicyRule, SettingsStore } from "./settings.js";

export function PolicyEditor({ store, client }: { store: SettingsStore; client: JsonRpcClient | undefined }) {
  const [draft, setDraft] = useState<PolicyRule[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (!dirty) setDraft(store.policyRules.map((rule) => ({ ...rule })));
  }, [store.policyRules, dirty]);

  const mutate = (next: PolicyRule[]): void => { setDraft(next); setDirty(true); setFailure(undefined); };
  const update = (index: number, patch: Partial<PolicyRule>): void => mutate(draft.map((rule, at) => at === index ? { ...rule, ...patch } : rule));
  const move = (index: number, delta: number): void => {
    const next = [...draft];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    mutate(next);
  };
  const save = async (): Promise<void> => {
    if (!client) return;
    setBusy(true); setFailure(undefined);
    try { await store.savePolicy(client, draft.filter((rule) => rule.pattern.trim())); setDirty(false); }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : "Could not save the policy rules"); }
    finally { setBusy(false); }
  };
  const revert = (): void => { setDraft(store.policyRules.map((rule) => ({ ...rule }))); setDirty(false); setFailure(undefined); };

  return (
    <section className="settings-section">
      <div className="settings-section-heading"><div><h2>Command policy</h2><p>Ordered regular-expression rules enforced in every permission mode. The first matching rule wins.</p></div></div>
      {!store.policyFileExists && <p className="settings-note">No <code>rules.local.md</code> exists yet. Saving creates it.</p>}
      <ol className="policy-editor">
        {draft.map((rule, index) => (
          <li className="policy-rule" data-outcome={rule.outcome} key={index}>
            <span className="policy-order">{index + 1}</span>
            <label className="sr-only" htmlFor={`policy-outcome-${index}`}>Rule {index + 1} outcome</label>
            <select id={`policy-outcome-${index}`} className="policy-rule-outcome" value={rule.outcome} disabled={busy} onChange={(event) => update(index, { outcome: event.currentTarget.value as PolicyRule["outcome"] })}>
              <option value="allow">✓ allow</option><option value="deny">✕ deny</option>
            </select>
            <label className="sr-only" htmlFor={`policy-pattern-${index}`}>Rule {index + 1} pattern</label>
            <input id={`policy-pattern-${index}`} className="policy-rule-pattern" value={rule.pattern} spellCheck={false} autoComplete="off" placeholder="^rm\\s+-rf\\s+/" disabled={busy} onChange={(event) => update(index, { pattern: event.currentTarget.value })} />
            <span className="policy-rule-actions">
              <button className="icon-button" aria-label={`Move rule ${index + 1} earlier`} disabled={busy || index === 0} onClick={() => move(index, -1)}>↑</button>
              <button className="icon-button" aria-label={`Move rule ${index + 1} later`} disabled={busy || index === draft.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button className="button" data-variant="ghost" disabled={busy} onClick={() => mutate(draft.filter((_, at) => at !== index))}>Remove</button>
            </span>
          </li>
        ))}
      </ol>
      {draft.length === 0 && <p className="empty">No local command rules.</p>}
      <div className="form-actions">
        <button className="button" data-variant="outline" disabled={busy} onClick={() => mutate([...draft, { outcome: "deny", pattern: "" }])}>Add rule</button>
        <button className="button" data-variant="primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save rules"}</button>
        {dirty && <><button className="button" data-variant="ghost" disabled={busy} onClick={revert}>Discard</button><span className="unsaved-state">Unsaved changes</span></>}
      </div>
      {failure && <p className="field-error" role="alert">{failure}</p>}
    </section>
  );
}
