/**
 * Deleting a plan card hands the work to the calendar's own delete, which does
 * not look at a task started straight from the plan. That check is here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let item: Record<string, unknown> | null
let who = { isAdmin: true, isViewAs: false }
const calendarDelete = vi.fn()

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
    loadCurrentUser: () => Promise.resolve(null),
  }
})
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: item, error: null }) }) }) }),
  }),
}))
vi.mock('@/app/(dashboard)/dashboard/social-calendar/actions', () => ({
  deleteCalendarItem: (id: string) => calendarDelete(id),
}))
vi.mock('@/app/(dashboard)/dashboard/tasks/actions', () => ({ serverFillTaskBilling: vi.fn() }))
vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }))
vi.mock('@/lib/requests/task-sync', () => ({ syncRequestStatusFromTask: vi.fn() }))
vi.mock('@/lib/packages/auto-link', () => ({ autoLinkTaskPackage: vi.fn() }))
vi.mock('@/lib/requests/my-work-load', () => ({ loadMyWork: vi.fn() }))

import { deletePlanCard } from './actions'

beforeEach(() => {
  who = { isAdmin: true, isViewAs: false }
  item = { id: 'plan-1', task: null }
  calendarDelete.mockReset()
  calendarDelete.mockResolvedValue({ ok: true })
})

describe('deletePlanCard', () => {
  it.each([
    ['anyone who is not an admin', { isAdmin: false, isViewAs: false }],
    ['an admin previewing another admin', { isAdmin: true, isViewAs: true }],
  ])('refuses %s', async (_who, caller) => {
    who = caller
    expect((await deletePlanCard('plan-1')).ok).toBe(false)
    expect(calendarDelete).not.toHaveBeenCalled()
  })

  it('deletes a plan with no task behind it', async () => {
    expect((await deletePlanCard('plan-1')).ok).toBe(true)
    expect(calendarDelete).toHaveBeenCalledWith('plan-1')
  })

  it.each([
    ['cancelled', { status: 'cancelled', deleted_at: null }],
    ['in the Trash', { status: 'in_progress', deleted_at: '2026-01-01' }],
  ])('deletes a plan whose task is %s', async (_what, task) => {
    item = { id: 'plan-1', task }
    expect((await deletePlanCard('plan-1')).ok).toBe(true)
    expect(calendarDelete).toHaveBeenCalledWith('plan-1')
  })

  it('keeps a plan whose task still stands', async () => {
    item = { id: 'plan-1', task: { status: 'done', deleted_at: null } }
    const res = await deletePlanCard('plan-1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/has a task/)
    expect(calendarDelete).not.toHaveBeenCalled()
  })

  it('passes the calendar’s own refusal back', async () => {
    calendarDelete.mockResolvedValue({ ok: false, error: 'This is finished work.' })
    expect(await deletePlanCard('plan-1')).toEqual({ ok: false, error: 'This is finished work.' })
  })

  it('says so when the card is already gone', async () => {
    item = null
    expect((await deletePlanCard('plan-1')).ok).toBe(false)
    expect(calendarDelete).not.toHaveBeenCalled()
  })
})
