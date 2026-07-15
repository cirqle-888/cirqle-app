'use client'

import { useState } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import {
  Users2, Wallet, CheckCircle2, Clock, FileClock, TrendingUp, CircleSlash,
  Copy, Image as ImageIcon, Download, Mail, Link as LinkIcon, X,
} from 'lucide-react'
import { linkClientToPartner, fetchPartnerStatement, setClientPartnerSince } from '../actions'
import { sendPartnerStatementEmail } from '@/lib/partners/send-email'
import { buildPartnerStatementText, partnerWhatsappShareUrl } from '@/lib/partners/whatsapp'
import { copyToClipboard } from '@/lib/clipboard'
import { downloadStatementImage } from '@/lib/partners/statement-image'
import { downloadStatementPdf } from '@/lib/partners/statement-pdf'
import { FavoriteToggle } from '@/components/ui/favorite-toggle'
import CommissionPlanner from '@/components/partners/commission-planner'
import type { BusinessPartner, PartnerDashboardData, PartnerStatementData, CommissionPayment } from '@/lib/partners/queries'

interface UnlinkedClient { id: string; name: string; code: string }
interface Brand { companyName: string; primaryColor: string }

interface Props {
  partner: BusinessPartner
  dashboard: PartnerDashboardData
  unlinkedClients: UnlinkedClient[]
  commissionPayments: CommissionPayment[]
  brand: Brand
  canEdit: boolean
  canExport: boolean
  canViewProfit: boolean
}

