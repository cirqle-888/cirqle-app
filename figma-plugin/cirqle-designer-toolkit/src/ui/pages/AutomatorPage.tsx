import { useCallback, useEffect, useState } from 'react';
import type { OperationResult, RunScope } from '@shared/types';
import { usePluginMessage } from '@ui/hooks/usePluginMessage';
import { usePluginEvent } from '@ui/hooks/usePluginEvent';
import { useToolkitStore } from '@ui/state/store';
import { Button, IconButton } from '@ui/components/common/Button';
import { ProgressBar } from '@ui/components/common/ProgressBar';
import { Modal } from '@ui/components/common/Modal';
import { EmptyState } from '@ui/components/common/EmptyState';

// ---------------------------------------------------------------------------
// Wire-shape types mirrored from src/main/modules/automator/actions/actionTypes.ts
// (and macroStorage.ts). UI code (this file) runs in a browser iframe and
// must never import from src/main/** (different runtime, no `figma` global
// there) — so these are duplicated on purpose, same pattern RenamePage.tsx /
// SettingsPage.tsx use. Keep in sync with actionTypes.ts if those shapes
// change.
// ---------------------------------------------------------------------------
type ActionType =
  | 'rename'
  | 'resize'
  | 'move'
  | 'align'
  | 'distribute'
  | 'rotate'
  | 'scale'
  | 'roundCorners'
  | 'replaceColor'
  | 'replaceFont'
  | 'replaceImage'
  | 'swapComponent'
  | 'createComponent'
  | 'applyAutoLayout'
  | 'updateVariable'
  | 'export'
  | 'duplicate'
  | 'delete'
  | 'group'
  | 'ungroup';

interface MacroStep {
  actionType: ActionType;
  params: Record<string, unknown>;
}

interface Macro {
  id: string;
  name: string;
  description: string;
  steps: MacroStep[];
  createdAt: number;
  updatedAt: number;
}

type RunFn = <TResult = unknown>(action: string, payload?: unknown) => Promise<TResult>;

const ACTION_TYPES: ActionType[] = [
  'rename',
  'resize',
  'move',
  'align',
  'distribute',
  'rotate',
  'scale',
  'roundCorners',
  'replaceColor',
  'replaceFont',
  'replaceImage',
  'swapComponent',
  'createComponent',
  'applyAutoLayout',
  'updateVariable',
  'export',
  'duplicate',
  'delete',
  'group',
  'ungroup',
];

const ACTION_LABELS: Record<ActionType, string> = {
  rename: 'Rename',
  resize: 'Resize',
  move: 'Move',
  align: 'Align',
  distribute: 'Distribute',
  rotate: 'Rotate',
  scale: 'Scale',
  roundCorners: 'Round corners',
  replaceColor: 'Replace colour',
  replaceFont: 'Replace font',
  replaceImage: 'Replace image',
  swapComponent: 'Swap component',
  createComponent: 'Create component',
  applyAutoLayout: 'Apply auto layout',
  updateVariable: 'Update variable',
  export: 'Export',
  duplicate: 'Duplicate',
  delete: 'Delete',
  group: 'Group',
  ungroup: 'Ungroup',
};

type FieldType = 'text' | 'number' | 'select' | 'file';

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  placeholder?: string;
}

