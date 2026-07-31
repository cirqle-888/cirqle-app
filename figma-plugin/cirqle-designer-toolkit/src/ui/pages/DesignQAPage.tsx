import { useMemo, useState } from 'react';
import { usePluginMessage } from '@ui/hooks/usePluginMessage';
import { useToolkitStore } from '@ui/state/store';
import { Button } from '@ui/components/common/Button';
import { Icon } from '@ui/components/common/Icon';
import { ProgressBar } from '@ui/components/common/ProgressBar';
import { EmptyState } from '@ui/components/common/EmptyState';
import type { Issue, RunScope, Severity } from '@shared/types';

// Mirrors src/main/modules/designQA/qaEngine.ts's DesignQAResult — UI files
// must never import from src/main/** (different runtime, no `figma`
// there), so cross-boundary types are small and copied, not shared.
interface DesignQAResult {
  scope: RunScope['scope'];
  scannedAt: number;
  issues: Issue[];
  summary: Record<string, number>;
}

const RULE_LABELS: Record<string, string> = {
  'missing-constraints': 'Missing constraints',
  'missing-auto-layout': 'Could use auto layout',
  'inconsistent-spacing': 'Inconsistent spacing',
  'inconsistent-radius': 'Inconsistent corner radius',
  'inconsistent-shadow': 'Inconsistent shadow',
  'inconsistent-typography': 'Inconsistent typography',
  'duplicate-text-style': 'Duplicate text styles',
  'missing-variable-binding': 'Missing variable binding',
};

const SEVERITY_ICON: Record<Severity, 'error' | 'warning' | 'info'> = { error: 'error', warning: 'warning', info: 'info' };
const ROWS_SHOWN_PER_GROUP = 8;

function groupIssues(issues: Issue[]): Array<{ ruleId: string; issues: Issue[] }> {
  const map = new Map<string, Issue[]>();
  for (const issue of issues) {
    const list = map.get(issue.ruleId) ?? [];
    list.push(issue);
    map.set(issue.ruleId, list);
  }
  return [...map.entries()]
    .map(([ruleId, list]) => ({ ruleId, issues: list }))
    .sort((a, b) => b.issues.length - a.issues.length);
}

function downloadJson(json: string, filename: string) {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function DesignQAPage() {
  const { run, loading, progress } = usePluginMessage('designQA');
  const pushToast = useToolkitStore((s) => s.pushToast);
  const [scope, setScope] = useState<RunScope['scope']>('page');
  const [result, setResult] = useState<DesignQAResult | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const groups = useMemo(() => (result ? groupIssues(result.issues) : []), [result]);

  const runScan = async () => {
    try {
      const res = await run<DesignQAResult>('scan', { scope });
      setResult(res);
      setExpanded(new Set());
    } catch (err) {
      pushToast({ variant: 'error', title: 'Design QA scan failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const exportReport = async () => {
    try {
      const json = await run<string>('exportJson');
      downloadJson(json, `cirqle-design-qa-${new Date().toISOString().slice(0, 10)}.json`);
      pushToast({ variant: 'success', title: 'Report downloaded' });
    } catch (err) {
      pushToast({ variant: 'error', title: 'Could not export report', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const toggle = (ruleId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  };

  return (
    <div>
      <ProgressBar progress={progress} />

      <div className="cdt-section">
        <div className="cdt-section__title">Scope</div>
        <div className="cdt-row">
          {(['selection', 'page', 'document'] as const).map((s) => (
            <Button key={s} variant={scope === s ? 'primary' : 'secondary'} onClick={() => setScope(s)}>
              {s[0]!.toUpperCase() + s.slice(1)}
            </Button>
          ))}
        </div>
        {scope === 'document' && (
          <div className="cdt-badge cdt-badge--warning" style={{ alignSelf: 'flex-start' }}>
            Scanning every page can be slow on very large files.
          </div>
        )}
        <div className="cdt-row">
          <Button variant="primary" icon="play" onClick={runScan} loading={loading}>Run Design QA</Button>
          <Button variant="ghost" icon="download" onClick={exportReport} disabled={!result}>Export report (JSON)</Button>
        </div>
      </div>

      {!result && !loading && (
        <EmptyState icon="qa" title="No scan run yet" description="Run Design QA to check spacing, radius, shadow, typography and colour consistency." />
      )}

      {result && (
        <div className="cdt-section">
          <div className="cdt-row cdt-row--between">
            <span className="cdt-section__title">{result.issues.length} finding{result.issues.length === 1 ? '' : 's'}</span>
            <span className="cdt-text-muted">Scanned {new Date(result.scannedAt).toLocaleTimeString()}</span>
          </div>

          {groups.length === 0 && (
            <EmptyState icon="check" title="No issues found" description="Nothing to flag for the current scope — nice and consistent." />
          )}

          {groups.map(({ ruleId, issues }) => {
            const isOpen = expanded.has(ruleId);
            const shown = isOpen ? issues.slice(0, ROWS_SHOWN_PER_GROUP) : [];
            const remaining = issues.length - shown.length;
            return (
              <div key={ruleId} className="cdt-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button
                  onClick={() => toggle(ruleId)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit', font: 'inherit' }}
                >
                  <span className="cdt-row" style={{ gap: 8 }}>
                    <Icon name="chevron-right" size={12} style={{ transform: isOpen ? 'rotate(90deg)' : undefined }} />
                    <strong>{RULE_LABELS[ruleId] ?? ruleId}</strong>
                  </span>
                  <span className="cdt-badge cdt-badge--warning">{issues.length}</span>
                </button>

                {isOpen && (
                  <div className="cdt-table-wrap">
                    <table className="cdt-table">
                      <thead>
                        <tr>
                          <th style={{ width: 20 }} />
                          <th>Title</th>
                          <th>Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((issue) => (
                          <tr key={issue.id}>
                            <td><Icon name={SEVERITY_ICON[issue.severity]} size={13} /></td>
                            <td>{issue.node ? issue.node.name : issue.title}</td>
                            <td className="cdt-text-muted">{issue.description}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {remaining > 0 && <div className="cdt-text-muted" style={{ padding: 8 }}>+{remaining} more</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
