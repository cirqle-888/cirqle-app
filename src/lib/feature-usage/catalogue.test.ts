import { describe, it, expect } from 'vitest'
import { Inbox } from 'lucide-react'
import { navSections, type NavSection } from '@/lib/nav-sections'
import { FEATURE_GUIDES, featureForPath, listFeatures } from './catalogue'

describe('the feature list is the sidebar', () => {
  const features = listFeatures()
  const navHrefs = [...new Set(navSections.flatMap(s => s.items.map(i => i.href)))]

  it('has every sidebar item, once, in sidebar order', () => {
    expect(features.map(f => f.href)).toEqual(navHrefs)
    expect(features.map(f => f.order)).toEqual(navHrefs.map((_, i) => i))
  })

  it('includes the report itself, admin only', () => {
    const self = features.find(f => f.href === '/dashboard/reports/feature-usage')
    expect(self?.adminOnly).toBe(true)
    expect(self?.section).toBe('Insights')
  })

  it('has a "what it\'s for" and "how to start" line for every sidebar page', () => {
    // A new sidebar page shows in the report on its own, with a fallback line.
    // This asks whoever added it for the real two lines in catalogue.ts.
    const missing = features.filter(f => !f.described).map(f => `${f.section} → ${f.label} (${f.href})`)
    expect(missing, `Add these to FEATURE_GUIDES in src/lib/feature-usage/catalogue.ts:\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('keeps every line short enough to read at a glance', () => {
    for (const [href, g] of Object.entries(FEATURE_GUIDES)) {
      expect(g.what.length, `${href} what`).toBeLessThanOrEqual(100)
      expect(g.start.length, `${href} start`).toBeLessThanOrEqual(110)
    }
  })

  it('copies the sidebar gate so the report decides access the same way', () => {
    const invoices = features.find(f => f.href === '/dashboard/invoices')
    expect(invoices?.requiredPerm).toBe('billing.view_invoices')
    const contributions = features.find(f => f.href === '/dashboard/contributions')
    expect(contributions?.requiredAnyPerm).toContain('contributions.view_own')
  })

  it('falls back to plain words for a page with no entry', () => {
    const sections: NavSection[] = [{ label: 'Work', items: [{ label: 'Brand New', href: '/dashboard/brand-new', icon: Inbox }] }]
    const [f] = listFeatures(sections)
    expect(f.described).toBe(false)
    expect(f.start).toBe('Open Work → Brand New in the sidebar.')
    expect(f.rhythm).toBe('weekly')
  })
})

describe('featureForPath', () => {
  it('maps a deeper page to its sidebar feature', () => {
    expect(featureForPath('/dashboard/clients/3f2a-uuid')).toBe('/dashboard/clients')
    expect(featureForPath('/dashboard/invoices')).toBe('/dashboard/invoices')
  })

  it('prefers the most specific sidebar page', () => {
    expect(featureForPath('/dashboard/invoices/follow-ups')).toBe('/dashboard/invoices/follow-ups')
    expect(featureForPath('/dashboard/cashbook/recurring')).toBe('/dashboard/cashbook/recurring')
    expect(featureForPath('/dashboard/clients/ranking')).toBe('/dashboard/clients/ranking')
  })

  it('drops query strings, hashes and trailing slashes, so no record id is kept', () => {
    expect(featureForPath('/dashboard/invoices?id=abc#pay')).toBe('/dashboard/invoices')
    expect(featureForPath('/dashboard/tasks/')).toBe('/dashboard/tasks')
    expect(featureForPath('/dashboard?denied=1')).toBe('/dashboard')
  })

  it('counts the Social tabs as the one Social feature', () => {
    expect(featureForPath('/dashboard/social/queue')).toBe('/dashboard/social-calendar')
    expect(featureForPath('/dashboard/social')).toBe('/dashboard/social-calendar')
    expect(featureForPath('/dashboard/social-calendar')).toBe('/dashboard/social-calendar')
  })

  it('ignores pages outside the sidebar and outside the dashboard', () => {
    expect(featureForPath('/dashboard/some-hidden-tool')).toBeNull()
    expect(featureForPath('/login')).toBeNull()
    expect(featureForPath('')).toBeNull()
    expect(featureForPath('/dashboardx')).toBeNull()
  })
})
