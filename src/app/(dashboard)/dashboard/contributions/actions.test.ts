import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────

let mockGuard = vi.fn()
let monthProtected = false
let existingScores: any[] = []
const captured: Record<string, any[]> = { contributions: [], contribution_scores: [], task_tools: [] }
const deleted: string[] = []
const updatedTables: string[] = []
const loggedActivity: any[] = []
const recordAdjustmentsCalls: { month: number; year: number }[] = []
const recalcCalls: { taskId: string; userId?: string }[] = []
let recordedAdjustments = 0

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))
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
vi.mock('@/lib/activity/log', () => ({
  logActivity: (input: any) => { loggedActivity.push(input); return Promise.resolve() },
}))
vi.mock('@/lib/payroll/adjustments', () => ({
  recordAdjustments: (_admin: any, month: number, year: number) => {
    recordAdjustmentsCalls.push({ month, year })
    return Promise.resolve({ recorded: recordedAdjustments })
  },
}))
// saveTaskContributions calls recalcTaskCommissions (added in 01d3377) purely as
// a downstream side effect. That module builds its OWN client via
// createTypedAdminClient in @/lib/supabase/server — a different seam from the
// @/lib/supabase/admin mock below — so without this the real supabase-js
// constructor ran and every case here died on "supabaseUrl is required".
// The recalc has its own coverage; this suite is about the closed-month
// correction path, so it is stubbed and its calls recorded.
vi.mock('@/lib/sync/integrity', () => ({
  recalcTaskCommissions: (taskId: string, userId?: string) => {
    recalcCalls.push({ taskId, userId })
    return Promise.resolve({ ok: true })
  },
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
      update: () => ({ eq: () => { updatedTables.push(table); return Promise.resolve({ error: null }) } }),
    }),
  }),
}))

import { saveTaskContributions } from './actions'

beforeEach(() => {
  mockGuard = vi.fn(() => Promise.resolve({ ok: true, employeeId: 'me' }))
  monthProtected = false
  existingScores = []
  recordedAdjustments = 0
  for (const k of Object.keys(captured)) captured[k] = []
  deleted.length = 0
  updatedTables.length = 0
  loggedActivity.length = 0
  recordAdjustmentsCalls.length = 0
})

describe('saveTaskContributions (Phase 3.0)', () => {
  it('refuses without the contributions.edit permission', async () => {
    mockGuard = vi.fn(() => Promise.resolve({ ok: false, error: 'Forbidden' }))
    const res = await saveTaskContributions({ taskId: 't1', contributions: {} })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('Forbidden')
    expect(captured.contribution_scores).toHaveLength(0)
  })

  // ── Closed-period corrections ──────────────────────────────────────────────
  // Closed books are never reopened, but the WORK RECORD is not the books. A
  // task remembered late belongs in the month it happened; the money difference
  // rides to the next open payroll as a prior-period adjustment.

  it('SAVES into a closed month instead of refusing', async () => {
    monthProtected = true
    const res = await saveTaskContributions({
      taskId: 't1', contributions: {},
      scores: [{ employeeId: 'e1', scorePercentage: 100, earnings: 500 }],
    })
    expect(res.ok).toBe(true)
    expect(res.closedPeriod).toBe(true)
    // The work data is written — that is the whole point of the correction.
    expect(captured.contribution_scores).toHaveLength(1)
  })

  it('queues the difference through the EXISTING adjustment engine', async () => {
    monthProtected = true
    recordedAdjustments = 2
    const res = await saveTaskContributions({
      taskId: 't1', contributions: {},
      scores: [{ employeeId: 'e1', scorePercentage: 100, earnings: 500 }],
    })
    expect(recordAdjustmentsCalls).toEqual([{ month: 8, year: 2026 }])
    expect(res.adjustmentsRecorded).toBe(2)
    expect(res.correctedMonth).toMatch(/2026/)
  })

  it('never advances task status in a closed month', async () => {
    // tasks.status feeds revenue reporting, so flipping a historical task to
    // done would restate the closed month's revenue — the one thing a
    // prior-period correction must never do.
    monthProtected = true
    await saveTaskContributions({
      taskId: 't1', contributions: {},
      scores: [{ employeeId: 'e1', scorePercentage: 100, earnings: 500 }],
      markDone: true,
    })
    expect(updatedTables).not.toContain('tasks')

    // …but an OPEN month still marks it done, unchanged.
    monthProtected = false
    updatedTables.length = 0
    await saveTaskContributions({
      taskId: 't1', contributions: {},
      scores: [{ employeeId: 'e1', scorePercentage: 100, earnings: 500 }],
      markDone: true,
    })
    expect(updatedTables).toContain('tasks')
  })

  it('audits the correction with actor, month, reason and a before/after diff', async () => {
    monthProtected = true
    existingScores = [
      { employee_id: 'e1', score_percentage: 40, earnings_inr: 200, is_manual_override: false },
    ]
    await saveTaskContributions({
      taskId: 't1', contributions: {},
      scores: [{ employeeId: 'e1', scorePercentage: 100, earnings: 500 }],
      reason: 'Task remembered late',
    })

    const entry = loggedActivity.find(a => a.action === 'contribution_corrected_closed_period')
    expect(entry, 'a closed-period edit must never be silent').toBeDefined()
    expect(entry.actorId).toBe('me')
    expect(entry.note).toBe('Task remembered late')
    expect(entry.detail.month).toBe(8)
    expect(entry.detail.year).toBe(2026)
    expect(Array.isArray(entry.detail.scores)).toBe(true)
  })

  it('leaves an open month on the plain save path — no correction machinery', async () => {
    monthProtected = false
    const res = await saveTaskContributions({
      taskId: 't1', contributions: {},
      scores: [{ employeeId: 'e1', scorePercentage: 100, earnings: 500 }],
    })
    expect(res.closedPeriod).toBeUndefined()
    expect(recordAdjustmentsCalls).toHaveLength(0)
    expect(loggedActivity.some(a => a.action === 'contribution_saved')).toBe(true)
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
