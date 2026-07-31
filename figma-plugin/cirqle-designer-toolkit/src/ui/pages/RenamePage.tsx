import { useCallback, useMemo, useRef, useState } from 'react';
import { RENAME_VARIABLES } from '@shared/constants';
import type { RunScope } from '@shared/types';
import { usePluginMessage } from '@ui/hooks/usePluginMessage';
import { useToolkitStore } from '@ui/state/store';
import { Button } from '@ui/components/common/Button';
import { ProgressBar } from '@ui/components/common/ProgressBar';
import { Table, type Column } from '@ui/components/common/Table';
import { EmptyState } from '@ui/components/common/EmptyState';

// ---------------------------------------------------------------------------
// Wire-shape types mirrored from src/main/modules/rename/renameTypes.ts.
// UI code (this file) runs in a browser iframe and must never import from
// src/main/** (different runtime, no `figma` global there) — so these are
// duplicated on purpose, same pattern SettingsPage.tsx uses for LogEntry.
// Keep in sync with renameTypes.ts if that file's shapes change.
// ---------------------------------------------------------------------------
type NodeTypeFilterKey = 'FRAME' | 'COMPONENT' | 'INSTANCE' | 'GROUP' | 'TEXT' | 'VECTOR' | 'IMAGE' | 'SECTION';

interface FindReplaceConfig {
  enabled: boolean;
  find: string;
  replace: string;
  mode: 'plain' | 'regex';
  flags: string;
  caseSensitive: boolean;
}
interface AffixConfig {
  enabled: boolean;
  value: string;
}
interface NumberingConfig {
  enabled: boolean;
  startNumber: number;
  padding: 'auto' | 'none';
}
interface RenameRule {
  findReplace: FindReplaceConfig;
  prefix: AffixConfig;
  suffix: AffixConfig;
  numbering: NumberingConfig;
}
interface RenamePayload {
  scope: RunScope['scope'];
  typeFilter: NodeTypeFilterKey[];
  rule: RenameRule;
}
interface RenamePreviewRow {
  id: string;
  oldName: string;
  newName: string;
  error?: string;
}
interface RenamePreviewResult {
  rows: RenamePreviewRow[];
  total: number;
}
interface RenameApplyResult {
  renamedCount: number;
  errorCount: number;
  errors: Array<{ id: string; error: string }>;
  undoToken?: string;
}

function defaultRule(): RenameRule {
  return {
    findReplace: { enabled: false, find: '', replace: '', mode: 'plain', flags: 'g', caseSensitive: false },
    prefix: { enabled: false, value: '' },
    suffix: { enabled: false, value: '' },
    numbering: { enabled: false, startNumber: 1, padding: 'auto' },
  };
}

const TYPE_FILTER_OPTIONS: Array<{ key: NodeTypeFilterKey; label: string }> = [
  { key: 'FRAME', label: 'Frames' },
  { key: 'COMPONENT', label: 'Components' },
  { key: 'INSTANCE', label: 'Instances' },
  { key: 'GROUP', label: 'Groups' },
  { key: 'TEXT', label: 'Text' },
  { key: 'VECTOR', label: 'Vectors' },
  { key: 'IMAGE', label: 'Images' },
  { key: 'SECTION', label: 'Sections' },
];

const SCOPE_OPTIONS: Array<{ key: RunScope['scope']; label: string }> = [
  { key: 'selection', label: 'Selection' },
  { key: 'page', label: 'Page' },
  { key: 'document', label: 'Document' },
];

const PREVIEW_CAP = 500;

type FieldKey = 'find' | 'replace' | 'prefix' | 'suffix';

