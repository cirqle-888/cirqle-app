/* eslint-disable @typescript-eslint/no-explicit-any -- the in-memory stand-in for the Supabase client is deliberately untyped. */
import { describe, it, expect } from 'vitest'
import { planMonth, captionFromText, cleanPlanItem, itemKey, addSocialPlanItems, listSocialPlan, MAX_ITEMS_PER_CALL } from './plan-mcp'

describe('planMonth', () => {
  it('accepts a month or any date in it', () => {
    expect(planMonth('2026-12')).toBe('2026-12-01')
    expect(planMonth(' 2026-12-17 ')).toBe('2026-12-01')
  })
  it('rejects anything that is not a month', () => {
    for (const bad of ['', 'December', '2026-13', '2026-00', '26-12', null, undefined]) expect(planMonth(bad)).toBeNull()
  })
})

describe('captionFromText', () => {
  it('keeps line breaks and escapes markup instead of running it', () => {
    expect(captionFromText('Fresh fish daily\nOpen till 10')).toBe('Fresh fish daily<br>Open till 10')
    const out = captionFromText('<script>alert(1)</script> 5 < 6 & more')!
    expect(out).not.toContain('<script')
    expect(out).toContain('5 &lt; 6 &amp; more')
  })
  it('keeps Malayalam as written', () => {
    expect(captionFromText('ഓണം ഓഫർ')).toBe('ഓണം ഓഫർ')
  })
  it('is null when there is nothing to show', () => {
    expect(captionFromText('   ')).toBeNull()
    expect(captionFromText(null)).toBeNull()
  })
})

describe('cleanPlanItem', () => {
  const M = '2026-12-01'
  it('normalises a full item', () => {
    const r = cleanPlanItem({ title: '  Weekend   fish offer ', date: '2026-12-04', content_type: 'Reel', platforms: ['Instagram', 'facebook', 'instagram'], caption: 'Hook', notes: ' brief ', asap: true }, M)
    expect(r).toEqual({ ok: true, item: { scheduled_date: '2026-12-04', title: 'Weekend fish offer', content_type: 'reel', platforms: ['instagram', 'facebook'], caption: 'Hook', notes: 'brief', post_asap: true } })
  })
  it('treats a missing date as an undated idea and defaults to a post', () => {
    const r = cleanPlanItem({ title: 'Rain-day delivery idea' }, M)
    expect(r.ok && r.item).toMatchObject({ scheduled_date: null, content_type: 'post', platforms: [], caption: null, notes: null, post_asap: false })
  })
  it('refuses a date outside the month, an impossible date, an unknown type or platform, and no title', () => {
    expect(cleanPlanItem({ title: 'x', date: '2027-01-02' }, M)).toMatchObject({ ok: false })
    expect(cleanPlanItem({ title: 'x', date: '2026-12-32' }, M)).toMatchObject({ ok: false })
    expect(cleanPlanItem({ title: 'x', content_type: 'meme' }, M)).toMatchObject({ ok: false })
    expect(cleanPlanItem({ title: 'x', platforms: ['snapchat'] }, M)).toMatchObject({ ok: false })
    expect(cleanPlanItem({ title: '   ' }, M)).toMatchObject({ ok: false })
  })
})

describe('itemKey', () => {
  it('matches the same day and title whatever the spacing or case', () => {
    expect(itemKey('2026-12-04', 'Weekend  Fish Offer')).toBe(itemKey('2026-12-04T00:00:00', ' weekend fish offer '))
    expect(itemKey(null, 'Idea')).toBe(itemKey(undefined, 'idea'))
    expect(itemKey('2026-12-04', 'A')).not.toBe(itemKey('2026-12-05', 'A'))
  })
})

/** A tiny in-memory stand-in for the three tables these functions touch. */
function fakeAdmin(seed: { calendars?: any[]; items?: any[]; missingCols?: string[] } = {}) {
  const db = { social_calendars: [...(seed.calendars ?? [])], social_calendar_items: [...(seed.items ?? [])], company_settings: [] as any[], services: [{ id: 'svc-reel', name: 'Reel editing', is_active: true }] } as Record<string, any[]>
  const inserts: any[] = []
  let n = 0
  const from = (table: string) => {
    const filters: ((r: any) => boolean)[] = []
    let pending: any[] | null = null
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => { filters.push(r => r[c] === v); return q },
      neq: (c: string, v: any) => { filters.push(r => r[c] !== v); return q },
      order: () => q,
      limit: () => q,
      insert: (rows: any) => { pending = Array.isArray(rows) ? rows : [rows]; return q },
      run: () => {
        if (pending) {
          // Only the items table has columns that arrived in later migrations.
          const bad = table === 'social_calendar_items' ? (seed.missingCols ?? []).find(c => pending!.some(r => c in r)) : undefined
          if (bad) return { data: null, error: { message: `Could not find the '${bad}' column of '${table}' in the schema cache` } }
          const saved = pending.map(r => ({ id: `${table}-${++n}`, ...r }))
          db[table].push(...saved)
          inserts.push(...saved.map(r => ({ table, ...r })))
          return { data: saved, error: null }
        }
        return { data: db[table].filter(r => filters.every(f => f(r))), error: null }
      },
      maybeSingle: async () => { const r = q.run(); return { data: r.data?.[0] ?? null, error: r.error } },
      single: async () => { const r = q.run(); return { data: r.data?.[0] ?? null, error: r.error } },
      then: (res: any, rej: any) => Promise.resolve(q.run()).then(res, rej),
    }
    return q
  }
  return { admin: { from } as any, db, inserts }
}

