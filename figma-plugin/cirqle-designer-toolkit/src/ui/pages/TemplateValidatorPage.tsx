import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePluginMessage } from '@ui/hooks/usePluginMessage';
import { usePluginEvent } from '@ui/hooks/usePluginEvent';
import { useToolkitStore } from '@ui/state/store';
import { Button, IconButton } from '@ui/components/common/Button';
import { Icon } from '@ui/components/common/Icon';
import { ProgressBar } from '@ui/components/common/ProgressBar';
import { EmptyState } from '@ui/components/common/EmptyState';
import type { Issue, NodeRef } from '@shared/types';

// Mirrors src/main/modules/templateValidator/templateValidatorTypes.ts —
// UI files must never import from src/main/** (different runtime, no
// `figma` there), so cross-boundary types are small and copied, not shared.
interface TemplateRuleLayer {
  name: string;
  required: boolean;
  hint?: string;
}
interface TemplateRule {
  id: string;
  label: string;
  requiredLayers: TemplateRuleLayer[];
}

interface ValidationResult {
  issues: Issue[];
  presentCount: number;
  missingCount: number;
  createdCount?: number;
}

function emptyDraft(): TemplateRule {
  return { id: '', label: '', requiredLayers: [{ name: '', required: true, hint: '' }] };
}

