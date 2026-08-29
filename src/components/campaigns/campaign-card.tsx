'use client'

/**
 * CampaignCard — the offer-campaign review card (collapsed summary → expandable
 * detail with change-log, products, sheet sync, and finalise/archive actions).
 *
 * Shared so it renders identically on the (legacy) Campaigns page AND inside the
 * unified Requests inbox, where offer-campaign submissions appear as items.
 */

import { useState } from 'react'
import {
  CheckCircle2, AlertCircle, ChevronDown, ChevronUp,
  RefreshCw, Archive, Flag, Link2, Copy, Check, Loader2,
  ImageIcon, Tag, Calendar, FileText, FileSpreadsheet, History,
} from 'lucide-react'
import {
  acknowledgeLogs, finaliseCampaign, archiveCampaign, resyncSheet, generateOfferLink,
} from '@/app/(dashboard)/dashboard/campaigns/actions'
import {
  convertSheetCampaign, listCampaignRevisions, restoreCampaignRevision, type RevisionMeta,
} from '@/app/(dashboard)/dashboard/offer-prepare/actions'
import { formatDate } from '@/lib/utils/format-date'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

const BADGE_COLOR: Record<string, string> = {
  red:    'bg-red-500/15 text-red-400 border-red-500/30',
  amber:  'bg-amber-500/15 text-amber-400 border-amber-500/30',
  orange: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  green:  'bg-green-500/15 text-green-400 border-green-500/30',
  blue:   'bg-blue-500/15 text-blue-400 border-blue-500/30',
  purple: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
}

const LOG_TYPE_LABEL: Record<string, string> = {
  product_added:    '➕ Product added',
  product_removed:  '🗑 Product removed',
  product_changed:  '✏️ Product changed',
  header_changed:   '📝 Header changed',
  client_note:      '💬 Client note',
  system:           '⚙️ Activity',
}

function fmtDate(d?: string | null) {
  if (!d) return ''
  return formatDate(d)
}
function fmtDateTime(d: string) {
  return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
function formatOfferDate(c: any): string {
  if (c.date_type === 'single' && c.offer_date) return fmtDate(c.offer_date)
  if (c.date_type === 'range' && c.offer_date_from) {
    const from = fmtDate(c.offer_date_from)
    const to = c.offer_date_to ? fmtDate(c.offer_date_to) : ''
    return to ? `${from} – ${to}` : from
  }
  return 'No date set'
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={handleCopy}
      className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
      title="Copy link"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  )
}

