import { useState } from 'react';
import type { RunScope } from '@shared/types';
import { usePluginMessage } from '@ui/hooks/usePluginMessage';
import { useToolkitStore } from '@ui/state/store';
import { Button } from '@ui/components/common/Button';
import { ProgressBar } from '@ui/components/common/ProgressBar';
import { EmptyState } from '@ui/components/common/EmptyState';
import { pngBytesToWebp } from '@ui/lib/image/webpEncode';

// Mirrors src/main/modules/exportManager's result shape. Duplicated on
// purpose — UI files must never import from src/main/** (different
// runtime, no `figma` global there).
type SupportedExportFormat = 'PNG' | 'JPG' | 'SVG' | 'PDF';
type RequestableExportFormat = SupportedExportFormat | 'WEBP';
interface ExportJobResult {
  nodeId: string;
  nodeName: string;
  scale: number;
  format: RequestableExportFormat;
  actualFormat: SupportedExportFormat;
  bytes: Uint8Array;
  suggestedFilename: string;
}

const SCOPES: RunScope['scope'][] = ['selection', 'page', 'document'];
const ALL_FORMATS: RequestableExportFormat[] = ['PNG', 'JPG', 'SVG', 'PDF', 'WEBP'];
const SCALE_CHIPS = [1, 2, 3, 4];

const TOKEN_LEGEND: Array<{ token: string; description: string }> = [
  { token: '{name}', description: 'Layer name' },
  { token: '{index}', description: 'Running index across this export batch (1, 2, 3…)' },
  { token: '{format}', description: 'Lowercased format, e.g. png / webp' },
  { token: '{scale}', description: 'Scale label, e.g. 2x' },
];

