/* eslint-disable @typescript-eslint/no-explicit-any -- a test double for the untyped Supabase query builder. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── A small stand-in for social_calendar_items and its joined request/task ───

type Item = { id: string; status: string; request_id: string | null; request: any }
let items: Item[]
let deleted: string[]
let cancelled: string[]

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }))
vi.mock('@/lib/permissions/check', () => ({
  requirePermission: () => Promise.resolve({ ok: true, employeeId: 'emp-1' }),
}))
vi.mock('@/lib/permissions/keys', () => ({ PERMS: { SOCIAL_MANAGE: 'social.manage' } }))
vi.mock('@/lib/settings/company-settings', () => ({ COMPANY_SETTINGS_TAG: 'x', getCompanySettings: vi.fn() }))
vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }))
vi.mock('@/app/(dashboard)/dashboard/requests/actions', () => ({ createManualRequest: vi.fn() }))
vi.mock('@/lib/requests/core', () => ({
  setRequestStatus: (_a: any, id: string) => { cancelled.push(id); return Promise.resolve(true) },
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      let id = ''
      const q: any = {
        select: () => q,
        eq: (col: string, v: string) => { if (col === 'id') id = v; return q },
        maybeSingle: () => {
          const it = items.find(i => i.id === id)
          return Promise.resolve({ data: it ?? null, error: null })
        },
        update: (patch: any) => {
          const u: any = {
            eq: (col: string, v: any) => (col === 'id' ? (id = v, u) : u),
            select: () => {
              const it = items.find(i => i.id === id)
              if (it) Object.assign(it, patch)
              return Promise.resolve({ data: it ? [{ id }] : [], error: null })
            },
          }
          return u
        },
        delete: () => ({
          eq: (_c: string, v: string) => { deleted.push(v); items = items.filter(i => i.id !== v); return Promise.resolve({ error: null }) },
        }),
      }
      return q
    },
  }),
}))

import { deleteCalendarItem, revertItemToPlanned } from './actions'

const milkees = (taskStatus: string, over: Partial<{ deleted_at: string | null; reqStatus: string }> = {}): Item => ({
  id: 'i1', status: 'requested', request_id: 'r1',
  request: {
    id: 'r1', ref_no: 39, status: over.reqStatus ?? 'in_progress', promoted_task_id: 't1',
    promoted_task: { id: 't1', status: taskStatus, deleted_at: over.deleted_at ?? null },
  },
})

beforeEach(() => { items = []; deleted = []; cancelled = [] })

describe('deleteCalendarItem — an item whose request became a task', () => {
  it('removes only the plan entry while the task is unfinished, leaving request and task alone', async () => {
    items = [milkees('in_progress')]
    const res = await deleteCalendarItem('i1')
    expect(res).toEqual({ ok: true })
    expect(deleted).toEqual(['i1'])
    expect(cancelled).toEqual([])          // the request is NOT cancelled from here
  })

  it('refuses finished work unless the caller acknowledges it', async () => {
    for (const status of ['delivered', 'done', 'invoiced', 'paid']) {
      items = [milkees(status)]
      const res = await deleteCalendarItem('i1')
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(new RegExp(`already ${status}`))
      expect(res.error).toMatch(/confirm/)
    }
    expect(deleted).toEqual([])
  })

  it('removes finished work from the PLAN only once acknowledged, never touching the task or request', async () => {
    items = [milkees('delivered', { reqStatus: 'delivered' })]
    const res = await deleteCalendarItem('i1', { acknowledgeFinished: true })
    expect(res).toEqual({ ok: true })
    expect(deleted).toEqual(['i1'])
    expect(cancelled).toEqual([])
  })

  it('still cancels the request of an item that was never a task', async () => {
    items = [{ id: 'i1', status: 'requested', request_id: 'r1', request: { id: 'r1', ref_no: 5, status: 'submitted', promoted_task_id: null, promoted_task: null } }]
    expect((await deleteCalendarItem('i1')).ok).toBe(true)
    expect(cancelled).toEqual(['r1'])
    expect(deleted).toEqual(['i1'])
  })

  it('a completed request the client has seen needs the acknowledgement too, and is not cancelled', async () => {
    items = [{ id: 'i1', status: 'requested', request_id: 'r1', request: { id: 'r1', ref_no: 5, status: 'completed', promoted_task_id: null, promoted_task: null } }]
    expect((await deleteCalendarItem('i1')).ok).toBe(false)
    expect(deleted).toEqual([])
    expect((await deleteCalendarItem('i1', { acknowledgeFinished: true })).ok).toBe(true)
    expect(deleted).toEqual(['i1'])
    expect(cancelled).toEqual([])
  })
})

describe('revertItemToPlanned — an item whose request became a task', () => {
  it('unlinks the plan entry and leaves the request and task untouched', async () => {
    items = [milkees('pending')]
    const res = await revertItemToPlanned('i1')
    expect(res).toEqual({ ok: true })
    expect(items[0]).toMatchObject({ request_id: null, status: 'planned' })
    expect(cancelled).toEqual([])
  })

  it('refuses when the task is finished', async () => {
    items = [milkees('delivered')]
    const res = await revertItemToPlanned('i1')
    expect(res.ok).toBe(false)
    expect(items[0].request_id).toBe('r1')
  })
})
