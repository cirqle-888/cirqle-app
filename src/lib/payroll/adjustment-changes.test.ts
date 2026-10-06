import { describe, it, expect } from 'vitest'
import { netChangesFromAudit, netEffect, forViewer, type AuditEntry } from './adjustment-changes'

// The real corrections behind CQID004's July 2026 adjustment (−₹291.20),
// reduced to the fields that matter. ME = CQID004, OTHER = CQID001.
const ME = 'emp-004', OTHER = 'emp-001'
const entry = (taskId: string, at: string, scores: unknown[], month = 7, year = 2026): AuditEntry =>
  ({ entity_id: taskId, actor_id: 'emp-002', created_at: at, detail: { month, year, scores } })
const row = (employee_id: string, from: number | null, to: number | null) => ({
  employee_id, from: from == null ? null : { earnings_inr: from }, to: to == null ? null : { earnings_inr: to },
})

const SEP4: AuditEntry[] = [
  entry('t1902', '2026-09-04T18:34:08Z', []),
  entry('t1902', '2026-09-04T18:35:23Z', [row(ME, 800, 693.33), row(OTHER, 0, 120)]),
  entry('t1903', '2026-09-04T18:35:50Z', []),
  entry('t1903', '2026-09-04T18:36:14Z', [row(ME, 800, 400), row(OTHER, 0, 450)]),
  entry('t1903', '2026-09-04T18:36:34Z', [row(ME, 400, 640), row(OTHER, 450, 180)]),
  entry('t1902', '2026-09-04T18:37:44Z', [row(ME, 693.33, 640), row(OTHER, 120, 180)]),
  entry('t1883', '2026-09-04T18:38:04Z', [row(ME, 216, 288)]),
  entry('t1883', '2026-09-04T18:38:21Z', [row(ME, 288, 230.4), row(OTHER, 0, 64.8)]),
  entry('t1885', '2026-09-04T18:38:48Z', [row(ME, 216, 230.4), row(OTHER, 0, 64.8)]),
]

describe('netChangesFromAudit', () => {
  it('nets each task first-from → last-to and sums to the recorded adjustment', () => {
    const c = netChangesFromAudit(SEP4, ME, 7, 2026)
    expect(c.map(x => [x.taskId, x.fromInr, x.toInr])).toEqual([
      ['t1902', 800, 640], ['t1903', 800, 640], ['t1883', 216, 230.4], ['t1885', 216, 230.4],
    ])
    expect(netEffect(c)).toBe(-291.2)   // the figure on the payroll screen
  })

  it("reads the other person's side of the same edits", () => {
    expect(netEffect(netChangesFromAudit(SEP4, OTHER, 7, 2026))).toBe(489.6)
  })

  it('ignores other months, and edits made before the month was paid', () => {
    expect(netChangesFromAudit(SEP4, ME, 8, 2026)).toEqual([])
    expect(netChangesFromAudit(SEP4, ME, 7, 2026, '2026-09-05T00:00:00Z')).toEqual([])
    expect(netChangesFromAudit(SEP4, ME, 7, 2026, '2026-09-04T18:38:00Z').map(c => c.taskId)).toEqual(['t1883', 't1885'])
  })

  it('reads a contributor removed from a task as earning nothing now', () => {
    const c = netChangesFromAudit([entry('t1', '2026-09-01T00:00:00Z', [row(ME, 300, null)])], ME, 7, 2026)
    expect(c).toEqual([expect.objectContaining({ fromInr: 300, toInr: 0 })])
  })

  it('drops tasks whose edits net to nothing', () => {
    const e = [entry('t1', '2026-09-01T00:00:00Z', [row(ME, 500, 400)]), entry('t1', '2026-09-01T01:00:00Z', [row(ME, 400, 500)])]
    expect(netChangesFromAudit(e, ME, 7, 2026)).toEqual([])
  })

  it('tolerates entries with no score detail', () => {
    expect(netChangesFromAudit([{ entity_id: 't', actor_id: null, created_at: '2026-09-01T00:00:00Z', detail: null }], ME, 7, 2026)).toEqual([])
  })
})

describe('forViewer — the employee a correction is about never sees the task detail', () => {
  const changes = [{ taskId: 't1' }]
  it('hides it from the employee themselves', () => {
    expect(forViewer(changes, { viewerEmployeeId: ME, subjectEmployeeId: ME, viewerIsAdmin: false })).toEqual([])
  })
  it('shows it to other staff who can see payroll amounts', () => {
    expect(forViewer(changes, { viewerEmployeeId: 'emp-002', subjectEmployeeId: ME, viewerIsAdmin: false })).toEqual(changes)
  })
  it('shows it to an admin, including on their own record', () => {
    expect(forViewer(changes, { viewerEmployeeId: ME, subjectEmployeeId: ME, viewerIsAdmin: true })).toEqual(changes)
  })
})
