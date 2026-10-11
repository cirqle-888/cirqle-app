import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ from: vi.fn(), insert: vi.fn(), sendWebPush: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mocks.from }) }))
vi.mock('@/lib/push/send', () => ({ sendWebPush: mocks.sendWebPush }))
import { notifyAdmins, notifyAdminsBatch } from './create'

const notification = { type: 'invoice_overdue', title: 'Follow up', sourceKey: 'invoice-1' }

describe.each([
  ['single', () => notifyAdmins(notification)],
  ['batch', () => notifyAdminsBatch([notification])],
] as const)('%s administrative notifications', (_label, notify) => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.insert.mockResolvedValue({ error: null })
    mocks.sendWebPush.mockResolvedValue(undefined)
    const employees = [
      { id: 'admin-1', designation_id: 'admin', designation: { is_admin: true } },
      { id: 'admin-2', designation_id: 'admin', designation: [{ is_admin: true }] },
      { id: 'unassigned', designation_id: null, designation: null },
      { id: 'staff', designation_id: 'staff', designation: { is_admin: false } },
    ]
    const query = {
      select: () => query,
      eq: () => query,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: employees, error: null }).then(resolve),
    }
    mocks.from.mockImplementation(table => table === 'employees' ? query : { insert: mocks.insert })
  })

  it('delivers only to explicit admin designations', async () => {
    await notify()
    const rows = mocks.insert.mock.calls[0][0]
    expect(rows.map((row: { employee_id: string }) => row.employee_id)).toEqual(['admin-1', 'admin-2'])
    expect(mocks.sendWebPush.mock.calls.map(call => call[0])).toEqual(['admin-1', 'admin-2'])
  })

  it('pushes only the new row after a partial duplicate conflict', async () => {
    mocks.insert
      .mockResolvedValueOnce({ error: { code: '23505' } })
      .mockResolvedValueOnce({ error: { code: '23505' } })
      .mockResolvedValueOnce({ error: null })
    await notify()
    expect(mocks.sendWebPush.mock.calls.map(call => call[0])).toEqual(['admin-2'])
  })

  it('does not send push when the notification write fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      mocks.insert.mockResolvedValue({ error: { code: '08006', message: 'Unavailable' } })
      await notify()
      expect(mocks.sendWebPush).not.toHaveBeenCalled()
    } finally {
      warning.mockRestore()
    }
  })
})
