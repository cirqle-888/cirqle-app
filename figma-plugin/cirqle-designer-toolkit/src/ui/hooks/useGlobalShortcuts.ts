import { useEffect } from 'react';
import { useToolkitStore } from '@ui/state/store';
import type { ViewId } from '@shared/types';

/** Maps a shortcut's letter key to the view it opens. Kept as a plain
 * table (not a parser of the display strings in constants.ts) so the two
 * can't silently drift — MODULES.shortcut is for display, this is for
 * behaviour, and Module 11 (Shortcuts docs) lists both. */
const SHIFT_META_SHORTCUTS: Record<string, ViewId> = {
  h: 'home',
  r: 'rename',
  c: 'cleaner',
  a: 'accessibility',
  m: 'automator',
  v: 'templateValidator',
  e: 'exportManager',
};

export function useGlobalShortcuts() {
  const setActiveModule = useToolkitStore((s) => s.setActiveModule);
  const setCommandPaletteOpen = useToolkitStore((s) => s.setCommandPaletteOpen);
  const commandPaletteOpen = useToolkitStore((s) => s.commandPaletteOpen);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
        return;
      }

      if (e.key === 'Escape' && commandPaletteOpen) {
        setCommandPaletteOpen(false);
        return;
      }

      if (mod && e.key === ',') {
        e.preventDefault();
        setActiveModule('settings');
        return;
      }

      if (mod && e.shiftKey) {
        const target = SHIFT_META_SHORTCUTS[e.key.toLowerCase()];
        if (target) {
          e.preventDefault();
          setActiveModule(target);
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commandPaletteOpen, setActiveModule, setCommandPaletteOpen]);
}
