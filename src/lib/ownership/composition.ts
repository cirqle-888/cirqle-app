/**
 * Award composition — "where did this money come from".
 *
 * An ownership award is one number: 2% of ₹32,008. This module turns the lines
 * behind that basis into the two questions people actually ask — which clients
 * generated it, and which pieces of work inside each client.
 *
 * Pure grouping over `BasisLine[]`. The lines come from
 * `loadPeriodComposition`, which returns exactly the rows the engine summed to
 * produce the award, so a breakdown here always reconciles to the payout.
 */

import type { BasisLine } from './types'

const r2 = (n: number) => Math.round(n * 100) / 100

export interface CompositionLine extends BasisLine {
  /** This line's share of the basis, 0–100. */
  sharePct: number
  /** What it contributed to the award, when a single rate applies. */
  earnedInr: number | null
}

export interface ClientComposition {
  clientId: string | null
  totalInr: number
  sharePct: number
  lineCount: number
  /** What this client contributed to the award, when a single rate applies. */
  earnedInr: number | null
  lines: CompositionLine[]
}

export interface Composition {
  totalInr: number
  lineCount: number
  /** The rate applied throughout, or null when participants earn at different rates. */
  ratePercent: number | null
  clients: ClientComposition[]
}

/**
 * The single rate behind a set of awards, or null when they differ.
 *
 * With one participant — the normal case while an owner still wears the hat —
 * every line can show what it contributed. With two participants on different
 * percentages there is no one answer, so the breakdown shows shares only
 * rather than picking someone's rate and implying it applies to everyone.
 */
export function singleRate(percents: (number | null)[]): number | null {
  const distinct = new Set(percents)
  if (distinct.size !== 1) return null
  const only = [...distinct][0]
  return only == null ? null : only
}

/**
 * Group basis lines by client, biggest first, with each client's lines nested.
 *
 * Lines with no client (an untagged receipt, a task recorded without one) fall
 * into a single `clientId: null` group rather than being dropped — money that
 * paid an award has to appear somewhere or the breakdown stops adding up.
 */
export function buildComposition(lines: BasisLine[], ratePercent: number | null): Composition {
  const total = lines.reduce((s, l) => s + l.amountInr, 0)
  const share = (amount: number) => (total > 0 ? r2((amount / total) * 100) : 0)
  const earned = (amount: number) => (ratePercent == null ? null : r2(amount * (ratePercent / 100)))

  const byClient = new Map<string, BasisLine[]>()
  for (const l of lines) {
    const key = l.clientId ?? ''
    const list = byClient.get(key)
    if (list) list.push(l)
    else byClient.set(key, [l])
  }

  const clients: ClientComposition[] = [...byClient.entries()].map(([key, clientLines]) => {
    const clientTotal = clientLines.reduce((s, l) => s + l.amountInr, 0)
    return {
      clientId: key === '' ? null : key,
      totalInr: r2(clientTotal),
      sharePct: share(clientTotal),
      lineCount: clientLines.length,
      earnedInr: earned(clientTotal),
      lines: clientLines
        .map(l => ({ ...l, sharePct: share(l.amountInr), earnedInr: earned(l.amountInr) }))
        .sort((a, b) => b.amountInr - a.amountInr || b.date.localeCompare(a.date)),
    }
  })

  clients.sort((a, b) =>
    b.totalInr - a.totalInr || (a.clientId ?? '').localeCompare(b.clientId ?? ''))

  return { totalInr: r2(total), lineCount: lines.length, ratePercent, clients }
}
