/**
 * Finance Engine — client contribution margin (pure).
 *
 * Management-accounting view, NOT a second ledger: the same salary rupee
 * appears in the Company P&L as what was actually paid (opex.salaries) and
 * here as who earned it (attributed labor via contribution_scores). The two
 * views are labeled and never summed together.
 *
 *   margin = invoiced − direct costs − attributed labor + rebilling markup
 */

import type { ClientProfitabilityInput, ClientProfitabilityRow } from './types'

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

export function buildClientProfitability(
  inputs: ClientProfitabilityInput[],
): { rows: ClientProfitabilityRow[]; totals: ClientProfitabilityRow } {
  const rows: ClientProfitabilityRow[] = inputs.map(i => {
    const markup = round2(i.markupRevenueInr ?? 0)
    const margin = round2(i.invoicedInr - i.directCostsInr - i.attributedLaborInr + markup)
    return {
      ...i,
      markupRevenueInr: markup,
      contributionMarginInr: margin,
      marginPct: i.invoicedInr > 0 ? Math.round((margin / i.invoicedInr) * 1000) / 10 : 0,
    }
  }).sort((a, b) => b.contributionMarginInr - a.contributionMarginInr)

  const sum = (f: (r: ClientProfitabilityRow) => number) =>
    round2(rows.reduce((s, r) => s + f(r), 0))
  const totals: ClientProfitabilityRow = {
    clientId: '__totals__',
    clientName: 'All clients',
    invoicedInr: sum(r => r.invoicedInr),
    collectedInr: sum(r => r.collectedInr),
    directCostsInr: sum(r => r.directCostsInr),
    attributedLaborInr: sum(r => r.attributedLaborInr),
    markupRevenueInr: sum(r => r.markupRevenueInr),
    contributionMarginInr: sum(r => r.contributionMarginInr),
    marginPct: 0,
  }
  totals.marginPct = totals.invoicedInr > 0
    ? Math.round((totals.contributionMarginInr / totals.invoicedInr) * 1000) / 10
    : 0

  return { rows, totals }
}
