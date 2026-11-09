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
