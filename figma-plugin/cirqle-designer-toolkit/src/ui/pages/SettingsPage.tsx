import { useEffect, useState } from 'react';
import { useSettings } from '@ui/state/useSettings';
import { useToolkitStore, type SettingsTab } from '@ui/state/store';
import { requestPlugin } from '@ui/lib/bridge';
import { Button, IconButton } from '@ui/components/common/Button';
import { EmptyState } from '@ui/components/common/EmptyState';
import { Icon, type IconName } from '@ui/components/common/Icon';
import { ORGANIZABLE_MODULES, isHidden, isPinned, usageOf } from '@ui/lib/toolOrganizer';
import type { HistoryEntry, ModuleId, ThemeMode } from '@shared/types';

// Mirrors src/main/utils/logger.ts's LogEntry shape. Duplicated on purpose —
// UI files must never import from src/main/** (different runtime, no DOM
// there), so cross-boundary types are small and copied, not shared.
interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
  data?: unknown;
}

const SHORTCUTS: Array<{ combo: string; description: string }> = [
  { combo: '⌘ / Ctrl + K', description: 'Open the command palette' },
  { combo: '⌘ / Ctrl + Shift + H', description: 'Go to Home' },
  { combo: '⌘ / Ctrl + ,', description: 'Open Settings' },
  { combo: '⌘ / Ctrl + Shift + R', description: 'Open Bulk Rename' },
  { combo: '⌘ / Ctrl + Shift + C', description: 'Open Cleaner' },
  { combo: '⌘ / Ctrl + Shift + A', description: 'Open Accessibility Checker' },
  { combo: '⌘ / Ctrl + Shift + M', description: 'Open Automator' },
  { combo: '⌘ / Ctrl + Shift + V', description: 'Open Template Validator' },
  { combo: '⌘ / Ctrl + Shift + E', description: 'Open Export Manager' },
  { combo: 'Esc', description: 'Close the command palette / active dialog' },
];

