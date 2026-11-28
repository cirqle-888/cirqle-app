import { describe, it, expect } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { crumbsFor } from './breadcrumbs'

/**
 * Every breadcrumb link must open a real page. Folders without a page of
 * their own ("Finance" above Months, "Employees" above a profile) used to be
 * links to a 404. This walks the app's actual routes, so a new folder without
 * a page fails here until breadcrumbs.ts says what its crumb should do.
 */
const APP = join(process.cwd(), 'src', 'app', '(dashboard)')

function pageRoutes(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) pageRoutes(full, out)
    else if (name === 'page.tsx') out.push('/' + relative(APP, dir).split(sep).join('/'))
  }
  return out
}

const routes = pageRoutes(join(APP, 'dashboard'))
const toRegex = (route: string) => new RegExp('^' + route.replace(/\[[^\]]+\]/g, '[^/]+') + '$')
const routeRes = routes.map(toRegex)
const isPage = (href: string) => routeRes.some(re => re.test(href.split(/[?#]/)[0]))
const sample = (route: string) => route.replace(/\[[^\]]+\]/g, '3f2a9c1e-0000-4000-8000-000000000000')

describe('breadcrumbs', () => {
  it('finds the app\'s pages', () => {
    expect(routes.length).toBeGreaterThan(100)
  })

  it.each(routes)('every crumb on %s opens a real page', route => {
    const crumbs = crumbsFor(sample(route))
    for (const c of crumbs.filter(c => !c.isLast)) {
      expect(isPage(c.href), `${route}: "${c.label}" → ${c.href}`).toBe(true)
    }
  })

  it('leaves out the Dashboard crumb (the Home icon is the dashboard)', () => {
    expect(crumbsFor('/dashboard/tasks').map(c => c.label)).toEqual(['Tasks'])
  })

  it('uses the sidebar\'s names, then readable folder names', () => {
    expect(crumbsFor('/dashboard/reports/what-if').map(c => c.label)).toEqual(['Team Performance', 'What-If Planner'])
    expect(crumbsFor('/dashboard/field-marketing').map(c => c.label)).toEqual(['Field Marketing'])
    expect(crumbsFor('/dashboard/requests/whatsapp/pending').map(c => c.label)).toEqual(['Requests', 'WhatsApp', 'Pending'])
  })

  it('drops a folder with no page and keeps the trail around it', () => {
    expect(crumbsFor('/dashboard/finance/months').map(c => c.label)).toEqual(['Months'])
    expect(crumbsFor('/dashboard/finance/profit-sharing/investors').map(c => c.href))
      .toEqual(['/dashboard/finance/profit-sharing', '/dashboard/finance/profit-sharing/investors'])
  })

  it('points a folder with no page at its obvious home', () => {
    const [accounts] = crumbsFor('/dashboard/social/accounts/abc').filter(c => c.label === 'Accounts')
    expect(accounts.href).toBe('/dashboard/social')
  })

  it('never prints a record id', () => {
    const last = crumbsFor('/dashboard/clients/3f2a9c1e-0000-4000-8000-000000000000').at(-1)!
    expect(last.label).toBe('Details')
    expect(crumbsFor('/dashboard/clients/3f2a9c1e-0000-4000-8000-000000000000', 'Acme Foods').at(-1)!.label).toBe('Acme Foods')
  })
})

describe('breadcrumbs follow the sidebar, not the folder', () => {
  it('puts a tab page under its own module', () => {
    expect(crumbsFor('/dashboard/reports/department-growth/3f2a9c1e-0000-4000-8000-000000000000', 'Social Media').map(c => c.label))
      .toEqual(['Business Health', 'Department Growth', 'Social Media'])
    expect(crumbsFor('/dashboard/clients/ranking').map(c => c.label)).toEqual(['Client Reports', 'Client Ranking'])
  })

  it('drops a folder that belongs to another section', () => {
    // Feature Usage is an Admin page that happens to live under /reports.
    expect(crumbsFor('/dashboard/reports/feature-usage').map(c => c.label)).toEqual(['Feature Usage'])
  })

  it('keeps a folder that is the page\'s own home', () => {
    expect(crumbsFor('/dashboard/invoices/follow-ups/activity').map(c => c.label)).toEqual(['Invoices', 'Follow-ups', 'Activity'])
    expect(crumbsFor('/dashboard/settings/workspaces').map(c => c.label)).toEqual(['Settings', 'Workspaces'])
  })
})
