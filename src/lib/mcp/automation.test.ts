/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'

// The task-status follow-ups touch caches and other modules; the pure parts are tested here.
vi.mock('@/lib/sync/integrity', () => ({ syncDraftInvoices: vi.fn() }))
vi.mock('@/lib/tasks/derived-billing-sync', () => ({ resyncDerivedForSource: vi.fn() }))
vi.mock('@/lib/analytics/invalidate', () => ({ invalidateAnalyticsForDates: vi.fn() }))
vi.mock('@/lib/requests/task-sync', () => ({ syncRequestStatusFromTask: vi.fn(async () => {}) }))
vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn(async () => {}) }))

import { buildItemUpdate, lockedReason, removePlanItems, requestRowForItem, sendPlanItemsToRequests } from './social-actions'
import { buildPrompt, cardField, mergeCard } from './content-actions'
import { setTaskStatus, statusChangeProblem, updateLead } from './ops-actions'
import { templateByKey } from '@/lib/prompt-studio/templates'
import { FEED_STYLE_OPTIONS } from '@/lib/prompt-studio/client-card'

/** In-memory tables with just enough of the query builder for these functions. */
function fakeAdmin(seed: Record<string, any[]>) {
  const db: Record<string, any[]> = { task_requests: [], request_activity: [], company_settings: [], social_calendars: [], social_calendar_items: [], tasks: [], leads: [], ...seed }
  let n = 0
  const from = (table: string) => {
    const filters: ((r: any) => boolean)[] = []
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let payload: any = null
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => { filters.push(r => r[c] === v); return q },
      neq: (c: string, v: any) => { filters.push(r => r[c] !== v); return q },
      is: (c: string, v: any) => { filters.push(r => (r[c] ?? null) === v); return q },
      in: (c: string, v: any[]) => { filters.push(r => v.includes(r[c])); return q },
      gte: (c: string, v: any) => { filters.push(r => r[c] >= v); return q },
      lte: (c: string, v: any) => { filters.push(r => r[c] <= v); return q },
      not: () => q, order: () => q, limit: () => q,
      insert: (row: any) => { op = 'insert'; payload = row; return q },
      update: (row: any) => { op = 'update'; payload = row; return q },
      delete: () => { op = 'delete'; return q },
      run: () => {
        const hit = () => db[table].filter(r => filters.every(f => f(r)))
        if (op === 'insert') { const row = { id: `${table}-${++n}`, ref_no: n, ...payload }; db[table].push(row); return { data: [row], error: null } }
        if (op === 'update') { const rows = hit(); rows.forEach(r => Object.assign(r, payload)); return { data: rows, error: null } }
        if (op === 'delete') { const rows = hit(); db[table] = db[table].filter(r => !rows.includes(r)); return { data: rows, error: null } }
        return { data: hit(), error: null, count: hit().length }
      },
      maybeSingle: async () => { const r = q.run(); return { data: r.data[0] ?? null, error: r.error } },
      single: async () => { const r = q.run(); return { data: r.data[0] ?? null, error: r.error } },
      then: (res: any, rej: any) => Promise.resolve(q.run()).then(res, rej),
    }
    return q
  }
  return { admin: { from } as any, db }
}

const item = (over: Record<string, any> = {}) => ({
  id: 'i1', calendar_id: 'cal1', scheduled_date: '2026-12-10', title: 'Guest reactions', content_type: 'reel',
  platforms: ['instagram'], caption: 'Hook', notes: 'Visual direction: warm', status: 'planned', request_id: null,
  task_id: null, links: [{ label: 'Pinterest: x', url: 'https://www.pinterest.com/search/pins/?q=x' }], reference_urls: [], ...over,
})

describe('planned post edits', () => {
  it('locks posts that work has started on', () => {
    expect(lockedReason({ status: 'planned' })).toBeNull()
    expect(lockedReason({ status: 'planned', request_id: 'r' })).toMatch(/Requests/)
    expect(lockedReason({ status: 'planned', task_id: 't' })).toMatch(/task/)
    expect(lockedReason({ status: 'cancelled' })).toMatch(/cancelled/)
  })

  it('changes only the fields given, with the same rules as adding a post', () => {
    const r = buildItemUpdate(item(), { notes: 'New prompt', caption: 'Line 1\nLine 2' }, '2026-12-01')
    expect(r.ok && Object.keys(r.update).sort()).toEqual(['caption', 'notes', 'updated_at'])
    expect(r.ok && r.update.caption).toBe('Line 1<br>Line 2')
    expect(buildItemUpdate(item(), { date: '2027-01-02' }, '2026-12-01')).toMatchObject({ ok: false })
    expect(buildItemUpdate(item(), { date: null }, '2026-12-01')).toMatchObject({ ok: true, update: { scheduled_date: null } })
    const imgs = buildItemUpdate(item(), { images: ['https://cdn.x/a.png'] }, '2026-12-01')
    expect(imgs.ok && imgs.update).toMatchObject({ reference_urls: ['https://cdn.x/a.png'], reference_url: 'https://cdn.x/a.png' })
    expect(buildItemUpdate(item(), {}, '2026-12-01')).toMatchObject({ ok: false, error: 'Nothing to change.' })
  })
})

