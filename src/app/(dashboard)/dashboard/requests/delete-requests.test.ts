/**
 * Deleting a request is permanent, so what matters here is what it refuses:
 * anyone but an admin, any "view as" preview, anything with a work record, a
 * row that changed after it was checked, and any run where a link could not be
 * read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── A small stand-in for the three tables deleteRequests touches ─────────────

type Row = Record<string, unknown>
let db: Record<string, Row[]>
let readErrors: Record<string, { code: string; message: string }>
let who = { isAdmin: true, isViewAs: false }
let logged: Row[]
/** Runs just after a table is read: how a test changes a row mid-delete. */
let afterRead: Record<string, () => void>

function query(table: string) {
  let op: 'select' | 'delete' | 'update' = 'select'
  let patch: Row = {}
  const filters: ((r: Row) => boolean)[] = []
  const run = () => {
    if (op === 'select' && readErrors[table]) return { data: null, error: readErrors[table] }
    const hit = db[table].filter(r => filters.every(f => f(r)))
    if (op === 'delete') db[table] = db[table].filter(r => !hit.includes(r))
    if (op === 'update') hit.forEach(r => Object.assign(r, patch))
    const result = { data: hit.map(r => ({ ...r })), error: null }
    if (op === 'select') afterRead[table]?.()
    return result
  }
  const builder = {
    select: () => builder,
    delete: () => { op = 'delete'; return builder },
    update: (p: Row) => { op = 'update'; patch = p; return builder },
    eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return builder },
    is: (c: string, v: unknown) => { filters.push(r => (r[c] ?? null) === v); return builder },
    in: (c: string, vs: unknown[]) => { filters.push(r => vs.includes(r[c])); return builder },
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
  }
  return builder
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/permissions/check', async () => {
  const { guardDecision } = await vi.importActual<typeof import('@/lib/permissions/check')>('@/lib/permissions/check')
  return {
    // The real guard rule, for a made-up caller who holds every permission key.
    requirePermission: async () => {
      const decision = guardDecision(
        { ...who, isArchived: false, designationId: 'des-1', hasPermission: true }, { allowViewAs: false })
      return decision.ok ? { ...decision, employeeId: 'emp-1' } : decision
    },
    requireReadPermission: () => Promise.resolve({ ok: false }),
    resolveCurrentEmployeeId: () => Promise.resolve('emp-1'),
    loadCurrentUser: () => Promise.resolve(null),
  }
})
vi.mock('@/lib/activity/log', () => ({ logActivity: (row: Row) => { logged.push(row); return Promise.resolve() } }))
vi.mock('@/lib/requests/notify', () => ({ notifyRequesterStatus: vi.fn(), notifyNewRequest: vi.fn() }))
vi.mock('@/lib/settings/company-settings', () => ({ getCompanySettings: () => Promise.resolve({}) }))
vi.mock('@/lib/ai/request-capture', () => ({ aiParse: vi.fn(), findClient: vi.fn(), findService: vi.fn(), normalizeDate: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: query }) }))

import { deleteRequests } from './actions'

const request = (id: string, status: string, task: Row | null = null): Row => ({
  id, ref_no: 1, title: `Request ${id}`, status,
  promoted_task_id: task ? `task-${id}` : null, promoted_task: task,
})
const left = () => db.task_requests.map(r => r.id)

beforeEach(() => {
  who = { isAdmin: true, isViewAs: false }
  logged = []
  readErrors = {}
  afterRead = {}
  db = {
    task_requests: [
      request('test', 'submitted'),
      request('cancelled', 'cancelled'),
      request('trashed-task', 'cancelled', { status: 'pending', deleted_at: '2026-01-01' }),
      request('cancelled-task', 'archived', { status: 'cancelled', deleted_at: null }),
      request('working', 'in_progress', { status: 'in_progress', deleted_at: null }),
      request('billed', 'archived', { status: 'invoiced', deleted_at: null }),
      request('finished', 'completed'),
      request('advert', 'cancelled'),
    ],
    ad_projects: [{ id: 'ad-1', request_id: 'advert' }],
    social_calendar_items: [
      { id: 'plan-1', request_id: 'cancelled', status: 'requested' },
      { id: 'plan-2', request_id: 'working', status: 'requested' },
      { id: 'plan-3', request_id: null, status: 'planned' },
    ],
  }
})

const everything = () => db.task_requests.map(r => r.id as string)

describe('deleteRequests', () => {
  it('refuses anyone who is not an admin, even one who manages requests', async () => {
    who = { isAdmin: false, isViewAs: false }
    const res = await deleteRequests(['test'])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Only an admin/)
    expect(left()).toContain('test')
    expect(logged).toHaveLength(0)
  })

  it('stays read-only while an admin previews another admin', async () => {
    who = { isAdmin: true, isViewAs: true }
    const res = await deleteRequests(['test'])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/read-only/)
    expect(left()).toContain('test')
  })

  it('deletes test, cancelled and abandoned requests, and keeps anything with a work record', async () => {
    const res = await deleteRequests(everything())
    expect(res.ok).toBe(true)
    expect(res.data!.deleted.sort()).toEqual(['cancelled', 'cancelled-task', 'test', 'trashed-task'])
    expect(left().sort()).toEqual(['advert', 'billed', 'finished', 'working'])
    const reasons = Object.fromEntries(res.data!.kept.map(k => [k.id, k.reason]))
    expect(reasons.working).toMatch(/has a task/)
    expect(reasons.billed).toMatch(/has a task/)
    expect(reasons.finished).toMatch(/finished work/)
    expect(reasons.advert).toMatch(/advertising project/)
  })

  it('writes each delete to the activity log, since the request’s own timeline goes with it', async () => {
    await deleteRequests(['test'])
    expect(logged).toEqual([expect.objectContaining({
      actorId: 'emp-1', entityType: 'request', entityId: 'test', action: 'deleted',
    })])
  })

  it('cancels the calendar entry behind a deleted request, and only that one', async () => {
    await deleteRequests(['cancelled', 'working'])
    const status = Object.fromEntries(db.social_calendar_items.map(i => [i.id, i.status]))
    expect(status).toEqual({ 'plan-1': 'cancelled', 'plan-2': 'requested', 'plan-3': 'planned' })
  })

  it('leaves a request alone if its status changed after it was checked', async () => {
    afterRead.social_calendar_items = () => {
      db.task_requests.find(r => r.id === 'test')!.status = 'in_progress'
    }
    const res = await deleteRequests(['test'])
    expect(res.data!.deleted).toEqual([])
    expect(res.data!.kept[0].reason).toMatch(/changed/)
    expect(left()).toContain('test')
  })

  it('leaves a request alone if a task was started after it was checked', async () => {
    afterRead.social_calendar_items = () => {
      db.task_requests.find(r => r.id === 'test')!.promoted_task_id = 'task-new'
    }
    const res = await deleteRequests(['test'])
    expect(res.data!.deleted).toEqual([])
    expect(left()).toContain('test')
  })

  it('deletes nothing when a link cannot be read', async () => {
    readErrors.ad_projects = { code: '57014', message: 'timeout' }
    const res = await deleteRequests(['advert', 'test'])
    expect(res.ok).toBe(false)
    expect(left()).toEqual(expect.arrayContaining(['advert', 'test']))
  })

  it('treats a module that was never set up as having no links', async () => {
    readErrors.ad_projects = { code: '42P01', message: 'relation does not exist' }
    const res = await deleteRequests(['test'])
    expect(res.data!.deleted).toEqual(['test'])
  })

  it('asks for something to delete', async () => {
    expect((await deleteRequests([])).ok).toBe(false)
  })
})
