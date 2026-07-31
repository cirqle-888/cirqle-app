import { useEffect, useMemo, useState } from 'react';
import type { Issue, RunScope } from '@shared/types';
import { usePluginMessage } from '@ui/hooks/usePluginMessage';
import { useToolkitStore } from '@ui/state/store';
import { Button } from '@ui/components/common/Button';
import { ProgressBar } from '@ui/components/common/ProgressBar';
import { Table, type Column } from '@ui/components/common/Table';
import { EmptyState } from '@ui/components/common/EmptyState';

// Mirrors src/main/modules/componentManager's result/meta shapes. Duplicated
// on purpose — UI files must never import from src/main/** (different
// runtime, no `figma` global there).
interface UnusedComponentMeta {
  isVariantSet: boolean;
  variantCount?: number;
}
interface DuplicateComponentMeta {
  nodeIds: string[];
  fingerprint: string;
}
interface ComponentScanResult {
  detached: Issue[];
  unused: Issue<UnusedComponentMeta>[];
  duplicates: Issue<DuplicateComponentMeta>[];
}
interface LocalComponentSummary {
  id: string;
  name: string;
  key: string;
}
interface BulkOpResult {
  affected: string[];
  failed: { id: string; reason: string }[];
}

interface DetachedRow {
  id: string; // node id — used both as the React key and the swap/relink payload
  issue: Issue;
}

const SCOPES: RunScope['scope'][] = ['selection', 'page', 'document'];

