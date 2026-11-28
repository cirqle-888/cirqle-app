import { describe, it, expect } from 'vitest'
import type { Feature } from './catalogue'
import {
  buildFeatureUsage, canUseFeature, classifyUsage, pickReminderFeatures, reminderText, weekNumber,
  type UsageEvent, type UsagePerson,
} from './report'
import { addDaysISO } from '@/lib/utils/local-date'

const TODAY = '2026-11-28'
const ago = (n: number) => addDaysISO(TODAY, -n)

function feature(href: string, extra: Partial<Feature> = {}): Feature {
  return {
    href, label: href.split('/').pop() || 'Dashboard', section: 'Work', order: 0, described: true,
    what: `What ${href} is for.`, start: `Open ${href}.`, rhythm: 'weekly', ...extra,
  }
}

function person(id: string, cqid: string, perms: string[] = [], isAdmin = false): UsagePerson {
  return { id, cqid, role: isAdmin ? 'Owner' : 'Designer', isAdmin, permissions: new Set(perms) }
}

const visit = (employeeId: string, href: string, day: string): UsageEvent => ({ employeeId, href, day })

describe('classifyUsage', () => {
  it('is never used when nothing happened in the lookback', () => {
    expect(classifyUsage('daily', 0, false)).toBe('never')
    expect(classifyUsage('occasional', 0, false)).toBe('never')
  })

  it('judges by how often the feature is meant to be used', () => {
    expect(classifyUsage('daily', 11, true)).toBe('rare')
    expect(classifyUsage('daily', 12, true)).toBe('well')
    expect(classifyUsage('weekly', 3, true)).toBe('rare')
    expect(classifyUsage('weekly', 4, true)).toBe('well')
    expect(classifyUsage('monthly', 0, true)).toBe('rare')   // used, but not this month
    expect(classifyUsage('monthly', 1, true)).toBe('well')
  })

  it('counts a set-up tool used once in 90 days as used well', () => {
    expect(classifyUsage('occasional', 0, true)).toBe('well')
  })
})

describe('canUseFeature — the sidebar gate', () => {
  const invoices = feature('/dashboard/invoices', { requiredPerm: 'billing.view_invoices' })
  const reports = feature('/dashboard/reports', { requiredAnyPerm: ['reports.view', 'reports.view_people_earnings'] })
  const importer = feature('/dashboard/import', { adminOnly: true })

  it('follows requiredPerm, requiredAnyPerm and adminOnly', () => {
    const designer = person('d', 'CQID003', ['reports.view_people_earnings'])
    expect(canUseFeature(invoices, designer)).toBe(false)
    expect(canUseFeature(reports, designer)).toBe(true)
    expect(canUseFeature(importer, designer)).toBe(false)
    expect(canUseFeature(feature('/dashboard/tasks'), designer)).toBe(true) // no gate = everyone
  })

  it('lets an admin open admin-only pages', () => {
    const owner = person('o', 'CQID001', ['billing.view_invoices'], true)
    expect(canUseFeature(importer, owner)).toBe(true)
  })
})

