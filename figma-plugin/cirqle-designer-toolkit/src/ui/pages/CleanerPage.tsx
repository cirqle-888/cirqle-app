import { useCallback, useMemo, useState } from 'react';
import type { Issue, RunScope } from '@shared/types';
import { usePluginMessage } from '@ui/hooks/usePluginMessage';
import { useToolkitStore } from '@ui/state/store';
import { Button } from '@ui/components/common/Button';
import { ProgressBar } from '@ui/components/common/ProgressBar';
import { Table, type Column } from '@ui/components/common/Table';
import { EmptyState } from '@ui/components/common/EmptyState';
import { Icon } from '@ui/components/common/Icon';

// ---------------------------------------------------------------------------
// Wire-shape types mirrored from src/main/modules/cleaner/cleanerScan.ts.
// `Issue`/`RunScope` are genuinely shared (no figma/DOM dependency) so those
// come straight from @shared/types; CleanerMode/CleanerScanResult are
// main-only shapes and are duplicated here on purpose (same pattern as
// RenamePage.tsx / SettingsPage.tsx) since UI code must never import from
// src/main/**.
// ---------------------------------------------------------------------------
type CleanerMode = 'quick' | 'deep';

interface CleanerScanResult {
  issues: Issue[];
  counts: Record<string, number>;
  estimatedSizeImpactKb: number;
  estimatedMemoryScore: number;
}

const SCOPE_OPTIONS: Array<{ key: RunScope['scope']; label: string }> = [
  { key: 'selection', label: 'Selection' },
  { key: 'page', label: 'Page' },
  { key: 'document', label: 'Document' },
];

/** Display order + labels for known ruleIds. Anything unrecognised still
 * renders (falls back to the raw ruleId as its label) so this page never
 * silently drops an issue group if a detector is added later. */
const RULE_ORDER = [
  'hidden-layer',
  'invisible-object',
  'empty-group',
  'empty-frame',
  'empty-section',
  'zero-size',
  'off-canvas',
  'duplicate-image',
  'duplicate-component',
  'duplicate-style',
  'detached-instance',
  'unused-paint-style',
  'unused-text-style',
];

const RULE_LABELS: Record<string, string> = {
  'hidden-layer': 'Hidden layers',
  'invisible-object': 'Invisible objects',
  'empty-group': 'Empty groups',
  'empty-frame': 'Empty frames',
  'empty-section': 'Empty sections',
  'zero-size': 'Zero-size layers',
  'off-canvas': 'Off-canvas layers',
  'duplicate-image': 'Duplicate images',
  'duplicate-component': 'Possible duplicate components',
  'duplicate-style': 'Duplicate styles',
  'detached-instance': 'Detached instances',
  'unused-paint-style': 'Unused paint styles',
  'unused-text-style': 'Unused text styles',
};

function severityBadgeClass(severity: Issue['severity']): string {
  if (severity === 'error') return 'cdt-badge--error';
  if (severity === 'warning') return 'cdt-badge--warning';
  return 'cdt-badge--info';
}

function memoryScoreBadgeClass(score: number): string {
  if (score >= 67) return 'cdt-badge--error';
  if (score >= 34) return 'cdt-badge--warning';
  return 'cdt-badge--success';
}

