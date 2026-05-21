'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AlertCircle, CheckCircle2, ShieldAlert, RefreshCw, History, Unlink, Trash2, RotateCcw, FileBarChart } from 'lucide-react'
import { useToast, ToastContainer } from '@/components/ui/toast'

type Tab = 'overview' | 'orphans' | 'mismatches' | 'softdeleted' | 'auditlog'

export default function ReconciliationClient() {
  const supabase = createClient()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('overview')
  const [loading, setLoading] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)

  // Data buckets
  const [orphans, setOrphans] = useState<any[]>([])
  const [mismatches, setMismatches] = useState<any[]>([])
  const [softDeleted, setSoftDeleted] = useState<any[]>([])
  const [auditLog, setAuditLog] = useState<any[]>([])

  useEffect(() => { analyzeData() }, [])

  async function analyzeData() {
    setLoading(true)
    try {
      const [cbRes, invRes, deletedRes, auditRes] = await Promise.all([
        supabase
          .from('cashbook_entries')
          .select('id, amount, currency, reference, invoice_id, entry_date, description')
          .eq('type', 'inflow')
          .is('deleted_at', null),
        supabase
          .from('invoices')
          .select('id, invoice_number, total_amount, paid_amount, status, currency, due_date'),
        supabase
          .from('cashbook_entries')
          .select('id, amount, currency, reference, invoice_id, entry_date, description, deleted_at')
          .not('deleted_at', 'is', null)
          .order('deleted_at', { ascending: false })
          .limit(100),
        supabase
          .from('cashbook_audit_log')
          .select('*, cashbook_entries(reference, description)')
          .order('changed_at', { ascending: false })
          .limit(200),
      ])

      const entries = cbRes.data || []
      const invoices = invRes.data || []

      // Orphans: entries with INV- pattern in reference but no invoice_id
      setOrphans(entries.filter(e => !e.invoice_id && e.reference?.match(/INV-\d+-\d+/i)))

      // Mismatches: stored paid_amount differs from SUM(cashbook_entries)
      const sumByInv: Record<string, number> = {}
      entries.filter(e => e.invoice_id).forEach(e => {
        sumByInv[e.invoice_id] = (sumByInv[e.invoice_id] || 0) + (parseFloat(e.amount) || 0)
      })
      setMismatches(
        invoices
          .map(inv => {
            const calculated = sumByInv[inv.id] || 0
            const stored = parseFloat(inv.paid_amount) || 0
            const total = parseFloat(inv.total_amount) || 0
            
            const amountMismatch = Math.abs(calculated - stored) > 0.01
            
            let expectedStatus = inv.status
            if (['draft', 'reviewed', 'cancelled', 'bad_debt'].includes(inv.status)) {
              expectedStatus = inv.status
            } else if (calculated >= total && total > 0) {
              expectedStatus = 'paid'
            } else if (calculated > 0) {
              expectedStatus = 'partial'
            } else if (inv.due_date && new Date(inv.due_date) < new Date()) {
              expectedStatus = 'overdue'
            } else {
              expectedStatus = 'sent'
            }

            const statusMismatch = inv.status !== expectedStatus

            return (amountMismatch || statusMismatch)
              ? { ...inv, calculated, stored, diff: calculated - stored, expectedStatus, statusMismatch }
              : null
          })
          .filter(Boolean)
      )

      setSoftDeleted(deletedRes.data || [])
      setAuditLog(auditRes.data || [])
    } catch (err: any) {
      toast.error('Analysis failed', err.message)
    } finally {
      setLoading(false)
    }
  }

  async function fixMismatches() {
    setAnalyzing(true)
    let fixed = 0
    try {
      for (const inv of mismatches) {
        let newStatus = inv.status
        if (!['draft', 'reviewed', 'cancelled', 'bad_debt'].includes(inv.status)) {
          if (inv.calculated >= inv.total_amount && inv.total_amount > 0) newStatus = 'paid'
          else if (inv.calculated > 0) newStatus = 'partial'
          else if (inv.due_date && new Date(inv.due_date) < new Date()) newStatus = 'overdue'
          else newStatus = 'sent'
        }

        await supabase.from('invoices').update({
          paid_amount: inv.calculated,
          status: newStatus,
        }).eq('id', inv.id)

        // Write a reconcile audit event
        await supabase.from('cashbook_audit_log').insert({
          invoice_id: inv.id,
          operation: 'RECONCILE',
          old_paid_amount: inv.stored,
          new_paid_amount: inv.calculated,
          old_status: inv.status,
          new_status: newStatus,
          notes: 'Manually force-recalculated via Reconciliation Toolkit',
        })
        fixed++
      }
      toast.success(`Fixed ${fixed} invoice balance${fixed !== 1 ? 's' : ''}`)
      analyzeData()
    } catch (err: any) {
      toast.error('Fix failed', err.message)
    } finally {
      setAnalyzing(false)
    }
  }

  async function fixOrphans() {
    setAnalyzing(true)
    let fixed = 0
    try {
      const { data: invoices } = await supabase.from('invoices').select('id, invoice_number')
      const invMap: Record<string, string> = {}
      ;(invoices || []).forEach(i => { invMap[i.invoice_number.toUpperCase()] = i.id })

      for (const orphan of orphans) {
        if (!orphan.reference) continue
        const upper = orphan.reference.toUpperCase()
        const match = Object.keys(invMap).find(num => upper.includes(num))
        if (match) {
          await supabase.from('cashbook_entries').update({ invoice_id: invMap[match] }).eq('id', orphan.id)
          fixed++
        }
      }
      toast.success(`Auto-linked ${fixed} orphaned payment${fixed !== 1 ? 's' : ''}`)
      analyzeData()
    } catch (err: any) {
      toast.error('Auto-link failed', err.message)
    } finally {
      setAnalyzing(false)
    }
  }

  async function restoreEntry(entryId: string) {
    try {
      const { error } = await supabase
        .from('cashbook_entries')
        .update({ deleted_at: null })
        .eq('id', entryId)
      if (error) throw error

      // Log the restore event
      await supabase.from('cashbook_audit_log').insert({
        entry_id: entryId,
        operation: 'RESTORE',
        notes: 'Entry restored from soft-delete via Reconciliation Toolkit',
      })

      toast.success('Entry restored and invoice balance recalculated')
      analyzeData()
    } catch (err: any) {
      toast.error('Restore failed', err.message)
    }
  }

  async function permanentlyDelete(entryId: string) {
    if (!confirm('Permanently delete this entry? This cannot be undone.')) return
    try {
      const { error } = await supabase.from('cashbook_entries').delete().eq('id', entryId)
      if (error) throw error
      toast.success('Entry permanently deleted')
      analyzeData()
    } catch (err: any) {
      toast.error('Delete failed', err.message)
    }
  }

  const isHealthy = orphans.length === 0 && mismatches.length === 0 && softDeleted.length === 0
  const TABS: { id: Tab; label: string; count?: number; alert?: boolean }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'orphans', label: 'Orphaned Payments', count: orphans.length, alert: orphans.length > 0 },
    { id: 'mismatches', label: 'Balance Mismatches', count: mismatches.length, alert: mismatches.length > 0 },
    { id: 'softdeleted', label: 'Deleted Entries', count: softDeleted.length },
    { id: 'auditlog', label: 'Audit Log', count: auditLog.length },
  ]

  return (
    <div className="space-y-6">
      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
      {/* Tabs */}
      <div className="flex gap-1 flex-wrap border-b border-border pb-0">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${
              tab === t.id
                ? 'border-primary text-foreground bg-card'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span className={`text-xs rounded-full px-1.5 py-0.5 font-semibold ${
                t.alert ? 'bg-destructive/20 text-destructive' : 'bg-secondary text-muted-foreground'
              }`}>
                {t.count}
              </span>
            )}
          </button>
        ))}
        <button
          onClick={analyzeData}
          disabled={loading}
          className="ml-auto mb-1 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/80 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Re-analyze
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
          <RefreshCw className="w-4 h-4 animate-spin" />
          Scanning ledger…
        </div>
      ) : (
        <>
          {/* ── OVERVIEW ──────────────────────────────────── */}
          {tab === 'overview' && (
            <div className="space-y-4">
              {isHealthy ? (
                <div className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-xl p-5 flex items-center gap-3">
                  <CheckCircle2 className="h-5 w-5 shrink-0" />
                  <div>
                    <p className="font-semibold">Ledger Integrity: 100% Healthy</p>
                    <p className="text-sm text-emerald-400/70 mt-0.5">No orphaned payments, balance mismatches, or soft-deleted entries detected.</p>
                  </div>
                </div>
              ) : (
                <div className="bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-xl p-5 flex items-center gap-3">
                  <AlertCircle className="h-5 w-5 shrink-0" />
                  <div>
                    <p className="font-semibold">Attention Required</p>
                    <p className="text-sm text-amber-400/70 mt-0.5">Review the tabs above to resolve flagged items.</p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  { label: 'Orphaned Payments', value: orphans.length, icon: <Unlink className="w-4 h-4" />, alert: orphans.length > 0 },
                  { label: 'Balance Mismatches', value: mismatches.length, icon: <ShieldAlert className="w-4 h-4" />, alert: mismatches.length > 0 },
                  { label: 'Soft-Deleted Entries', value: softDeleted.length, icon: <Trash2 className="w-4 h-4" />, alert: false },
                  { label: 'Audit Events', value: auditLog.length, icon: <History className="w-4 h-4" />, alert: false },
                ].map(card => (
                  <div key={card.label} className={`bg-card border rounded-xl p-4 ${card.alert ? 'border-destructive/40' : 'border-border'}`}>
                    <div className={`flex items-center gap-2 mb-2 ${card.alert ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {card.icon}
                      <p className="text-xs font-medium">{card.label}</p>
                    </div>
                    <p className={`text-2xl font-bold ${card.alert ? 'text-destructive' : 'text-foreground'}`}>{card.value}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── ORPHANS ───────────────────────────────────── */}
          {tab === 'orphans' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold">Orphaned Cashbook Payments</h3>
                  <p className="text-sm text-muted-foreground mt-0.5">Entries containing an invoice number in their reference but lacking a strict <code className="text-xs bg-secondary px-1 rounded">invoice_id</code> link.</p>
                </div>
                {orphans.length > 0 && (
                  <button onClick={fixOrphans} disabled={analyzing} className="flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-lg gradient-bg text-white hover:opacity-90 disabled:opacity-50">
                    <Unlink className="w-4 h-4" />
                    Auto-Link All
                  </button>
                )}
              </div>
              {orphans.length === 0 ? (
                <EmptyState icon={<CheckCircle2 className="w-8 h-8 text-emerald-400" />} text="No orphaned payments found." />
              ) : (
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-secondary/50 border-b border-border">
                      <tr>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Date</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Reference</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Description</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {orphans.map(o => (
                        <tr key={o.id} className="hover:bg-secondary/20">
                          <td className="px-4 py-3 text-xs text-muted-foreground">{o.entry_date}</td>
                          <td className="px-4 py-3 font-mono text-xs text-amber-400">{o.reference}</td>
                          <td className="px-4 py-3 text-xs text-muted-foreground truncate max-w-[200px]">{o.description || '—'}</td>
                          <td className="px-4 py-3 text-right font-semibold text-green-400">+{o.amount} {o.currency}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── MISMATCHES ────────────────────────────────── */}
          {tab === 'mismatches' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold">Balance Mismatches</h3>
                  <p className="text-sm text-muted-foreground mt-0.5">Invoices where the stored <code className="text-xs bg-secondary px-1 rounded">paid_amount</code> differs from the real-time sum of linked cashbook entries.</p>
                </div>
                {mismatches.length > 0 && (
                  <button onClick={fixMismatches} disabled={analyzing} className="flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-lg bg-destructive text-destructive-foreground hover:opacity-90 disabled:opacity-50">
                    <FileBarChart className="w-4 h-4" />
                    Force Recalculate All
                  </button>
                )}
              </div>
              {mismatches.length === 0 ? (
                <EmptyState icon={<CheckCircle2 className="w-8 h-8 text-emerald-400" />} text="All invoice balances match perfectly." />
              ) : (
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-secondary/50 border-b border-border">
                      <tr>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Invoice</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Status</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Stored Paid</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">True Sum</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Discrepancy</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {mismatches.map((m: any) => (
                        <tr key={m.id} className="hover:bg-secondary/20">
                          <td className="px-4 py-3 font-mono text-xs">{m.invoice_number}</td>
                          <td className="px-4 py-3">
                            {m.statusMismatch ? (
                              <div className="flex items-center gap-1.5">
                                <span className="line-through opacity-50"><StatusBadge status={m.status} /></span>
                                <span>→</span>
                                <StatusBadge status={m.expectedStatus} />
                              </div>
                            ) : (
                              <StatusBadge status={m.status} />
                            )}
                          </td>
                          <td className="px-4 py-3 text-right text-xs">{m.stored.toFixed(2)} {m.currency}</td>
                          <td className="px-4 py-3 text-right text-xs text-green-400">{m.calculated.toFixed(2)} {m.currency}</td>
                          <td className={`px-4 py-3 text-right font-semibold text-xs ${m.diff > 0 ? 'text-green-400' : m.diff < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                            {m.diff > 0 ? '+' : ''}{m.diff !== 0 ? m.diff.toFixed(2) : 'Status Only'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── SOFT DELETED ──────────────────────────────── */}
          {tab === 'softdeleted' && (
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold">Soft-Deleted Entries</h3>
                <p className="text-sm text-muted-foreground mt-0.5">These entries have been soft-deleted. They are excluded from invoice payment calculations. You can restore or permanently delete them.</p>
              </div>
              {softDeleted.length === 0 ? (
                <EmptyState icon={<Trash2 className="w-8 h-8 text-muted-foreground" />} text="No soft-deleted entries found." />
              ) : (
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-secondary/50 border-b border-border">
                      <tr>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Date</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Reference</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Description</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Amount</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Deleted At</th>
                        <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {softDeleted.map(e => (
                        <tr key={e.id} className="hover:bg-secondary/20 opacity-70">
                          <td className="px-4 py-3 text-xs text-muted-foreground">{e.entry_date}</td>
                          <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{e.reference || '—'}</td>
                          <td className="px-4 py-3 text-xs text-muted-foreground truncate max-w-[200px]">{e.description || '—'}</td>
                          <td className="px-4 py-3 text-right text-xs line-through text-muted-foreground">{e.amount} {e.currency}</td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(e.deleted_at).toLocaleString()}</td>
                          <td className="px-4 py-3">
                            <div className="flex gap-2 justify-center">
                              <button
                                onClick={() => restoreEntry(e.id)}
                                className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-secondary hover:bg-secondary/80 text-foreground transition-colors"
                                title="Restore entry"
                              >
                                <RotateCcw className="w-3 h-3" />
                                Restore
                              </button>
                              <button
                                onClick={() => permanentlyDelete(e.id)}
                                className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-destructive/10 hover:bg-destructive/20 text-destructive transition-colors"
                                title="Permanently delete"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── AUDIT LOG ─────────────────────────────────── */}
          {tab === 'auditlog' && (
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold">Payment Audit Log</h3>
                <p className="text-sm text-muted-foreground mt-0.5">Every cashbook payment event that touched an invoice — automatic and manual. Showing last 200 events.</p>
              </div>
              {auditLog.length === 0 ? (
                <EmptyState icon={<History className="w-8 h-8 text-muted-foreground" />} text="No audit events recorded yet." />
              ) : (
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-secondary/50 border-b border-border">
                      <tr>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Timestamp</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Operation</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Reference</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Paid Δ</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Status Change</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {auditLog.map(a => (
                        <tr key={a.id} className="hover:bg-secondary/20">
                          <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                            {new Date(a.changed_at).toLocaleString()}
                          </td>
                          <td className="px-4 py-3">
                            <OperationBadge op={a.operation} />
                          </td>
                          <td className="px-4 py-3 text-xs font-mono text-muted-foreground">
                            {a.cashbook_entries?.reference || '—'}
                          </td>
                          <td className="px-4 py-3 text-right text-xs">
                            {a.old_paid_amount !== null && a.new_paid_amount !== null ? (
                              <span className={a.new_paid_amount >= (a.old_paid_amount || 0) ? 'text-green-400' : 'text-destructive'}>
                                {a.old_paid_amount?.toFixed(2)} → {a.new_paid_amount?.toFixed(2)}
                              </span>
                            ) : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs">
                            {a.old_status && a.new_status && a.old_status !== a.new_status ? (
                              <span className="text-muted-foreground">
                                <StatusBadge status={a.old_status} /> → <StatusBadge status={a.new_status} />
                              </span>
                            ) : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground max-w-[180px] truncate" title={a.notes || ''}>
                            {a.notes || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center gap-3 text-muted-foreground">
      {icon}
      <p className="text-sm">{text}</p>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft:     'bg-secondary text-muted-foreground',
    reviewed:  'bg-blue-500/10 text-blue-400',
    sent:      'bg-violet-500/10 text-violet-400',
    partial:   'bg-amber-500/10 text-amber-400',
    paid:      'bg-emerald-500/10 text-emerald-400',
    overdue:   'bg-red-500/10 text-red-400',
    cancelled: 'bg-secondary text-muted-foreground',
    bad_debt:  'bg-red-500/10 text-red-400',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[status] || 'bg-secondary text-muted-foreground'}`}>
      {status}
    </span>
  )
}

function OperationBadge({ op }: { op: string }) {
  const colors: Record<string, string> = {
    INSERT:     'bg-emerald-500/10 text-emerald-400',
    UPDATE:     'bg-blue-500/10 text-blue-400',
    DELETE:     'bg-red-500/10 text-red-400',
    SOFT_DELETE:'bg-amber-500/10 text-amber-400',
    RESTORE:    'bg-violet-500/10 text-violet-400',
    RECONCILE:  'bg-secondary text-muted-foreground',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-mono font-medium ${colors[op] || 'bg-secondary text-muted-foreground'}`}>
      {op}
    </span>
  )
}