describe('addSocialPlanItems', () => {
  const base = { clientId: 'c1', month: '2026-12-01' }

  it('creates the month plan when there is none and saves every item as planned', async () => {
    const { admin, db } = fakeAdmin()
    const r = await addSocialPlanItems(admin, { ...base, items: [{ title: 'Reel: morning fish', date: '2026-12-02', content_type: 'reel', platforms: ['instagram'] }, { title: 'Trend idea' }] })
    expect(r).toMatchObject({ ok: true, createdPlan: true, added: 2, skipped: [] })
    expect(db.social_calendars).toHaveLength(1)
    expect(db.social_calendars[0]).toMatchObject({ client_id: 'c1', month: '2026-12-01', status: 'active' })
    expect(db.social_calendar_items.every(i => i.status === 'planned')).toBe(true)
    expect(db.social_calendar_items[0].service_id).toBe('svc-reel')
    expect(db.social_calendar_items[1].scheduled_date).toBeNull()
  })

  it('saves nothing at all when one item is wrong', async () => {
    const { admin, db } = fakeAdmin()
    const r = await addSocialPlanItems(admin, { ...base, items: [{ title: 'Good', date: '2026-12-02' }, { title: 'Bad', date: '2027-01-02' }] })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/Nothing was saved.*outside this plan's month/)
    expect(db.social_calendars).toHaveLength(0)
    expect(db.social_calendar_items).toHaveLength(0)
  })

  it('does not double an item when the same plan is sent twice', async () => {
    const { admin, db } = fakeAdmin()
    const items = [{ title: 'Friday offer', date: '2026-12-04' }, { title: 'Sunday story', date: '2026-12-06' }]
    await addSocialPlanItems(admin, { ...base, items })
    const again = await addSocialPlanItems(admin, { ...base, items: [...items, { title: 'New one', date: '2026-12-07' }] })
    expect(again).toMatchObject({ ok: true, createdPlan: false, added: 1, skipped: ['Friday offer', 'Sunday story'] })
    expect(db.social_calendar_items).toHaveLength(3)
  })

  it('still saves where a later column has not been migrated', async () => {
    const { admin, db } = fakeAdmin({ missingCols: ['post_asap'] })
    const r = await addSocialPlanItems(admin, { ...base, items: [{ title: 'Trend post', date: '2026-12-03', asap: true }] })
    expect(r).toMatchObject({ ok: true, added: 1 })
    expect('post_asap' in db.social_calendar_items[0]).toBe(false)
  })

  it('records who added the items when a signed-in person did', async () => {
    const { admin, db } = fakeAdmin()
    await addSocialPlanItems(admin, { ...base, items: [{ title: 'Friday offer', date: '2026-12-04' }], createdBy: 'emp-1' })
    expect(db.social_calendars[0].created_by).toBe('emp-1')
    expect(db.social_calendar_items[0].created_by).toBe('emp-1')
    const anon = fakeAdmin()
    await addSocialPlanItems(anon.admin, { ...base, items: [{ title: 'Friday offer', date: '2026-12-04' }] })
    expect('created_by' in anon.db.social_calendar_items[0]).toBe(false)
  })

  it('drops missing columns whatever order the database reports them in', async () => {
    const { admin, db } = fakeAdmin({ missingCols: ['created_by', 'service_id'] })
    const r = await addSocialPlanItems(admin, { ...base, items: [{ title: 'Trend post', date: '2026-12-03' }], createdBy: 'emp-1' })
    expect(r).toMatchObject({ ok: true, added: 1 })
    expect(Object.keys(db.social_calendar_items[0])).not.toContain('service_id')
  })

  it('refuses an archived plan, an empty call and an oversized call', async () => {
    const { admin } = fakeAdmin({ calendars: [{ id: 'cal1', client_id: 'c1', month: '2026-12-01', status: 'archived' }] })
    expect(await addSocialPlanItems(admin, { ...base, items: [{ title: 'x' }] })).toMatchObject({ ok: false })
    expect(await addSocialPlanItems(admin, { ...base, items: [] })).toMatchObject({ ok: false })
    const many = Array.from({ length: MAX_ITEMS_PER_CALL + 1 }, (_, i) => ({ title: `t${i}` }))
    expect(await addSocialPlanItems(admin, { ...base, items: many })).toMatchObject({ ok: false })
  })
})

describe('listSocialPlan', () => {
  it('returns no plan rather than an error for a month nobody planned', async () => {
    const { admin } = fakeAdmin()
    expect(await listSocialPlan(admin, 'c1', '2026-12-01')).toEqual({ ok: true, plan: null, items: [] })
  })
  it('returns the plan with captions as plain text', async () => {
    const { admin } = fakeAdmin({
      calendars: [{ id: 'cal1', client_id: 'c1', month: '2026-12-01', title: null, status: 'active' }],
      items: [{ id: 'i1', calendar_id: 'cal1', scheduled_date: '2026-12-04', title: 'Offer', content_type: 'post', platforms: [], caption: 'Line one<br>Line two', notes: null, status: 'planned' }],
    })
    const r = await listSocialPlan(admin, 'c1', '2026-12-01')
    expect(r.ok && r.items[0]).toMatchObject({ scheduled_date: '2026-12-04', caption: 'Line one\nLine two' })
  })
})
