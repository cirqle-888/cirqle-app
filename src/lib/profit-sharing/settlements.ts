/**
 * Settling what is owed (design §10.4).
 *
 * Pending = amount − Σ settlements. A settlement is paid (Cash Book outflow,
 * linked one-to-one), reinvested (capital, no cash), waived (reason required)
 * or an advance offset (against a withdrawal reviewed as an advance
 * distribution). The database refuses over-settlement too; these checks give
 * the Admin a readable message before the write is attempted.
 */

import { round2 } from '@/lib/calculations/currency'

export type SettlementKind = 'paid' | 'reinvested' | 'waived' | 'advance_offset'

export const pendingOf = (amountInr: number, settled: { amountInr: number }[]) =>
  round2(amountInr - settled.reduce((s, x) => s + x.amountInr, 0))

export interface SettlementCheck {
  kind: SettlementKind
  amountInr: number
  pendingInr: number
  reason?: string | null
  /** For advance offsets: what the reviewed advance still has left. */
  advanceLeftInr?: number
  /** For device reinvestment: an approved device-investment agreement is in force (D10). */
  hasDeviceAgreement?: boolean
  isDevice?: boolean
  /** For payments: cash available right now, and whether the shortfall was acknowledged (D13). */
  cashAvailableInr?: number
  cashAck?: string | null
}

export function settlementRefusal(c: SettlementCheck): string | null {
  const amount = round2(c.amountInr)
  if (!(amount > 0)) return 'Enter an amount above zero.'
  if (amount > round2(c.pendingInr) + 0.004) return `Only ₹${round2(c.pendingInr).toLocaleString('en-IN')} is still pending.`
  if (c.kind === 'waived' && !c.reason?.trim()) return 'A waiver needs a written reason.'
  if (c.kind === 'advance_offset') {
    if (c.isDevice) return 'Advance offsets apply to profit-share entitlements only.'
    if (c.advanceLeftInr == null) return 'Choose the reviewed advance to offset.'
    if (amount > round2(c.advanceLeftInr) + 0.004) return `That advance has only ₹${round2(c.advanceLeftInr).toLocaleString('en-IN')} left.`
  }
  if (c.kind === 'reinvested' && c.isDevice && !c.hasDeviceAgreement) {
    return 'Device value can become capital only under an approved written device-investment agreement.'
  }
  if (c.kind === 'paid' && c.cashAvailableInr != null && amount > c.cashAvailableInr && !c.cashAck?.trim()) {
    return 'This payment is more than the cash available. Record a written acknowledgement to continue.'
  }
  return null
}
