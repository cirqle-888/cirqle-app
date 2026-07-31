import type { ProgressState } from '@shared/types';

export function ProgressBar({ progress }: { progress: ProgressState | null }) {
  if (!progress) return null;
  const pct = progress.indeterminate || progress.total === 0
    ? undefined
    : Math.min(100, Math.round((progress.done / progress.total) * 100));

  return (
    <div className="cdt-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="cdt-progress__track">
        <div
          className={['cdt-progress__fill', pct === undefined ? 'cdt-progress__fill--indeterminate' : ''].join(' ')}
          style={pct === undefined ? undefined : { width: `${pct}%` }}
        />
      </div>
      <div className="cdt-progress__label">
        {progress.label ?? 'Working…'}
        {pct !== undefined ? ` — ${pct}% (${progress.done}/${progress.total})` : ''}
      </div>
    </div>
  );
}
