import { useMemo, useState } from 'react';
import type { Issue, RunScope } from '@shared/types';
import { usePluginMessage } from '@ui/hooks/usePluginMessage';
import { useToolkitStore } from '@ui/state/store';
import { Button } from '@ui/components/common/Button';
import { ProgressBar } from '@ui/components/common/ProgressBar';
import { Table, type Column } from '@ui/components/common/Table';
import { EmptyState } from '@ui/components/common/EmptyState';
import { compressImage } from '@ui/lib/image/canvasResize';

// Mirrors src/main/modules/assetManager's result/meta shapes. Duplicated on
// purpose — UI files must never import from src/main/** (different
// runtime, no `figma` global there).
type ImagePaintSource = 'fills' | 'strokes';
interface AssetIssueMeta {
  hash: string;
  nodeIds: string[];
  occurrences: number;
  refs: { nodeId: string; property: ImagePaintSource; paintIndex: number }[];
  bytesLength?: number;
}
interface AssetScanResult {
  duplicates: Issue<AssetIssueMeta>[];
  large: Issue<AssetIssueMeta>[];
  possiblyUnused: Issue<AssetIssueMeta>[];
}

const SCOPES: RunScope['scope'][] = ['selection', 'page', 'document'];

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/** A file-picker disguised as a cdt-btn — reading a local file from the
 * designer's computer is a UI-thread-only capability (no file picker in
 * Figma's plugin sandbox), so this always lives here, never in main/**. */