describe('buildFeatureUsage', () => {
  const tasks = feature('/dashboard/tasks', { rhythm: 'daily', order: 0 })
  const invoices = feature('/dashboard/invoices', { rhythm: 'weekly', requiredPerm: 'billing.view_invoices', order: 1 })
  const months = feature('/dashboard/finance/months', { rhythm: 'monthly', requiredPerm: 'payroll.view', order: 2 })
  const importer = feature('/dashboard/import', { rhythm: 'occasional', adminOnly: true, order: 3 })
  const features = [tasks, invoices, months, importer]

  const owner = person('o', 'CQID001', [], true)
  const accounts = person('a', 'CQID002', ['billing.view_invoices', 'payroll.view'])
  const designer = person('d', 'CQID010')
  const people = [designer, owner, accounts] // out of order on purpose

  const events: UsageEvent[] = [
    // Tasks: 12 distinct days in the last 30, from two people (shared days count once).
    ...Array.from({ length: 12 }, (_, i) => visit('d', '/dashboard/tasks', ago(i))),
    visit('o', '/dashboard/tasks', ago(0)),
    visit('o', '/dashboard/tasks', ago(1)),
    // Invoices: 2 days → rare for a weekly tool.
    visit('a', '/dashboard/invoices', ago(3)),
    visit('a', '/dashboard/invoices', ago(10)),
    // Months: only 45 days ago → used in the lookback, not this month → rare.
    visit('o', '/dashboard/finance/months', ago(45)),
    // Noise that must not count:
    visit('a', '/dashboard/import', ago(200)),            // outside the 90-day lookback
    visit('x', '/dashboard/import', ago(1)),              // someone not in the list (archived / no login)
    visit('o', '/dashboard/not-a-feature', ago(1)),       // unknown page
    visit('o', '/dashboard/tasks', addDaysISO(TODAY, 1)), // future
  ]

  const report = buildFeatureUsage({ features, people, events, today: TODAY })
  const row = (href: string) => report.rows.find(r => r.href === href)!

  it('sorts each feature into never / rare / well', () => {
    expect(row('/dashboard/tasks').status).toBe('well')
    expect(row('/dashboard/invoices').status).toBe('rare')
    expect(row('/dashboard/finance/months').status).toBe('rare')
    expect(row('/dashboard/import').status).toBe('never')
    expect(report.counts).toEqual({ never: 1, rare: 2, well: 1 })
  })

  it('counts days, not visits: two people on one day is one day', () => {
    expect(row('/dashboard/tasks').activeDays30).toBe(12)
    expect(row('/dashboard/tasks').usedBy30).toEqual(['CQID001', 'CQID010'])
  })

  it('reports the last day used, inside the lookback only', () => {
    expect(row('/dashboard/tasks').lastUsed).toBe(TODAY)
    expect(row('/dashboard/finance/months').lastUsed).toBe(ago(45))
    expect(row('/dashboard/import').lastUsed).toBeNull()
  })

  it('names who could use a feature but never has, by CQID', () => {
    expect(row('/dashboard/tasks').allowed).toEqual(['CQID001', 'CQID002', 'CQID010'])
    expect(row('/dashboard/tasks').notYetBy).toEqual(['CQID002'])
    expect(row('/dashboard/invoices').allowed).toEqual(['CQID001', 'CQID002'])
    expect(row('/dashboard/invoices').notYetBy).toEqual(['CQID001'])
    expect(row('/dashboard/import').allowed).toEqual(['CQID001'])
  })

  it('lists, per person, the features their role allows that they never opened', () => {
    const byCqid = Object.fromEntries(report.people.map(p => [p.cqid, p]))
    expect(report.people.map(p => p.cqid)).toEqual(['CQID001', 'CQID002', 'CQID010'])
    expect(byCqid.CQID010.neverOpened).toEqual([])                       // only Tasks allowed, and used
    expect(byCqid.CQID010.allowedCount).toBe(1)
    expect(byCqid.CQID002.neverOpened).toEqual(['/dashboard/tasks', '/dashboard/finance/months'])
    expect(byCqid.CQID001.neverOpened).toEqual(['/dashboard/invoices', '/dashboard/import'])
    expect(byCqid.CQID001.usedCount).toBe(2)
    expect(byCqid.CQID002.lastActive).toBe(ago(3))
  })

  it('narrows to one person: their use, and only features their role allows', () => {
    const one = buildFeatureUsage({ features, people, events, today: TODAY, personId: 'a' })
    expect(one.person?.cqid).toBe('CQID002')
    expect(one.rows.map(r => r.href)).toEqual(['/dashboard/tasks', '/dashboard/invoices', '/dashboard/finance/months'])
    const r = (href: string) => one.rows.find(x => x.href === href)!
    expect(r('/dashboard/tasks').status).toBe('never')    // others use it; CQID002 never has
    expect(r('/dashboard/invoices').status).toBe('rare')
    expect(r('/dashboard/finance/months').status).toBe('never')
    expect(r('/dashboard/tasks').notYetBy).toEqual(['CQID002'])
    // The person list is still everyone, for the picker.
    expect(one.people).toHaveLength(3)
  })

  it('ignores an unknown person id instead of showing an empty report', () => {
    const r = buildFeatureUsage({ features, people, events, today: TODAY, personId: 'nobody' })
    expect(r.person).toBeNull()
    expect(r.rows).toHaveLength(features.length)
  })
})

describe('the weekly reminder', () => {
  const mk = (href: string, status: 'never' | 'rare' | 'well', allowed = ['CQID001']) => ({
    ...feature(href), label: href.slice(11), status, lastUsed: null, activeDays30: 0, usedBy30: [], allowed, notYetBy: allowed,
  })

  it('moves on by one week every Monday', () => {
    expect(weekNumber('2026-11-30') - weekNumber('2026-11-23')).toBe(1)
    expect(weekNumber('2026-11-29')).toBe(weekNumber('2026-11-23')) // Sunday still the same week
  })

  it('suggests never-used features first, rotating, never the report itself', () => {
    const rows = [
      mk('/dashboard/a', 'never'), mk('/dashboard/b', 'never'), mk('/dashboard/c', 'never'),
      mk('/dashboard/d', 'never'), mk('/dashboard/e', 'rare'),
      mk('/dashboard/reports/feature-usage', 'never'),
      mk('/dashboard/nobody-can', 'never', []),
    ]
    const week1 = pickReminderFeatures(rows, '2026-11-23').map(r => r.href)
    const week2 = pickReminderFeatures(rows, '2026-11-30').map(r => r.href)
    expect(week1).toHaveLength(3)
    expect(new Set(week1).size).toBe(3)
    for (const h of [...week1, ...week2]) {
      expect(['/dashboard/a', '/dashboard/b', '/dashboard/c', '/dashboard/d']).toContain(h)
    }
    expect(week2).not.toEqual(week1)
  })

  it('falls back to rarely used ones, and to nothing when all is used well', () => {
    expect(pickReminderFeatures([mk('/dashboard/e', 'rare'), mk('/dashboard/f', 'well')], TODAY).map(r => r.href))
      .toEqual(['/dashboard/e'])
    expect(pickReminderFeatures([mk('/dashboard/f', 'well')], TODAY)).toEqual([])
  })

  it('words the notification with each feature\'s how-to-start line', () => {
    const text = reminderText([mk('/dashboard/a', 'never'), mk('/dashboard/b', 'never')])!
    expect(text.title).toBe('2 features nobody has used yet')
    expect(text.message).toBe('a: Open /dashboard/a. · b: Open /dashboard/b.')
    expect(reminderText([mk('/dashboard/e', 'rare')])!.title).toBe('1 feature hardly used this month')
    expect(reminderText([])).toBeNull()
  })
})
