import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type ToolkitSettings } from '@shared/types';
import {
  ORGANIZABLE_MODULES,
  YOUR_TOOLS_MAX,
  moreTools,
  rankedForPalette,
  recentTools,
  yourTools,
} from './toolOrganizer';

function settings(patch: Partial<ToolkitSettings> = {}): ToolkitSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe('yourTools', () => {
  it('is empty for a brand-new user — nothing promotes itself without usage', () => {
    expect(yourTools(settings())).toEqual([]);
  });

  it('puts pinned tools first, then fills with most-used', () => {
    const s = settings({
      pinnedTools: ['exportManager'],
      usageCounts: { rename: 5, cleaner: 9, analytics: 1 },
    });
    expect(yourTools(s).map((m) => m.id)).toEqual(['exportManager', 'cleaner', 'rename', 'analytics']);
  });

  it('never includes hidden tools, even heavily-used or pinned ones', () => {
    const s = settings({
      pinnedTools: ['exportManager'],
      hiddenTools: ['exportManager', 'cleaner'],
      usageCounts: { cleaner: 50, rename: 1 },
    });
    expect(yourTools(s).map((m) => m.id)).toEqual(['rename']);
  });

  it('caps usage-fill at the max but always shows every pin', () => {
    const allUsed = Object.fromEntries(ORGANIZABLE_MODULES.map((m, i) => [m.id, i + 1]));
    expect(yourTools(settings({ usageCounts: allUsed }))).toHaveLength(YOUR_TOOLS_MAX);

    const manyPins = ORGANIZABLE_MODULES.slice(0, YOUR_TOOLS_MAX + 2).map((m) => m.id);
    expect(yourTools(settings({ pinnedTools: manyPins }))).toHaveLength(YOUR_TOOLS_MAX + 2);
  });

  it('tolerates settings saved by an older version with no hiddenTools/usageCounts', () => {
    const legacy = settings();
    delete (legacy as Partial<ToolkitSettings>).hiddenTools;
    delete (legacy as Partial<ToolkitSettings>).usageCounts;
    expect(yourTools(legacy)).toEqual([]);
    expect(moreTools(legacy, []).length).toBe(ORGANIZABLE_MODULES.length);
  });
});

describe('moreTools', () => {
  it('returns everything visible that is not already shown', () => {
    const s = settings({ hiddenTools: ['analytics'] });
    const shown = yourTools(s);
    const rest = moreTools(s, shown);
    expect(rest.map((m) => m.id)).not.toContain('analytics');
    expect(shown.length + rest.length).toBe(ORGANIZABLE_MODULES.length - 1);
  });
});

describe('recentTools', () => {
  it('keeps recency order and drops hidden tools', () => {
    const s = settings({
      recentlyUsed: ['cleaner', 'rename', 'analytics'],
      hiddenTools: ['rename'],
    });
    expect(recentTools(s).map((m) => m.id)).toEqual(['cleaner', 'analytics']);
  });
});

describe('rankedForPalette', () => {
  it('lists every module (hidden ones last), pinned and most-used first', () => {
    const s = settings({
      pinnedTools: ['designQA'],
      hiddenTools: ['rename'],
      usageCounts: { cleaner: 3 },
    });
    const ids = rankedForPalette(s).map((m) => m.id);
    expect(ids).toHaveLength(ORGANIZABLE_MODULES.length + 1); // + settings
    expect(ids[0]).toBe('designQA');
    expect(ids[1]).toBe('cleaner');
    expect(ids[ids.length - 1]).toBe('rename'); // hidden sinks to the bottom, but stays findable
  });

  it('keeps Settings in registry order (last) when nothing is pinned or used', () => {
    const ids = rankedForPalette(settings()).map((m) => m.id);
    expect(ids[ids.length - 1]).toBe('settings');
  });
});