function ReplaceFileButton({ onFile, disabled }: { onFile: (file: File) => void; disabled?: boolean }) {
  return (
    <label
      className="cdt-btn cdt-btn--ghost"
      style={{ cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}
    >
      Replace
      <input
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </label>
  );
}

export function AssetManagerPage() {
  const { run, loading, progress } = usePluginMessage('assetManager');
  const pushToast = useToolkitStore((s) => s.pushToast);
  const requestConfirm = useToolkitStore((s) => s.requestConfirm);

  const [scope, setScope] = useState<RunScope['scope']>('selection');
  const [results, setResults] = useState<AssetScanResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set()); // Issue ids, shared across the three tables
  const [renamePattern, setRenamePattern] = useState('Asset_{nn}');
  const [maxDimension, setMaxDimension] = useState(1600);
  const [quality, setQuality] = useState(0.75);
  const [compressMime, setCompressMime] = useState<'image/jpeg' | 'image/webp'>('image/jpeg');
  const [busy, setBusy] = useState<string | null>(null); // label of the in-flight bulk action, for disabling buttons

  const issueById = useMemo(() => {
    const map = new Map<string, Issue<AssetIssueMeta>>();
    for (const issue of [...(results?.duplicates ?? []), ...(results?.large ?? []), ...(results?.possiblyUnused ?? [])]) {
      map.set(issue.id, issue);
    }
    return map;
  }, [results]);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const scan = async () => {
    try {
      const result = await run<AssetScanResult>('scan', { scope });
      setResults(result);
      setSelectedIds(new Set());
    } catch (err) {
      pushToast({ variant: 'error', title: 'Scan failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const doRename = async () => {
    const nodeIds = [...new Set([...selectedIds].flatMap((id) => issueById.get(id)?.meta?.nodeIds ?? []))];
    if (nodeIds.length === 0 || !renamePattern.trim()) return;
    setBusy('rename');
    try {
      await run('renameAssetNodes', { nodeIds, pattern: renamePattern.trim() });
      pushToast({ variant: 'success', title: `Renamed ${nodeIds.length} layer(s)` });
      setSelectedIds(new Set());
      await scan();
    } catch (err) {
      pushToast({ variant: 'error', title: 'Rename failed', description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const doCompressSelected = async () => {
    const issues = [...selectedIds].map((id) => issueById.get(id)).filter((i): i is Issue<AssetIssueMeta> => Boolean(i));
    if (issues.length === 0) return;
    const confirmed = await requestConfirm({
      title: 'Compress selected images?',
      description: `${issues.length} distinct image(s) will be recompressed and every layer using each one updated to match.`,
      confirmLabel: 'Compress',
    });
    if (!confirmed) return;

    setBusy('compress');
    let totalBefore = 0;
    let totalAfter = 0;
    let failures = 0;
    try {
      for (const issue of issues) {
        const refs = issue.meta?.refs ?? [];
        const first = refs[0];
        if (!first) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          const { bytes } = await run<{ bytes: Uint8Array; hash: string }>('getImageForRoundTrip', {
            nodeId: first.nodeId,
            property: first.property,
            paintIndex: first.paintIndex,
          });
          totalBefore += bytes.length;
          // eslint-disable-next-line no-await-in-loop
          const compressed = await compressImage(bytes, { maxDimension, quality, mimeType: compressMime });
          totalAfter += compressed.length;
          for (const ref of refs) {
            // eslint-disable-next-line no-await-in-loop
            await run('applyImageBytes', { nodeId: ref.nodeId, property: ref.property, paintIndex: ref.paintIndex, bytes: compressed });
          }
        } catch {
          failures += 1;
        }
      }
      pushToast({
        variant: failures ? 'warning' : 'success',
        title: `Compressed ${issues.length - failures} image(s)`,
        description: `${kb(totalBefore)} → ${kb(totalAfter)}${failures ? ` — ${failures} failed` : ''}.`,
      });
      setSelectedIds(new Set());
      await scan();
    } finally {
      setBusy(null);
    }
  };

  const handleReplaceFile = async (issue: Issue<AssetIssueMeta>, file: File) => {
    const refs = issue.meta?.refs ?? [];
    if (refs.length === 0) return;
    setBusy(`replace:${issue.id}`);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      for (const ref of refs) {
        // eslint-disable-next-line no-await-in-loop
        await run('applyImageBytes', { nodeId: ref.nodeId, property: ref.property, paintIndex: ref.paintIndex, bytes });
      }
      pushToast({ variant: 'success', title: `Replaced image across ${refs.length} layer(s)` });
      await scan();
    } catch (err) {
      pushToast({ variant: 'error', title: 'Replace failed', description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const baseColumns = (showSize: boolean): Column<Issue<AssetIssueMeta>>[] => [
    { key: 'title', header: 'Image', render: (r) => r.title },
    { key: 'layers', header: 'Layers', width: '70px', render: (r) => r.meta?.nodeIds.length ?? 0 },
    ...(showSize
      ? ([{ key: 'size', header: 'Size', width: '80px', render: (r) => (r.meta?.bytesLength !== undefined ? kb(r.meta.bytesLength) : '—') }] as Column<
          Issue<AssetIssueMeta>
        >[])
      : []),
    {
      key: 'actions',
      header: '',
      width: '90px',
      render: (r) => <ReplaceFileButton disabled={busy !== null} onFile={(f) => handleReplaceFile(r, f)} />,
    },
  ];

  const duplicateColumns = baseColumns(true);
  const largeColumns = baseColumns(true);
  const possiblyUnusedColumns: Column<Issue<AssetIssueMeta>>[] = [
    { key: 'title', header: 'Image', render: (r) => r.title },
    { key: 'layers', header: 'Layers', width: '70px', render: (r) => r.meta?.nodeIds.length ?? 0 },
    { key: 'desc', header: 'Why', render: (r) => r.description },
  ];

  const selectedCount = selectedIds.size;

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
          icon="assets"
          title="No scan yet"
          description="Pick a scope and hit Scan to find duplicate, large and possibly-unused images."
        />
      ) : (
        <>
          <div className="cdt-section">
            <div className="cdt-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="cdt-section__title">Bulk actions ({selectedCount} image(s) selected)</div>

              <div className="cdt-row">
                <div className="cdt-field">
                  <label htmlFor="maxdim">Max dimension (px)</label>
                  <input id="maxdim" type="number" className="cdt-input" style={{ width: 90 }} value={maxDimension} onChange={(e) => setMaxDimension(Number(e.target.value) || 1)} />
                </div>
                <div className="cdt-field">
                  <label htmlFor="quality">Quality ({Math.round(quality * 100)}%)</label>
                  <input id="quality" type="range" min={0.1} max={1} step={0.05} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
                </div>
                <div className="cdt-field">
                  <label htmlFor="mime">Output</label>
                  <select id="mime" className="cdt-select" value={compressMime} onChange={(e) => setCompressMime(e.target.value as 'image/jpeg' | 'image/webp')}>
                    <option value="image/jpeg">JPEG</option>
                    <option value="image/webp">WebP</option>
                  </select>
                </div>
                <Button disabled={selectedCount === 0 || busy !== null} loading={busy === 'compress'} onClick={doCompressSelected}>
                  Compress selected
                </Button>
              </div>

              <div className="cdt-row">
                <div className="cdt-field" style={{ flex: 1 }}>
                  <label htmlFor="rename-pattern">Rename pattern ({'{n}'} / {'{nn}'})</label>
                  <input id="rename-pattern" className="cdt-input" value={renamePattern} onChange={(e) => setRenamePattern(e.target.value)} />
                </div>
                <Button disabled={selectedCount === 0 || busy !== null} loading={busy === 'rename'} onClick={doRename}>
                  Rename selected layers
                </Button>
              </div>
              <span className="cdt-text-muted">
                Compress/rename act on the layers behind whichever rows you check below, across all three sections.
              </span>
            </div>
          </div>

          <div className="cdt-section">
            <div className="cdt-section__title">Duplicate images ({results.duplicates.length})</div>
            <Table columns={duplicateColumns} rows={results.duplicates} selected={selectedIds} onToggleSelect={toggleSelected} emptyMessage="No duplicate images found." />
          </div>

          <div className="cdt-section">
            <div className="cdt-section__title">Large images ({results.large.length})</div>
            <Table columns={largeColumns} rows={results.large} selected={selectedIds} onToggleSelect={toggleSelected} emptyMessage="No large images found." />
          </div>

          <div className="cdt-section">
            <div className="cdt-section__title">Possibly unused images ({results.possiblyUnused.length})</div>
            <div className="cdt-text-muted" style={{ marginBottom: 4 }}>
              Approximate heuristic (hidden or far off-canvas layers only) — verify before deleting anything.
            </div>
            <Table columns={possiblyUnusedColumns} rows={results.possiblyUnused} selected={selectedIds} onToggleSelect={toggleSelected} emptyMessage="Nothing flagged." />
          </div>
        </>
      )}
    </div>
  );
}
