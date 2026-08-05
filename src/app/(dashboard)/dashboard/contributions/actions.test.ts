import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────

let mockGuard = vi.fn()
let monthProtected = false
let existingScores: any[] = []
const captured: Record<string, any[]> = { contributions: [], contribution_scores: [], task_tools: [] }
const deleted: string[] = []

vi.mock('@/lib/permissions/check', () => ({
  requireAnyPermission: (...a: any[]) => mockGuard(...a),
  requirePermission: (...a: any[]) => mockGuard(...a),
}))
vi.mock('@/lib/permissions/keys', () => ({
  PERMS: { CONTRIBUTIONS_EDIT: 'contributions.edit', TASKS_CREATE: 'tasks.create' },
}))
vi.mock('@/lib/payroll/compute', () => ({
  isTaskMonthProtected: () => Promise.resolve(monthProtected),
}))
vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }))
vi.mock('@/lib/sync/agreement-earnings', () => ({
  syncTaskAgreementEarnings: vi.fn(() => Promise.resolve({ changed: 0 })),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({
            data: { id: 't1', status: 'pending', task_date: '2026-08-01', title: 'Poster' },
            error: null,
          }),
          then: (r: any) => r({ data: existingScores, error: null }),
        }),
      }),
      insert: (rows: any) => {
        captured[table] = (captured[table] ?? []).concat(rows)
        return Promise.resolve({ error: null })
      },
      delete: () => ({ eq: () => { deleted.push(table); return Promise.resolve({ error: null }) } }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  }),
}))

import { saveTaskContributions } from './actions'

beforeEach(() => {
  mockGuard = vi.fn(() => Promise.resolve({ ok: true, employeeId: 'me' }))
  monthProtected = false
  existingScores = []
  for (const k of Object.keys(captured)) captured[k] = []
  deleted.length = 0
})

describe('saveTaskContributions (Phase 3.0)', () => {
  it('refuses without the contributions.edit permission', async () => {
    mockGuard = vi.fn(() => Promise.resolve({ ok: false, error: 'Forbidden' }))
    const res = await saveTaskContributions({ taskId: 't1', contributions: {} })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('Forbidden')
    expect(captured.contribution_scores).toHaveLength(0)
  })

  it('refuses when the payroll month is finalized', async () => {
    monthProtected = true
    const res = await saveTaskContributions({
      taskId: 't1', contributions: {},
      scores: [{ employeeId: 'e1', scorePercentage: 100, earnings: 500 }],
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/finalized/i)
    expect(deleted).not.toContain('contribution_scores')
  })

  it('preserves a manually-overridden score instead of recomputing over it', async () => {
    // The reason this phase exists: ~97% of contribution_scores carry this flag,
    // and the old browser-side delete-then-insert discarded every one of them.
    existingScores = [
      { employee_id: 'e1', score_percentage: 80, earnings_inr: 999, is_manual_override: true },
      { employee_id: 'e2', score_percentage: 20, earnings_inr: 100, is_manual_override: false },
    ]
    const res = await saveTaskContributions({
      taskId: 't1', contributions: {},
      scores: [
        { employeeId: 'e1', scorePercentage: 50, earnings: 111 },  // must NOT win
        { employeeId: 'e2', scorePercentage: 50, earnings: 222 },  // must win
      ],
    })
    expect(res.ok).toBe(true)
    expect(res.preservedOverrides).toBe(1)

    const rows = captured.contribution_scores
    const e1 = rows.find((r: any) => r.employee_id === 'e1')
    const e2 = rows.find((r: any) => r.employee_id === 'e2')

    expect(e1.earnings_inr).toBe(999)           // original override kept
    expect(e1.is_manual_override).toBe(true)
    expect(e2.earnings_inr).toBe(222)           // recomputed
    expect(e2.is_manual_override).toBe(false)
  })

  it('drops zero and negative contribution values', async () => {
    await saveTaskContributions({
      taskId: 't1',
      contributions: { p1: { e1: 5, e2: 0 }, p2: { e3: -1 } },
    })
    expect(captured.contributions).toHaveLength(1)
    expect(captured.contributions[0]).toMatchObject({ employee_id: 'e1', value: 5 })
  })

  it('leaves scores untouched when none are supplied', async () => {
    const res = await saveTaskContributions({ taskId: 't1', contributions: { p1: { e1: 3 } } })
    expect(res.ok).toBe(true)
    expect(deleted).not.toContain('contribution_scores')
    expect(captured.contribution_scores).toHaveLength(0)
  })

  it('score-only recalc (no contributions key) never touches contributions or tools', async () => {
    // The bulk auto-recalc path recomputes earnings from existing DB rows —
    // it must replace scores while leaving contributions/task_tools intact.
    const res = await saveTaskContributions({
      taskId: 't1',
      scores: [{ employeeId: 'e1', scorePercentage: 100, earnings: 500 }],
    })
    expect(res.ok).toBe(true)
    expect(deleted).not.toContain('contributions')
    expect(deleted).not.toContain('task_tools')
    expect(deleted).toContain('contribution_scores')
    expect(captured.contribution_scores).toHaveLength(1)
  })
})