// Deliberately hand-written per action rather than schema-driven — every
// action's params object (actionTypes.ts) is small, so this list is easy to
// keep in sync and avoids building a generic JSON-schema form renderer for
// only 20 shapes.
const ACTION_FIELDS: Record<ActionType, FieldDef[]> = {
  rename: [
    { key: 'pattern', label: 'Pattern (use {n} or {nn} for numbering)', type: 'text', placeholder: 'Layer {n}' },
    { key: 'start', label: 'Start at', type: 'number' },
    { key: 'padding', label: 'Zero-pad width (0 = off)', type: 'number' },
  ],
  resize: [
    { key: 'mode', label: 'Mode', type: 'select', options: ['absolute', 'percentage'] },
    { key: 'width', label: 'Width (absolute mode)', type: 'number' },
    { key: 'height', label: 'Height (absolute mode)', type: 'number' },
    { key: 'percentage', label: 'Percentage (percentage mode)', type: 'number' },
  ],
  move: [
    { key: 'dx', label: 'Delta X', type: 'number' },
    { key: 'dy', label: 'Delta Y', type: 'number' },
  ],
  align: [{ key: 'mode', label: 'Align', type: 'select', options: ['left', 'right', 'center-h', 'top', 'bottom', 'center-v'] }],
  distribute: [{ key: 'axis', label: 'Axis', type: 'select', options: ['horizontal', 'vertical'] }],
  rotate: [{ key: 'degrees', label: 'Degrees', type: 'number' }],
  scale: [{ key: 'factor', label: 'Factor (1 = 100%)', type: 'number' }],
  roundCorners: [{ key: 'radius', label: 'Radius', type: 'number' }],
  replaceColor: [
    { key: 'fromHex', label: 'From colour (hex)', type: 'text', placeholder: '#FF0000' },
    { key: 'toHex', label: 'To colour (hex)', type: 'text', placeholder: '#00FF00' },
    { key: 'tolerance', label: 'Tolerance (0-255 per channel)', type: 'number' },
  ],
  replaceFont: [
    { key: 'fromFamily', label: 'From family', type: 'text' },
    { key: 'fromStyle', label: 'From style', type: 'text', placeholder: 'Regular' },
    { key: 'toFamily', label: 'To family', type: 'text' },
    { key: 'toStyle', label: 'To style', type: 'text', placeholder: 'Regular' },
  ],
  replaceImage: [
    { key: 'imageFile', label: 'Replacement image', type: 'file' },
    { key: 'targetImageHash', label: 'Target image hash (blank = all image fills)', type: 'text' },
  ],
  swapComponent: [{ key: 'targetComponentId', label: 'Target component node id', type: 'text', placeholder: 'e.g. 123:456' }],
  createComponent: [{ key: 'namePrefix', label: 'Name prefix (optional)', type: 'text' }],
  applyAutoLayout: [
    { key: 'direction', label: 'Direction', type: 'select', options: ['HORIZONTAL', 'VERTICAL'] },
    { key: 'itemSpacing', label: 'Item spacing', type: 'number' },
    { key: 'padding', label: 'Padding (all sides)', type: 'number' },
  ],
  updateVariable: [
    { key: 'variableId', label: 'Variable id', type: 'text' },
    { key: 'field', label: 'Bound field (e.g. "fills", "width")', type: 'text' },
  ],
  export: [
    { key: 'format', label: 'Format', type: 'select', options: ['PNG', 'JPG', 'SVG', 'PDF'] },
    { key: 'scale', label: 'Scale', type: 'number' },
  ],
  duplicate: [
    { key: 'offsetX', label: 'Offset X', type: 'number' },
    { key: 'offsetY', label: 'Offset Y', type: 'number' },
  ],
  delete: [],
  group: [],
  ungroup: [],
};

const DEFAULT_PARAMS: Record<ActionType, Record<string, unknown>> = {
  rename: { pattern: 'Layer {n}', start: 1, padding: 0 },
  resize: { mode: 'absolute', width: 100, height: 100, percentage: 100 },
  move: { dx: 0, dy: 0 },
  align: { mode: 'left' },
  distribute: { axis: 'horizontal' },
  rotate: { degrees: 0 },
  scale: { factor: 1 },
  roundCorners: { radius: 8 },
  replaceColor: { fromHex: '#FF0000', toHex: '#00FF00', tolerance: 10 },
  replaceFont: { fromFamily: '', fromStyle: 'Regular', toFamily: '', toStyle: 'Regular' },
  replaceImage: { imageBytes: [], targetImageHash: '' },
  swapComponent: { targetComponentId: '' },
  createComponent: { namePrefix: '' },
  applyAutoLayout: { direction: 'VERTICAL', itemSpacing: 8, padding: 16 },
  updateVariable: { variableId: '', field: 'fills' },
  export: { format: 'PNG', scale: 1 },
  duplicate: { offsetX: 16, offsetY: 16 },
  delete: {},
  group: {},
  ungroup: {},
};

function defaultParamsFor(actionType: ActionType): Record<string, unknown> {
  return { ...DEFAULT_PARAMS[actionType] };
}

