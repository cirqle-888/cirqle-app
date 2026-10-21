import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── A tiny stand-in for the two tables updateRequestTitle touches ────────────

let requests: Record<string, { id: string; title: string; updated_at?: string }>
let activity: any[]
let guardOk = true

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/permissions/check', () => ({
  requirePermission: () => Promise.resolve(guardOk ? { ok: true, employeeId: 'emp-1' } : { ok: false, error: 'Forbidden' }),
  requireReadPermission: () => Promise.resolve({ ok: true }),
  resolveCurrentEmployeeId: () => Promise.resolve('emp-1'),
  loadCurrentUser: () => Promise.resolve(null),
}))
vi.mock('@/lib/requests/notify', () => ({ notifyRequesterStatus: vi.fn(), notifyNewRequest: vi.fn() }))
vi.mock('@/lib/settings/company-settings', () => ({ getCompanySettings: () => Promise.resolve({}) }))
vi.mock('@/lib/ai/request-capture', () => ({ aiParse: vi.fn(), findClient: vi.fn(), findService: vi.fn(), normalizeDate: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === 'request_activity') {
        return { insert: (row: any) => { activity.push(row); return Promise.resolve({ error: null }) } }
      }
      // task_requests
      return {
        select: () => ({
          eq: (_c: string, id: string) => ({
            maybeSingle: () => Promise.resolve({ data: requests[id] ? { ...requests[id] } : null, error: null }),
          }),
        }),
        update: (patch: any) => ({
          eq: (_c: string, id: string) => {
            if (requests[id]) Object.assign(requests[id], patch)
            return Promise.resolve({ error: null })
          },
        }),
      }
    },
  }),
}))

import { updateRequestTitle } from './actions'

beforeEach(() => {
  requests = { r1: { id: 'r1', title: 'Coolng glass' } }
  activity = []
  guardOk = true
})

describe('updateRequestTitle', () => {
  it('saves the title with the same formatting as a task title', async () => {
    const res = await updateRequestTitle('r1', '  halloween   day  post for CQID004 ')
    expect(res).toEqual({ ok: true, data: { title: 'Halloween Day Post for CQID004' } })
    expect(requests.r1.title).toBe('Halloween Day Post for CQID004')
    expect(requests.r1.updated_at).toBeTruthy()
  })

  it('logs the rename internally as old → new', async () => {
    await updateRequestTitle('r1', 'cooling glass')
    expect(activity).toHaveLength(1)
    expect(activity[0]).toMatchObject({
      request_id: 'r1', action: 'field_changed', visibility: 'internal',
      detail: { field: 'title', from: 'Coolng glass', to: 'Cooling Glass' },
    })
  })

  it('keeps brand capitals and Malayalam as typed', async () => {
    const res = await updateRequestTitle('r1', 'iPhone ഓണം offer')
    expect(res.data?.title).toBe('iPhone ഓണം Offer')
  })

  it('writes and logs nothing when the formatted title is unchanged', async () => {
    requests.r1.title = 'Story Type Post'
    const res = await updateRequestTitle('r1', 'story type post')
    expect(res).toEqual({ ok: true, data: { title: 'Story Type Post' } })
    expect(requests.r1.updated_at).toBeUndefined()
    expect(activity).toHaveLength(0)
  })

  it('refuses an empty title, an unknown request, and staff without requests.manage', async () => {
    expect(await updateRequestTitle('r1', '   ')).toMatchObject({ ok: false, error: 'Title is required.' })
    expect(await updateRequestTitle('nope', 'X')).toMatchObject({ ok: false, error: 'Request not found.' })
    guardOk = false
    expect(await updateRequestTitle('r1', 'Anything')).toMatchObject({ ok: false, error: 'Forbidden' })
    expect(requests.r1.title).toBe('Coolng glass')
  })
})