export function TemplateValidatorPage() {
  const { run, loading, progress } = usePluginMessage('templateValidator');
  const pushToast = useToolkitStore((s) => s.pushToast);
  const requestConfirm = useToolkitStore((s) => s.requestConfirm);
  const selectionCount = useToolkitStore((s) => s.selectionCount);

  const [rules, setRules] = useState<TemplateRule[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string>('');
  const [draft, setDraft] = useState<TemplateRule | null>(null);
  const [selectionRoots, setSelectionRoots] = useState<NodeRef[]>([]);
  const [fixTargetId, setFixTargetId] = useState<string>('');
  const [result, setResult] = useState<ValidationResult | null>(null);

  const loadRules = useCallback(async () => {
    const list = await run<TemplateRule[]>('listRules');
    setRules(list);
    if (list.length > 0 && !list.some((r) => r.id === selectedRuleId)) {
      setSelectedRuleId(list[0]!.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  const loadSelectionRoots = useCallback(async () => {
    const roots = await run<NodeRef[]>('getSelectionRoots');
    setSelectionRoots(roots);
    setFixTargetId((current) => (roots.some((r) => r.id === current) ? current : roots[0]?.id ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  useEffect(() => {
    loadRules().catch(() => pushToast({ variant: 'error', title: 'Could not load rule sets' }));
    loadSelectionRoots().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePluginEvent('system', 'selectionchange', () => {
    loadSelectionRoots().catch(() => undefined);
    setResult(null);
  });

  const selectedRule = useMemo(() => rules.find((r) => r.id === selectedRuleId) ?? null, [rules, selectedRuleId]);

  const startNewRule = () => {
    setDraft(emptyDraft());
  };

  const startEditRule = () => {
    if (!selectedRule) return;
    setDraft(JSON.parse(JSON.stringify(selectedRule)) as TemplateRule);
  };

  const cancelEdit = () => setDraft(null);

  const updateDraftLayer = (index: number, patch: Partial<TemplateRuleLayer>) => {
    setDraft((d) => {
      if (!d) return d;
      const requiredLayers = d.requiredLayers.map((l, i) => (i === index ? { ...l, ...patch } : l));
      return { ...d, requiredLayers };
    });
  };

  const addDraftLayer = () => {
    setDraft((d) => (d ? { ...d, requiredLayers: [...d.requiredLayers, { name: '', required: true, hint: '' }] } : d));
  };

  const removeDraftLayer = (index: number) => {
    setDraft((d) => (d ? { ...d, requiredLayers: d.requiredLayers.filter((_, i) => i !== index) } : d));
  };

  const saveDraft = async () => {
    if (!draft) return;
    if (draft.label.trim() === '') {
      pushToast({ variant: 'error', title: 'Give this rule set a name first' });
      return;
    }
    const cleanedLayers = draft.requiredLayers
      .map((l) => ({ ...l, name: l.name.trim().replace(/^#/, '') }))
      .filter((l) => l.name !== '');
    if (cleanedLayers.length === 0) {
      pushToast({ variant: 'error', title: 'Add at least one required layer' });
      return;
    }
    try {
      const { rule, rules: nextRules } = await run<{ rule: TemplateRule; rules: TemplateRule[] }>('saveRule', {
        ...draft,
        requiredLayers: cleanedLayers,
      });
      setRules(nextRules);
      setSelectedRuleId(rule.id);
      setDraft(null);
      setResult(null);
      pushToast({ variant: 'success', title: `Saved "${rule.label}"` });
    } catch (err) {
      pushToast({ variant: 'error', title: 'Could not save rule set', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const deleteRule = async () => {
    if (!selectedRule) return;
    const confirmed = await requestConfirm({
      title: `Delete "${selectedRule.label}"?`,
      description: 'This only removes the saved rule set — it does not change any layers in your file.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    const { rules: nextRules } = await run<{ rules: TemplateRule[] }>('deleteRule', { id: selectedRule.id });
    setRules(nextRules);
    setSelectedRuleId(nextRules[0]?.id ?? '');
    setResult(null);
    pushToast({ variant: 'success', title: 'Rule set deleted' });
  };

  const validate = async () => {
    if (!selectedRule) return;
    try {
      const res = await run<ValidationResult>('validate', { scope: 'selection', ruleId: selectedRule.id });
      setResult(res);
    } catch (err) {
      pushToast({ variant: 'error', title: 'Validation failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const autoFix = async () => {
    if (!selectedRule || !fixTargetId) return;
    const confirmed = await requestConfirm({
      title: 'Auto-fix missing layers?',
      description: 'This creates a new placeholder layer for every missing required layer, directly inside the selected frame/component. It edits your file.',
      confirmLabel: 'Create placeholders',
    });
    if (!confirmed) return;
    try {
      const res = await run<ValidationResult>('autoFix', { nodeId: fixTargetId, ruleId: selectedRule.id });
      setResult(res);
      pushToast({ variant: 'success', title: `Created ${res.createdCount ?? 0} placeholder layer(s)` });
    } catch (err) {
      pushToast({ variant: 'error', title: 'Auto-fix failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const missingTokens = useMemo(() => new Set((result?.issues ?? []).map((i) => (i.meta as { token?: string } | undefined)?.token)), [result]);

  return (
    <div>
      <ProgressBar progress={progress} />

      <div className="cdt-section">
        <div className="cdt-section__title">Rule set</div>
        <div className="cdt-row">
          <select
            className="cdt-select"
            style={{ flex: 1 }}
            value={selectedRuleId}
            onChange={(e) => {
              setSelectedRuleId(e.target.value);
              setResult(null);
            }}
          >
            {rules.length === 0 && <option value="">No rule sets yet</option>}
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label} ({r.requiredLayers.filter((l) => l.required).length} required)
              </option>
            ))}
          </select>
          <Button icon="plus" onClick={startNewRule}>New rule set</Button>
        </div>
        {selectedRule && (
          <div className="cdt-row">
            <Button variant="ghost" onClick={startEditRule}>Edit rule set</Button>
            <Button variant="ghost" icon="trash" onClick={deleteRule}>Delete</Button>
          </div>
        )}
      </div>

      {draft && (
        <div className="cdt-section">
          <div className="cdt-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="cdt-field">
              <label htmlFor="rule-label">Rule set name</label>
              <input
                id="rule-label"
                className="cdt-input"
                value={draft.label}
                onChange={(e) => setDraft((d) => (d ? { ...d, label: e.target.value } : d))}
                placeholder="e.g. Retail Offer Card"
              />
            </div>

            <div className="cdt-field">
              <label>Required layers (#name)</label>
              {draft.requiredLayers.map((layer, i) => (
                <div key={i} className="cdt-row" style={{ marginBottom: 6 }}>
                  <input
                    className="cdt-input"
                    style={{ width: 100 }}
                    value={layer.name}
                    onChange={(e) => updateDraftLayer(i, { name: e.target.value })}
                    placeholder="product"
                  />
                  <label className="cdt-checkbox-row" style={{ flexShrink: 0 }}>
                    <input type="checkbox" checked={layer.required} onChange={(e) => updateDraftLayer(i, { required: e.target.checked })} />
                    Required
                  </label>
                  <input
                    className="cdt-input"
                    style={{ flex: 1 }}
                    value={layer.hint ?? ''}
                    onChange={(e) => updateDraftLayer(i, { hint: e.target.value })}
                    placeholder="Optional hint"
                  />
                  <IconButton icon="trash" label="Remove layer" onClick={() => removeDraftLayer(i)} />
                </div>
              ))}
              <Button variant="ghost" icon="plus" onClick={addDraftLayer}>Add layer</Button>
            </div>

            <div className="cdt-row">
              <Button variant="primary" onClick={saveDraft} loading={loading}>Save rule set</Button>
              <Button variant="ghost" onClick={cancelEdit}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {!draft && selectedRule && (
        <>
          <div className="cdt-section">
            <div className="cdt-row cdt-row--between">
              <div className="cdt-section__title">Validate selection</div>
              <span className="cdt-text-muted">{selectionCount} layer{selectionCount === 1 ? '' : 's'} selected</span>
            </div>
            <div className="cdt-text-muted">
              Select the template frame(s)/component(s) to check, then validate. Template Validator only makes sense against a specific
              template root — not a whole page or document.
            </div>
            <Button variant="primary" icon="play" onClick={validate} loading={loading} disabled={selectionCount === 0}>
              Validate selection
            </Button>
          </div>

          {result && (
            <div className="cdt-section">
              <div className="cdt-row">
                <span className="cdt-badge cdt-badge--success">{result.presentCount} present</span>
                <span className="cdt-badge cdt-badge--error">{result.missingCount} missing</span>
              </div>
              <div className="cdt-table-wrap">
                <table className="cdt-table">
                  <thead>
                    <tr>
                      <th style={{ width: 24 }} />
                      <th>Layer</th>
                      <th>Status</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRule.requiredLayers.map((layer) => {
                      const missing = missingTokens.has(layer.name);
                      const issue = result.issues.find((i) => (i.meta as { token?: string } | undefined)?.token === layer.name);
                      return (
                        <tr key={layer.name}>
                          <td>
                            <Icon name={missing ? 'error' : 'check'} size={14} style={{ color: missing ? 'var(--cdt-text-danger)' : 'var(--cdt-text-success)' }} />
                          </td>
                          <td>#{layer.name}{layer.required ? '' : ' (optional)'}</td>
                          <td>{missing ? (layer.required ? 'Missing' : 'Missing (optional)') : 'Present'}</td>
                          <td className="cdt-text-muted">{missing ? issue?.description : layer.hint ?? ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {result.missingCount > 0 && (
                <div className="cdt-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div className="cdt-section__title">Auto-fix missing layers</div>
                  {selectionRoots.length > 1 && (
                    <div className="cdt-field">
                      <label htmlFor="fix-target">Create placeholders inside</label>
                      <select id="fix-target" className="cdt-select" value={fixTargetId} onChange={(e) => setFixTargetId(e.target.value)}>
                        {selectionRoots.map((r) => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {selectionRoots.length === 0 ? (
                    <div className="cdt-text-muted">Select a frame or component to auto-fix into.</div>
                  ) : (
                    <Button variant="danger" icon="refresh" onClick={autoFix} loading={loading}>
                      Create placeholder layers
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {!draft && rules.length === 0 && (
        <EmptyState icon="validator" title="No rule sets yet" description="Create a rule set to define which #layer names a template family requires." />
      )}
    </div>
  );
}
