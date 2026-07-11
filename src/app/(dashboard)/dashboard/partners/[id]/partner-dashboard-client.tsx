'use client'

import { useState } from 'react'
import Header from '@/components/layout/header'
import {
  Users2, Wallet, CheckCircle2, Clock, Sparkles,
  Copy, Image as ImageIcon, Download, Mail, Link as LinkIcon, X,
} from 'lucide-react'
import { linkClientToPartner, fetchPartnerStatement } from '../actions'
import { sendPartnerStatementEmail } from '@/lib/partners/send-email'
import { buildPartnerStatementText, partnerWhatsappShareUrl } from '@/lib/partners/whatsapp'
import { downloadStatementImage } from '@/lib/partners/statement-image'
import { downloadStatementPdf } from '@/lib/partners/statement-pdf'
import { FavoriteToggle } from '@/components/ui/favorite-toggle'
import type { BusinessPartner, PartnerDashboardData, PartnerStatementData } from '@/lib/partners/queries'

interface UnlinkedClient { id: string; name: string; code: string }
interface Brand { companyName: string; primaryColor: string }

interface Props {
  partner: BusinessPartner
  dashboard: PartnerDashboardData
  unlinkedClients: UnlinkedClient[]
  brand: Brand
  canEdit: boolean
  canExport: boolean
}

const fmtAmt = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const fmtDate = (s: string | null) => {
  if (!s) return '—'
  const d = new Date(s)
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function PartnerDashboardClient({ partner, dashboard, unlinkedClients, brand, canEdit, canExport }: Props) {
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
      const text = buildPartnerStatementText(data)
      await navigator.clipboard.writeText(text)
      setActionMsg('Statement text copied to clipboard.')
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
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Kpi icon={Users2} label="Total Clients" value={String(dashboard.totalClients)} />
          <Kpi icon={Clock} label="Pending Collection" value={fmtAmt(dashboard.pendingCollection)} />
          <Kpi icon={CheckCircle2} label="Collected Amount" value={fmtAmt(dashboard.collectedAmount)} />
          <Kpi icon={Wallet} label="Last Collection" value={fmtDate(dashboard.lastCollection)} />
          <div className="bg-secondary border border-dashed border-border rounded-xl p-4 flex flex-col justify-center items-center text-center">
            <Sparkles className="w-4 h-4 text-muted-foreground mb-1" />
            <div className="text-xs font-medium text-muted-foreground">Commission Settlement</div>
            <div className="text-xs text-muted-foreground/70 mt-0.5">Coming Soon</div>
          </div>
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
                  </div>
                ))}
              </div>

              <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="pb-2 font-medium">Client</th>
                    <th className="pb-2 font-medium text-right">Outstanding</th>
                    <th className="pb-2 font-medium text-right">Pending Invoices</th>
                    <th className="pb-2 font-medium text-right">Last Payment</th>
                    <th className="pb-2 font-medium text-right">Last Invoice</th>
                    {canEdit && <th className="pb-2"></th>}
                  </tr>
                </thead>
                <tbody>
                  {dashboard.clients.map(c => (
                    <tr key={c.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2.5 text-foreground">{c.name}</td>
                      <td className="py-2.5 text-right text-foreground">{fmtAmt(c.outstanding)}</td>
                      <td className="py-2.5 text-right text-muted-foreground">{c.pendingInvoices}</td>
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

function Kpi({ icon: Icon, label, value }: { icon: typeof Users2; label: string; value: string }) {
  return (
    <div className="bg-secondary border border-border rounded-xl p-4">
      <Icon className="w-4 h-4 text-muted-foreground mb-2" />
      <div className="text-lg font-semibold text-foreground">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
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