describe('sending planned posts to Requests', () => {
  it('files one request per post with the brief and the designer’s deadline, then links the post', async () => {
    const { admin, db } = fakeAdmin({
      social_calendars: [{ id: 'cal1', client_id: 'c1', title: 'December plan' }],
      social_calendar_items: [item(), item({ id: 'i2', title: 'Already sent', request_id: 'r9', status: 'requested' })],
      company_settings: [{ key: 'social_lead_days', value: '2' }],
    })
    const r = await sendPlanItemsToRequests(admin, ['i1', 'i2', 'missing'])
    expect(r.ok && r.sent.map(s => s.title)).toEqual(['Guest reactions'])
    expect(r.ok && r.skipped).toEqual([{ id: 'i2', title: 'Already sent', reason: 'it is already in Requests' }])
    expect(r.ok && r.unknown).toEqual(['missing'])
    const req = db.task_requests[0]
    expect(req).toMatchObject({ client_id: 'c1', is_planned: true, status: 'submitted', due_date: '2026-12-08', priority_rank: 1 })
    expect(req.content_brief).toMatchObject({ notes: 'Visual direction: warm' })
    expect(req.social_meta).toMatchObject({ calendar_id: 'cal1', item_id: 'i1' })
    expect(db.social_calendar_items[0]).toMatchObject({ status: 'requested', request_id: req.id })
    expect(db.request_activity).toHaveLength(1)
  })

  it('builds the same request row the calendar files', () => {
    const row = requestRowForItem(item({ title: 'guest reactions' }), { client_id: 'c1', title: 'Dec' }, 0)
    expect(row.title).toBe('Guest Reactions')
    expect(row.due_date).toBe('2026-12-10')
    expect(String(row.description)).toContain('Notes for designer:\nVisual direction: warm')
  })
})

describe('removing planned posts', () => {
  it('removes only posts no work has started on, and lists the rest', async () => {
    const { admin, db } = fakeAdmin({ social_calendar_items: [item(), item({ id: 'i2', title: 'In Requests', request_id: 'r1', status: 'requested' })] })
    const r = await removePlanItems(admin, ['i1', 'i2'])
    expect(r.ok && r.removed.map(x => x.id)).toEqual(['i1'])
    expect(r.ok && r.kept.map(x => x.id)).toEqual(['i2'])
    expect(db.social_calendar_items.map(x => x.id)).toEqual(['i2'])
  })
})

describe('Client Card merge', () => {
  it('finds fields by key or label', () => {
    expect(cardField('Feed style')?.key).toBe('feedStyle')
    expect(cardField('feedStyle')?.label).toBe('Feed style')
    expect(cardField('nope')).toBeUndefined()
  })

  it('matches choices, refuses what does not fit, never wipes with an empty value', () => {
    const m = mergeCard({ brand: 'Sea Star', audience: 'Families' }, {
      'Feed style': 'mixed', goal: 'Enquiries', audience: '', 'Brand colors': 'Red #FE0000', Platforms: 'Instagram, Facebook', unknown: 'x',
    })
    expect(m.card.feedStyle).toBe(FEED_STYLE_OPTIONS[2])
    expect(m.card.colors).toBe('Red #FE0000')
    expect(m.card.platforms).toBe('Instagram; Facebook')
    expect(m.card.audience).toBe('Families')
    expect(m.card.goal).toBeUndefined()
    expect(m.refused.map(r => r.field).sort()).toEqual(['Main goal', 'unknown'])
    expect(m.changed).toEqual(expect.arrayContaining(['Brand colors', 'Feed style', 'Platforms']))
  })

  it('empties a field only when asked', () => {
    const m = mergeCard({ brand: 'X', gulf: 'UAE' }, {}, ['Gulf audience'])
    expect(m.card.gulf).toBe('')
    expect(m.changed).toEqual(['Gulf audience (cleared)'])
  })
})

describe('build_prompt', () => {
  it('fills a template with the card and refuses when a required field is empty', () => {
    const t = templateByKey('social-calendar-month')!
    expect(buildPrompt(t, {}, null)).toMatchObject({ ok: false })
    const r = buildPrompt(t, { month: 'December 2026' }, { brand: 'Sea Star' })
    expect(r.ok && r.prompt).toContain('CLIENT CARD\nBrand: Sea Star')
    expect(r.ok && r.prompt).toContain('December 2026')
  })
})

describe('task status', () => {
  it('allows the workflow statuses only', () => {
    expect(statusChangeProblem('pending', 'done')).toBeNull()
    expect(statusChangeProblem('done', 'done')).toMatch(/already/)
    expect(statusChangeProblem('pending', 'invoiced')).toMatch(/cannot be set/)
    expect(statusChangeProblem('invoiced', 'done')).toMatch(/invoiced/)
  })

  it('moves a task and saves nothing when it changed meanwhile', async () => {
    const { admin, db } = fakeAdmin({ tasks: [{ id: 't1', task_number: 12, title: 'Poster', status: 'pending', deleted_at: null }] })
    expect(await setTaskStatus(admin, '#12', 'done')).toMatchObject({ ok: true, from: 'pending', to: 'done' })
    expect(db.tasks[0].status).toBe('done')
    expect(await setTaskStatus(admin, 13, 'done')).toMatchObject({ ok: false })
  })
})

describe('leads', () => {
  it('appends dated notes and stamps the first contact', async () => {
    const { admin, db } = fakeAdmin({ leads: [{ id: 'l1', status: 'new', notes: 'From ad', full_name: 'Asha', first_contacted_at: null }] })
    const r = await updateLead(admin, 'l1', { status: 'contacted', note: 'Called, wants a quote' })
    expect(r).toMatchObject({ ok: true, status: 'contacted' })
    expect(db.leads[0].notes).toMatch(/^From ad\n\d{4}-\d{2}-\d{2}: Called, wants a quote$/)
    expect(db.leads[0].first_contacted_at).toBeTruthy()
    expect(await updateLead(admin, 'l1', { status: 'maybe' })).toMatchObject({ ok: false })
  })
})