const fmtAmt = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const fmtDate = (s: string | null) => {
  if (!s) return '—'
  const d = new Date(s)
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function PartnerDashboardClient({ partner, dashboard, unlinkedClients, commissionPayments, brand, canEdit, canExport, canViewProfit }: Props) {
  const hasDrafts = dashboard.draftInvoices > 0
  const hasHandover = dashboard.clients.some(c => c.partnerSince)
  const hasBadDebt = dashboard.totalBadDebt > 0
  const [linkOpen, setLinkOpen] = useState(false)
  const [linking, setLinking] = useState(false)
  const [statement, setStatement] = useState<PartnerStatementData | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<string | null>(null)

  async function ensureStatement(): Promise<PartnerStatementData | null> {
    if (statement) return statement
    const res = await fetchPartnerStatement(partner.id)
    if (!res.ok || !res.data) {
      setActionMsg(res.error || 'Could not load statement data.')
      return null
    }
    setStatement(res.data)
    return res.data
  }

  async function handleCopyText() {
    setBusyAction('text')
    setActionMsg(null)
    const data = await ensureStatement()
    if (data) {
      const ok = await copyToClipboard(buildPartnerStatementText(data))
      setActionMsg(ok
        ? 'Statement text copied to clipboard.'
        : 'Could not reach the clipboard — open WhatsApp from the link instead.')
    }
    setBusyAction(null)
  }

  async function handleShareImage() {
    setBusyAction('image')
    setActionMsg(null)
    const data = await ensureStatement()
    if (data) {
      await downloadStatementImage(data, brand)
      setActionMsg('Statement image downloaded — attach it to WhatsApp.')
    }
    setBusyAction(null)
  }

  async function handleDownloadPdf() {
    setBusyAction('pdf')
    setActionMsg(null)
    const data = await ensureStatement()
    if (data) {
      await downloadStatementPdf(data, brand)
      setActionMsg('Statement PDF downloaded.')
    }
    setBusyAction(null)
  }

  async function handleSendEmail() {
    setBusyAction('email')
    setActionMsg(null)
    const res = await sendPartnerStatementEmail(partner.id, brand.companyName, brand.primaryColor)
    setActionMsg(res.ok ? 'Statement emailed to the partner.' : (res.error || 'Could not send email.'))
    setBusyAction(null)
  }

  async function handleLink(clientId: string) {
    setLinking(true)
    await linkClientToPartner(clientId, partner.id)
    setLinking(false)
    setLinkOpen(false)
    window.location.reload()
  }

  async function handleUnlink(clientId: string) {
    await linkClientToPartner(clientId, null)
    window.location.reload()
  }

  return (
    <>
      <Header
        title={partner.name}
        crumbLabel={partner.name}
        subtitle={`${partner.partner_code}${partner.company ? ` · ${partner.company}` : ''}`}
        actions={
          <FavoriteToggle
            entityType="business_partner"
            entityId={partner.id}
            href={`/dashboard/partners/${partner.id}`}
            label={partner.name}
            iconKey="Handshake"
            size={18}
          />
        }
      />

      <div className="p-4 sm:p-6 space-y-6">
        {/* KPI cards */}
        {/* Up to 7 tiles (drafts + profit are conditional) — wrap instead of
            squeezing them into one unreadable row. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          <Kpi icon={Users2} label="Total Clients" value={String(dashboard.totalClients)} />
          <Kpi icon={Clock} label="Pending Collection" value={fmtAmt(dashboard.pendingCollection)} hint="Billed to the client — what this partner chases" />
          {hasDrafts && (
            <Link href="/dashboard/invoices/follow-ups" className="block rounded-xl transition-colors hover:bg-secondary/70">
              <Kpi
                icon={FileClock}
                label="Not yet sent"
                value={fmtAmt(dashboard.draftAmount)}
                hint={`${dashboard.draftInvoices} draft invoice${dashboard.draftInvoices === 1 ? '' : 's'} · internal, never on the statement`}
              />
            </Link>
          )}
          <Kpi
            icon={CheckCircle2}
            label="Collected Amount"
            value={fmtAmt(dashboard.collectedAmount)}
            hint={hasHandover
              ? 'Excludes billing from before they took each client over'
              : 'Every client’s full history — set a Partner Since date below to narrow it'}
          />
          {canViewProfit && (
            <Kpi
              icon={TrendingUp}
              label="Total Profit"
              value={fmtAmt(dashboard.totalProfit)}
              tint={dashboard.totalProfit < 0 ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}
              hint={`${dashboard.totalMarginPct}% margin · invoiced minus direct costs and staff commission`}
            />
          )}
          {dashboard.totalBadDebt > 0 && (
            <Kpi
              icon={CircleSlash}
              label="Bad debt (loss)"
              value={fmtAmt(dashboard.totalBadDebt)}
              tint="text-red-500"
              hint="Written off — delivered, never paid. Already subtracted from profit."
            />
          )}
          <Kpi icon={Wallet} label="Last Collection" value={fmtDate(dashboard.lastCollection)} />
        </div>

        {/* Generate Statement */}
        {canExport && (
          <div className="bg-secondary border border-border rounded-xl p-4">
            <h2 className="text-sm font-semibold text-foreground mb-3">Generate Statement</h2>
            <div className="flex flex-wrap gap-2">
              <ActionButton icon={Copy} label="Copy WhatsApp Text" busy={busyAction === 'text'} onClick={handleCopyText} primary />
              <ActionButton icon={ImageIcon} label="Share WhatsApp Image" busy={busyAction === 'image'} onClick={handleShareImage} primary />
              <ActionButton icon={Download} label="Download PDF" busy={busyAction === 'pdf'} onClick={handleDownloadPdf} />
              <ActionButton icon={Mail} label="Send Email" busy={busyAction === 'email'} onClick={handleSendEmail} />
              {statement?.partner.phone && (
                <a
                  href={partnerWhatsappShareUrl(buildPartnerStatementText(statement), statement.partner.phone)}
                  target="_blank" rel="noreferrer"
                  className="text-xs text-primary hover:underline self-center"
                >
                  Open in WhatsApp →
                </a>
              )}
            </div>
            {actionMsg && <div className="text-xs text-muted-foreground mt-3">{actionMsg}</div>}
          </div>
        )}

        {/* Commission planner — margin-revealing, so same gate as the profit column */}
        {canViewProfit && (
          <CommissionPlanner
            partnerId={partner.id}
            partnerName={partner.name}
            clients={dashboard.clients}
            savedPercent={partner.commission_type === 'percentage' ? partner.commission_value : null}
            payments={commissionPayments}
            canEdit={canEdit}
          />
        )}

        {/* Linked clients */}
        <div className="bg-secondary border border-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-foreground">Linked Clients</h2>
            {canEdit && (
              <button onClick={() => setLinkOpen(true)} className="text-xs font-medium text-primary hover:underline flex items-center gap-1">
                <LinkIcon className="w-3.5 h-3.5" /> Link a client
              </button>
            )}
          </div>

          {dashboard.clients.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No clients linked yet.</p>
          ) : (
            <>
              {/* Phones: card list — 5 columns (+ unlink) has no room below sm. */}
              <div className="sm:hidden divide-y divide-border/50">
                {dashboard.clients.map(c => (
                  <div key={c.id} className="py-3">
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="font-medium text-foreground text-sm truncate">{c.name}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-medium text-foreground text-sm">{fmtAmt(c.outstanding)}</span>
                        {canEdit && (
                          <button onClick={() => handleUnlink(c.id)} className="text-muted-foreground hover:text-destructive p-1">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {c.pendingInvoices} pending · last payment {fmtDate(c.lastPayment)} · last invoice {fmtDate(c.lastInvoice)}
                    </p>
                    {canViewProfit && (
                      <p className={`text-xs mt-0.5 ${c.profitInr < 0 ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                        {fmtAmt(c.profitInr)} profit · {c.marginPct}% margin
                      </p>
                    )}
                    <div className="text-[11px] text-muted-foreground/70 mt-0.5 flex items-center gap-1">
                      Partner since
                      <PartnerSinceCell clientId={c.id} value={c.partnerSince} canEdit={canEdit} onError={setActionMsg} />
                    </div>
                    {c.draftInvoices > 0 && (
                      <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                        {fmtAmt(c.draftAmount)} in {c.draftInvoices} draft{c.draftInvoices === 1 ? '' : 's'} — not sent, not on the statement
                      </p>
                    )}
                  </div>
                ))}
              </div>

              <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="pb-2 font-medium">Client</th>
                    <th className="pb-2 font-medium">Partner Since</th>
                    <th className="pb-2 font-medium text-right">Outstanding</th>
                    <th className="pb-2 font-medium text-right">Pending Invoices</th>
                    {hasDrafts && <th className="pb-2 font-medium text-right">Not Sent</th>}
                    {hasBadDebt && <th className="pb-2 font-medium text-right">Bad Debt</th>}
                    {canViewProfit && <th className="pb-2 font-medium text-right">Profit</th>}
                    <th className="pb-2 font-medium text-right">Last Payment</th>
                    <th className="pb-2 font-medium text-right">Last Invoice</th>
                    {canEdit && <th className="pb-2"></th>}
                  </tr>
                </thead>
                <tbody>
                  {dashboard.clients.map(c => (
                    <tr key={c.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2.5 text-foreground">{c.name}</td>
                      <td className="py-2.5">
                        <PartnerSinceCell
                          clientId={c.id}
                          value={c.partnerSince}
                          canEdit={canEdit}
                          onError={setActionMsg}
                        />
                      </td>
                      <td className="py-2.5 text-right text-foreground">{fmtAmt(c.outstanding)}</td>
                      <td className="py-2.5 text-right text-muted-foreground">{c.pendingInvoices}</td>
                      {hasDrafts && (
                        <td className="py-2.5 text-right text-muted-foreground/70" title="Draft invoices — not sent to the client, not on the statement">
                          {c.draftInvoices > 0 ? `${fmtAmt(c.draftAmount)} · ${c.draftInvoices}` : '—'}
                        </td>
                      )}
                      {hasBadDebt && (
                        <td className="py-2.5 text-right text-red-500 tabular-nums" title="Delivered but never paid — written off">
                          {c.badDebtInr > 0 ? fmtAmt(c.badDebtInr) : '—'}
                        </td>
                      )}
                      {canViewProfit && (
                        <td
                          className={`py-2.5 text-right font-medium ${c.profitInr < 0 ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}`}
                          title="Invoiced minus direct costs and attributed staff commission, on this partner's invoices only"
                        >
                          {fmtAmt(c.profitInr)}
                          <span className="text-[10px] text-muted-foreground ml-1">{c.marginPct}%</span>
                        </td>
                      )}
                      <td className="py-2.5 text-right text-muted-foreground">{fmtDate(c.lastPayment)}</td>
                      <td className="py-2.5 text-right text-muted-foreground">{fmtDate(c.lastInvoice)}</td>
                      {canEdit && (
                        <td className="py-2.5 text-right">
                          <button onClick={() => handleUnlink(c.id)} className="text-muted-foreground hover:text-destructive">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </>
          )}
        </div>
      </div>

      {linkOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onMouseDown={e => e.target === e.currentTarget && setLinkOpen(false)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-sm p-5 max-h-[70vh] overflow-y-auto">
            <h2 className="text-base font-semibold text-foreground mb-3">Link a Client</h2>
            {unlinkedClients.length === 0 ? (
              <p className="text-sm text-muted-foreground">No unlinked clients available.</p>
            ) : (
              <div className="space-y-1">
                {unlinkedClients.map(c => (
                  <button
                    key={c.id}
                    disabled={linking}
                    onClick={() => handleLink(c.id)}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-secondary text-sm text-foreground flex items-center justify-between disabled:opacity-50"
                  >
                    <span>{c.name}</span>
                    <span className="text-xs text-muted-foreground">{c.code}</span>
                  </button>
                ))}
              </div>
            )}
            <button onClick={() => setLinkOpen(false)} className="w-full mt-4 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-secondary">
              Close
            </button>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * The handover date, editable inline. A client the partner originated has no
 * date ("From the start") — one they inherited gets the date they took over,
 * and everything billed before it stops counting as theirs.
 */
function PartnerSinceCell({ clientId, value, canEdit, onError }: {
  clientId: string
  value: string | null
  canEdit: boolean
  onError: (msg: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [saving, setSaving] = useState(false)

  async function save(next: string | null) {
    setSaving(true)
    const res = await setClientPartnerSince(clientId, next)
    if (!res.ok) {
      setSaving(false)
      onError(res.error || 'Could not save the handover date.')
      return
    }
    // Every figure on this page is derived from the date, so reload rather than
    // trying to re-add the arithmetic client-side.
    window.location.reload()
  }

  if (!canEdit) {
    return <span className="text-muted-foreground">{value ? fmtDate(value) : 'From the start'}</span>
  }

  if (!editing) {
    return (
      <button
        onClick={() => { setDraft(value ?? ''); setEditing(true) }}
        title="Invoices issued before this date aren't attributed to this partner"
        className={`text-xs hover:underline ${value ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        {value ? fmtDate(value) : 'From the start'}
      </button>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <input
        type="date"
        value={draft}
        autoFocus
        disabled={saving}
        onChange={e => setDraft(e.target.value)}
        className="text-xs bg-background border border-border rounded-lg px-2 py-1 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
      <button onClick={() => save(draft || null)} disabled={saving}
        className="text-xs font-medium text-primary hover:underline disabled:opacity-50">Save</button>
      {value && (
        <button onClick={() => save(null)} disabled={saving}
          title="This client was the partner's from the start"
          className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">Clear</button>
      )}
      <button onClick={() => setEditing(false)} disabled={saving}
        className="text-muted-foreground hover:text-foreground p-0.5"><X className="w-3 h-3" /></button>
    </div>
  )
}

function Kpi({ icon: Icon, label, value, hint, tint }: {
  icon: typeof Users2; label: string; value: string; hint?: string; tint?: string
}) {
  return (
    <div className="bg-secondary border border-border rounded-xl p-4 h-full">
      <Icon className="w-4 h-4 text-muted-foreground mb-2" />
      <div className={`text-lg font-semibold ${tint || 'text-foreground'}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {hint && <div className="text-[10px] text-muted-foreground/70 mt-1 leading-snug">{hint}</div>}
    </div>
  )
}

function ActionButton({ icon: Icon, label, busy, onClick, primary = false }: {
  icon: typeof Copy; label: string; busy: boolean; onClick: () => void; primary?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg disabled:opacity-50 ${
        primary ? 'gradient-bg text-white' : 'border border-border text-foreground hover:bg-background'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {busy ? 'Working…' : label}
    </button>
  )
}
