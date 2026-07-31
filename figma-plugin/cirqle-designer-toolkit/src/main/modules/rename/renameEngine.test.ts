import { describe, it, expect } from 'vitest';
import { buildNewName, formatDateYYYYMMDD, type RenameContext } from './renameEngine';
import type { RenameRule } from './renameTypes';

const baseCtx: RenameContext = { type: 'FRAME', parent: 'Page 1', page: 'Cards', date: '2026-07-28', batchCount: 12 };

function rule(overrides: Partial<RenameRule> = {}): RenameRule {
  return {
    findReplace: { enabled: false, find: '', replace: '', mode: 'plain', flags: '', caseSensitive: false },
    prefix: { enabled: false, value: '' },
    suffix: { enabled: false, value: '' },
    numbering: { enabled: false, startNumber: 1, padding: 'auto' },
    ...overrides,
  } as RenameRule;
}

describe('buildNewName', () => {
  it('leaves the name untouched when every sub-rule is disabled', () => {
    const result = buildNewName('Product Card', 0, baseCtx, rule());
    expect(result).toEqual({ ok: true, name: 'Product Card' });
  });

  it('applies plain find & replace case-insensitively by default', () => {
    const result = buildNewName('Old Card', 0, baseCtx, rule({
      findReplace: { enabled: true, find: 'old', replace: 'New', mode: 'plain', flags: '', caseSensitive: false },
    }));
    expect(result).toEqual({ ok: true, name: 'New Card' });
  });

  it('applies prefix and suffix together', () => {
    const result = buildNewName('Card', 0, baseCtx, rule({
      prefix: { enabled: true, value: '[' }, suffix: { enabled: true, value: ']' },
    }));
    expect(result).toEqual({ ok: true, name: '[Card]' });
  });

  it('pads {nn} to the widest index in the batch', () => {
    const ctx = { ...baseCtx, batchCount: 12 };
    const r = rule({ suffix: { enabled: true, value: ' {nn}' }, numbering: { enabled: true, startNumber: 1, padding: 'auto' } });
    expect(buildNewName('Card', 0, ctx, r)).toEqual({ ok: true, name: 'Card 01' });
    expect(buildNewName('Card', 9, ctx, r)).toEqual({ ok: true, name: 'Card 10' });
  });

  it('leaves {n}/{nn}/{index} literal when numbering is disabled', () => {
    const result = buildNewName('Card {n}', 0, baseCtx, rule());
    expect(result).toEqual({ ok: true, name: 'Card {n}' });
  });

  it('resolves {type} {parent} {page} {date} regardless of numbering', () => {
    const result = buildNewName('{type}/{parent}/{page}/{date}', 0, baseCtx, rule());
    expect(result).toEqual({ ok: true, name: 'FRAME/Page 1/Cards/2026-07-28' });
  });

  it('supports regex replace with capture groups', () => {
    const result = buildNewName('price_09_99', 0, baseCtx, rule({
      findReplace: { enabled: true, find: 'price_(\\d+)_(\\d+)', replace: '$1.$2', mode: 'regex', flags: 'g', caseSensitive: false },
    }));
    expect(result).toEqual({ ok: true, name: '09.99' });
  });

  it('reports an invalid regex as a per-row error instead of throwing', () => {
    const result = buildNewName('Card', 0, baseCtx, rule({
      findReplace: { enabled: true, find: '(unterminated', replace: 'x', mode: 'regex', flags: 'g', caseSensitive: false },
    }));
    expect(result.ok).toBe(false);
  });
});

describe('formatDateYYYYMMDD', () => {
  it('zero-pads month and day', () => {
    expect(formatDateYYYYMMDD(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
