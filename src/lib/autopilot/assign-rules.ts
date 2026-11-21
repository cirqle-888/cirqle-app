/**
 * Who should get a new request: the person who usually does this client's
 * work. Pure; see assign.ts for the reads and the write.
 *
 * Evidence is task assignments in the last few months: the same client AND
 * service counts three times, the same client with another service once.
 * Someone is picked only when they clearly lead (at least half of the
 * weighted history and at least two jobs); a split team or a new client
 * stays for a person to decide.
 */

export const HISTORY_DAYS = 120

export interface AssignHistoryRow { client_id: string; service_id: string | null; employee_id: string }
export interface AssignRequest { id: string; client_id: string | null; service_id: string | null }

export function pickAssignee(req: AssignRequest, history: AssignHistoryRow[], active: Set<string>): { employeeId: string; sharePct: number; jobs: number } | null {
  if (!req.client_id) return null
  const score = new Map<string, number>()
  const jobs = new Map<string, number>()
  let total = 0
  for (const h of history) {
    if (h.client_id !== req.client_id || !active.has(h.employee_id)) continue
    const w = req.service_id && h.service_id === req.service_id ? 3 : 1
    score.set(h.employee_id, (score.get(h.employee_id) || 0) + w)
    jobs.set(h.employee_id, (jobs.get(h.employee_id) || 0) + 1)
    total += w
  }
  if (!total) return null
  const [best] = [...score.entries()].sort((a, b) => b[1] - a[1])
  const share = best[1] / total
  const n = jobs.get(best[0]) || 0
  if (share < 0.5 || n < 2) return null
  return { employeeId: best[0], sharePct: Math.round(share * 100), jobs: n }
}