export function SettingsPage() {
  const { settings, update, reset } = useSettings();
  const pushToast = useToolkitStore((s) => s.pushToast);
  const requestConfirm = useToolkitStore((s) => s.requestConfirm);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [activity, setActivity] = useState<LogEntry[]>([]);
  // Tab lives in the store so other views (Home's "Manage tools") can land
  // directly on a specific tab.
  const tab = useToolkitStore((s) => s.settingsTab);
  const setTab = useToolkitStore((s) => s.setSettingsTab);

  useEffect(() => {
    requestPlugin<HistoryEntry[]>('system', 'getHistory').promise.then(setHistory).catch(() => undefined);
    requestPlugin<LogEntry[]>('system', 'getActivityLog', { limit: 150 }).promise.then(setActivity).catch(() => undefined);
  }, []);

  const clearHistory = async () => {
    const confirmed = await requestConfirm({
      title: 'Clear history?',
      description: 'This removes the local record of past operations. It does not undo anything already applied.',
      confirmLabel: 'Clear history',
      destructive: true,
    });
    if (!confirmed) return;
    const next = await requestPlugin<HistoryEntry[]>('system', 'clearHistory').promise;
    setHistory(next);
    pushToast({ variant: 'success', title: 'History cleared' });
  };

  const doReset = async () => {
    const confirmed = await requestConfirm({
      title: 'Reset all settings?',
      description: 'Theme, performance mode, pinned tools and favourites all go back to their defaults.',
      confirmLabel: 'Reset',
      destructive: true,
    });
    if (!confirmed) return;
    await reset();
    pushToast({ variant: 'success', title: 'Settings reset to defaults' });
  };

  return (
    <div>
      <div className="cdt-row" style={{ marginBottom: 16, gap: 4 }}>
        {(['general', 'tools', 'history', 'activity', 'shortcuts'] as const satisfies readonly SettingsTab[]).map((t) => (
          <Button key={t} variant={tab === t ? 'primary' : 'ghost'} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </Button>
        ))}
      </div>

      {tab === 'tools' && <ToolsTab />}

      {tab === 'general' && (
        <div className="cdt-section">
          <div className="cdt-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="cdt-field">
              <label htmlFor="theme">Theme</label>
              <select
                id="theme"
                className="cdt-select"
                value={settings.theme}
                onChange={(e) => update({ theme: e.target.value as ThemeMode })}
              >
                <option value="system">Match Figma / system</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>

            <div className="cdt-field">
              <label htmlFor="language">Language</label>
              <select
                id="language"
                className="cdt-select"
                value={settings.language}
                onChange={(e) => update({ language: e.target.value })}
              >
                <option value="en">English</option>
              </select>
              <span className="cdt-text-muted">More languages are on the roadmap — see docs/ROADMAP.md.</span>
            </div>

            <div className="cdt-field">
              <label htmlFor="perf">Performance mode</label>
              <select
                id="perf"
                className="cdt-select"
                value={settings.performanceMode}
                onChange={(e) => update({ performanceMode: e.target.value as typeof settings.performanceMode })}
              >
                <option value="auto">Auto (recommended)</option>
                <option value="balanced">Balanced — smaller chunks, more UI updates</option>
                <option value="max-performance">Max performance — larger chunks, fewer UI updates</option>
              </select>
            </div>

            <div className="cdt-field">
              <label htmlFor="chunk">Chunk size ({settings.chunkSize} nodes per batch)</label>
              <input
                id="chunk"
                type="range"
                min={50}
                max={1000}
                step={50}
                value={settings.chunkSize}
                onChange={(e) => update({ chunkSize: Number(e.target.value) })}
              />
              <span className="cdt-text-muted">
                Larger batches finish faster but repaint Figma less often. Lower this if the UI feels sluggish during a scan.
              </span>
            </div>

            <div className="cdt-checkbox-row">
              <input
                id="autosave"
                type="checkbox"
                checked={settings.autoSave}
                onChange={(e) => update({ autoSave: e.target.checked })}
              />
              <label htmlFor="autosave">Auto-save macros and rename presets as you edit them</label>
            </div>

            <div className="cdt-field">
              <label htmlFor="history-count">Keep last N history entries ({settings.keepHistoryCount})</label>
              <input
                id="history-count"
                type="range"
                min={10}
                max={500}
                step={10}
                value={settings.keepHistoryCount}
                onChange={(e) => update({ keepHistoryCount: Number(e.target.value) })}
              />
            </div>
          </div>

          <Button variant="danger" onClick={doReset}>
            Reset all settings
          </Button>
        </div>
      )}

      {tab === 'history' && (
        <div className="cdt-section">
          <div className="cdt-row cdt-row--between">
            <div className="cdt-section__title">Operation history</div>
            <Button variant="ghost" icon="trash" onClick={clearHistory}>Clear</Button>
          </div>
          {history.length === 0 ? (
            <EmptyState icon="undo" title="No operations yet" description="Actions from any module that change your file will show up here." />
          ) : (
            <div className="cdt-table-wrap">
              <table className="cdt-table">
                <thead>
                  <tr><th>When</th><th>Module</th><th>Action</th><th>Summary</th><th>Affected</th></tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>{new Date(h.timestamp).toLocaleString()}</td>
                      <td>{h.module}</td>
                      <td>{h.action}</td>
                      <td>{h.summary}</td>
                      <td>{h.affectedNodeIds.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'activity' && (
        <div className="cdt-section">
          <div className="cdt-section__title">Activity log</div>
          <div className="cdt-text-muted" style={{ marginBottom: 8 }}>
            Low-level log from the plugin backend — most useful when reporting a bug.
          </div>
          {activity.length === 0 ? (
            <EmptyState icon="info" title="Nothing logged yet" />
          ) : (
            <div className="cdt-card" style={{ fontFamily: 'monospace', fontSize: 10, maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {activity.map((entry, i) => (
                <div key={i}>
                  <span className="cdt-text-muted">{new Date(entry.timestamp).toLocaleTimeString()}</span>{' '}
                  <strong>[{entry.level}]</strong> {entry.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'shortcuts' && (
        <div className="cdt-section">
          <div className="cdt-section__title">Keyboard shortcuts</div>
          <div className="cdt-table-wrap">
            <table className="cdt-table">
              <thead><tr><th style={{ width: 160 }}>Shortcut</th><th>Action</th></tr></thead>
              <tbody>
                {SHORTCUTS.map((s) => (
                  <tr key={s.combo}><td><kbd>{s.combo}</kbd></td><td>{s.description}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** Pin, hide and usage management — decides what the main interface shows.
 * Hiding never disables a tool: it stays reachable from search and ⌘K. */
function ToolsTab() {
  const { settings, update } = useSettings();
  const pushToast = useToolkitStore((s) => s.pushToast);
  const requestConfirm = useToolkitStore((s) => s.requestConfirm);

  const togglePin = (id: ModuleId) => {
    const next = isPinned(settings, id)
      ? settings.pinnedTools.filter((t) => t !== id)
      : [...settings.pinnedTools, id];
    void update({ pinnedTools: next });
  };

  const toggleHidden = (id: ModuleId) => {
    const hidden = settings.hiddenTools ?? [];
    const next = hidden.includes(id) ? hidden.filter((t) => t !== id) : [...hidden, id];
    void update({ hiddenTools: next });
  };

  const resetUsage = async () => {
    const confirmed = await requestConfirm({
      title: 'Reset usage data?',
      description:
        'Open counts and the recently-used list go back to zero, so the sidebar and Home stop ranking tools until you use them again. Pins and hidden tools are kept.',
      confirmLabel: 'Reset usage',
      destructive: true,
    });
    if (!confirmed) return;
    await update({ usageCounts: {}, recentlyUsed: [] });
    pushToast({ variant: 'success', title: 'Usage data reset' });
  };

  return (
    <div className="cdt-section">
      <div className="cdt-text-muted">
        The sidebar and Home organise themselves around what you pin and use. Hide a tool to remove it from the main
        interface — it stays available from search and the ⌘K palette.
      </div>
      <div className="cdt-tool-rows">
        {ORGANIZABLE_MODULES.map((m) => {
          const pinned = isPinned(settings, m.id);
          const hidden = isHidden(settings, m.id);
          const opens = usageOf(settings, m.id);
          return (
            <div key={m.id} className={['cdt-tool-row', hidden ? 'cdt-tool-row--hidden' : ''].join(' ')}>
              <Icon name={m.icon as IconName} size={14} />
              <span className="cdt-tool-row__label">{m.label}</span>
              {opens > 0 && <span className="cdt-tool-row__opens">{opens}×</span>}
              <IconButton
                icon="star"
                label={pinned ? `Unpin ${m.label}` : `Pin ${m.label}`}
                className={pinned ? 'cdt-icon-btn--brand' : undefined}
                onClick={() => togglePin(m.id)}
              />
              <IconButton
                icon={hidden ? 'eye-off' : 'eye'}
                label={hidden ? `Show ${m.label} in the main interface` : `Hide ${m.label} from the main interface`}
                onClick={() => toggleHidden(m.id)}
              />
            </div>
          );
        })}
      </div>
      <div>
        <Button variant="ghost" icon="refresh" onClick={resetUsage}>
          Reset usage data
        </Button>
      </div>
    </div>
  );
}
