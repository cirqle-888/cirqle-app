import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import * as lucide from 'lucide-react'
import { FAVORITE_ICON_MAP, resolveFavoriteIcon, iconKeyFor } from './icon-map'

/**
 * A favourite whose icon_key is not in the map renders a Star. Several stars
 * in a row look like a broken sidebar, and the failure is silent — nothing
 * errors, the icon is just wrong.
 *
 * This had happened to 21 of the 46 icons navSections uses, from two causes:
 * the map drifting behind the nav, and the sidebar capturing keys from
 * `displayName` (lucide's CURRENT name) against a map keyed on the import
 * alias. Both are pinned here.
 */
const NAV = readFileSync(join(process.cwd(), 'src/lib/nav-sections.ts'), 'utf8')

/** Every `icon: X` referenced by navSections, minus the type import. */
const navIconNames = [...new Set(
  [...NAV.matchAll(/icon:\s*([A-Za-z0-9_]+)/g)].map(m => m[1]),
)].filter(n => n !== 'LucideIcon').sort()

describe('every nav icon can round-trip through Favorites', () => {
  it('finds icons to check at all', () => {
    expect(navIconNames.length).toBeGreaterThan(30)
  })

  it.each(navIconNames)('%s resolves to itself, not a Star', (name) => {
    const key = name in FAVORITE_ICON_MAP ? name : name
    const resolved = resolveFavoriteIcon(key)
    expect(resolved, `${name} is missing from FAVORITE_ICON_MAP`).not.toBe(lucide.Star)
  })

  it('resolves every nav icon by its displayName spelling too', () => {
    // This is the spelling older favourites were stored under.
    const unresolved: string[] = []
    for (const name of navIconNames) {
      const Icon = (lucide as unknown as Record<string, unknown>)[name === 'PackageIcon' ? 'Package' : name]
      const dn = (Icon as { displayName?: string } | undefined)?.displayName
      if (!dn) continue
      if (resolveFavoriteIcon(dn) === lucide.Star && dn !== 'Star') unresolved.push(`${name} (displayName ${dn})`)
    }
    expect(unresolved, `stored under these spellings, they would render a Star:\n  ${unresolved.join('\n  ')}`).toEqual([])
  })
})

describe('the spellings already in the database still resolve', () => {
  // Read from employee_favorites on 2026-09-12 — the four the sidebar was
  // showing as identical stars, plus a control that always worked.
  const stored = ['SquareCheckBig', 'CalendarDays', 'UsersRound', 'Images', 'Wallet']

  it.each(stored)('%s is not a Star', (key) => {
    expect(resolveFavoriteIcon(key)).not.toBe(lucide.Star)
  })

  it('maps the renamed ones onto the same component as their alias', () => {
    expect(resolveFavoriteIcon('SquareCheckBig')).toBe(lucide.CheckSquare)
    expect(resolveFavoriteIcon('UsersRound')).toBe(lucide.Users2)
  })

  it('keeps CalendarDays distinct from CalendarClock — different icons', () => {
    expect(resolveFavoriteIcon('CalendarDays')).not.toBe(resolveFavoriteIcon('CalendarClock'))
  })
})

describe('resolveFavoriteIcon / iconKeyFor', () => {
  it('still falls back to a Star for a genuinely unknown key', () => {
    expect(resolveFavoriteIcon('NoSuchIcon')).toBe(lucide.Star)
    expect(resolveFavoriteIcon('')).toBe(lucide.Star)
  })

  it('round-trips: a key from iconKeyFor always resolves back', () => {
    for (const [key, Icon] of Object.entries(FAVORITE_ICON_MAP)) {
      const roundTripped = resolveFavoriteIcon(iconKeyFor(Icon))
      expect(roundTripped, `${key} did not survive the round trip`).toBe(Icon)
    }
  })

  it('an explicit map entry is never shadowed by an alias', () => {
    // CalendarDays is registered outright; nothing may repoint it.
    expect(resolveFavoriteIcon('CalendarDays')).toBe(lucide.CalendarDays)
  })
})

describe('the sidebar captures keys the map knows', () => {
  const SIDEBAR = readFileSync(join(process.cwd(), 'src/components/layout/sidebar.tsx'), 'utf8')

  it('does not take the key from displayName', () => {
    // The original bug, in one line: `const iconKey = Icon.displayName`.
    expect(SIDEBAR).not.toMatch(/iconKey\s*=\s*Icon\.displayName/)
    expect(SIDEBAR).toMatch(/iconKey\s*=\s*iconKeyFor\(Icon\)/)
  })
})
