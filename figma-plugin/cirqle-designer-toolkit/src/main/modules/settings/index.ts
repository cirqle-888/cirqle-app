import type { HandlerContext } from '../../bridge';
import { DEFAULT_SETTINGS, type ModuleId, type ToolkitSettings } from '@shared/types';
import { STORAGE_KEYS } from '@shared/constants';
import { loadJSON, saveJSON } from '../../utils/storage';

/** clientStorage returns whatever shape was last saved — possibly from an
 * older plugin version missing newer fields — so every read merges over the
 * defaults instead of trusting the stored object wholesale. */
async function loadSettings(): Promise<ToolkitSettings> {
  const stored = await loadJSON<Partial<ToolkitSettings>>(STORAGE_KEYS.settings, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function handle(action: string, payload: unknown, _ctx: HandlerContext): Promise<unknown> {
  switch (action) {
    case 'get': {
      return loadSettings();
    }
    case 'update': {
      const current = await loadSettings();
      const next: ToolkitSettings = { ...current, ...(payload as Partial<ToolkitSettings>) };
      await saveJSON(STORAGE_KEYS.settings, next);
      return next;
    }
    case 'reset': {
      await saveJSON(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }
    case 'trackUsage': {
      const current = await loadSettings();
      const moduleId = (payload as { module: ModuleId }).module;
      const withoutDup = current.recentlyUsed.filter((m) => m !== moduleId);
      const next: ToolkitSettings = {
        ...current,
        recentlyUsed: [moduleId, ...withoutDup].slice(0, 8),
        usageCounts: {
          ...current.usageCounts,
          [moduleId]: (current.usageCounts[moduleId] ?? 0) + 1,
        },
      };
      await saveJSON(STORAGE_KEYS.settings, next);
      return next;
    }
    default:
      throw new Error(`settings: unknown action "${action}"`);
  }
}