export function RenamePage() {
  const { run, loading, progress } = usePluginMessage('rename');
  const pushToast = useToolkitStore((s) => s.pushToast);
  const selectionCount = useToolkitStore((s) => s.selectionCount);

  const [scope, setScope] = useState<RunScope['scope']>('selection');
  const [typeFilter, setTypeFilter] = useState<Set<NodeTypeFilterKey>>(new Set());
  const [rule, setRule] = useState<RenameRule>(defaultRule);
  const [previewResult, setPreviewResult] = useState<RenamePreviewResult | null>(null);
  const [undoToken, setUndoToken] = useState<string | undefined>(undefined);
  const [activeField, setActiveField] = useState<FieldKey>('suffix');

  const fieldRefs = useRef<Record<FieldKey, HTMLInputElement | null>>({
    find: null,
    replace: null,
    prefix: null,
    suffix: null,
  });

  const updateField = useCallback((key: FieldKey, value: string) => {
    setRule((r) => {
      switch (key) {
        case 'find':
          return { ...r, findReplace: { ...r.findReplace, find: value } };
        case 'replace':
          return { ...r, findReplace: { ...r.findReplace, replace: value } };
        case 'prefix':
          return { ...r, prefix: { ...r.prefix, value } };
        case 'suffix':
          return { ...r, suffix: { ...r.suffix, value } };
        default:
          return r;
      }
    });
  }, []);

  const insertToken = useCallback(
    (token: string) => {
      const el = fieldRefs.current[activeField];
      const current =
        activeField === 'find'
          ? rule.findReplace.find
          : activeField === 'replace'
            ? rule.findReplace.replace
            : activeField === 'prefix'
              ? rule.prefix.value
              : rule.suffix.value;

      if (!el) {
        updateField(activeField, current + token);
        return;
      }
      const start = el.selectionStart ?? current.length;
      const end = el.selectionEnd ?? current.length;
      const next = current.slice(0, start) + token + current.slice(end);
      updateField(activeField, next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      });
    },
    [activeField, rule, updateField]
  );

  const toggleType = (key: NodeTypeFilterKey) => {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const buildPayload = useCallback(
    (): RenamePayload => ({
      scope,
      typeFilter: Array.from(typeFilter),
      rule,
    }),
    [scope, typeFilter, rule]
  );

  const handlePreview = async () => {
    setUndoToken(undefined);
    try {
      const result = await run<RenamePreviewResult>('preview', buildPayload());
      setPreviewResult(result);
      if (result.total === 0) {
        pushToast({ variant: 'info', title: 'Nothing matched', description: 'No layers in this scope matched your filters.' });
      }
    } catch (err) {
      pushToast({ variant: 'error', title: 'Preview failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleApply = async () => {
    try {
      const result = await run<RenameApplyResult>('apply', buildPayload());
      setUndoToken(result.undoToken);
      setPreviewResult(null);
      if (result.errorCount > 0) {
        pushToast({
          variant: 'warning',
          title: `Renamed ${result.renamedCount} layer${result.renamedCount === 1 ? '' : 's'}`,
          description: `${result.errorCount} layer${result.errorCount === 1 ? '' : 's'} could not be renamed — check your rule.`,
        });
      } else {
        pushToast({ variant: 'success', title: `Renamed ${result.renamedCount} layer${result.renamedCount === 1 ? '' : 's'}` });
      }
    } catch (err) {
      pushToast({ variant: 'error', title: 'Rename failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleUndo = async () => {
    if (!undoToken) return;
    try {
      await run('undo', { token: undoToken });
      pushToast({ variant: 'success', title: 'Rename undone' });
      setUndoToken(undefined);
    } catch (err) {
      pushToast({ variant: 'error', title: 'Undo failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const visibleRows = useMemo(() => previewResult?.rows.slice(0, PREVIEW_CAP) ?? [], [previewResult]);
  const remaining = previewResult ? Math.max(0, previewResult.rows.length - PREVIEW_CAP) : 0;

  const columns: Column<RenamePreviewRow>[] = [
    { key: 'oldName', header: 'Old name', render: (r) => r.oldName },
    {
      key: 'newName',
      header: 'New name',
      render: (r) => (r.error ? <span className="cdt-badge cdt-badge--error">{r.error}</span> : r.newName),
    },
  ];

  return (
    <div>
      <div className="cdt-section">
        <div className="cdt-section__title">Scope</div>
        <div className="cdt-row" style={{ gap: 16 }}>
          {SCOPE_OPTIONS.map((opt) => (
            <label key={opt.key} className="cdt-checkbox-row">
              <input type="radio" name="rename-scope" checked={scope === opt.key} onChange={() => setScope(opt.key)} />
              {opt.key === 'selection' ? `${opt.label} (${selectionCount})` : opt.label}
            </label>
          ))}
        </div>
      </div>

      <div className="cdt-section">
        <div className="cdt-section__title">Node types</div>
        <div className="cdt-text-muted">Leave all unchecked to match every layer type.</div>
        <div className="cdt-row" style={{ flexWrap: 'wrap', gap: 12 }}>
          {TYPE_FILTER_OPTIONS.map((opt) => (
            <label key={opt.key} className="cdt-checkbox-row">
              <input type="checkbox" checked={typeFilter.has(opt.key)} onChange={() => toggleType(opt.key)} />
              {opt.label}
            </label>
          ))}
        </div>
      </div>

      <div className="cdt-section">
        <div className="cdt-section__title">Smart variables</div>
        <div className="cdt-text-muted">Click a token to insert it into the last-focused field below (default: Suffix).</div>
        <div className="cdt-row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {RENAME_VARIABLES.map((v) => (
            <button
              key={v.token}
              type="button"
              className="cdt-badge cdt-badge--info"
              style={{ cursor: 'pointer', border: 'none' }}
              title={v.description}
              onClick={() => insertToken(v.token)}
            >
              {v.token}
            </button>
          ))}
        </div>
      </div>

      <div className="cdt-section">
        <div className="cdt-row cdt-row--between">
          <div className="cdt-section__title">Find &amp; replace</div>
          <label className="cdt-checkbox-row">
            <input
              type="checkbox"
              checked={rule.findReplace.enabled}
              onChange={(e) => setRule((r) => ({ ...r, findReplace: { ...r.findReplace, enabled: e.target.checked } }))}
            />
            Enabled
          </label>
        </div>
        <div className="cdt-row cdt-row--between">
          <label className="cdt-checkbox-row">
            <input
              type="checkbox"
              checked={rule.findReplace.mode === 'regex'}
              onChange={(e) =>
                setRule((r) => ({ ...r, findReplace: { ...r.findReplace, mode: e.target.checked ? 'regex' : 'plain' } }))
              }
            />
            Regex mode
          </label>
          {rule.findReplace.mode === 'plain' ? (
            <label className="cdt-checkbox-row">
              <input
                type="checkbox"
                checked={rule.findReplace.caseSensitive}
                onChange={(e) => setRule((r) => ({ ...r, findReplace: { ...r.findReplace, caseSensitive: e.target.checked } }))}
              />
              Case sensitive
            </label>
          ) : null}
        </div>
        <div className="cdt-field">
          <label htmlFor="rn-find">{rule.findReplace.mode === 'regex' ? 'Pattern' : 'Find'}</label>
          <input
            id="rn-find"
            ref={(el) => {
              fieldRefs.current.find = el;
            }}
            className="cdt-input"
            value={rule.findReplace.find}
            onFocus={() => setActiveField('find')}
            onChange={(e) => updateField('find', e.target.value)}
            placeholder={rule.findReplace.mode === 'regex' ? 'e.g. ^old-(.*)$' : 'e.g. old'}
          />
        </div>
        <div className="cdt-field">
          <label htmlFor="rn-replace">Replace with</label>
          <input
            id="rn-replace"
            ref={(el) => {
              fieldRefs.current.replace = el;
            }}
            className="cdt-input"
            value={rule.findReplace.replace}
            onFocus={() => setActiveField('replace')}
            onChange={(e) => updateField('replace', e.target.value)}
            placeholder={rule.findReplace.mode === 'regex' ? 'e.g. new-$1' : 'e.g. new'}
          />
        </div>
        {rule.findReplace.mode === 'regex' ? (
          <div className="cdt-field">
            <label htmlFor="rn-flags">Flags</label>
            <input
              id="rn-flags"
              className="cdt-input"
              value={rule.findReplace.flags}
              onChange={(e) => setRule((r) => ({ ...r, findReplace: { ...r.findReplace, flags: e.target.value } }))}
              placeholder="g"
              style={{ maxWidth: 80 }}
            />
            <span className="cdt-text-muted">"g" is always applied even if omitted, so every match gets replaced.</span>
          </div>
        ) : null}
      </div>

      <div className="cdt-section">
        <div className="cdt-row" style={{ gap: 24, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div className="cdt-row cdt-row--between">
              <div className="cdt-section__title">Prefix</div>
              <label className="cdt-checkbox-row">
                <input
                  type="checkbox"
                  checked={rule.prefix.enabled}
                  onChange={(e) => setRule((r) => ({ ...r, prefix: { ...r.prefix, enabled: e.target.checked } }))}
                />
                Enabled
              </label>
            </div>
            <input
              ref={(el) => {
                fieldRefs.current.prefix = el;
              }}
              className="cdt-input"
              value={rule.prefix.value}
              onFocus={() => setActiveField('prefix')}
              onChange={(e) => updateField('prefix', e.target.value)}
              placeholder="e.g. icon-"
            />
          </div>
          <div style={{ flex: 1 }}>
            <div className="cdt-row cdt-row--between">
              <div className="cdt-section__title">Suffix</div>
              <label className="cdt-checkbox-row">
                <input
                  type="checkbox"
                  checked={rule.suffix.enabled}
                  onChange={(e) => setRule((r) => ({ ...r, suffix: { ...r.suffix, enabled: e.target.checked } }))}
                />
                Enabled
              </label>
            </div>
            <input
              ref={(el) => {
                fieldRefs.current.suffix = el;
              }}
              className="cdt-input"
              value={rule.suffix.value}
              onFocus={() => setActiveField('suffix')}
              onChange={(e) => updateField('suffix', e.target.value)}
              placeholder="e.g. -{nn}"
            />
          </div>
        </div>
      </div>

      <div className="cdt-section">
        <div className="cdt-row cdt-row--between">
          <div className="cdt-section__title">Sequential numbering</div>
          <label className="cdt-checkbox-row">
            <input
              type="checkbox"
              checked={rule.numbering.enabled}
              onChange={(e) => setRule((r) => ({ ...r, numbering: { ...r.numbering, enabled: e.target.checked } }))}
            />
            Enabled
          </label>
        </div>
        <div className="cdt-text-muted">
          Use the {'{n}'} / {'{nn}'} / {'{index}'} chips above inside Prefix, Suffix or Replace text to place the number.
          When disabled, those tokens are left as literal text.
        </div>
        <div className="cdt-row" style={{ gap: 16 }}>
          <div className="cdt-field">
            <label htmlFor="rn-start">Start number</label>
            <input
              id="rn-start"
              type="number"
              className="cdt-input"
              value={rule.numbering.startNumber}
              onChange={(e) =>
                setRule((r) => ({ ...r, numbering: { ...r.numbering, startNumber: Number(e.target.value) || 1 } }))
              }
              style={{ maxWidth: 100 }}
            />
          </div>
          <div className="cdt-field">
            <label htmlFor="rn-padding">Padding style ({'{nn}'})</label>
            <select
              id="rn-padding"
              className="cdt-select"
              value={rule.numbering.padding}
              onChange={(e) => setRule((r) => ({ ...r, numbering: { ...r.numbering, padding: e.target.value as 'auto' | 'none' } }))}
            >
              <option value="auto">Auto (pad to widest number, e.g. 01..12)</option>
              <option value="none">None (same as {'{n}'})</option>
            </select>
          </div>
        </div>
      </div>

      <div className="cdt-section">
        <div className="cdt-row" style={{ gap: 8 }}>
          <Button variant="secondary" icon="search" onClick={handlePreview} loading={loading}>
            Preview
          </Button>
          <Button variant="primary" icon="check" onClick={handleApply} disabled={!previewResult || loading}>
            Apply
          </Button>
          {undoToken ? (
            <Button variant="ghost" icon="undo" onClick={handleUndo} disabled={loading}>
              Undo last rename
            </Button>
          ) : null}
        </div>
        {loading ? <ProgressBar progress={progress} /> : null}
      </div>

      <div className="cdt-section">
        <div className="cdt-section__title">Preview</div>
        {previewResult === null ? (
          <EmptyState icon="rename" title="No preview yet" description="Run Preview to see old → new names before applying anything." />
        ) : (
          <>
            <Table columns={columns} rows={visibleRows} emptyMessage="No layers matched this scope and filter." />
            {remaining > 0 ? <div className="cdt-text-muted">+{remaining} more will also be renamed.</div> : null}
          </>
        )}
      </div>
    </div>
  );
}
