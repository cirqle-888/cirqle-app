import { useState } from 'react';
import { usePluginMessage } from '@ui/hooks/usePluginMessage';
import { useToolkitStore } from '@ui/state/store';
import { Button } from '@ui/components/common/Button';
import { ProgressBar } from '@ui/components/common/ProgressBar';
import { Table, type Column } from '@ui/components/common/Table';
import { EmptyState } from '@ui/components/common/EmptyState';
import { downloadJson } from '@ui/lib/report/jsonReport';
import { generateAccessibilityPdf } from '@ui/lib/report/pdfReport';
import type { A11yScanResult, ContrastFinding } from '@ui/lib/report/a11yTypes';

type Scope = 'selection' | 'page';
type ContrastRow = ContrastFinding & { id: string };

const LEVEL_BADGE: Record<ContrastFinding['level'], string> = {
  fail: 'cdt-badge--error',
  AA: 'cdt-badge--success',
  AAA: 'cdt-badge--success',
};

export function AccessibilityPage() {
  const { run, loading, progress } = usePluginMessage('accessibility');
  const pushToast = useToolkitStore((s) => s.pushToast);
  const selectionCount = useToolkitStore((s) => s.selectionCount);

  const [scope, setScope] = useState<Scope>('selection');
  const [result, setResult] = useState<A11yScanResult | null>(null);
  const [fixingNodeId, setFixingNodeId] = useState<string | null>(null);

  const runScan = async () => {
    try {
      const scanResult = await run<A11yScanResult>('scan', { scope });
      setResult(scanResult);
    } catch (err) {
      pushToast({
        variant: 'error',
        title: 'Scan failed',
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const applyFix = async (finding: ContrastFinding) => {
    if (!finding.suggestion) return;
    setFixingNodeId(finding.nodeId);
    try {
      await run('applyFix', {
        nodeId: finding.nodeId,
        field: finding.suggestion.field,
        hex: finding.suggestion.hex,
      });
      pushToast({
        variant: 'success',
        title: 'Fix applied',
        description: `Updated the ${finding.suggestion.field} colour on "${finding.nodeName}" to ${finding.suggestion.hex}.`,
      });
      await runScan();
    } catch (err) {
      pushToast({
        variant: 'error',
        title: 'Could not apply fix',
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setFixingNodeId(null);
    }
  };

  const cannotDetermineIssues = result?.issues.filter((i) => i.ruleId === 'a11y.cannot-determine') ?? [];

  const contrastColumns: Column<ContrastRow>[] = [
    { key: 'node', header: 'Node', render: (r) => r.nodeName },
    { key: 'ratio', header: 'Ratio', render: (r) => `${r.ratio.toFixed(2)}:1` },
    { key: 'size', header: 'Size', render: (r) => (r.isLargeText ? 'Large' : 'Normal') },
    {
      key: 'level',
      header: 'Level',
      render: (r) => (
        <span className={['cdt-badge', LEVEL_BADGE[r.level]].join(' ')}>{r.level === 'fail' ? 'FAIL' : r.level}</span>
      ),
    },
    {
      key: 'fix',
      header: '',
      width: '64px',
      render: (r) =>
        r.level === 'fail' && r.suggestion ? (
          <Button variant="ghost" loading={fixingNodeId === r.nodeId} onClick={() => applyFix(r)}>
            Fix
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <div className="cdt-section">
        <div className="cdt-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="cdt-row cdt-row--between">
            <div className="cdt-field" style={{ minWidth: 200 }}>
              <label htmlFor="a11y-scope">Scope</label>
              <select
                id="a11y-scope"
                className="cdt-select"
                value={scope}
                onChange={(e) => setScope(e.target.value as Scope)}
              >
                <option value="selection">
                  Selection ({selectionCount} node{selectionCount === 1 ? '' : 's'})
                </option>
                <option value="page">Current page</option>
              </select>
            </div>
            <Button variant="primary" icon="play" loading={loading} onClick={runScan}>
              Run scan
            </Button>
          </div>
          {loading ? <ProgressBar progress={progress} /> : null}
          <span className="cdt-text-muted">
            Analyses text contrast (WCAG AA/AAA), minimum readable font size, minimum touch target size, and simulates
            colour-blindness across every distinct solid colour found in scope. Background colour for contrast checks is
            approximated from the nearest solid-filled ancestor — Figma's Plugin API has no real pixel-compositing
            access, so this cannot account for effects, blend modes or overlapping siblings.
          </span>
        </div>
      </div>

      {!result && !loading ? (
        <EmptyState
          icon="a11y"
          title="No scan yet"
          description="Select some frames (or switch scope to the current page) and run a scan to see findings."
        />
      ) : null}

      {result ? (
        <>
          <div className="cdt-section">
            <div className="cdt-card cdt-row cdt-row--between">
              <div>
                <div className="cdt-section__title">Accessibility score</div>
                <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2 }}>
                  {result.score}
                  <span className="cdt-text-muted" style={{ fontSize: 13 }}> / 100</span>
                </div>
                <div className="cdt-text-muted" style={{ fontSize: 9.5 }}>
                  50% contrast pass-rate + 25% font-size pass-rate + 25% touch-target pass-rate
                </div>
              </div>
              <div className="cdt-row">
                <Button variant="secondary" icon="download" onClick={() => downloadJson('accessibility-report.json', result)}>
                  Export JSON
                </Button>
                <Button
                  variant="secondary"
                  icon="download"
                  onClick={() => generateAccessibilityPdf(result, 'accessibility-report.pdf')}
                >
                  Export PDF
                </Button>
              </div>
            </div>
          </div>

          <div className="cdt-section">
            <div className="cdt-section__title">Contrast findings ({result.contrast.length})</div>
            <Table
              columns={contrastColumns}
              rows={result.contrast.map((c): ContrastRow => ({ ...c, id: c.nodeId }))}
              emptyMessage="No text nodes with a resolvable solid fill were found."
            />
          </div>

          <div className="cdt-section">
            <div className="cdt-row cdt-row--between">
              <div className="cdt-section__title">Font size issues ({result.fontSize.length})</div>
            </div>
            {result.fontSize.length === 0 ? (
              <EmptyState icon="check" title="No readability issues" description="Every text node meets the minimum font size." />
            ) : (
              <div className="cdt-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {result.fontSize.map((f) => (
                  <div key={f.nodeId} className="cdt-row cdt-row--between">
                    <span>{f.nodeName}</span>
                    <span className="cdt-badge cdt-badge--warning">
                      {f.fontSize}px (min {f.minSize}px)
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="cdt-section">
            <div className="cdt-section__title">Touch target issues ({result.touchTargets.length})</div>
            {result.touchTargets.length === 0 ? (
              <EmptyState icon="check" title="No touch target issues" description="Every interactive-looking node meets the minimum tap size." />
            ) : (
              <div className="cdt-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {result.touchTargets.map((t) => (
                  <div key={t.nodeId} className="cdt-row cdt-row--between">
                    <span>{t.nodeName}</span>
                    <span className="cdt-badge cdt-badge--warning">
                      {Math.round(t.width)}×{Math.round(t.height)}px (min {t.minSize}px)
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="cdt-section">
            <div className="cdt-section__title">Colour-blindness simulation ({result.swatches.length} colours)</div>
            <span className="cdt-text-muted" style={{ display: 'block', marginBottom: 8 }}>
              This preview simulates colour values only — it is not a live render filter over the canvas, since the
              Plugin API has no pixel/render access.
            </span>
            {result.swatches.length === 0 ? (
              <EmptyState icon="a11y" title="No solid colours found" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {result.swatches.map((s) => (
                  <div key={s.hex} className="cdt-row" style={{ gap: 12 }}>
                    {(['hex', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia'] as const).map((k) => (
                      <div key={k} style={{ textAlign: 'center' }}>
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 4,
                            border: '1px solid var(--cdt-border)',
                            background: s[k],
                          }}
                          title={s[k]}
                        />
                        <div className="cdt-text-muted" style={{ fontSize: 8, marginTop: 2 }}>
                          {k === 'hex' ? 'Original' : k}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {cannotDetermineIssues.length > 0 ? (
            <div className="cdt-section">
              <div className="cdt-section__title">Could not determine contrast ({cannotDetermineIssues.length})</div>
              <div className="cdt-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {cannotDetermineIssues.map((i) => (
                  <div key={i.id} className="cdt-row cdt-row--between">
                    <span>{i.node?.name ?? 'Unknown node'}</span>
                    <span className="cdt-text-muted">{i.description}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