function mimeTypeFor(format: RequestableExportFormat): string {
  switch (format) {
    case 'PNG':
      return 'image/png';
    case 'JPG':
      return 'image/jpeg';
    case 'SVG':
      return 'image/svg+xml';
    case 'PDF':
      return 'application/pdf';
    case 'WEBP':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function downloadBlob(bytes: Uint8Array, filename: string, mimeType: string) {
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ExportManagerPage() {
  const { run, loading, progress } = usePluginMessage('exportManager');
  const pushToast = useToolkitStore((s) => s.pushToast);

  const [scope, setScope] = useState<RunScope['scope']>('selection');
  const [formats, setFormats] = useState<Set<RequestableExportFormat>>(new Set(['PNG']));
  const [scales, setScales] = useState<Set<number>>(new Set([1, 2]));
  const [customScale, setCustomScale] = useState('');
  const [namingPreset, setNamingPreset] = useState('{name}@{scale}x.{format}');
  const [quality, setQuality] = useState(0.85);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<{ count: number; totalBytes: number } | null>(null);

  const needsQuality = formats.has('JPG') || formats.has('WEBP');

  const toggleFormat = (f: RequestableExportFormat) => {
    setFormats((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };

  const toggleScale = (s: number) => {
    setScales((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const doExport = async () => {
    if (formats.size === 0) {
      pushToast({ variant: 'warning', title: 'Pick at least one format' });
      return;
    }
    const custom = customScale.trim() ? Number(customScale) : undefined;
    const scaleList = [...scales, ...(custom && Number.isFinite(custom) && custom > 0 ? [custom] : [])];
    if (scaleList.length === 0) {
      pushToast({ variant: 'warning', title: 'Pick at least one scale' });
      return;
    }

    setBusy(true);
    setSummary(null);
    let totalBytes = 0;
    let fileCount = 0;

    try {
      for (const format of formats) {
        // eslint-disable-next-line no-await-in-loop
        const results = await run<ExportJobResult[]>('exportBatch', { scope, format, scales: scaleList, namingPreset, quality });
        for (const item of results) {
          let bytes = item.bytes;
          if (item.format === 'WEBP') {
            // Figma has no native WebP export — main thread sent PNG bytes
            // tagged requestedFormat: 'WEBP'; re-encode here where Canvas
            // is actually available.
            // eslint-disable-next-line no-await-in-loop
            bytes = await pngBytesToWebp(bytes, quality);
          }
          downloadBlob(bytes, item.suggestedFilename, mimeTypeFor(item.format));
          totalBytes += bytes.length;
          fileCount += 1;
          // Browsers throttle/silently drop rapid successive downloads
          // triggered from script — a short delay between clicks is a
          // simple, effective mitigation when exporting many files at once.
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 60));
        }
      }
      setSummary({ count: fileCount, totalBytes });
      pushToast({ variant: 'success', title: `Exported ${fileCount} file(s)`, description: `${Math.round(totalBytes / 1024)} KB total.` });
    } catch (err) {
      pushToast({ variant: 'error', title: 'Export failed', description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="cdt-section">
        <div className="cdt-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="cdt-field">
            <label htmlFor="scope">Scope</label>
            <select id="scope" className="cdt-select" value={scope} onChange={(e) => setScope(e.target.value as RunScope['scope'])}>
              {SCOPES.map((s) => (
                <option key={s} value={s}>
                  {s[0]!.toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </div>

          <div className="cdt-field">
            <label>Formats</label>
            <div className="cdt-row" style={{ flexWrap: 'wrap' }}>
              {ALL_FORMATS.map((f) => (
                <label key={f} className="cdt-checkbox-row">
                  <input type="checkbox" checked={formats.has(f)} onChange={() => toggleFormat(f)} />
                  {f}
                </label>
              ))}
            </div>
            <span className="cdt-text-muted">WebP isn't a native Figma export format — PNG is exported, then re-encoded to WebP in this UI.</span>
          </div>

          <div className="cdt-field">
            <label>Scales</label>
            <div className="cdt-row" style={{ flexWrap: 'wrap' }}>
              {SCALE_CHIPS.map((s) => (
                <Button key={s} variant={scales.has(s) ? 'primary' : 'secondary'} onClick={() => toggleScale(s)}>
                  {s}x
                </Button>
              ))}
              <input
                className="cdt-input"
                style={{ width: 90 }}
                placeholder="Custom"
                value={customScale}
                onChange={(e) => setCustomScale(e.target.value)}
              />
            </div>
          </div>

          <div className="cdt-field">
            <label htmlFor="naming">Naming preset</label>
            <input id="naming" className="cdt-input" value={namingPreset} onChange={(e) => setNamingPreset(e.target.value)} />
            <span className="cdt-text-muted">
              Tokens: {TOKEN_LEGEND.map((t) => `${t.token} (${t.description})`).join(' · ')}. Figma plugins can't write real
              folders to disk — any <code>/</code> in the pattern is baked into the filename as <code>__</code> instead of
              creating actual subfolders (e.g. "{'{name}/{scale}x.{format}'}" → "ProductCard__2x.png").
            </span>
          </div>

          {needsQuality && (
            <div className="cdt-field">
              <label htmlFor="quality">Quality ({Math.round(quality * 100)}%) — JPG/WebP only</label>
              <input id="quality" type="range" min={0.1} max={1} step={0.05} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
              <span className="cdt-text-muted">Figma's native PNG/JPG export has no adjustable quality — this only affects client-side WebP re-encoding.</span>
            </div>
          )}

          <div className="cdt-row cdt-row--between">
            <Button variant="primary" icon="download" loading={loading || busy} onClick={doExport}>
              Export
            </Button>
            {summary && (
              <span className="cdt-text-muted">
                Last run: {summary.count} file(s), {Math.round(summary.totalBytes / 1024)} KB total.
              </span>
            )}
          </div>
          <ProgressBar progress={progress} />
        </div>
      </div>

      {!summary && !busy && (
        <EmptyState
          icon="export"
          title="Nothing exported yet"
          description="Pick a scope, formats and scales, then hit Export — files download straight to your browser's downloads folder."
        />
      )}
    </div>
  );
}
