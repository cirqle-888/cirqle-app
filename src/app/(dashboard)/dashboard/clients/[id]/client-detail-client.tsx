'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { usePrivacy } from '@/contexts/privacy-context'
import {
  IndianRupee, CheckCircle2, Clock, FileText, CheckSquare, Handshake,
  Mail, Phone, MapPin, Globe, ExternalLink, Award, Tag, Plus, AlertTriangle,
} from 'lucide-react'

interface Props {
  client: any
  invoices: any[]
  tasks: any[]
  pricing: { service_id: string; price: number | null; commission_percentage: number | null; currency: string | null }[]
  services: { id: string; name: string; is_active: boolean }[]
  partner: { id: string; name: string; partner_code: string } | null
  showAmounts: boolean
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const fmtDate = (d?: string | null) => {
  if (!d) return '—'
  try { return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) } catch { return d }
}

const INVOICE_STATUS_STYLE: Record<string, string> = {
  draft:   'bg-secondary text-muted-foreground border-border',
  sent:    'bg-blue-500/10 text-blue-400 border-blue-500/25',
  partial: 'bg-amber-500/10 text-amber-400 border-amber-500/25',
  paid:    'bg-emerald-500/10 text-emerald-500 border-emerald-500/25',
  overdue: 'bg-red-500/10 text-red-400 border-red-500/25',
}

const TASK_STATUS_STYLE: Record<string, string> = {
  pending:     'bg-secondary text-muted-foreground border-border',
  in_progress: 'bg-blue-500/10 text-blue-400 border-blue-500/25',
  done:        'bg-emerald-500/10 text-emerald-500 border-emerald-500/25',
  delivered:   'bg-violet-500/10 text-violet-400 border-violet-500/25',
  invoiced:    'bg-primary/10 text-primary border-primary/25',
  paid:        'bg-emerald-500/10 text-emerald-500 border-emerald-500/25',
  cancelled:   'bg-red-500/10 text-red-400 border-red-500/25',
}

