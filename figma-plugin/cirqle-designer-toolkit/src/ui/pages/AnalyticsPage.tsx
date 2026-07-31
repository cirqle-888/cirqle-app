import { useState } from 'react';
import { usePluginMessage } from '@ui/hooks/usePluginMessage';
import { useToolkitStore } from '@ui/state/store';
import { Button } from '@ui/components/common/Button';
import { ProgressBar } from '@ui/components/common/ProgressBar';
import { EmptyState } from '@ui/components/common/EmptyState';

// Mirrors src/main/modules/analytics/analyticsEngine.ts's AnalyticsSnapshot
// — UI files must never import from src/main/** (different runtime, no
// `figma` there), so cross-boundary types are small and copied, not shared.
interface AnalyticsSnapshot {
  scope: 'page' | 'document';
  scannedAt: number;
  totalNodeCount: number;
  maxNestingDepth: number;
  pageCount: number;
  frameCount: number;
  componentCount: number;
  variantCount: number;
  imageCount: { distinct: number; totalUsages: number };
  vectorCount: number;
  fontsUsed: { distinct: number; families: string[]; mixedStyleTextNodeCount: number };
  styleCounts: { paint: number; text: number; effect: number; grid: number };
  variableCount: number | null;
  estimatedFileSizeKb: number;
  complexityScore: number;
  performanceScore: number;
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="cdt-card" style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span className="cdt-text-muted" style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</span>
      <span style={{ fontSize: 18, fontWeight: 700 }}>{value}</span>
      {hint ? <span className="cdt-text-muted">{hint}</span> : null}
    </div>
  );
}

function ScoreCard({ label, score, explanation }: { label: string; score: number; explanation: string }) {
  const tone = score >= 70 ? 'var(--cdt-text-success)' : score >= 40 ? 'var(--cdt-text-warning)' : 'var(--cdt-text-danger)';
  return (
    <div className="cdt-card" style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
      <span className="cdt-section__title">{label}</span>
      <span style={{ fontSize: 28, fontWeight: 700, color: tone }}>{score}<span style={{ fontSize: 12, color: 'var(--cdt-text-tertiary)' }}>/100</span></span>
      <span className="cdt-text-muted">{explanation}</span>
    </div>
  );
}

export function AnalyticsPage() {
  const { run, loading, progress } = usePluginMessage('analytics');
  const pushToast = useToolkitStore((s) => s.pushToast);
  const [scope, setScope] = useState<'page' | 'document'>('page');
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null);

  const runAnalysis = async () => {
    try {
      const result = await run<AnalyticsSnapshot>('scan', { scope });
      setSnapshot(result);
    } catch (err) {
      pushToast({ variant: 'error', title: 'Analysis failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div>
      <ProgressBar progress={progress} />

      <div className="cdt-section">
        <div className="cdt-section__title">Scope</div>
        <div className="cdt-row">
          <Button variant={scope === 'page' ? 'primary' : 'secondary'} onClick={() => setScope('page')}>Current page</Button>
          <Button variant={scope === 'document' ? 'primary' : 'secondary'} onClick={() => setScope('document')}>Whole document</Button>
        </div>
        {scope === 'document' && (
          <div className="cdt-badge cdt-badge--warning" style={{ alignSelf: 'flex-start' }}>
            Scanning every page can be slow on very large files.
          </div>
        )}
        <Button variant="primary" icon="play" onClick={runAnalysis} loading={loading}>Run analysis</Button>
      </div>

      {!snapshot && !loading && (
        <EmptyState icon="analytics" title="No analysis run yet" description="Run analysis to see counts, complexity and a performance outlook for this file." />
      )}

      {snapshot && (
        <>
          <div className="cdt-section">
            <div className="cdt-row" style={{ gap: 12 }}>
              <ScoreCard
                label="Complexity"
                score={snapshot.complexityScore}
                explanation="Driven by total layer count, how deeply layers are nested, and how many local styles the file defines."
              />
              <ScoreCard
                label="Performance outlook"
                score={snapshot.performanceScore}
                explanation="Starts at 100 and loses points for high layer count, deep nesting, and many ungrouped vector layers."
              />
            </div>
          </div>

          <div className="cdt-section">
            <div className="cdt-section__title">Structure</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
              <Tile label="Pages" value={String(snapshot.pageCount)} />
              <Tile label="Frames" value={String(snapshot.frameCount)} />
              <Tile label="Components" value={String(snapshot.componentCount)} />
              <Tile label="Variants" value={String(snapshot.variantCount)} />
              <Tile label="Total layers" value={String(snapshot.totalNodeCount)} />
              <Tile label="Max nesting" value={String(snapshot.maxNestingDepth)} />
            </div>
          </div>

          <div className="cdt-section">
            <div className="cdt-section__title">Assets & type</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
              <Tile label="Images" value={String(snapshot.imageCount.distinct)} hint={`${snapshot.imageCount.totalUsages} fill usages`} />
              <Tile label="Vectors" value={String(snapshot.vectorCount)} />
              <Tile
                label="Fonts"
                value={String(snapshot.fontsUsed.distinct)}
                hint={snapshot.fontsUsed.mixedStyleTextNodeCount > 0 ? `${snapshot.fontsUsed.mixedStyleTextNodeCount} mixed-style text skipped` : undefined}
              />
            </div>
          </div>

          <div className="cdt-section">
            <div className="cdt-section__title">Styles & variables</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
              <Tile label="Paint styles" value={String(snapshot.styleCounts.paint)} />
              <Tile label="Text styles" value={String(snapshot.styleCounts.text)} />
              <Tile label="Effect styles" value={String(snapshot.styleCounts.effect)} />
              <Tile label="Grid styles" value={String(snapshot.styleCounts.grid)} />
              <Tile
                label="Variables"
                value={snapshot.variableCount === null ? 'Unavailable' : String(snapshot.variableCount)}
                hint={snapshot.variableCount === null ? "Variables API isn't available on this editor/plan" : undefined}
              />
              <Tile label="Est. file size" value={`${snapshot.estimatedFileSizeKb} KB`} hint="Rough heuristic, not a real byte size" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
