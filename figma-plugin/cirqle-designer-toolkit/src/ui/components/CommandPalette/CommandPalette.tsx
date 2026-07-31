import { useEffect, useMemo, useRef, useState } from 'react';
import { MODULES, type ModuleMeta } from '@shared/constants';
import type { ViewId } from '@shared/types';
import { useToolkitStore } from '@ui/state/store';
import { useSettings } from '@ui/state/useSettings';
import { Icon, type IconName } from '@ui/components/common/Icon';
import { isHidden, rankedForPalette } from '@ui/lib/toolOrganizer';

interface PaletteEntry {
  id: ViewId;
  label: string;
  description: string;
  icon: IconName;
  shortcut?: string;
  hidden?: boolean;
}

const HOME_ENTRY: PaletteEntry = {
  id: 'home',
  label: 'Home',
  description: 'Your pinned and most-used tools.',
  icon: 'home',
  shortcut: '⌘⇧H',
};

export function CommandPalette() {
  const open = useToolkitStore((s) => s.commandPaletteOpen);
  const setOpen = useToolkitStore((s) => s.setCommandPaletteOpen);
  const setActiveModule = useToolkitStore((s) => s.setActiveModule);
  const { settings } = useSettings();
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // The palette always searches everything, hidden tools included — hiding
  // only trims the main interface. Empty query = pinned/most-used first.
  const results = useMemo<PaletteEntry[]>(() => {
    const toEntry = (m: ModuleMeta): PaletteEntry => ({
      id: m.id,
      label: m.label,
      description: m.description,
      icon: m.icon as IconName,
      shortcut: m.shortcut,
      hidden: m.id !== 'settings' && isHidden(settings, m.id),
    });
    const q = query.trim().toLowerCase();
    if (!q) return [HOME_ENTRY, ...rankedForPalette(settings).map(toEntry)];
    const scored = [HOME_ENTRY, ...MODULES.map(toEntry)]
      .map((entry) => {
        const hay = `${entry.label} ${entry.description}`.toLowerCase();
        return { entry, score: hay.indexOf(q) };
      })
      .filter((r) => r.score >= 0);
    scored.sort((a, b) => a.score - b.score);
    return scored.map((r) => r.entry);
  }, [query, settings]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlight(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const choose = (index: number) => {
    const target = results[index];
    if (!target) return;
    setActiveModule(target.id);
    setOpen(false);
  };

  return (
    <div className="cdt-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="cdt-command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cdt-command-palette__input">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search tools and actions…"
            onChange={(e) => { setQuery(e.target.value); setHighlight(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, results.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
              if (e.key === 'Enter') { e.preventDefault(); choose(highlight); }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="cdt-command-palette__list">
          {results.length === 0 && <div className="cdt-command-palette__empty">No matches.</div>}
          {results.map((entry, i) => (
            <button
              key={entry.id}
              className={['cdt-command-palette__item', i === highlight ? 'cdt-command-palette__item--active' : ''].join(' ')}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => choose(i)}
            >
              <Icon name={entry.icon} size={16} />
              <span className="cdt-command-palette__item-label">{entry.label}</span>
              <span className="cdt-command-palette__item-desc">{entry.description}</span>
              {entry.hidden ? <span className="cdt-badge cdt-badge--info">Hidden</span> : null}
              {entry.shortcut ? <kbd>{entry.shortcut}</kbd> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