function downloadBytes(bytes: number[], filename: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadJson(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
function ScopePicker({ scope, onChange }: { scope: RunScope['scope']; onChange: (s: RunScope['scope']) => void }) {
  const selectionCount = useToolkitStore((s) => s.selectionCount);
  return (
    <div className="cdt-field">
      <label htmlFor="automator-scope">Scope</label>
      <select id="automator-scope" className="cdt-select" value={scope} onChange={(e) => onChange(e.target.value as RunScope['scope'])}>
        <option value="selection">Current selection ({selectionCount})</option>
        <option value="page">Current page</option>
        <option value="document">Entire document</option>
      </select>
    </div>
  );
}

function WarningsList({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  const CAP = 50;
  return (
    <div className="cdt-card">
      <div className="cdt-section__title">Warnings ({warnings.length})</div>
      <ul style={{ margin: 0, paddingLeft: 16, maxHeight: 200, overflowY: 'auto' }}>
        {warnings.slice(0, CAP).map((w, i) => (
          <li key={i} className="cdt-text-muted">
            {w}
          </li>
        ))}
      </ul>
      {warnings.length > CAP ? <div className="cdt-text-muted">…and {warnings.length - CAP} more.</div> : null}
    </div>
  );
}

function ParamsForm({
  actionType,
  params,
  onChange,
}: {
  actionType: ActionType;
  params: Record<string, unknown>;
  onChange: (p: Record<string, unknown>) => void;
}) {
  const fields = ACTION_FIELDS[actionType];
  if (fields.length === 0) {
    return <div className="cdt-text-muted">This action has no parameters — it runs directly on the resolved scope.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {fields.map((field) => {
        const id = `${actionType}-${field.key}`;
        if (field.type === 'select') {
          const value = typeof params[field.key] === 'string' ? (params[field.key] as string) : (field.options?.[0] ?? '');
          return (
            <div className="cdt-field" key={field.key}>
              <label htmlFor={id}>{field.label}</label>
              <select id={id} className="cdt-select" value={value} onChange={(e) => onChange({ ...params, [field.key]: e.target.value })}>
                {field.options?.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
          );
        }
        if (field.type === 'number') {
          const value = typeof params[field.key] === 'number' ? (params[field.key] as number) : '';
          return (
            <div className="cdt-field" key={field.key}>
              <label htmlFor={id}>{field.label}</label>
              <input
                id={id}
                className="cdt-input"
                type="number"
                value={value}
                onChange={(e) => onChange({ ...params, [field.key]: e.target.value === '' ? undefined : Number(e.target.value) })}
              />
            </div>
          );
        }
        if (field.type === 'file') {
          return (
            <div className="cdt-field" key={field.key}>
              <label htmlFor={id}>{field.label}</label>
              <input
                id={id}
                className="cdt-input"
                type="file"
                accept="image/*"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const buffer = await file.arrayBuffer();
                  onChange({ ...params, imageBytes: Array.from(new Uint8Array(buffer)) });
                }}
              />
              {Array.isArray(params.imageBytes) && (params.imageBytes as unknown[]).length > 0 ? (
                <span className="cdt-text-muted">Image loaded ({(params.imageBytes as unknown[]).length} bytes).</span>
              ) : null}
            </div>
          );
        }
        const value = typeof params[field.key] === 'string' ? (params[field.key] as string) : '';
        return (
          <div className="cdt-field" key={field.key}>
            <label htmlFor={id}>{field.label}</label>
            <input
              id={id}
              className="cdt-input"
              type="text"
              placeholder={field.placeholder}
              value={value}
              onChange={(e) => onChange({ ...params, [field.key]: e.target.value })}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Run once" tab
// ---------------------------------------------------------------------------
function RunOnceTab() {
  const { run, cancel, loading, progress } = usePluginMessage('automator');
  const pushToast = useToolkitStore((s) => s.pushToast);

  const [scope, setScope] = useState<RunScope['scope']>('selection');
  const [actionType, setActionType] = useState<ActionType>('rename');
  const [params, setParams] = useState<Record<string, unknown>>(() => defaultParamsFor('rename'));
  const [warnings, setWarnings] = useState<string[]>([]);
  const [lastResult, setLastResult] = useState<{ affectedCount: number; durationMs: number } | null>(null);

  useEffect(() => {
    setParams(defaultParamsFor(actionType));
    setWarnings([]);
    setLastResult(null);
  }, [actionType]);

  // 'export' (single-action) results stream back as postEvent payloads
  // (see actionRegistry.ts's exportAction — the {affected,warnings} return
  // shape can't carry bytes) — turn each into a browser download.
  const onExportResult = useCallback((payload: { nodeName: string; format: string; bytes: number[] }) => {
    downloadBytes(payload.bytes, `${payload.nodeName}.${payload.format.toLowerCase()}`);
  }, []);
  usePluginEvent<{ nodeName: string; format: string; bytes: number[] }>('automator', 'exportResult', onExportResult);

  const runOnce = async () => {
    setWarnings([]);
    setLastResult(null);
    try {
      const result = await run<OperationResult>('runAction', { actionType, params, scope });
      setWarnings(result.warnings ?? []);
      setLastResult({ affectedCount: result.affectedCount, durationMs: result.durationMs });
      pushToast({
        variant: (result.warnings?.length ?? 0) > 0 ? 'warning' : 'success',
        title: `${ACTION_LABELS[actionType]} complete`,
        description: `${result.affectedCount} node(s) affected${result.warnings?.length ? `, ${result.warnings.length} warning(s)` : ''}`,
      });
    } catch (err) {
      pushToast({ variant: 'error', title: 'Action failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="cdt-section">
      <div className="cdt-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <ScopePicker scope={scope} onChange={setScope} />
        <div className="cdt-field">
          <label htmlFor="run-once-action">Action</label>
          <select
            id="run-once-action"
            className="cdt-select"
            value={actionType}
            onChange={(e) => setActionType(e.target.value as ActionType)}
          >
            {ACTION_TYPES.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABELS[a]}
              </option>
            ))}
          </select>
        </div>
        <ParamsForm actionType={actionType} params={params} onChange={setParams} />
        <div className="cdt-row">
          <Button variant="primary" icon="play" onClick={runOnce} loading={loading}>
            Run
          </Button>
          {loading ? (
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          ) : null}
        </div>
        {loading ? <ProgressBar progress={progress} /> : null}
      </div>

      {lastResult ? (
        <div className="cdt-text-muted">
          Affected {lastResult.affectedCount} node(s) in {lastResult.durationMs}ms.
        </div>
      ) : null}

      <WarningsList warnings={warnings} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Macro builder modal — add/reorder/remove steps, reusing ParamsForm
// ---------------------------------------------------------------------------
function MacroBuilderModal({
  macro,
  run,
  onClose,
  onSaved,
}: {
  macro: Macro | null;
  run: RunFn;
  onClose: () => void;
  onSaved: () => void;
}) {
  const pushToast = useToolkitStore((s) => s.pushToast);
  const [name, setName] = useState(macro?.name ?? '');
  const [description, setDescription] = useState(macro?.description ?? '');
  const [steps, setSteps] = useState<MacroStep[]>(
    macro?.steps.map((s) => ({ actionType: s.actionType, params: { ...s.params } })) ?? []
  );
  const [draftAction, setDraftAction] = useState<ActionType>('rename');
  const [saving, setSaving] = useState(false);

  const addStep = () => setSteps((prev) => [...prev, { actionType: draftAction, params: defaultParamsFor(draftAction) }]);
  const removeStep = (index: number) => setSteps((prev) => prev.filter((_, i) => i !== index));
  const moveStep = (index: number, dir: -1 | 1) => {
    setSteps((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      return next;
    });
  };
  const updateStepParams = (index: number, next: Record<string, unknown>) =>
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, params: next } : s)));

  const save = async () => {
    if (!name.trim()) {
      pushToast({ variant: 'error', title: 'Macro needs a name' });
      return;
    }
    if (steps.length === 0) {
      pushToast({ variant: 'error', title: 'Macro needs at least one step' });
      return;
    }
    setSaving(true);
    try {
      await run('saveMacro', { id: macro?.id, name: name.trim(), description, steps });
      pushToast({ variant: 'success', title: macro ? 'Macro updated' : 'Macro created' });
      onSaved();
    } catch (err) {
      pushToast({ variant: 'error', title: 'Save failed', description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={macro ? `Edit "${macro.name}"` : 'New macro'} onClose={onClose} wide>
      <div className="cdt-field">
        <label htmlFor="macro-name">Name</label>
        <input id="macro-name" className="cdt-input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="cdt-field">
        <label htmlFor="macro-desc">Description</label>
        <input id="macro-desc" className="cdt-input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div className="cdt-section__title">Steps</div>
      {steps.length === 0 ? (
        <div className="cdt-text-muted">No steps yet — pick an action below and add one.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {steps.map((step, i) => (
            <div className="cdt-card" key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="cdt-row cdt-row--between">
                <strong>
                  {i + 1}. {ACTION_LABELS[step.actionType]}
                </strong>
                <div className="cdt-row">
                  <IconButton icon="chevron-right" label="Move up" style={{ transform: 'rotate(-90deg)' }} onClick={() => moveStep(i, -1)} disabled={i === 0} />
                  <IconButton icon="chevron-right" label="Move down" style={{ transform: 'rotate(90deg)' }} onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} />
                  <IconButton icon="trash" label="Remove step" onClick={() => removeStep(i)} />
                </div>
              </div>
              <ParamsForm actionType={step.actionType} params={step.params} onChange={(p) => updateStepParams(i, p)} />
            </div>
          ))}
        </div>
      )}

      <div className="cdt-row">
        <select className="cdt-select" value={draftAction} onChange={(e) => setDraftAction(e.target.value as ActionType)}>
          {ACTION_TYPES.map((a) => (
            <option key={a} value={a}>
              {ACTION_LABELS[a]}
            </option>
          ))}
        </select>
        <Button variant="ghost" icon="plus" onClick={addStep}>
          Add step
        </Button>
      </div>

      <div className="cdt-modal__actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save} loading={saving}>
          Save macro
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// "Macros" tab
// ---------------------------------------------------------------------------
function MacrosTab() {
  const { run, cancel, loading, progress } = usePluginMessage('automator');
  const pushToast = useToolkitStore((s) => s.pushToast);
  const requestConfirm = useToolkitStore((s) => s.requestConfirm);

  const [macros, setMacros] = useState<Macro[]>([]);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingMacro, setEditingMacro] = useState<Macro | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [runModal, setRunModal] = useState<Macro | null>(null);
  const [runScope, setRunScope] = useState<RunScope['scope']>('selection');
  const [stopOnError, setStopOnError] = useState(true);
  const [runWarnings, setRunWarnings] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    const list = await run<Macro[]>('listMacros');
    setMacros(list);
  }, [run]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount, refresh() is stable enough here
  }, []);

  const handleDelete = async (macro: Macro) => {
    const confirmed = await requestConfirm({
      title: `Delete macro "${macro.name}"?`,
      description: 'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    const next = await run<Macro[]>('deleteMacro', { id: macro.id });
    setMacros(next);
    pushToast({ variant: 'success', title: 'Macro deleted' });
  };

  const handleDuplicate = async (macro: Macro) => {
    await run('duplicateMacro', { id: macro.id });
    await refresh();
    pushToast({ variant: 'success', title: 'Macro duplicated' });
  };

  const handleExportDownload = async (macro: Macro) => {
    const full = await run<Macro>('exportMacro', { id: macro.id });
    downloadJson(full, `${macro.name.replace(/[^a-z0-9-_]+/gi, '_') || 'macro'}.json`);
  };

  // There's no backend to "share" a macro through (manifest.json's
  // networkAccess is "none") — this is a plain JSON copy of the macro, to
  // be pasted into "Import" on another file/machine. It is intentionally
  // not a real link or sync mechanism.
  const handleCopyClipboard = async (macro: Macro) => {
    const full = await run<Macro>('exportMacro', { id: macro.id });
    try {
      await navigator.clipboard.writeText(JSON.stringify(full));
      pushToast({ variant: 'success', title: 'Macro JSON copied to clipboard' });
    } catch (err) {
      pushToast({ variant: 'error', title: 'Clipboard copy failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleImport = async () => {
    try {
      const parsed: unknown = JSON.parse(importText);
      await run('importMacro', { macro: parsed });
      setImportText('');
      setImportOpen(false);
      await refresh();
      pushToast({ variant: 'success', title: 'Macro imported' });
    } catch (err) {
      pushToast({ variant: 'error', title: 'Import failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleRun = async (macro: Macro) => {
    setRunWarnings([]);
    try {
      const result = await run<OperationResult<{ stoppedEarly: boolean }>>('runMacro', {
        macroId: macro.id,
        scope: runScope,
        stopOnError,
      });
      setRunWarnings(result.warnings ?? []);
      pushToast({
        variant: (result.warnings?.length ?? 0) > 0 ? 'warning' : 'success',
        title: `Macro "${macro.name}" complete`,
        description: `${result.affectedCount} node-op(s) affected${result.data?.stoppedEarly ? ' — stopped early' : ''}`,
      });
    } catch (err) {
      pushToast({ variant: 'error', title: 'Macro failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="cdt-section">
      <div className="cdt-row cdt-row--between">
        <div className="cdt-section__title">Saved macros</div>
        <div className="cdt-row">
          <Button
            variant="ghost"
            icon="plus"
            onClick={() => {
              setEditingMacro(null);
              setBuilderOpen(true);
            }}
          >
            New macro
          </Button>
          <Button variant="ghost" icon="download" onClick={() => setImportOpen(true)}>
            Import
          </Button>
        </div>
      </div>

      {macros.length === 0 ? (
        <EmptyState
          icon="automator"
          title="No macros yet"
          description="Build a reusable multi-step macro to run across a selection, page or the whole document."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {macros.map((macro) => (
            <div className="cdt-card" key={macro.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="cdt-row cdt-row--between">
                <div>
                  <div style={{ fontWeight: 600 }}>{macro.name}</div>
                  {macro.description ? <div className="cdt-text-muted">{macro.description}</div> : null}
                  <div className="cdt-text-muted">
                    {macro.steps.length} step{macro.steps.length === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="cdt-row">
                  <IconButton icon="play" label="Run" onClick={() => setRunModal(macro)} />
                  <IconButton
                    icon="chevron-right"
                    label="Edit"
                    onClick={() => {
                      setEditingMacro(macro);
                      setBuilderOpen(true);
                    }}
                  />
                  <IconButton icon="refresh" label="Duplicate" onClick={() => handleDuplicate(macro)} />
                  <IconButton icon="download" label="Export as JSON file" onClick={() => handleExportDownload(macro)} />
                  <IconButton icon="check" label="Copy JSON to clipboard" onClick={() => handleCopyClipboard(macro)} />
                  <IconButton icon="trash" label="Delete" onClick={() => handleDelete(macro)} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {builderOpen ? (
        <MacroBuilderModal
          macro={editingMacro}
          run={run}
          onClose={() => setBuilderOpen(false)}
          onSaved={async () => {
            setBuilderOpen(false);
            await refresh();
          }}
        />
      ) : null}

      {importOpen ? (
        <Modal title="Import macro" onClose={() => setImportOpen(false)}>
          <div className="cdt-field">
            <label htmlFor="import-json">Paste macro JSON</label>
            <textarea
              id="import-json"
              className="cdt-textarea"
              rows={10}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder='{"name": "…", "steps": [{ "actionType": "rename", "params": { … } }]}'
            />
          </div>
          <div className="cdt-modal__actions">
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleImport} disabled={!importText.trim()}>
              Import
            </Button>
          </div>
        </Modal>
      ) : null}

      {runModal ? (
        <Modal title={`Run "${runModal.name}"`} onClose={() => setRunModal(null)}>
          <ScopePicker scope={runScope} onChange={setRunScope} />
          <label className="cdt-checkbox-row">
            <input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} />
            Stop early if a step fails on every node
          </label>
          <div className="cdt-row">
            <Button variant="primary" icon="play" loading={loading} onClick={() => handleRun(runModal)}>
              Run macro
            </Button>
            {loading ? (
              <Button variant="ghost" onClick={cancel}>
                Cancel
              </Button>
            ) : null}
          </div>
          {loading ? <ProgressBar progress={progress} /> : null}
          <WarningsList warnings={runWarnings} />
        </Modal>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function AutomatorPage() {
  const [tab, setTab] = useState<'run' | 'macros'>('run');

  return (
    <div>
      <div className="cdt-row" style={{ marginBottom: 16, gap: 4 }}>
        <Button variant={tab === 'run' ? 'primary' : 'ghost'} onClick={() => setTab('run')}>
          Run once
        </Button>
        <Button variant={tab === 'macros' ? 'primary' : 'ghost'} onClick={() => setTab('macros')}>
          Macros
        </Button>
      </div>
      {tab === 'run' ? <RunOnceTab /> : <MacrosTab />}
    </div>
  );
}
