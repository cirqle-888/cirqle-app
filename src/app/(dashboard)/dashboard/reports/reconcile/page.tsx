import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import Header from '@/components/layout/header'
import { AlertTriangle, CheckCircle2, FileText, ListChecks, Wallet } from 'lucide-react'

// Live reconciliation — always read fresh.
export const dynamic = 'force-dynamic'

const inr = (n: number) =>
  '₹' + (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

type Task = {
  id: string; task_number: number | null; title: string | null; task_date: string | null
  status: string; currency: string | null; billing_amount: number | null
  billing_amount_inr: number | null; client_id: string | null
}
type InvItem = { task_id: string | null; invoice_id: string; total: number | null }
type Invoice = { id: string; invoice_number: string; status: string }
type Cashbook = {
  id: string; entry_date: string | null; description: string | null
  amount: number | null; currency: string | null; client_id: string | null
}

export default async function ReconcilePage() {
  // Same wall as Reports: admin OR explicit reports.view (fail-open pre-migration).
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || me?.permissions.has('reports.view') || !me
  if (me && !canView) redirect('/dashboard')

  const supabase = createAdminClient()

  const [tasks, clients, invItems, invoices, cashbook, expItems] = await Promise.all([
    fetchAll(
      supabase
        .from('tasks')
        .select('id, task_number, title, task_date, status, currency, billing_amount, billing_amount_inr, client_id')
        .is('deleted_at', null),
    ).then(r => r.data as Task[]),
    supabase.from('clients').select('id, name').then(r => (r.data || []) as { id: string; name: string }[]),
    fetchAll(supabase.from('invoice_items').select('task_id, invoice_id, total')).then(r => r.data as InvItem[]),
    fetchAll(supabase.from('invoices').select('id, invoice_number, status')).then(r => r.data as Invoice[]),
    fetchAll(
      supabase
        .from('cashbook_entries')
        .select('id, entry_date, description, amount, currency, client_id')
        .eq('type', 'outflow')
        .is('deleted_at', null)
        .not('client_id', 'is', null),
    ).then(r => r.data as Cashbook[]),
    fetchAll(supabase.from('invoice_expense_items').select('cashbook_entry_id')).then(r => r.data as { cashbook_entry_id: string }[]),
  ])

  const clientName = new Map(clients.map(c => [c.id, c.name]))
  const invById = new Map(invoices.map(i => [i.id, i]))
  const itemsByTask = new Map<string, InvItem>()
  for (const it of invItems) if (it.task_id) itemsByTask.set(it.task_id, it)
  const billedEntryIds = new Set(expItems.map(e => e.cashbook_entry_id))

  const taskBilling = (t: Task) => t.billing_amount ?? t.billing_amount_inr ?? 0

  // ── Check 1: done/invoiced tasks that are on NO invoice ──────────────────────
  const orphanTasks = tasks
    .filter(t => (t.status === 'done' || t.status === 'invoiced') && !itemsByTask.has(t.id) && taskBilling(t) > 0)
    .sort((a, b) => (b.task_date || '').localeCompare(a.task_date || ''))
  const orphanTotal = orphanTasks.reduce((s, t) => s + taskBilling(t), 0)

  // ── Check 2: invoice lines whose amount drifted from the task's billing ──────
  const drift = invItems
    .map(it => {
      const t = it.task_id ? tasks.find(x => x.id === it.task_id) : null
      if (!t) return null
      const expected = taskBilling(t)
      const line = it.total ?? 0
      if (Math.abs(line - expected) < 0.01) return null
      return { task: t, inv: invById.get(it.invoice_id), line, expected }
    })
    .filter((x): x is { task: Task; inv: Invoice | undefined; line: number; expected: number } => x !== null)
    .sort((a, b) => Math.abs(b.line - b.expected) - Math.abs(a.line - a.expected))

  // ── Check 3: client-tagged outflows not billed on any invoice ────────────────
  const unbilled = cashbook
    .filter(e => !billedEntryIds.has(e.id))
    .sort((a, b) => (b.entry_date || '').localeCompare(a.entry_date || ''))
  const unbilledTotal = unbilled.reduce((s, e) => s + (e.amount || 0), 0)

  const allClear = orphanTasks.length === 0 && drift.length === 0 && unbilled.length === 0

  return (
    <div>
      <Header
        title="Billing Reconciliation"
        subtitle="Tasks & expenses that should be billed but aren't, and invoice lines that drifted from their task"
      />

      <div className="p-6 space-y-6 max-w-5xl">
        {allClear && (
          <div className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            <p className="text-sm text-emerald-300">Everything reconciles — no orphan tasks, no amount drift, no unbilled client expenses.</p>
          </div>
        )}

        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <SummaryCard icon={<ListChecks className="w-4 h-4" />} label="Done tasks not invoiced" count={orphanTasks.length} sub={inr(orphanTotal)} tone={orphanTasks.length ? 'warn' : 'ok'} />
          <SummaryCard icon={<FileText className="w-4 h-4" />} label="Invoice-line amount drift" count={drift.length} sub={drift.length ? 'needs review' : 'in sync'} tone={drift.length ? 'warn' : 'ok'} />
          <SummaryCard icon={<Wallet className="w-4 h-4" />} label="Unbilled client expenses" count={unbilled.length} sub={inr(unbilledTotal)} tone={unbilled.length ? 'warn' : 'ok'} />
        </div>

        {/* 1. Orphan done tasks */}
        {orphanTasks.length > 0 && (
          <Section title={`Done tasks on no invoice (${orphanTasks.length})`} hint="These are marked done but have no invoice line. Re-save the task (or toggle status) to let the trigger attach it.">
            <table className="w-full text-sm">
              <THead cols={['Task', 'Client', 'Date', 'Billing']} />
              <tbody>
                {orphanTasks.slice(0, 200).map(t => (
                  <tr key={t.id} className="border-t border-border/50">
                    <Td><span className="font-mono text-[11px] text-muted-foreground mr-1">{t.task_number ? `T-${t.task_number}` : '—'}</span>{t.title}</Td>
                    <Td>{t.client_id ? clientName.get(t.client_id) || '—' : '—'}</Td>
                    <Td>{t.task_date || '—'}</Td>
                    <Td right>{inr(taskBilling(t))}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {/* 2. Amount drift */}
        {drift.length > 0 && (
          <Section title={`Invoice lines that don't match their task (${drift.length})`} hint="The invoice line amount differs from the task's current billing. On draft/reviewed invoices, editing the task now re-syncs automatically; sent/paid invoices are intentionally frozen.">
            <table className="w-full text-sm">
              <THead cols={['Task', 'Invoice', 'On invoice', 'Task now', 'Δ']} />
              <tbody>
                {drift.slice(0, 200).map(({ task, inv, line, expected }) => (
                  <tr key={task.id} className="border-t border-border/50">
                    <Td><span className="font-mono text-[11px] text-muted-foreground mr-1">{task.task_number ? `T-${task.task_number}` : '—'}</span>{task.title}</Td>
                    <Td>{inv ? <span className="font-mono text-[11px]">{inv.invoice_number}<span className="ml-1 text-muted-foreground">· {inv.status}</span></span> : '—'}</Td>
                    <Td right>{inr(line)}</Td>
                    <Td right>{inr(expected)}</Td>
                    <Td right><span className={line - expected > 0 ? 'text-emerald-400' : 'text-red-400'}>{line - expected > 0 ? '+' : ''}{inr(line - expected)}</span></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {/* 3. Unbilled expenses */}
        {unbilled.length > 0 && (
          <Section title={`Unbilled client-tagged expenses (${unbilled.length})`} hint="Cashbook outflows tagged to a client but not on any invoice. New/edited ones now auto-attach; these are pre-existing or on a closed month — open the client's invoice → Add Expenses to bill them.">
            <table className="w-full text-sm">
              <THead cols={['Date', 'Description', 'Client', 'Amount']} />
              <tbody>
                {unbilled.slice(0, 200).map(e => (
                  <tr key={e.id} className="border-t border-border/50">
                    <Td>{e.entry_date || '—'}</Td>
                    <Td>{e.description || '—'}</Td>
                    <Td>{e.client_id ? clientName.get(e.client_id) || '—' : '—'}</Td>
                    <Td right>{inr(e.amount || 0)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
          <AlertTriangle className="w-3 h-3" />
          Read-only. Sent/paid invoices are intentionally frozen — reconcile them by issuing a correction, not by editing the sent invoice.
        </p>
        <p className="text-[11px] text-muted-foreground"><Link href="/dashboard/invoices" className="underline hover:text-foreground">← Back to Invoices</Link></p>
      </div>
    </div>
  )
}

function SummaryCard({ icon, label, count, sub, tone }: { icon: React.ReactNode; label: string; count: number; sub: string; tone: 'ok' | 'warn' }) {
  return (
    <div className={`rounded-xl border p-4 ${tone === 'warn' ? 'border-amber-500/30 bg-amber-500/5' : 'border-border bg-card'}`}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`text-2xl font-bold ${tone === 'warn' ? 'text-amber-300' : 'text-foreground'}`}>{count}</span>
        <span className="text-xs text-muted-foreground">{sub}</span>
      </div>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-secondary/30">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  )
}

function THead({ cols }: { cols: string[] }) {
  return (
    <thead>
      <tr className="bg-secondary/20">
        {cols.map((c, i) => (
          <th key={c} className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground ${i === cols.length - 1 ? 'text-right' : 'text-left'}`}>{c}</th>
        ))}
      </tr>
    </thead>
  )
}

function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <td className={`px-3 py-2 ${right ? 'text-right tabular-nums' : 'text-left'}`}>{children}</td>
}
