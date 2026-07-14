import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import Header from '@/components/layout/header'
import { buildClientProfitability } from '@/lib/finance/client-profitability'
import type { ClientProfitabilityInput } from '@/lib/finance/types'
import { Info } from 'lucide-react'

// Live financials — always read fresh.
export const dynamic = 'force-dynamic'

const inr = (n: number) =>
  '₹' + (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * Client contribution margin, computed by the Finance Engine
 * (src/lib/finance/client-profitability.ts):
 *
 *   margin = invoiced − direct costs − attributed labor + rebilling markup
 *
 * This is the management view: labor is ATTRIBUTED via contribution scores
 * (who earned commission on which client's tasks). The Company P&L shows the
 * ledger truth (salaries as actually paid). Same rupee, two labeled views —
 * never summed together.
 */
export default async function ClientProfitabilityPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || me?.permissions.has('reports.view') || !me
  if (me && !canView) redirect('/dashboard')

  const admin = createAdminClient()

  const [clientsRes, invoicesRes, expenseItemsRes, walletRes, scoresRes] = await Promise.all([
    Promise.resolve(admin.from('clients').select('id, name, code').order('name')),

    // Non-cancelled invoices; INR snapshot columns with pre-FX fallback.
    fetchAll(
      admin.from('invoices')
        .select('id, client_id, status, total_amount, total_amount_inr, paid_amount, paid_amount_inr')
        .neq('status', 'cancelled'),
    ),

    // Rebilled client expenses: original = our cost, amount − original = markup.
    fetchAll(
      admin.from('invoice_expense_items')
        .select('amount_inr, original_amount_inr, invoice:invoices(client_id, status)'),
    ).catch(() => ({ data: [] as any[] })),

    // Ad spend actually allocated to each client's campaigns (GST-inclusive
    // money paid). The bulk platform top-up itself is normally NOT client-
    // tagged, so this doesn't double-count with the rebilled expenses above.
    // Error-tolerant: ledger table may not be migrated yet.
    Promise.resolve(
      admin.from('ad_wallet_ledger')
        .select('client_id, amount_inr')
        .eq('direction', 'debit').eq('kind', 'campaign_allocation')
        .not('client_id', 'is', null)
        .is('deleted_at', null),
    ),

    // Attributed labor: commission earned per task, joined to the task's client.
    fetchAll(
      admin.from('contribution_scores')
        .select('earnings_inr, task:tasks(client_id, scope, deleted_at)'),
    ),
  ])

  const clients = (clientsRes.data || []) as { id: string; name: string; code: string | null }[]
  const invoices = (invoicesRes.data || []) as any[]
  const expenseItems = (expenseItemsRes.data || []) as any[]
  const walletDebits = ((walletRes as any).error ? [] : ((walletRes as any).data || [])) as any[]
  const scores = (scoresRes.data || []) as any[]

  // ── Aggregate per client ────────────────────────────────────────────────────
  const byClient = new Map<string, ClientProfitabilityInput>()
  const nameOf = new Map<string, string>(clients.map(c => [c.id, c.name]))
  const ensure = (clientId: string): ClientProfitabilityInput => {
    let row = byClient.get(clientId)
    if (!row) {
      row = {
        clientId,
        clientName: nameOf.get(clientId) || 'Unknown client',
        invoicedInr: 0, collectedInr: 0, directCostsInr: 0,
        attributedLaborInr: 0, markupRevenueInr: 0,
      }
      byClient.set(clientId, row)
    }
    return row
  }

  for (const inv of invoices) {
    if (!inv.client_id) continue
    const row = ensure(inv.client_id)
    row.invoicedInr = r2(row.invoicedInr + Number(inv.total_amount_inr ?? inv.total_amount ?? 0))
    row.collectedInr = r2(row.collectedInr + Number(inv.paid_amount_inr ?? inv.paid_amount ?? 0))
  }

  for (const item of expenseItems) {
    const clientId = item.invoice?.client_id
    if (!clientId || item.invoice?.status === 'cancelled') continue
    const row = ensure(clientId)
    const original = Number(item.original_amount_inr ?? item.amount_inr ?? 0)
    const billed = Number(item.amount_inr ?? original)
    row.directCostsInr = r2(row.directCostsInr + original)
    row.markupRevenueInr = r2((row.markupRevenueInr ?? 0) + Math.max(0, r2(billed - original)))
  }

  for (const d of walletDebits) {
    const row = ensure(d.client_id)
    row.directCostsInr = r2(row.directCostsInr + Number(d.amount_inr || 0))
  }

  let internalLaborInr = 0
  for (const s of scores) {
    const task = s.task
    if (!task || task.deleted_at) continue
    const earnings = Number(s.earnings_inr || 0)
    if (task.client_id) {
      const row = ensure(task.client_id)
      row.attributedLaborInr = r2(row.attributedLaborInr + earnings)
    } else {
      internalLaborInr = r2(internalLaborInr + earnings)   // company-scoped work
    }
  }

  const { rows, totals } = buildClientProfitability([...byClient.values()])

  return (
    <div className="space-y-6">
      <Header
        title="Client Profitability"
        subtitle="Contribution margin per client — invoiced revenue minus direct costs and attributed labor, plus rebilling markup"
      />

      {/* Methodology note — this is the management view, not the cash ledger. */}
      <div className="flex items-start gap-2 rounded-xl border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        <Info className="h-4 w-4 shrink-0 mt-0.5" />
        <p>
          Labor is <strong>attributed</strong> from contribution scores (who earned commission on which client&apos;s
          tasks). The <Link href="/dashboard/reports/company-ops" className="text-primary hover:underline">Company P&L</Link> shows
          salaries as actually paid — the same rupee appears in both views by design and they are never summed together.
          Direct costs = rebilled expense originals + ad-wallet campaign allocations (GST-inclusive).
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="text-left px-4 py-2 font-medium">Client</th>
                <th className="text-right px-3 py-2 font-medium">Invoiced</th>
                <th className="text-right px-3 py-2 font-medium">Collected</th>
                <th className="text-right px-3 py-2 font-medium">Direct costs</th>
                <th className="text-right px-3 py-2 font-medium">Attributed labor</th>
                <th className="text-right px-3 py-2 font-medium">Markup</th>
                <th className="text-right px-3 py-2 font-medium">Margin</th>
                <th className="text-right px-4 py-2 font-medium">Margin %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.clientId} className="border-b border-border/50">
                  <td className="px-4 py-2">{r.clientName}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{inr(r.invoicedInr)}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-muted-foreground">{inr(r.collectedInr)}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{inr(r.directCostsInr)}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{inr(r.attributedLaborInr)}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-muted-foreground">{inr(r.markupRevenueInr)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium ${r.contributionMarginInr < 0 ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {inr(r.contributionMarginInr)}
                  </td>
                  <td className={`px-4 py-2 text-right tabular-nums whitespace-nowrap ${r.contributionMarginInr < 0 ? 'text-red-500' : ''}`}>
                    {r.invoicedInr > 0 ? `${r.marginPct}%` : '—'}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-border font-semibold">
                <td className="px-4 py-2.5">All clients</td>
                <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{inr(totals.invoicedInr)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{inr(totals.collectedInr)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{inr(totals.directCostsInr)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{inr(totals.attributedLaborInr)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{inr(totals.markupRevenueInr)}</td>
                <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${totals.contributionMarginInr < 0 ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {inr(totals.contributionMarginInr)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">{totals.invoicedInr > 0 ? `${totals.marginPct}%` : '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">No client billing data yet.</p>
        )}
      </div>

      {internalLaborInr > 0 && (
        <div className="rounded-xl border border-border bg-card px-4 py-3 text-sm flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="font-medium">Internal initiatives — attributed labor</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Commission earned on company-scoped (internal) tasks. Already included in payroll on the Company P&L;
              shown here so internal work&apos;s labor cost is visible next to client margins.
            </p>
          </div>
          <div className="tabular-nums font-semibold">{inr(internalLaborInr)}</div>
        </div>
      )}
    </div>
  )
}
