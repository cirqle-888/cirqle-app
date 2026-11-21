/**
 * Per-brand result (pure) — what each of Cirqle's brands brought in and cost,
 * measured from real rows only.
 *
 *   revenue          client work billed in the period, by the brand that SELLS
 *                    the service (service.brand_id; NULL = default brand).
 *                    Same predicate as the profit engine: billable tasks by
 *                    task_date, billing_amount_inr.
 *   direct labour    contribution earnings on those same tasks.
 *   other income     company cash-book receipts tagged with the brand (e.g.
 *                    Memoura orders paid straight to Cirqle).
 *   ad spend         company campaigns' Meta spend incl. 18% GST, by the
 *                    campaign's brand.
 *   brand expenses   company cash-book payments tagged with the brand. Ad
 *                    wallet top-ups are skipped — their spend is already
 *                    counted from Meta, and counting both would double it.
 *   = brand result   before shared overheads (salaries, rent, untagged costs),
 *                    which are deliberately NOT apportioned here.
 *
 * Every brand in `brands` gets a row, even with nothing in it, so a new brand
 * shows up at ₹0 rather than missing.
 */

import { brandKey, type Brand } from './brands'

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

export interface BrandPnlTask {
  id: string
  client_id: string | null
  service_id: string | null
  billing_amount_inr: number | null
  is_billable?: boolean | null
}

export interface BrandPnlCampaign {
  id: string
  client_id: string | null
  brand_id: string | null
}

export interface BrandPnlEntry {
  id: string
  type: 'inflow' | 'outflow' | string
  amount_inr: number | null
  brand_id: string | null
  scope?: string | null
  client_id?: string | null
}

export interface BrandPnlInput {
  brands: Brand[]
  /** service id → the brand that sells it (NULL = default). */
  serviceBrand: Map<string, string | null>
  tasks: BrandPnlTask[]
  /** task id → contribution earnings (INR). */
  earningsByTask: Map<string, number>
  campaigns: BrandPnlCampaign[]
  /** campaign id → Meta spend in the period, EXCLUDING GST. */
  spendByCampaign: Map<string, number>
  entries: BrandPnlEntry[]
  /** Cash-book entries that funded an ad wallet — never brand expenses. */
  walletFundingEntryIds: Set<string>
  gstRate?: number
}

export interface BrandPnlRow {
  brandId: string
  revenueInr: number
  directLabourInr: number
  contributionMarginInr: number
  otherIncomeInr: number
  adSpendInr: number
  brandExpensesInr: number
  resultInr: number
  billedTasks: number
}

export function computeBrandPnl(input: BrandPnlInput): BrandPnlRow[] {
  const gst = input.gstRate ?? 0.18
  const rows = new Map<string, BrandPnlRow>()
  const row = (id: string | null) => {
    if (!id) return null
    let r = rows.get(id)
    if (!r) {
      r = { brandId: id, revenueInr: 0, directLabourInr: 0, contributionMarginInr: 0, otherIncomeInr: 0,
            adSpendInr: 0, brandExpensesInr: 0, resultInr: 0, billedTasks: 0 }
      rows.set(id, r)
    }
    return r
  }
  for (const b of input.brands) row(b.id)

  // Client work → the brand that sells the service.
  for (const t of input.tasks) {
    if (!t.client_id) continue                       // internal work earns nothing
    if (t.is_billable === false) continue            // waived: no revenue (labour still paid below)
    const r = row(brandKey(t.service_id ? input.serviceBrand.get(t.service_id) ?? null : null, input.brands))
    if (!r) continue
    r.revenueInr += Number(t.billing_amount_inr || 0)
    r.billedTasks++
  }
  // Labour is a cost whether or not the work was billed (waived work still paid).
  for (const t of input.tasks) {
    if (!t.client_id) continue
    const r = row(brandKey(t.service_id ? input.serviceBrand.get(t.service_id) ?? null : null, input.brands))
    if (!r) continue
    r.directLabourInr += Number(input.earningsByTask.get(t.id) || 0)
  }

  // Company campaigns → their brand.
  for (const c of input.campaigns) {
    if (c.client_id) continue
    const r = row(brandKey(c.brand_id, input.brands))
    if (!r) continue
    r.adSpendInr += Number(input.spendByCampaign.get(c.id) || 0) * (1 + gst)
  }

  // Company cash-book entries explicitly tagged with a brand.
  for (const e of input.entries) {
    if (!e.brand_id || e.client_id) continue
    if (e.scope && e.scope !== 'company') continue
    if (input.walletFundingEntryIds.has(e.id)) continue
    const r = row(e.brand_id)
    if (!r) continue
    if (e.type === 'inflow') r.otherIncomeInr += Number(e.amount_inr || 0)
    else if (e.type === 'outflow') r.brandExpensesInr += Number(e.amount_inr || 0)
  }

  const known = new Set(input.brands.map(b => b.id))
  return [...rows.values()]
    .filter(r => known.has(r.brandId))
    .map(r => {
      const revenueInr = r2(r.revenueInr)
      const directLabourInr = r2(r.directLabourInr)
      const otherIncomeInr = r2(r.otherIncomeInr)
      const adSpendInr = r2(r.adSpendInr)
      const brandExpensesInr = r2(r.brandExpensesInr)
      return {
        ...r, revenueInr, directLabourInr, otherIncomeInr, adSpendInr, brandExpensesInr,
        contributionMarginInr: r2(revenueInr - directLabourInr),
        resultInr: r2(revenueInr + otherIncomeInr - directLabourInr - adSpendInr - brandExpensesInr),
      }
    })
}
