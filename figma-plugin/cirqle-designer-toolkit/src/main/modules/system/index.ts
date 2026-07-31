import type { HandlerContext } from '../../bridge';
import { logger } from '../../utils/logger';
import { STORAGE_KEYS } from '@shared/constants';
import { loadJSON, saveJSON, pushCapped } from '../../utils/storage';
import type { HistoryEntry } from '@shared/types';

/** Cross-cutting "system" concerns: activity log, history list, ping. Not
 * one of the 12 numbered feature modules, but every module can push into
 * it (see recordHistory, exported for other modules to import directly). */
export async function handle(action: string, payload: unknown, _ctx: HandlerContext): Promise<unknown> {
  switch (action) {
    case 'ping':
      return { ok: true, version: '0.1.0', figmaVersion: figma.editorType };
    case 'getActivityLog':
      return logger.getRecent((payload as { limit?: number } | undefined)?.limit ?? 100);
    case 'getHistory':
      return loadJSON<HistoryEntry[]>(STORAGE_KEYS.history, []);
    case 'clearHistory':
      await saveJSON<HistoryEntry[]>(STORAGE_KEYS.history, []);
      return [];
    default:
      throw new Error(`system: unknown action "${action}"`);
  }
}

export async function recordHistory(entry: HistoryEntry, cap: number): Promise<void> {
  await pushCapped(STORAGE_KEYS.history, entry, cap);
}
