import { MODULES, type ModuleMeta } from '@shared/constants';
import type { ModuleId, ToolkitSettings } from '@shared/types';

/** Everything the user can organise. Settings is deliberately excluded —
 * it always lives at the bottom of the sidebar and can't be hidden. */
export const ORGANIZABLE_MODULES: ModuleMeta[] = MODULES.filter((m) => m.id !== 'settings');

/** How many items "Your tools" shows before the rest folds into More tools. */
export const YOUR_TOOLS_MAX = 5;

export function usageOf(settings: ToolkitSettings, id: ModuleId): number {
  return settings.usageCounts?.[id] ?? 0;
}

export function isPinned(settings: ToolkitSettings, id: ModuleId): boolean {
  return settings.pinnedTools.includes(id);
}

export function isHidden(settings: ToolkitSettings, id: ModuleId): boolean {
  return (settings.hiddenTools ?? []).includes(id);
}

/** The tools that earn a spot in the main interface: pinned ones first (in
 * registry order), then the most-used unpinned ones — never hidden tools,
 * never more than `max`. A tool with zero opens never auto-promotes itself. */
export function yourTools(settings: ToolkitSettings, max = YOUR_TOOLS_MAX): ModuleMeta[] {
  const pinned = ORGANIZABLE_MODULES.filter((m) => isPinned(settings, m.id) && !isHidden(settings, m.id));
  const byUsage = ORGANIZABLE_MODULES.filter(
    (m) => !isPinned(settings, m.id) && !isHidden(settings, m.id) && usageOf(settings, m.id) > 0
  ).sort((a, b) => usageOf(settings, b.id) - usageOf(settings, a.id));
  return [...pinned, ...byUsage].slice(0, Math.max(pinned.length, max));
}

/** Everything visible that didn't make the "Your tools" cut. */
export function moreTools(settings: ToolkitSettings, shown: ModuleMeta[]): ModuleMeta[] {
  const shownIds = new Set(shown.map((m) => m.id));
  return ORGANIZABLE_MODULES.filter((m) => !shownIds.has(m.id) && !isHidden(settings, m.id));
}

/** Recently used tools, most recent first, skipping hidden ones. */
export function recentTools(settings: ToolkitSettings, max = 4): ModuleMeta[] {
  return settings.recentlyUsed
    .map((id) => ORGANIZABLE_MODULES.find((m) => m.id === id))
    .filter((m): m is ModuleMeta => Boolean(m) && !isHidden(settings, (m as ModuleMeta).id))
    .slice(0, max);
}

/** Ranking for the command palette's empty-query state: pinned first, then
 * by usage, then registry order. Includes hidden tools at the end — hiding
 * removes a tool from the main interface, not from search. */
export function rankedForPalette(settings: ToolkitSettings): ModuleMeta[] {
  // Rank against the full registry — ORGANIZABLE_MODULES lacks 'settings',
  // and findIndex's -1 would catapult it to the top of the palette.
  const rank = (m: ModuleMeta) => MODULES.findIndex((x) => x.id === m.id);
  return [...MODULES].sort((a, b) => {
    const aHidden = a.id !== 'settings' && isHidden(settings, a.id) ? 1 : 0;
    const bHidden = b.id !== 'settings' && isHidden(settings, b.id) ? 1 : 0;
    if (aHidden !== bHidden) return aHidden - bHidden;
    const aPinned = isPinned(settings, a.id) ? 1 : 0;
    const bPinned = isPinned(settings, b.id) ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    const usage = usageOf(settings, b.id) - usageOf(settings, a.id);
    if (usage !== 0) return usage;
    return rank(a) - rank(b);
  });
}