export function CleanerPage() {
  const { run, loading, progress } = usePluginMessage('cleaner');
  const pushToast = useToolkitStore((s) => s.pushToast);
  const requestConfirm = useToolkitStore((s) => s.requestConfirm);

  const [scope, setScope] = useState<RunScope['scope']>('selection');
  const [mode, setMode] = useState<CleanerMode>('quick');
  const [scanResult, setScanResult] = useState<CleanerScanResult | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const grouped = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const issue of scanResult?.issues ?? []) {
      const list = map.get(issue.ruleId) ?? [];
      list.push(issue);
      map.set(issue.ruleId, list);
    }
    const orderedKeys = [...RULE_ORDER.filter((r) => map.has(r)), ...[...map.keys()].filter((r) => !RULE_ORDER.includes(r))];
    return orderedKeys.map((ruleId) => ({ ruleId, issues: map.get(ruleId) ?? [] }));
  }, [scanResult]);

  const toggleExpanded = (ruleId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  };

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleScan = async () => {
    try {
      const result = await run<CleanerScanResult>('scan', { scope, mode });
      setScanResult(result);
      setSelected(new Set());
      setExpanded(new Set(Object.keys(result.counts)));
      if (result.issues.length === 0) {
        pushToast({ variant: 'success', title: 'No issues found', description: 'This scope looks clean.' });
      }
    } catch (err) {
      pushToast({ variant: 'error', title: 'Scan failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleSelectOne = async (issue: Issue) => {
    if (!issue.node) return;
    try {
      const result = await run<{ selectedCount: number; missing: string[] }>('select', { nodeIds: [issue.node.id] });
      if (result.selectedCount === 0) {
        pushToast({ variant: 'warning', title: 'Could not select layer', description: 'It may have been moved or deleted since the scan.' });
      }
    } catch (err) {
      pushToast({ variant: 'error', title: 'Select failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleIgnoreOne = async (issue: Issue) => {
    if (!issue.node) return;
    try {
      await run('ignore', { nodeId: issue.node.id, ruleId: issue.ruleId });
      setScanResult((prev) => (prev ? { ...prev, issues: prev.issues.filter((i) => i.id !== issue.id) } : prev));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(issue.id);
        return next;
      });
      pushToast({ variant: 'info', title: 'Ignored', description: 'This layer will be skipped by future scans for this rule.' });
    } catch (err) {
      pushToast({ variant: 'error', title: 'Ignore failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const selectedNodeIds = useMemo(() => {
    if (!scanResult) return [];
    const byId = new Map(scanResult.issues.map((i) => [i.id, i] as const));
    const ids: string[] = [];
    for (const issueId of selected) {
      const node = byId.get(issueId)?.node;
      if (node) ids.push(node.id);
    }
    return ids;
  }, [scanResult, selected]);

  const handleDeleteSelected = async () => {
    if (selectedNodeIds.length === 0) return;
    const confirmed = await requestConfirm({
      title: `Delete ${selectedNodeIds.length} layer${selectedNodeIds.length === 1 ? '' : 's'}?`,
      description:
        'This permanently removes the selected layers from the file. The plugin cannot undo a delete (see the Cleaner module notes) — only Figma\'s own Cmd/Ctrl+Z, if used immediately, might.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      const result = await run<{ deletedCount: number; missing: string[] }>('delete', { nodeIds: selectedNodeIds });
      pushToast({ variant: 'success', title: `Deleted ${result.deletedCount} layer${result.deletedCount === 1 ? '' : 's'}` });
      setScanResult((prev) =>
        prev ? { ...prev, issues: prev.issues.filter((i) => !i.node || !selectedNodeIds.includes(i.node.id)) } : prev
      );
      setSelected(new Set());
    } catch (err) {
      pushToast({ variant: 'error', title: 'Delete failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const columnsFor = (): Column<Issue>[] => [
    {
      key: 'issue',
      header: 'Issue',
      render: (i) => (
        <div>
          <div>{i.node?.name ?? i.title}</div>
          {i.node ? <div className="cdt-text-muted">{i.node.type} · {i.node.pageName}</div> : <div className="cdt-text-muted">{i.description}</div>}
        </div>
      ),
    },
    {
      key: 'severity',
      header: 'Severity',
      width: '90px',
      render: (i) => <span className={`cdt-badge ${severityBadgeClass(i.severity)}`}>{i.severity}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: '140px',
      render: (i) => (
        <div className="cdt-row" style={{ gap: 4 }}>
          {i.node ? (
            <Button variant="ghost" onClick={() => handleSelectOne(i)}>
              Select
            </Button>
          ) : null}
          {i.node ? (
            <Button variant="ghost" onClick={() => handleIgnoreOne(i)}>
              Ignore
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  const totalIssues = scanResult?.issues.length ?? 0;

  return (
    <div>
      <div className="cdt-section">
        <div className="cdt-card">
          <div className="cdt-row cdt-row--between">
            <div className="cdt-section__title">Summary</div>
            <Button
              variant="ghost"
              onClick={async () => {
                await run('clearIgnored');
                pushToast({ variant: 'info', title: 'Ignore list cleared', description: 'Run Scan again to see previously-ignored items.' });
              }}
            >
              Clear ignored
            </Button>
          </div>
          {scanResult === null ? (
            <div className="cdt-text-muted">Run a scan to see a summary.</div>
          ) : (
            <div className="cdt-row" style={{ gap: 24, flexWrap: 'wrap' }}>
              <div>
                <div className="cdt-text-muted">Total issues</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{totalIssues}</div>
              </div>
              <div>
                <div className="cdt-text-muted">Estimated size impact</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{scanResult.estimatedSizeImpactKb} KB</div>
              </div>
              <div>
                <div className="cdt-text-muted">Memory score</div>
                <div>
                  <span className={`cdt-badge ${memoryScoreBadgeClass(scanResult.estimatedMemoryScore)}`}>
                    {scanResult.estimatedMemoryScore} / 100
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="cdt-section">
        <div className="cdt-row" style={{ gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div className="cdt-section__title">Mode</div>
            <div className="cdt-row" style={{ gap: 12 }}>
              <label className="cdt-checkbox-row">
                <input type="radio" name="cleaner-mode" checked={mode === 'quick'} onChange={() => setMode('quick')} />
                Quick
              </label>
              <label className="cdt-checkbox-row">
                <input type="radio" name="cleaner-mode" checked={mode === 'deep'} onChange={() => setMode('deep')} />
                Deep
              </label>
            </div>
            {mode === 'deep' ? (
              <div className="cdt-text-muted" style={{ maxWidth: 320 }}>
                Deep mode also checks duplicate images/components/styles, detached instances, and unused styles. For
                meaningful "unused style" results, scan with scope = Document.
              </div>
            ) : null}
          </div>
          <div>
            <div className="cdt-section__title">Scope</div>
            <div className="cdt-row" style={{ gap: 12 }}>
              {SCOPE_OPTIONS.map((opt) => (
                <label key={opt.key} className="cdt-checkbox-row">
                  <input type="radio" name="cleaner-scope" checked={scope === opt.key} onChange={() => setScope(opt.key)} />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="cdt-row" style={{ gap: 8 }}>
          <Button variant="primary" icon="cleaner" onClick={handleScan} loading={loading}>
            Scan
          </Button>
          <Button variant="danger" icon="trash" onClick={handleDeleteSelected} disabled={selectedNodeIds.length === 0 || loading}>
            Delete selected ({selectedNodeIds.length})
          </Button>
        </div>
        {loading ? <ProgressBar progress={progress} /> : null}
      </div>

      <div className="cdt-section">
        {scanResult === null ? (
          <EmptyState icon="cleaner" title="No scan yet" description="Choose a mode and scope, then run Scan to find clutter." />
        ) : grouped.length === 0 ? (
          <EmptyState icon="check" title="Nothing to clean up" description="No issues matched in this scope." />
        ) : (
          grouped.map(({ ruleId, issues }) => {
            const isOpen = expanded.has(ruleId);
            return (
              <div key={ruleId} className="cdt-card" style={{ marginBottom: 12 }}>
                <button
                  type="button"
                  onClick={() => toggleExpanded(ruleId)}
                  className="cdt-row cdt-row--between"
                  style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit' }}
                >
                  <div className="cdt-row" style={{ gap: 8 }}>
                    <Icon name="chevron-right" size={12} style={{ transform: isOpen ? 'rotate(90deg)' : undefined }} />
                    <strong>{RULE_LABELS[ruleId] ?? ruleId}</strong>
                    <span className="cdt-badge cdt-badge--info">{issues.length}</span>
                  </div>
                </button>
                {isOpen ? (
                  <div style={{ marginTop: 8 }}>
                    <Table
                      columns={columnsFor()}
                      rows={issues}
                      selected={selected}
                      onToggleSelect={(id) => {
                        const issue = issues.find((i) => i.id === id);
                        if (issue?.node) toggleSelected(id);
                      }}
                    />
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
