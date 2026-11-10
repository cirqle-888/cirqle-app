/**
 * The shape a job's referral must have before it is saved — pure, so the rule
 * the database CHECK enforces (tasks_referral_shape) is tested in one place
 * and the editor can say what is wrong before a round trip.
 *
 *   both empty                     → no referral (clears one)
 *   a staff member and 0 < % ≤ 100 → a referral
 *   anything else                  → refused, with a sentence a person can act on
 */

import { round2 } from '@/lib/calculations/currency'

export type ReferralCheck =
  | { ok: true; employeeId: string | null; percent: number | null }
  | { ok: false; error: string }

export function validateReferral(employeeId: string | null | undefined, percent: number | null | undefined): ReferralCheck {
  const who = employeeId?.trim() || null
  const pct = percent == null || Number.isNaN(Number(percent)) ? null : Number(percent)

  if (!who && pct == null) return { ok: true, employeeId: null, percent: null }
  if (!who) return { ok: false, error: 'Pick who referred this job, or clear the %.' }
  if (pct == null) return { ok: false, error: 'Enter their commission %.' }
  if (pct <= 0) return { ok: false, error: 'The commission % must be more than 0.' }
  if (pct > 100) return { ok: false, error: 'The commission % cannot be more than 100.' }
  // Two decimals, matching the column (numeric 6,2) — so what is shown is what is paid.
  return { ok: true, employeeId: who, percent: round2(pct) }
}

/** What a referral pays on one job — the same arithmetic the engine uses. */
export function referralCommission(billingInr: number | null | undefined, percent: number | null | undefined): number {
  const pct = Math.min(100, Math.max(0, Number(percent) || 0))
  return round2((Number(billingInr) || 0) * pct / 100)
}

// ── Client referral ──────────────────────────────────────────────────────────
//
// "This client came through <staff>, X%, from <date> (until <date>)". New jobs
// pick it up from a database trigger (20261110200000_client_referral); this is
// the other half — what saving the client's referral does to jobs that ALREADY
// exist. Pure, so the rule is tested without a database.

export interface ClientReferral {
  employeeId: string
  percent: number
  /** YYYY-MM-DD, first job date it covers. */
  from: string
  /** YYYY-MM-DD, last job date it covers; null = no end. */
  until: string | null
}

export interface ReferralJob {
  id: string
  /** YYYY-MM-DD */
  date: string
  referredBy: string | null
  percent: number | null
}

const inRange = (date: string, r: ClientReferral) =>
  date >= r.from && (r.until == null || date <= r.until)

const sameReferral = (j: ReferralJob, r: ClientReferral) =>
  j.referredBy === r.employeeId && Number(j.percent) === Number(r.percent)

/**
 * What saving a client's referral changes on its existing jobs.
 *
 * A job "follows the client" when it has no referral of its own, or when it
 * carries exactly the client's previous referral inside the previous range
 * (it was filled from the client). Those jobs are brought in line:
 *   inside the new range  → the new referral
 *   outside it            → cleared, but only if it came from the old one
 * A job someone set differently by hand is left alone — that choice was made
 * on purpose, job by job. `next = null` removes the client's referral.
 *
 * Returns only jobs that actually change. Paid-month filtering is the
 * caller's job (it needs the database).
 */
export function planClientReferralSync(
  jobs: ReferralJob[],
  prev: ClientReferral | null,
  next: ClientReferral | null,
): { id: string; date: string; referredBy: string | null; percent: number | null }[] {
  const out: { id: string; date: string; referredBy: string | null; percent: number | null }[] = []
  for (const j of jobs) {
    const empty = j.referredBy == null && j.percent == null
    const fromPrev = prev != null && inRange(j.date, prev) && sameReferral(j, prev)
    if (!empty && !fromPrev) continue

    if (next && inRange(j.date, next)) {
      if (!sameReferral(j, next)) out.push({ id: j.id, date: j.date, referredBy: next.employeeId, percent: next.percent })
    } else if (fromPrev) {
      out.push({ id: j.id, date: j.date, referredBy: null, percent: null })
    }
  }
  return out
}

/** Check the date range of a client referral; null when it is fine. */
export function clientReferralRangeError(from: string, until: string | null): string | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/
  if (!iso.test(from)) return 'Pick the date it starts from.'
  if (until != null && !iso.test(until)) return 'The end date is not a valid date.'
  if (until != null && until < from) return 'The end date is before the start date.'
  return null
}