export default function ClientDetailClient({ client, invoices, tasks, pricing, services, partner, showAmounts }: Props) {
  const { ds } = usePrivacy()

  const kpi = useMemo(() => {
    let billed = 0, paid = 0, drafts = 0
    for (const inv of invoices) {
      if (inv.status === 'draft') { drafts += 1; continue }
      billed += inv.total_amount || 0
      paid += inv.paid_amount || 0
    }
    const openInvoices = invoices.filter(i => i.status !== 'draft' && (i.paid_amount || 0) < (i.total_amount || 0))
    const activeTasks = tasks.filter(t => ['pending', 'in_progress'].includes(t.status))
    return {
      billed, paid, drafts,
      outstanding: Math.max(0, billed - paid),
      openInvoices,
      activeTasks: activeTasks.length,
      totalTasks: tasks.length,
      lastTask: tasks[0]?.task_date as string | undefined,
    }
  }, [invoices, tasks])

  const serviceName = (sid: string) => services.find(s => s.id === sid)?.name || '—'
  const recentTasks = tasks.slice(0, 8)

  return (
    <>
      <Header
        title={client.name}
        subtitle={`Client ${client.code}${client.country ? ` · ${client.country}` : ''}`}
        crumbLabel={client.name}
        actions={
          <>
            <Link href={`/dashboard/tasks?q=${encodeURIComponent(client.name)}`}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
              <CheckSquare className="w-4 h-4" /> Tasks
            </Link>
            <Link href="/dashboard/invoices"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
              <FileText className="w-4 h-4" /> Invoices
            </Link>
            <Link href={`/dashboard/settings?tab=clients&editClient=${client.id}&returnTo=/dashboard/clients/${client.id}`}
              className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90">
              Edit Client
            </Link>
          </>
        }
      />

      <div className="p-4 md:p-6 space-y-5">
        {client.is_active === false && (
          <div className="px-4 py-2.5 rounded-xl border bg-amber-500/10 border-amber-500/25 text-amber-400 text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" /> This client is archived — it's hidden from task and invoice forms. Restore it from the Clients list.
          </div>
        )}

        {/* KPI cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {showAmounts && (
            <>
              <div className="bg-card border border-border rounded-xl px-4 py-3.5">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1"><IndianRupee className="w-3.5 h-3.5" /> Billed</div>
                <p className="text-xl font-bold">{inr(kpi.billed)}</p>
                {kpi.drafts > 0 && <p className="text-[11px] text-muted-foreground mt-0.5">+{kpi.drafts} draft invoice{kpi.drafts === 1 ? '' : 's'} not sent</p>}
              </div>
              <div className="bg-card border border-border rounded-xl px-4 py-3.5">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1"><CheckCircle2 className="w-3.5 h-3.5" /> Collected</div>
                <p className="text-xl font-bold text-emerald-500">{inr(kpi.paid)}</p>
              </div>
              <div className="bg-card border border-border rounded-xl px-4 py-3.5">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1"><Clock className="w-3.5 h-3.5" /> Outstanding</div>
                <p className={`text-xl font-bold ${kpi.outstanding > 0 ? 'text-amber-400' : ''}`}>{inr(kpi.outstanding)}</p>
                {kpi.openInvoices.length > 0 && <p className="text-[11px] text-muted-foreground mt-0.5">{kpi.openInvoices.length} unpaid invoice{kpi.openInvoices.length === 1 ? '' : 's'}</p>}
              </div>
            </>
          )}
          <div className="bg-card border border-border rounded-xl px-4 py-3.5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1"><CheckSquare className="w-3.5 h-3.5" /> Tasks</div>
            <p className="text-xl font-bold">{kpi.totalTasks}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {kpi.activeTasks > 0 ? `${kpi.activeTasks} in progress` : `last ${fmtDate(kpi.lastTask)}`}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Left column: invoices + tasks */}
          <div className="lg:col-span-2 space-y-5">
            {showAmounts && kpi.openInvoices.length > 0 && (
              <div className="bg-card border border-border rounded-2xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-border/60 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Unpaid invoices</h2>
                  <Link href="/dashboard/invoices/follow-ups" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                    Follow-ups <ExternalLink className="w-3 h-3" />
                  </Link>
                </div>
                <div className="divide-y divide-border/40">
                  {kpi.openInvoices.slice(0, 6).map(inv => (
                    <div key={inv.id} className="px-5 py-3 flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{inv.invoice_number || 'Invoice'}</p>
                        <p className="text-xs text-muted-foreground">Issued {fmtDate(inv.issue_date)}{inv.due_date ? ` · due ${fmtDate(inv.due_date)}` : ''}</p>
                      </div>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border capitalize shrink-0 ${INVOICE_STATUS_STYLE[inv.status] || INVOICE_STATUS_STYLE.sent}`}>{inv.status}</span>
                      <div className="text-right shrink-0 w-28">
                        <p className="text-sm font-semibold">{inr((inv.total_amount || 0) - (inv.paid_amount || 0))}</p>
                        <p className="text-[10px] text-muted-foreground">of {inr(inv.total_amount || 0)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="bg-card border border-border rounded-2xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-border/60 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Recent tasks</h2>
                <Link href={`/dashboard/tasks?q=${encodeURIComponent(client.name)}`} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                  View all <ExternalLink className="w-3 h-3" />
                </Link>
              </div>
              {recentTasks.length === 0 ? (
                <p className="px-5 py-8 text-sm text-muted-foreground text-center">No tasks yet for this client.</p>
              ) : (
                <div className="divide-y divide-border/40">
                  {recentTasks.map(t => (
                    <Link key={t.id} href={`/dashboard/tasks?highlight=${t.id}`} className="px-5 py-3 flex items-center gap-3 hover:bg-secondary/40 transition-colors">
                      <span className="text-[10px] font-mono text-muted-foreground/60 shrink-0">#{t.task_number ?? '—'}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{t.title}</p>
                        <p className="text-xs text-muted-foreground truncate">{t.service?.name || '—'} · {fmtDate(t.task_date)}</p>
                      </div>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border capitalize shrink-0 ${TASK_STATUS_STYLE[t.status] || TASK_STATUS_STYLE.pending}`}>
                        {String(t.status).replace('_', ' ')}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right column: contact + pricing + links */}
          <div className="space-y-5">
            <div className="bg-card border border-border rounded-2xl p-5 space-y-3">
              <h2 className="text-sm font-semibold mb-1">Details</h2>
              {client.contact_name && <p className="text-sm flex items-center gap-2 text-foreground/90"><Handshake className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> {client.contact_name}</p>}
              {client.email && <p className="text-sm flex items-center gap-2 text-foreground/90 break-all"><Mail className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> {ds(client.email, '••••@••••')}</p>}
              {client.phone && <p className="text-sm flex items-center gap-2 text-foreground/90"><Phone className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> {client.phone}</p>}
              {client.address && <p className="text-sm flex items-start gap-2 text-foreground/90"><MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" /> <span className="whitespace-pre-line">{client.address}</span></p>}
              {client.gstin && <p className="text-sm flex items-center gap-2 text-foreground/90"><Tag className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> GSTIN {client.gstin}</p>}
              <p className="text-sm flex items-center gap-2 text-foreground/90"><Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> Billing currency {client.default_currency || 'INR'}</p>
              {partner && (
                <Link href={`/dashboard/partners/${partner.id}`} className="text-sm flex items-center gap-2 text-blue-400 hover:text-blue-300 transition-colors">
                  <Handshake className="w-3.5 h-3.5 shrink-0" /> Referred by {partner.name} ({partner.partner_code})
                </Link>
              )}
              {client.drive_folder_link && (
                <a href={client.drive_folder_link} target="_blank" rel="noreferrer" className="text-sm flex items-center gap-2 text-blue-400 hover:text-blue-300 transition-colors">
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" /> Drive folder
                </a>
              )}
            </div>

            {showAmounts && (
              <div className="bg-card border border-border rounded-2xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-border/60 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Service pricing</h2>
                  <Link href={`/dashboard/settings?tab=clients&editClient=${client.id}&returnTo=/dashboard/clients/${client.id}`}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                    <Plus className="w-3 h-3" /> Edit
                  </Link>
                </div>
                {pricing.length === 0 ? (
                  <p className="px-5 py-6 text-sm text-muted-foreground text-center">No service pricing configured yet.</p>
                ) : (
                  <div className="divide-y divide-border/40">
                    {pricing.map(p => (
                      <div key={p.service_id} className="px-5 py-2.5 flex items-center justify-between gap-3">
                        <p className="text-sm truncate">{serviceName(p.service_id)}</p>
                        <p className="text-sm font-semibold shrink-0">
                          {p.price ? `${p.currency || 'INR'} ${p.price.toLocaleString('en-IN')}` : '—'}
                          {p.commission_percentage ? <span className="text-[11px] text-muted-foreground font-normal ml-1.5">{p.commission_percentage}% comm.</span> : null}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="bg-card border border-border rounded-2xl p-5">
              <h2 className="text-sm font-semibold mb-3">Analytics</h2>
              <div className="space-y-1.5">
                <Link href="/dashboard/clients/ranking" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors py-1">
                  <Award className="w-4 h-4" /> Client Ranking
                </Link>
                <Link href="/dashboard/reports/client-profitability" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors py-1">
                  <IndianRupee className="w-4 h-4" /> Client Profitability
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
