import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  SHORTCUTS, SCOPE_LABELS, formatChord, isApplePlatform, groupedShortcuts,
} from './shortcuts'

const ALLOW_ALL = () => true

describe('the registry stays honest', () => {
  it('points every entry at a file that exists', () => {
    // A guide that lists a shortcut nobody implements is worse than no guide.
    for (const s of SHORTCUTS) {
      expect(existsSync(join(process.cwd(), s.source)), `${s.id} → ${s.source}`).toBe(true)
    }
  })

  it('points every modifier chord at a file that actually handles a modifier', () => {
    // Catches the real drift: a shortcut's implementation gets moved or
    // deleted and the guide keeps advertising it.
    for (const s of SHORTCUTS.filter(x => x.chord.startsWith('mod+'))) {
      const src = readFileSync(join(process.cwd(), s.source), 'utf8')
      expect(src, `${s.id} → ${s.source}`).toMatch(/metaKey|ctrlKey/)
    }
  })

  it('has no duplicate ids or chords', () => {
    expect(new Set(SHORTCUTS.map(s => s.id)).size).toBe(SHORTCUTS.length)
    expect(new Set(SHORTCUTS.map(s => s.chord)).size).toBe(SHORTCUTS.length)
  })

  it('labels every scope it uses', () => {
    for (const s of SHORTCUTS) expect(SCOPE_LABELS[s.scope]).toBeTruthy()
  })
})

describe('formatChord', () => {
  it('uses the platform’s own modifier', () => {
    expect(formatChord('mod+k', true)).toEqual(['⌘', 'K'])
    expect(formatChord('mod+k', false)).toEqual(['Ctrl', 'K'])
  })

  it('renders a three-part chord', () => {
    expect(formatChord('mod+shift+h', true)).toEqual(['⌘', '⇧', 'H'])
  })

  it('names the keys that have no letter', () => {
    expect(formatChord('escape', true)).toEqual(['Esc'])
    expect(formatChord('arrowdown', true)).toEqual(['↓'])
    expect(formatChord('shift+/', true)).toEqual(['⇧', '/'])
  })
})

describe('isApplePlatform', () => {
  it('prefers the modern hint', () => {
    expect(isApplePlatform({ userAgentData: { platform: 'macOS' }, platform: 'Win32' })).toBe(true)
  })

  it('falls back to the deprecated one, then the UA', () => {
    expect(isApplePlatform({ platform: 'MacIntel' })).toBe(true)
    expect(isApplePlatform({ userAgent: 'iPhone' })).toBe(true)
    expect(isApplePlatform({ platform: 'Win32' })).toBe(false)
  })

  it('assumes Ctrl when it cannot tell', () => {
    // Guessing wrong is cosmetic — every handler accepts either modifier.
    expect(isApplePlatform({})).toBe(false)
  })
})

describe('groupedShortcuts', () => {
  it('lists the broadest scope first', () => {
    expect(groupedShortcuts(ALLOW_ALL).map(g => g.scope)).toEqual(['global', 'lists', 'forms'])
  })

  it('shows everything when nothing is gated', () => {
    const total = groupedShortcuts(ALLOW_ALL).reduce((n, g) => n + g.items.length, 0)
    expect(total).toBe(SHORTCUTS.length)
  })

  it('never advertises a shortcut the viewer cannot use', () => {
    const gated = groupedShortcuts(() => false)
    const shown = gated.flatMap(g => g.items)
    expect(shown.every(s => !s.requiresPerm)).toBe(true)
  })

  it('drops a scope that ends up empty rather than rendering a bare heading', () => {
    expect(groupedShortcuts(ALLOW_ALL).every(g => g.items.length > 0)).toBe(true)
  })
})