export function ComponentManagerPage() {
  const { run, loading, progress } = usePluginMessage('componentManager');
  const pushToast = useToolkitStore((s) => s.pushToast);
  const requestConfirm = useToolkitStore((s) => s.requestConfirm);

  const [scope, setScope] = useState<RunScope['scope']>('selection');
  const [results, setResults] = useState<ComponentScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetComponentId, setTargetComponentId] = useState('');
  const [localComponents, setLocalComponents] = useState<LocalComponentSummary[]>([]);
  const [variantProperty, setVariantProperty] = useState('');
  const [variantValue, setVariantValue] = useState('');

  useEffect(() => {
    run<LocalComponentSummary[]>('listLocalComponents')
      .then(setLocalComponents)
      .catch(() => undefined); // optional convenience — text-input fallback still works
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scan = async () => {
    try {
      const result = await run<ComponentScanResult>('scan', { scope });
      setResults(result);
      setSelected(new Set());
    } catch (err) {
      pushToast({ variant: 'error', title: 'Scan failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const detachedRows: DetachedRow[] = useMemo(
    () => (results?.detached ?? []).filter((i) => i.node).map((i) => ({ id: i.node!.id, issue: i })),
    [results]
  );

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const doSwap = async () => {
    if (selected.size === 0 || !targetComponentId.trim()) return;
    const confirmed = await requestConfirm({
      title: 'Swap instances?',
      description: `${selected.size} instance(s) will be repointed to component "${targetComponentId.trim()}".`,
      confirmLabel: 'Swap',
    });
    if (!confirmed) return;
    try {
      const result = await run<{ ok: boolean; data: BulkOpResult }>('swapInstances', {
        instanceIds: [...selected],
        targetComponentId: targetComponentId.trim(),
      });
      pushToast({
        variant: result.data.failed.length === 0 ? 'success' : 'warning',
        title: `Swapped ${result.data.affected.length} instance(s)`,
        description: result.data.failed.length ? `${result.data.failed.length} failed — see Settings → History for details.` : undefined,
      });
      setSelected(new Set());
      await scan();
    } catch (err) {
      pushToast({ variant: 'error', title: 'Swap failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const doBulkVariant = async () => {
    if (selected.size === 0 || !variantProperty.trim()) return;
    try {
      const result = await run<{ ok: boolean; data: BulkOpResult }>('bulkUpdateVariant', {
        instanceIds: [...selected],
        property: variantProperty.trim(),
        value: variantValue,
      });
      pushToast({
        variant: result.data.failed.length === 0 ? 'success' : 'warning',
        title: `Updated ${result.data.affected.length} instance(s)`,
        description: result.data.failed.length
          ? `${result.data.failed.length} failed — not every selected instance belongs to a variant set with this property.`
          : undefined,
      });
    } catch (err) {
      pushToast({ variant: 'error', title: 'Bulk update failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const detachedColumns: Column<DetachedRow>[] = [
    { key: 'name', header: 'Name', render: (r) => r.issue.node?.name ?? '—' },
    { key: 'type', header: 'Type', width: '80px', render: (r) => r.issue.node?.type ?? '—' },
    { key: 'page', header: 'Page', width: '100px', render: (r) => r.issue.node?.pageName ?? '—' },
    { key: 'issue', header: 'Issue', render: (r) => r.issue.description },
  ];

  const unusedColumns: Column<Issue<UnusedComponentMeta>>[] = [
    { key: 'name', header: 'Name', render: (r) => r.node?.name ?? '—' },
    {
      key: 'kind',
      header: 'Kind',
      width: '130px',
      render: (r) => (r.meta?.isVariantSet ? `Component set (${r.meta.variantCount ?? '?'} variants)` : 'Component'),
    },
    { key: 'issue', header: 'Issue', render: (r) => r.description },
    {
      key: 'action',
      header: '',
      width: '110px',
      render: (r) => (
        <Button variant="ghost" onClick={() => r.node && setTargetComponentId(r.node.id)}>
          Use as target
        </Button>
      ),
    },
  ];

  const duplicateColumns: Column<Issue<DuplicateComponentMeta>>[] = [
    { key: 'title', header: 'Group', render: (r) => r.title },
    { key: 'count', header: 'Members', width: '70px', render: (r) => r.meta?.nodeIds.length ?? 0 },
    { key: 'desc', header: 'Details', render: (r) => r.description },
  ];

  return (
    <div>
      <div className="cdt-section">
        <div className="cdt-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="cdt-row cdt-row--between">
            <div className="cdt-field" style={{ flex: 1 }}>
              <label htmlFor="scope">Scope</label>
              <select id="scope" className="cdt-select" value={scope} onChange={(e) => setScope(e.target.value as RunScope['scope'])}>
                {SCOPES.map((s) => (
                  <option key={s} value={s}>
                    {s[0]!.toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <Button variant="primary" icon="play" loading={loading} onClick={scan}>
              Scan
            </Button>
          </div>
          <ProgressBar progress={progress} />
        </div>
      </div>

      {!results ? (
        <EmptyState
          icon="components"
          title="No scan yet"
          description="Pick a scope and hit Scan to find detached/broken instances, unused components and duplicate candidates."
        />
      ) : (
        <>
          <div className="cdt-section">
            <div className="cdt-section__title">Detached / broken instances ({detachedRows.length})</div>
            <Table<DetachedRow>
              columns={detachedColumns}
              rows={detachedRows}
              selected={selected}
              onToggleSelect={toggleSelected}
              emptyMessage="No detached or broken instances found."
            />
          </div>

          <div className="cdt-section">
            <div className="cdt-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="cdt-section__title">Swap selected instances ({selected.size} selected)</div>
              <span className="cdt-text-muted">
                Selection is driven by the Detached / broken table above (that's the set of instance ids this page has to
                work with).
              </span>
              <div className="cdt-row">
                <div className="cdt-field" style={{ flex: 1 }}>
                  <label htmlFor="target">Target component id or key</label>
                  <input
                    id="target"
                    className="cdt-input"
                    placeholder="Paste a component id, or pick one below"
                    value={targetComponentId}
                    onChange={(e) => setTargetComponentId(e.target.value)}
                  />
                </div>
                <Button variant="primary" disabled={selected.size === 0 || !targetComponentId.trim()} onClick={doSwap}>
                  Swap selected →
                </Button>
              </div>
              {localComponents.length > 0 && (
                <div className="cdt-field">
                  <label htmlFor="local-components">Or pick a local component</label>
                  <select
                    id="local-components"
                    className="cdt-select"
                    value=""
                    onChange={(e) => e.target.value && setTargetComponentId(e.target.value)}
                  >
                    <option value="">Select a local component…</option>
                    {localComponents.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="cdt-section__title" style={{ marginTop: 8 }}>
                Bulk variant property update
              </div>
              <div className="cdt-row">
                <div className="cdt-field">
                  <label htmlFor="prop">Property</label>
                  <input
                    id="prop"
                    className="cdt-input"
                    placeholder="e.g. State"
                    value={variantProperty}
                    onChange={(e) => setVariantProperty(e.target.value)}
                  />
                </div>
                <div className="cdt-field">
                  <label htmlFor="val">Value</label>
                  <input id="val" className="cdt-input" placeholder="e.g. Hover" value={variantValue} onChange={(e) => setVariantValue(e.target.value)} />
                </div>
                <Button disabled={selected.size === 0 || !variantProperty.trim()} onClick={doBulkVariant}>
                  Apply
                </Button>
              </div>
              <span className="cdt-text-muted">
                Not every selected instance will belong to a variant set with this property — failures are reported
                per-instance, not all-or-nothing.
              </span>
            </div>
          </div>

          <div className="cdt-section">
            <div className="cdt-section__title">Unused components ({results.unused.length})</div>
            <Table columns={unusedColumns} rows={results.unused} emptyMessage="No unused components found." />
          </div>

          <div className="cdt-section">
            <div className="cdt-section__title">Duplicate candidates ({results.duplicates.length})</div>
            <div className="cdt-text-muted" style={{ marginBottom: 4 }}>
              Heuristic only (name + rounded size + child count) — not byte-identical detection. Review before merging.
            </div>
            <Table columns={duplicateColumns} rows={results.duplicates} emptyMessage="No duplicate candidates found." />
          </div>
        </>
      )}
    </div>
  );
}