export function CampaignCard({
  campaign,
  onRefresh,
  defaultExpanded = false,
}: {
  campaign: any
  onRefresh: () => void
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [busy, setBusy] = useState(false)
  const [intakeLink, setIntakeLink] = useState<string | null>(null)
  const [linkLoading, setLinkLoading] = useState(false)
  const [revisions, setRevisions] = useState<RevisionMeta[] | null>(null)
  const [revisionsError, setRevisionsError] = useState('')
  // In-app confirmation. NOT window.confirm: the desktop shell returns false
  // from it immediately without ever drawing a dialog, so these buttons would
  // silently do nothing there, with no error to explain it.
  const [confirmPrompt, setConfirmPrompt] = useState<{
    title: string
    body: string
    confirmLabel: string
    danger?: boolean
    onConfirm: () => void
  } | null>(null)

  async function loadRevisions() {
    if (revisions) return
    const res = await listCampaignRevisions(campaign.id)
    if (res.ok && res.data) setRevisions(res.data.revisions)
    else setRevisionsError(res.error || 'Could not load versions.')
  }

  async function handleRestore(rev: RevisionMeta) {
    setBusy(true)
    const res = await restoreCampaignRevision(campaign.id, rev.id)
    if (!res.ok) alert(res.error || 'Could not restore.')
    setRevisions(null)
    setRevisionsError('')
    onRefresh()
    setBusy(false)
  }

  const logs: any[] = campaign.logs || []
  const unacknowledged = logs.filter((l: any) => !l.acknowledged)
  const acknowledged = logs.filter((l: any) => l.acknowledged)
  const products: any[] = campaign.products || []
  const clientId = campaign.client?.id

  // "Changed since last sync" — the designer pulls the Google Sheet into Figma,
  // so any edit made after the last sync means the sheet (and the in-progress
  // artwork) is stale until someone re-syncs. Computed from the two timestamps
  // that already exist; a small grace window absorbs the write→sync clock skew.
  const staleSinceSync = !!campaign.sheet_last_synced_at
    && !campaign.sheet_sync_error
    && campaign.updated_at
    && new Date(campaign.updated_at).getTime() - new Date(campaign.sheet_last_synced_at).getTime() > 2000

  async function handleAcknowledgeAll() {
    setBusy(true)
    const ids = unacknowledged.map((l: any) => l.id)
    await acknowledgeLogs(campaign.id, ids)
    onRefresh()
    setBusy(false)
  }

  async function handleAcknowledgeSingle(logId: string) {
    await acknowledgeLogs(campaign.id, [logId])
    onRefresh()
  }

  async function handleFinalise() {
    setBusy(true)
    const res = await finaliseCampaign(campaign.id)
    if (!res.ok) alert(res.error || 'Could not finalise.')
    onRefresh()
    setBusy(false)
  }

  async function handleConvert() {
    setBusy(true)
    const res = await convertSheetCampaign(campaign.id)
    if (!res.ok) alert(res.error || 'Could not convert.')
    onRefresh()
    setBusy(false)
  }

  async function handleArchive() {
    setBusy(true)
    const res = await archiveCampaign(campaign.id)
    if (!res.ok) alert(res.error || 'Could not archive.')
    onRefresh()
    setBusy(false)
  }

  async function handleResync() {
    setBusy(true)
    const res = await resyncSheet(campaign.id, clientId)
    if (!res.ok) alert(res.error || 'Sync failed')
    onRefresh()
    setBusy(false)
  }

  async function handleGetLink() {
    setLinkLoading(true)
    const res = await generateOfferLink(clientId)
    if (res.ok && res.data) {
      const url = `${window.location.origin}/intake/offer/${res.data.token}`
      setIntakeLink(url)
    } else {
      alert(res.error || 'Could not generate the intake link.')
    }
    setLinkLoading(false)
  }

  const statusBadge = campaign.status === 'finalised'
    ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
    : 'bg-amber-500/15 text-amber-400 border-amber-500/30'

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      {/* Header */}
      <div
        role="button" tabIndex={0}
        onClick={() => setExpanded(e => !e)}
        onKeyDown={e => e.key === 'Enter' && setExpanded(e => !e)}
        className="px-5 py-4 flex items-start gap-4 cursor-pointer hover:bg-secondary/30 transition-colors"
      >
        {/* Unack badge */}
        <div className="shrink-0 mt-0.5">
          {unacknowledged.length > 0 ? (
            <div className="w-6 h-6 rounded-full bg-amber-500/20 border border-amber-500/40 flex items-center justify-center">
              <span className="text-[10px] font-bold text-amber-400">{unacknowledged.length}</span>
            </div>
          ) : (
            <div className="w-6 h-6 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <Check className="w-3 h-3 text-emerald-400" />
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Type badge — makes it clear this is an offer submission in the inbox */}
            <span className="text-[10px] px-2 py-0.5 rounded-full border font-medium bg-purple-500/15 text-purple-600 border-purple-500/30 dark:text-purple-400">
              Offer Campaign
            </span>
            <span className="text-sm font-semibold text-foreground truncate">
              {campaign.client?.name || 'Unknown client'}
            </span>
            {campaign.title && (
              <span className="text-xs text-muted-foreground">— {campaign.title}</span>
            )}
            <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${statusBadge}`}>
              {campaign.status}
            </span>
            {campaign.source === 'sheet_import' && (
              <span
                className="text-[10px] px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/25 font-medium shrink-0"
                title="Imported from the client's own Google Sheet — read-only in Cirqle"
              >
                Sheet managed
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1">
              <Calendar className="w-3 h-3" /> {formatOfferDate(campaign)}
            </span>
            <span className="flex items-center gap-1">
              <Tag className="w-3 h-3" /> {products.length} products
            </span>
            {unacknowledged.length > 0 && (
              <span className="flex items-center gap-1 text-amber-400">
                <AlertCircle className="w-3 h-3" /> {unacknowledged.length} unreviewed change{unacknowledged.length !== 1 ? 's' : ''}
              </span>
            )}
            {staleSinceSync && (
              <span className="flex items-center gap-1 text-amber-400" title="Edited after the last Google Sheet sync — re-sync so the designer's data matches">
                <RefreshCw className="w-3 h-3" /> Sheet out of date
              </span>
            )}
            <span>Updated {fmtDateTime(campaign.updated_at)}</span>
          </div>
        </div>

        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0 mt-1" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 mt-1" />}
      </div>

      {expanded && (
        <div className="border-t border-border px-5 py-5 space-y-5">

          {/* ── Unacknowledged change log ── */}
          {unacknowledged.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5" /> Needs reflection in design ({unacknowledged.length})
                </h3>
                <button
                  onClick={handleAcknowledgeAll}
                  disabled={busy}
                  className="text-xs px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/20 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                  Mark all reflected
                </button>
              </div>
              <div className="space-y-2">
                {unacknowledged.map((log: any) => (
                  <div key={log.id} className="flex items-start gap-3 bg-amber-500/5 border border-amber-500/20 rounded-xl px-3 py-2.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-amber-700 dark:text-amber-300">{LOG_TYPE_LABEL[log.log_type] || log.log_type}</p>
                      {log.product_name && <p className="text-xs text-foreground/80 mt-0.5">{log.product_name}</p>}
                      {log.field && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {log.field}: <span className="line-through text-red-400/70">{log.old_value || '–'}</span>
                          {' → '}
                          <span className="text-emerald-400">{log.new_value || '–'}</span>
                        </p>
                      )}
                      {log.note && <p className="text-xs text-foreground/80 mt-0.5 italic">&quot;{log.note}&quot;</p>}
                      <p className="text-[10px] text-muted-foreground/50 mt-1">{fmtDateTime(log.created_at)}</p>
                    </div>
                    <button
                      onClick={() => handleAcknowledgeSingle(log.id)}
                      className="shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                      title="Mark reflected"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Products grid — flyer-style reference for whoever is designing the offer ── */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" /> Products ({products.length})
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {products.map((p: any) => (
                <div key={p.id} className="bg-secondary/40 border border-border/60 rounded-xl overflow-hidden">
                  <div className="aspect-square bg-secondary relative">
                    {p.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image_url} alt={p.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <ImageIcon className="w-6 h-6 text-muted-foreground/30" />
                      </div>
                    )}
                    {!!(p.badges || []).length && (
                      <div className="absolute top-1.5 left-1.5 flex flex-col gap-0.5 items-start">
                        {p.badges.map((b: any, i: number) => (
                          <span key={i} className={`text-[9px] px-1.5 py-0.5 rounded-md border font-medium ${BADGE_COLOR[b.color] || BADGE_COLOR.amber}`}>
                            {b.custom_label || b.badge?.label}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="p-2">
                    <p className="text-xs font-medium text-foreground truncate" title={p.name}>{p.name}</p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {p.offer_type === 'price' && p.price ? `₹${p.price}${p.mrp ? ` (MRP ₹${p.mrp})` : ''}` : ''}
                      {p.offer_type === 'bogo' ? 'Buy 1 Get 1' : ''}
                      {(p.offer_type === 'percent' || p.offer_type === 'other') ? p.offer_text || '' : ''}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Acknowledged log (collapsed) ── */}
          {acknowledged.length > 0 && (
            <details className="group">
              <summary className="text-xs text-muted-foreground/50 cursor-pointer hover:text-muted-foreground list-none flex items-center gap-1.5">
                <CheckCircle2 className="w-3 h-3 text-emerald-400/50" />
                {acknowledged.length} reflected change{acknowledged.length !== 1 ? 's' : ''} (view history)
                <ChevronDown className="w-3 h-3 group-open:rotate-180 transition-transform" />
              </summary>
              <div className="mt-2 space-y-1.5">
                {acknowledged.map((log: any) => (
                  <div key={log.id} className="flex items-start gap-3 bg-secondary/20 rounded-xl px-3 py-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400/40 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-muted-foreground">{LOG_TYPE_LABEL[log.log_type] || log.log_type}
                        {log.product_name ? ` — ${log.product_name}` : ''}
                        {log.note ? ` — "${log.note}"` : ''}
                      </p>
                      <p className="text-[10px] text-muted-foreground/40">
                        {fmtDateTime(log.created_at)} · reflected {log.acknowledged_at ? fmtDateTime(log.acknowledged_at) : ''}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* ── Sheet sync status ── */}
          <div className="flex items-center gap-3 bg-secondary/30 rounded-xl px-3 py-2.5">
            <RefreshCw className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground">
                Google Sheet: {campaign.sheet_last_synced_at
                  ? `Last synced ${fmtDateTime(campaign.sheet_last_synced_at)}`
                  : 'Not synced yet'}
              </p>
              {staleSinceSync && (
                <p className="text-[10px] text-amber-400 mt-0.5">⚠ Edited since last sync — re-sync so the designer&apos;s sheet matches.</p>
              )}
              {campaign.sheet_sync_error && (
                <p className="text-[10px] text-red-400 mt-0.5">{campaign.sheet_sync_error}</p>
              )}
            </div>
            <button
              onClick={handleResync}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/70 text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5 disabled:opacity-50 shrink-0"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Sync now
            </button>
          </div>

          {/* ── Intake link ── */}
          <div>
            {intakeLink ? (
              <div className="flex items-center gap-2 bg-secondary/30 rounded-xl px-3 py-2.5">
                <Link2 className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                <p className="text-xs text-muted-foreground truncate flex-1">{intakeLink}</p>
                <CopyButton text={intakeLink} />
              </div>
            ) : (
              <button
                onClick={handleGetLink}
                disabled={linkLoading}
                className="text-xs flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
              >
                {linkLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />}
                Get client&apos;s offer link
              </button>
            )}
          </div>

          {/* ── Versions (admin; feature_offer_revisions) ─────────────────
              Loaded lazily on first open; the server action is admin-gated,
              so a non-admin opening it just sees the refusal note. */}
          <details
            className="group"
            onToggle={e => { if ((e.target as HTMLDetailsElement).open) void loadRevisions() }}
          >
            <summary className="cursor-pointer text-xs text-muted-foreground/60 hover:text-muted-foreground flex items-center gap-1.5 list-none">
              <History className="w-3 h-3" /> Versions
              <ChevronDown className="w-3 h-3 group-open:rotate-180 transition-transform" />
            </summary>
            <div className="mt-2 space-y-1.5">
              {revisionsError && <p className="text-xs text-muted-foreground/60">{revisionsError}</p>}
              {revisions && revisions.length === 0 && !revisionsError && (
                <p className="text-xs text-muted-foreground/60">No saved versions yet.</p>
              )}
              {(revisions || []).map(rev => (
                <div key={rev.id} className="flex items-center gap-3 bg-secondary/20 rounded-xl px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-foreground/80">
                      v{rev.revision_no} · {rev.product_count} products · {rev.actor_kind === 'figma' ? 'from Figma' : rev.actor_kind === 'restore' ? 'backup' : rev.actor_kind}
                    </p>
                    <p className="text-[10px] text-muted-foreground/50">
                      {fmtDateTime(rev.created_at)}{rev.note ? ` · ${rev.note}` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => setConfirmPrompt({
                      title: `Roll back to version ${rev.revision_no}?`,
                      body: `The current product list is replaced by the ${rev.product_count} products in that version. Today's list is saved as a new version first, so you can roll forward again.`,
                      confirmLabel: 'Restore version',
                      onConfirm: () => { void handleRestore(rev) },
                    })}
                    disabled={busy}
                    className="shrink-0 text-[11px] px-2.5 py-1 rounded-lg bg-secondary text-muted-foreground border border-border hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          </details>

          {/* ── Actions ── */}
          <div className="flex gap-2 pt-1 border-t border-border flex-wrap">
            {campaign.status === 'active' && (
              <button
                onClick={() => setConfirmPrompt({
                  title: 'Mark this campaign as finalised?',
                  body: 'It moves out of the in-progress list and is treated as agreed. The client can still send updates, which will show up as changes to acknowledge.',
                  confirmLabel: 'Mark finalised',
                  onConfirm: () => { void handleFinalise() },
                })}
                disabled={busy}
                className="text-xs px-3 py-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/20 transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                <Flag className="w-3.5 h-3.5" /> Mark finalised
              </button>
            )}
            {campaign.source === 'sheet_import' && (
              <button
                onClick={() => setConfirmPrompt({
                  title: 'Convert this into a Cirqle offer?',
                  body: 'It stops tracking the client\u2019s Google Sheet for good — later edits they make there are ignored, and future pulls leave this campaign alone. The products already pulled in stay.',
                  confirmLabel: 'Convert to offer',
                  onConfirm: () => { void handleConvert() },
                })}
                disabled={busy}
                title="Stop tracking the client's sheet so this offer can be edited in Cirqle"
                className="text-xs px-3 py-2 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/25 hover:bg-sky-500/20 transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" /> Convert to Cirqle offer
              </button>
            )}
            <button
              onClick={() => setConfirmPrompt({
                title: 'Archive this campaign?',
                body: 'It disappears from the main view and stops syncing, but nothing is deleted — the products, versions and history are all kept.',
                confirmLabel: 'Archive campaign',
                onConfirm: () => { void handleArchive() },
              })}
              disabled={busy}
              className="text-xs px-3 py-2 rounded-lg bg-secondary text-muted-foreground border border-border hover:text-foreground transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              <Archive className="w-3.5 h-3.5" /> Archive
            </button>
          </div>
        </div>
      )}
      {confirmPrompt && (
        <ConfirmDialog
          title={confirmPrompt.title}
          body={confirmPrompt.body}
          confirmLabel={confirmPrompt.confirmLabel}
          danger={confirmPrompt.danger}
          onConfirm={() => { const fn = confirmPrompt.onConfirm; setConfirmPrompt(null); fn() }}
          onCancel={() => setConfirmPrompt(null)}
        />
      )}
    </div>
  )
}

export default CampaignCard
