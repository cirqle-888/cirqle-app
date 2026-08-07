'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Link2, Tag, Copy, Check, RefreshCw, Loader2,
  AlertTriangle, CheckCircle2, ExternalLink, Webhook,
  ChevronDown, ChevronUp, Search, ShieldAlert, FlaskConical,
  Package, Store, Upload, Settings2, Sprout,
} from 'lucide-react'
import {
  saveWebhookUrl, saveOfferSheetUrl, resetOfferToken, testSheetSync, ensureOfferToken,
  saveGlobalWebhookUrl, regenerateSheetSecret,
  saveClientFlowMode,
  saveMasterSheetUrl,
  saveClientFigmaUrl,
  type OfferGroupRow,
} from './actions'
import { OfferGroupsPanel } from './offer-groups-panel'
import { PluginHealthPanel } from './plugin-health-panel'
import { FigmaBindingHelp } from '@/components/offer/figma-binding-help'
import { FigmaLink } from '@/components/offer/figma-link'

const inputCls = 'w-full bg-secondary border border-foreground/15 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20'
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1.5'

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={handleCopy}
      title="Copy"
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs bg-secondary border border-border hover:bg-secondary/70 text-muted-foreground hover:text-foreground transition-colors shrink-0"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      {label && <span>{copied ? 'Copied!' : label}</span>}
    </button>
  )
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
  )
}

function HealthRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-foreground/80 truncate ml-auto">{value}</span>
    </div>
  )
}

/** 'warn' = the call succeeded but did no work (skipped / blocked). */
type Flash = 'ok' | 'err' | 'warn'

const FLASH_CLS: Record<Flash, string> = {
  ok:   'bg-emerald-500/10 border border-emerald-500/25 text-emerald-700 dark:text-emerald-300',
  warn: 'bg-amber-500/10 border border-amber-500/25 text-amber-700 dark:text-amber-300',
  err:  'bg-red-500/10 border border-red-500/25 text-red-700 dark:text-red-300',
}

type FlowMode = 'push' | 'pull' | 'manual'

// Labels say what HAPPENS. "Push"/"Pull" describe the plumbing's direction,
// which only makes sense once you already know the plumbing.
const FLOW_LABEL: Record<FlowMode, string> = {
  push: 'Cirqle writes the sheet',
  pull: "Client owns the sheet",
  manual: 'No sheet',
}
/** Short form for chips and the status row, where the full label won't fit. */
const FLOW_SHORT: Record<FlowMode, string> = { push: 'Push', pull: 'Pull', manual: 'Manual' }

const FLOW_HELP: Record<FlowMode, string> = {
  push: 'Cirqle writes the designer Google Sheet from the offer list collected here.',
  pull: 'The client keeps their own Google Sheet. Cirqle only reads it and never writes, so any formulas or photo automation they have built keep working.',
  manual: 'No sheet sync at all. The flyer is built by hand in Figma.',
}

// ── Client card ───────────────────────────────────────────────────────────────

function ClientCard({
  client: initialClient, appUrl, globalConfigured, groups: initialGroups = [],
}: {
  client: {
    id: string; name: string; code?: string
    offer_intake_token: string | null
    product_library_token?: string | null
    offer_sheet_webhook_url: string | null
    offer_sheet_url: string | null
    offer_flow_mode?: string | null
    offer_master_sheet_url?: string | null
    integrations?: { figma?: { file_url?: string } } | null
    has_offer_flyer_service: boolean
  }
  appUrl: string
  globalConfigured: boolean
  groups?: OfferGroupRow[]
}) {
  const [client, setClient] = useState(initialClient)
  const [expanded, setExpanded] = useState(false)
  const [webhookDraft, setWebhookDraft] = useState(client.offer_sheet_webhook_url || '')
  const [sheetUrlDraft, setSheetUrlDraft] = useState(client.offer_sheet_url || '')
  const [token, setToken] = useState(client.offer_intake_token || '')
  const [webhookSaving, setWebhookSaving] = useState(false)
  const [sheetUrlSaving, setSheetUrlSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(!!client.offer_sheet_webhook_url)
  const [msg, setMsg] = useState<{ type: Flash; text: string } | null>(null)
  const [groups, setGroups] = useState<OfferGroupRow[]>(initialGroups)
  const [flowMode, setFlowMode] = useState<FlowMode>((client.offer_flow_mode as FlowMode) || 'push')
  const [flowSaving, setFlowSaving] = useState(false)
  const [masterDraft, setMasterDraft] = useState(client.offer_master_sheet_url || '')
  const [masterSaving, setMasterSaving] = useState(false)
  const [figmaDraft, setFigmaDraft] = useState(client.integrations?.figma?.file_url || '')
  const [figmaSaving, setFigmaSaving] = useState(false)

  const intakeUrl = token ? `${appUrl}/intake/offer/${token}` : null
  // Separate link and separate token from the offer form: this one goes to
  // whoever buys the produce, and is usually not the person who sends the
  // weekly offer list.
  const libraryUrl = client.product_library_token
    ? `${appUrl}/intake/library/${client.product_library_token}`
    : null
  const hasWebhook = !!client.offer_sheet_webhook_url
  const hasSheetLink = !!client.offer_sheet_url
  const hasToken = !!token
  // The sheet is reachable when either a legacy per-client script is set, or the
  // shared script is connected AND this client has pasted their Sheet link.
  const hasSheetDestination = hasWebhook || (globalConfigured && hasSheetLink)
  // Readiness means something different per mode, so the chip stops telling a
  // pull-mode client they are "Setup needed" for a sheet Cirqle never writes.
  const hasMasterSheet = !!client.offer_master_sheet_url
  const onboardingDone =
    flowMode === 'manual' ? true
    : flowMode === 'pull' ? hasMasterSheet
    : hasSheetDestination && hasToken

  function flash(type: Flash, text: string) {
    setMsg({ type, text })
    setTimeout(() => setMsg(null), 4000)
  }

  async function handleFlowMode(next: FlowMode) {
    setFlowSaving(true)
    const res = await saveClientFlowMode(client.id, next)
    setFlowSaving(false)
    if (res.ok) { setFlowMode(next); flash('ok', `Saved — ${FLOW_LABEL[next]} ✓`) }
    else flash('err', res.error || 'Could not change flow mode')
  }

  async function handleSaveMasterSheet() {
    setMasterSaving(true)
    const res = await saveMasterSheetUrl(client.id, masterDraft)
    setMasterSaving(false)
    if (res.ok) { setClient(c => ({ ...c, offer_master_sheet_url: masterDraft.trim() || null })); flash('ok', 'Master sheet link saved ✓') }
    else flash('err', res.error || 'Could not save')
  }

  async function handleSaveFigma() {
    setFigmaSaving(true)
    const res = await saveClientFigmaUrl(client.id, figmaDraft)
    setFigmaSaving(false)
    if (res.ok) {
      const url = figmaDraft.trim()
      setClient(c => ({ ...c, integrations: url ? { figma: { file_url: url } } : {} }))
      flash('ok', url ? 'Figma link saved ✓' : 'Figma link cleared')
    } else flash('err', res.error || 'Could not save')
  }

  async function handleSaveWebhook() {
    setWebhookSaving(true)
    const res = await saveWebhookUrl(client.id, webhookDraft)
    setWebhookSaving(false)
    if (res.ok) { setClient(c => ({ ...c, offer_sheet_webhook_url: webhookDraft.trim() || null })); flash('ok', 'Per-client script URL saved ✓') }
    else flash('err', res.error || 'Could not save')
  }

  async function handleSaveSheetUrl() {
    setSheetUrlSaving(true)
    const res = await saveOfferSheetUrl(client.id, sheetUrlDraft)
    setSheetUrlSaving(false)
    if (res.ok) { setClient(c => ({ ...c, offer_sheet_url: sheetUrlDraft.trim() || null })); flash('ok', 'Google Sheet link saved ✓') }
    else flash('err', res.error || 'Could not save')
  }

  async function handleResetToken() {
    if (!confirm('Replace this client link? The old one stops working immediately and you will need to send them the new one.')) return
    setResetting(true)
    const res = await resetOfferToken(client.id)
    setResetting(false)
    if (res.ok && res.data) { setToken(res.data.token); flash('ok', 'Token reset — share the new link') }
    else flash('err', res.error || 'Could not reset')
  }

  async function handleGenerateToken() {
    setGenerating(true)
    const res = await ensureOfferToken(client.id)
    setGenerating(false)
    if (res.ok && res.data) { setToken(res.data.token); flash('ok', 'Intake link generated ✓') }
    else flash('err', res.error || 'Could not generate')
  }

  async function handleTestSync() {
    setTesting(true)
    const res = await testSheetSync(client.id)
    setTesting(false)

    if (!res.ok) { flash('err', res.error || 'Sync failed'); return }

    const out = res.data
    if (!out) { flash('err', 'Sync returned no result.'); return }

    // Only 'success' is green. A skipped or blocked run wrote nothing, and
    // saying "synced ✓" for it is exactly the false confidence being removed.
    flash(out.status === 'success' ? 'ok' : out.status === 'failed' ? 'err' : 'warn', out.message)

    // sheetUrl is only ever returned on a real write.
    if (out.status === 'success' && out.sheetUrl) {
      setSheetUrlDraft(out.sheetUrl)
      setClient(c => ({ ...c, offer_sheet_url: out.sheetUrl || null }))
    }
  }

  return (
    <div className="bg-card border border-violet-500/20 rounded-2xl overflow-hidden transition-colors">
      {/* Header row */}
      <div
        role="button" tabIndex={0}
        onClick={() => setExpanded(e => !e)}
        onKeyDown={e => e.key === 'Enter' && setExpanded(e => !e)}
        className="px-5 py-4 flex items-center gap-3 cursor-pointer hover:bg-secondary/30 transition-colors"
      >
        <Store className="w-4 h-4 shrink-0 text-violet-400" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold truncate">{client.name}</p>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-400 border border-violet-500/20 font-medium shrink-0">
              Offer Flyer
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {onboardingDone
              ? 'Fully set up'
              : [!hasToken && 'No intake link', !hasSheetDestination && 'No sheet linked'].filter(Boolean).join(' · ')}
          </p>
        </div>

        {/* Status dots — intake link + sheet destination */}
        <div className="flex items-center gap-1 shrink-0">
          <StatusDot ok={hasToken} />
          <StatusDot ok={hasSheetDestination} />
        </div>

        {flowMode !== 'push' && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/25 font-medium shrink-0">
            {FLOW_LABEL[flowMode]}
          </span>
        )}
        {onboardingDone
          ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 font-medium shrink-0">Ready</span>
          : <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/25 font-medium shrink-0">Setup needed</span>
        }
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </div>

      {expanded && (
        <div className="border-t border-border px-5 py-5 space-y-5">

          {/* Flash message */}
          {msg && (
            <div className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm ${FLASH_CLS[msg.type]}`}>
              {msg.type === 'ok' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
              {msg.text}
            </div>
          )}

          {/* ── Flow mode ──────────────────────────────────────────────────
              Which direction data moves for this client. Getting this wrong is
              expensive: pushing to a client-maintained sheet destroys their own
              IMPORTRANGE feeds, so the choice is explicit rather than inferred. */}
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">How is the designer sheet made?</p>
            <div className="flex items-center gap-1.5 mb-2">
              {(['push', 'pull', 'manual'] as FlowMode[]).map(mode => (
                <button
                  key={mode}
                  onClick={() => void handleFlowMode(mode)}
                  disabled={flowSaving || flowMode === mode}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    flowMode === mode
                      ? 'bg-violet-600 text-white'
                      : 'bg-secondary border border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {FLOW_LABEL[mode]}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">{FLOW_HELP[flowMode]}</p>
          </div>

          {/* Master sheet — only meaningful when Cirqle is the reader. */}
          {flowMode === 'pull' && (
            <div>
              <p className="text-xs font-semibold text-foreground mb-2">Client's master Google Sheet</p>
              <div className="flex items-center gap-2">
                <input
                  value={masterDraft}
                  onChange={e => setMasterDraft(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/…/edit"
                  className={inputCls + ' flex-1'}
                />
                {client.offer_master_sheet_url && (
                  <a
                    href={client.offer_master_sheet_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open the client's own sheet"
                    className="shrink-0 p-2 rounded-xl bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                )}
                <button
                  onClick={() => void handleSaveMasterSheet()}
                  disabled={masterSaving}
                  className="px-3 py-2 rounded-xl text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 transition-colors shrink-0"
                >
                  {masterSaving ? 'Saving…' : 'Save link'}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Must be shared with “Anyone with the link” (Viewer is enough). Cirqle reads it and never writes to it.
              </p>
            </div>
          )}

          {/* ── Integration health ─────────────────────────────────────────
              All derived, nothing stored. Sea Star's sheet sat contaminated for
              a day and Goodwill's Figma file quietly lost its binding — both
              would have been obvious at a glance here. */}
          <div className="rounded-xl bg-secondary/40 border border-border p-3">
            <p className="text-xs font-semibold text-foreground mb-2">Integration status</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
              <HealthRow label="Sheet mode" value={FLOW_SHORT[flowMode]} ok />
              <HealthRow label="Intake link" value={hasToken ? 'Created' : 'Not created'} ok={hasToken} />
              {flowMode === 'pull' ? (
                <>
                  <HealthRow label="Master sheet" value={hasMasterSheet ? 'Linked' : 'Not linked'} ok={hasMasterSheet} />
                  <HealthRow
                    label="Source tabs"
                    value={groups.length ? `${groups.filter(g => g.master_tab_name).length}/${groups.length} mapped` : 'First tab'}
                    ok={!groups.length || groups.every(g => g.master_tab_name)}
                  />
                </>
              ) : (
                <>
                  <HealthRow label="Google Sheet" value={hasSheetLink ? 'Linked' : hasWebhook ? 'Via bound script' : 'Not linked'} ok={hasSheetDestination} />
                  <HealthRow
                    label="Sync script"
                    value={hasWebhook ? 'Per-client' : globalConfigured ? 'Shared' : 'Not connected'}
                    ok={hasWebhook || globalConfigured}
                  />
                </>
              )}
              <HealthRow label="Categories" value={groups.length ? `${groups.length}` : 'Single list'} ok />
              <HealthRow
                label="Figma"
                value={
                  groups.some(g => g.integrations?.figma?.file_url)
                    ? `${groups.filter(g => g.integrations?.figma?.file_url).length} linked`
                    : client.integrations?.figma?.file_url ? 'Linked' : 'Not linked'
                }
                ok={groups.some(g => g.integrations?.figma?.file_url) || !!client.integrations?.figma?.file_url}
              />
            </div>
          </div>

          {/* Where the capability comes from — read-only. A client appears here
              because one of their assigned services has Intake Kind = "Offer
              Intake"; that assignment IS the on/off switch. */}
          <div className="flex items-center gap-3 p-3 bg-secondary/40 rounded-xl border border-border">
            <Store className="w-4 h-4 text-violet-400 shrink-0" />
            <p className="text-xs text-muted-foreground flex-1 min-w-0">
              Enabled by this client's <span className="text-foreground font-medium">Offer Intake</span> service. To remove access, unassign that service from the client.
            </p>
            <Link
              href={`/dashboard/settings?tab=clients&editClient=${client.id}&returnTo=/dashboard/apps/offer-intake`}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg bg-secondary border border-border hover:bg-secondary/70 text-muted-foreground hover:text-foreground transition-colors shrink-0"
            >
              <Settings2 className="w-3 h-3" /> Services
            </Link>
          </div>

              {/* ── Section 1: Intake link ── */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mb-3 flex items-center gap-1.5">
                  <Link2 className="w-3.5 h-3.5" /> Client Intake Link
                </p>
                {hasToken ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 bg-secondary/40 rounded-xl px-3 py-2.5">
                      <p className="text-xs font-mono text-muted-foreground truncate flex-1">{intakeUrl}</p>
                      <CopyBtn text={intakeUrl!} label="Copy" />
                      <a href={intakeUrl!} target="_blank" rel="noopener noreferrer"
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors" title="Open link">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleResetToken}
                        disabled={resetting}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-50"
                      >
                        {resetting ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldAlert className="w-3 h-3" />}
                        Replace link (old one stops working)
                      </button>
                      <p className="text-[11px] text-muted-foreground/50">Use only if the link is compromised</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 bg-amber-500/5 border border-amber-500/20 rounded-xl px-4 py-3">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                    <p className="text-sm text-amber-600 dark:text-amber-300 flex-1">No intake link yet</p>
                    <button
                      onClick={handleGenerateToken}
                      disabled={generating}
                      className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg gradient-bg text-white hover:opacity-90 disabled:opacity-50 transition-opacity shrink-0"
                    >
                      {generating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />}
                      Generate link
                    </button>
                  </div>
                )}
              </div>

              {/* ── Section 1b: Product Library link ──
                  A second, independent link. Clients send produce (name,
                  Malayalam name, photo) into the shared catalog; submissions
                  wait for staff approval before they can reach a flyer. */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mb-3 flex items-center gap-1.5">
                  <Sprout className="w-3.5 h-3.5" /> Product Library Link
                </p>
                {libraryUrl ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 bg-secondary/40 rounded-xl px-3 py-2.5">
                      <p className="text-xs font-mono text-muted-foreground truncate flex-1">{libraryUrl}</p>
                      <CopyBtn text={libraryUrl} label="Copy" />
                      <a href={libraryUrl} target="_blank" rel="noopener noreferrer"
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors" title="Open link">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                    <p className="text-[11px] text-muted-foreground/50">
                      For whoever buys the produce — they add vegetables and fruits with a photo, and you approve them in the catalog.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No library link yet — it is created automatically for every active client.
                  </p>
                )}
              </div>

              {/* ── Section 2: Sheet link (primary) ──
                  PUSH ONLY. In pull mode Cirqle reads the client's own sheet
                  and must never write one; in manual there is no sync at all.
                  Showing these fields invited staff to paste a sheet URL into
                  a field that would silently never be used. The matching
                  server actions refuse the write too — hiding is not
                  enforcement. */}
              {flowMode === 'push' && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mb-3 flex items-center gap-1.5">
                  <Webhook className="w-3.5 h-3.5" /> Google Sheet Sync
                </p>

                {!globalConfigured && !hasWebhook && (
                  <div className="flex items-center gap-2 bg-amber-500/5 border border-amber-500/20 rounded-xl px-3 py-2.5 mb-3">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                    <p className="text-xs text-amber-600 dark:text-amber-300">Connect the shared sync script once (top of this page), then just paste each client’s Sheet link here.</p>
                  </div>
                )}

                <div className="space-y-2">
                  <div>
                    <label className={labelCls}>
                      Google Sheet link <span className="text-muted-foreground/40">— open the client’s sheet and copy the URL</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        value={sheetUrlDraft}
                        onChange={e => setSheetUrlDraft(e.target.value)}
                        className={inputCls}
                        placeholder="https://docs.google.com/spreadsheets/d/…/edit"
                      />
                      {client.offer_sheet_url && (
                        <>
                          <CopyBtn text={client.offer_sheet_url} />
                          <a href={client.offer_sheet_url} target="_blank" rel="noopener noreferrer"
                            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0" title="Open sheet">
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSaveSheetUrl}
                      disabled={sheetUrlSaving || sheetUrlDraft === (client.offer_sheet_url || '')}
                      className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg gradient-bg text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
                    >
                      {sheetUrlSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                      Save link
                    </button>
                    <p className="text-[11px] text-muted-foreground/50">Make sure the sheet is shared so “Anyone with the link” can view.</p>
                  </div>
                </div>

                {/* Advanced: legacy per-client bound script (override). Rarely needed
                    once the shared script is connected — kept for existing setups. */}
                <div className="mt-3">
                  <button
                    onClick={() => setAdvancedOpen(o => !o)}
                    className="text-[11px] text-muted-foreground/60 hover:text-muted-foreground flex items-center gap-1"
                  >
                    {advancedOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    Advanced: use a different sync script for this client
                  </button>
                  {advancedOpen && (
                    <div className="space-y-2 mt-2 pl-3 border-l border-border">
                      <div>
                        <label className={labelCls}>Sync script URL <span className="text-muted-foreground/60 font-normal">(Google Apps Script Web App)</span></label>
                        <input
                          value={webhookDraft}
                          onChange={e => setWebhookDraft(e.target.value)}
                          className={inputCls}
                          placeholder="https://script.google.com/macros/s/…/exec"
                        />
                      </div>
                      {webhookDraft && !webhookDraft.startsWith('https://script.google.com/macros/s/') && (
                        <p className="text-xs text-red-400 flex items-center gap-1.5">
                          <AlertTriangle className="w-3 h-3" /> Must be a Google Apps Script Web App URL
                        </p>
                      )}
                      <p className="text-[11px] text-muted-foreground/50">
                        Only needed for a sheet-bound script. When set, it takes precedence over the shared script + link above.
                      </p>
                      <button
                        onClick={handleSaveWebhook}
                        disabled={webhookSaving || webhookDraft === (client.offer_sheet_webhook_url || '')}
                        className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-secondary border border-border hover:bg-secondary/70 text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
                      >
                        {webhookSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                        Save override
                      </button>
                    </div>
                  )}
                </div>
              </div>

              )}

              {/* ── Section 3: Test sync ── PUSH ONLY, same reason. */}
              {flowMode === 'push' && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mb-3 flex items-center gap-1.5">
                  <FlaskConical className="w-3.5 h-3.5" /> Test Sheet Sync
                </p>
                {hasSheetDestination ? (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleTestSync}
                      disabled={testing}
                      className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-secondary border border-border hover:bg-secondary/70 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                    >
                      {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      Run test sync now
                    </button>
                    <p className="text-[11px] text-muted-foreground/50">Pushes the latest campaign data to the sheet</p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground/50">Paste the client’s Google Sheet link first to enable test sync.</p>
                )}
              </div>

              )}

          {/* ── Design ──────────────────────────────────────────────
              Moved below the sheet and link setup: these are per-client
              design details, not part of getting a client working, and
              they used to sit between choosing a mode and connecting the
              sheet — interrupting the one sequence staff follow. */}
          {/* ── Figma file ─────────────────────────────────────────────────
              The client's main design file. Categories carry their own link,
              but most clients have no categories, so this is where the link
              lives for them — and it puts the design one click from the
              offer list instead of hunting through Figma's file browser. */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-foreground">Figma file</p>
              <FigmaBindingHelp />
            </div>
            <div className="flex items-center gap-2">
              <input
                value={figmaDraft}
                onChange={e => setFigmaDraft(e.target.value)}
                placeholder="https://www.figma.com/design/…"
                className={inputCls + ' flex-1'}
              />
              {client.integrations?.figma?.file_url && (
                <FigmaLink
                  url={client.integrations.figma.file_url}
                  title="Open in the Figma desktop app"
                  className="shrink-0 p-2 rounded-xl bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                </FigmaLink>
              )}
              <button
                onClick={() => void handleSaveFigma()}
                disabled={figmaSaving}
                className="px-3 py-2 rounded-xl text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 transition-colors shrink-0"
              >
                {figmaSaving ? 'Saving…' : 'Save link'}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Adds an “Open in Figma” shortcut to this client’s card in Offer Intake.
            </p>
          </div>

          {/* ── Categories ─────────────────────────────────────────────────── */}
          <OfferGroupsPanel
            clientId={client.id}
            flowMode={flowMode}
            groups={groups}
            onChanged={setGroups}
          />


              {/* ── Onboarding checklist ──
                  Steps differ per mode: a pull client never needs a Cirqle-owned
                  sheet, a manual client needs neither. The old list also had a
                  row that ticked itself — "Link sent to client via WhatsApp"
                  shared its predicate with "Intake link generated", so it went
                  green the moment the link existed, whether or not anyone had
                  sent it. Nothing records that, so it is now an explicit
                  reminder rather than a fake tick. */}
              <div className="bg-secondary/30 rounded-xl px-4 py-3 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground/70 mb-2">Setup checklist</p>
                {[
                  { done: true, label: 'Offer Intake service enabled' },
                  { done: hasToken, label: 'Client link created' },
                  ...(flowMode === 'push'
                    ? [{ done: hasSheetDestination, label: 'Google Sheet connected' }]
                    : flowMode === 'pull'
                      ? [{ done: hasMasterSheet, label: "Client's own sheet linked" }]
                      : []),
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    {item.done
                      ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      : <div className="w-3.5 h-3.5 rounded-full border border-muted-foreground/30 shrink-0" />}
                    <span className={item.done ? 'text-foreground/70' : 'text-muted-foreground/50'}>{item.label}</span>
                  </div>
                ))}
                {hasToken && (
                  <p className="text-[11px] text-muted-foreground/60 pt-1">
                    Last step: send the client link above to the client.
                  </p>
                )}
              </div>
        </div>
      )}
    </div>
  )
}

// ── Global shared-script setup (one-time, whole workspace) ──────────────────
function GlobalSyncCard({ initial }: { initial: { webhookUrl: string; secret: string; configured: boolean } }) {
  const [cfg, setCfg] = useState(initial)
  const [urlDraft, setUrlDraft] = useState(initial.webhookUrl)
  const [saving, setSaving] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [open, setOpen] = useState(!initial.configured)
  const [msg, setMsg] = useState<{ type: Flash; text: string } | null>(null)

  function flash(type: Flash, text: string) { setMsg({ type, text }); setTimeout(() => setMsg(null), 4000) }

  async function handleSave() {
    setSaving(true)
    const res = await saveGlobalWebhookUrl(urlDraft)
    setSaving(false)
    if (res.ok && res.data) { setCfg({ webhookUrl: urlDraft.trim(), secret: res.data.secret, configured: !!urlDraft.trim() }); flash('ok', 'Shared sync script connected ✓') }
    else flash('err', res.error || 'Could not save')
  }

  async function handleRotate() {
    if (!confirm('Generate a new secret? You must paste it into the Apps Script (SECRET) and redeploy, or syncs will fail.')) return
    setRotating(true)
    const res = await regenerateSheetSecret()
    setRotating(false)
    if (res.ok && res.data) { setCfg(c => ({ ...c, secret: res.data!.secret })); flash('ok', 'New secret generated — update the Apps Script') }
    else flash('err', res.error || 'Could not regenerate')
  }

  return (
    <div className={`bg-card border rounded-2xl overflow-hidden mb-4 ${cfg.configured ? 'border-emerald-500/20' : 'border-amber-500/30'}`}>
      <button onClick={() => setOpen(o => !o)} className="w-full px-5 py-4 flex items-center gap-3 hover:bg-secondary/30 transition-colors text-left">
        <Webhook className={`w-4 h-4 shrink-0 ${cfg.configured ? 'text-emerald-400' : 'text-amber-400'}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">Shared sync script <span className="text-muted-foreground/50 font-normal">· set up once for all clients</span></p>
          <p className="text-[11px] text-muted-foreground">
            {cfg.configured ? 'Connected — add a client by pasting their Sheet link below.' : 'Not connected — deploy one Apps Script, paste its URL here, then each client only needs a Sheet link.'}
          </p>
        </div>
        {cfg.configured
          ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 font-medium shrink-0">Connected</span>
          : <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/25 font-medium shrink-0">Action needed</span>}
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-border px-5 py-5 space-y-4">
          {msg && (
            <div className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm ${FLASH_CLS[msg.type]}`}>
              {msg.type === 'ok' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
              {msg.text}
            </div>
          )}

          <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal pl-4">
            <li>Create one Google Sheet Apps Script (standalone) using the script in <span className="font-mono text-muted-foreground/80">GOOGLE_SHEETS_SETUP.md</span>, paste the secret below into its <span className="font-mono">SECRET</span>, and deploy as a Web App (Execute as: Me · Who has access: Anyone).</li>
            <li>Paste the Web App URL here and Save.</li>
            <li>For each client, just paste their Google Sheet link in their card below — no more Apps Script per client.</li>
          </ol>

          <div>
            <label className={labelCls}>Shared Apps Script Web App URL</label>
            <input value={urlDraft} onChange={e => setUrlDraft(e.target.value)} className={inputCls} placeholder="https://script.google.com/macros/s/…/exec" />
            {urlDraft && !urlDraft.startsWith('https://script.google.com/macros/s/') && (
              <p className="text-xs text-red-400 flex items-center gap-1.5 mt-1"><AlertTriangle className="w-3 h-3" /> Must be a Google Apps Script Web App URL</p>
            )}
            <button onClick={handleSave} disabled={saving || urlDraft === cfg.webhookUrl}
              className="mt-2 flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg gradient-bg text-white hover:opacity-90 disabled:opacity-50 transition-opacity">
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save & connect
            </button>
          </div>

          {cfg.secret && (
            <div>
              <label className={labelCls}>Shared secret <span className="text-muted-foreground/40">— paste into the Apps Script’s SECRET</span></label>
              <div className="flex items-center gap-2">
                <input readOnly value={cfg.secret} className={`${inputCls} font-mono`} />
                <CopyBtn text={cfg.secret} />
                <button onClick={handleRotate} disabled={rotating} title="Generate a new secret"
                  className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0 disabled:opacity-50">
                  {rotating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground/50 mt-1">The script rejects any request without this secret, so a leaked URL alone can’t write to your sheets.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function OfferIntakeSettingsClient({
  clients, appUrl, globalConfig, groupsByClient = {},
}: {
  clients: any[]
  appUrl: string
  globalConfig: { webhookUrl: string; secret: string; configured: boolean }
  groupsByClient?: Record<string, OfferGroupRow[]>
}) {
  const [q, setQ] = useState('')

  const globalConfigured = globalConfig.configured
  // A client is "ready" once it has an intake link AND a reachable sheet — either
  // its own legacy script, or the shared script + a pasted Sheet link.
  const isReady = (c: any) => {
    const mode = (c.offer_flow_mode as FlowMode) || 'push'
    if (mode === 'manual') return true
    if (mode === 'pull') return !!c.offer_master_sheet_url
    return !!c.offer_intake_token
      && (c.offer_sheet_webhook_url || (globalConfigured && c.offer_sheet_url))
  }

  const filtered = [...clients].filter(c =>
    c.name.toLowerCase().includes(q.toLowerCase()) ||
    (c.code || '').toLowerCase().includes(q.toLowerCase())
  ).sort((a, b) => {
    const aSetup = isReady(a) ? 1 : 0
    const bSetup = isReady(b) ? 1 : 0
    if (aSetup !== bSetup) return bSetup - aSetup
    return a.name.localeCompare(b.name)
  })

  const readyCount = clients.filter(isReady).length

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <Link href="/dashboard/apps" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-3">
        <ArrowLeft className="w-4 h-4" /> Back to Apps Directory
      </Link>

      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
          <Tag className="w-4.5 h-4.5 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-bold">Offer Intake settings</h1>
          <p className="text-xs text-muted-foreground">Clients with an Offer Intake service · manage intake links, catalog, and sheet sync.</p>
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-4 mt-5 mb-5 px-4 py-3 bg-card border border-border rounded-2xl flex-wrap">
        <div className="flex items-center gap-2">
          <Store className="w-4 h-4 text-violet-400" />
          <span className="text-sm font-semibold">{clients.length}</span>
          <span className="text-xs text-muted-foreground">clients with service</span>
        </div>
        <div className="w-px h-5 bg-border" />
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-semibold">{readyCount}</span>
          <span className="text-xs text-muted-foreground">fully set up</span>
        </div>
        <div className="w-px h-5 bg-border" />
        <div className="flex gap-2 ml-auto shrink-0">
          <Link href="/dashboard/catalog/import"
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/70 text-muted-foreground hover:text-foreground transition-colors">
            <Upload className="w-3 h-3" /> Bulk import
          </Link>
          <Link href="/dashboard/catalog"
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg gradient-bg text-white hover:opacity-90 transition-opacity">
            <Package className="w-3 h-3" /> Product catalog
          </Link>
        </div>
      </div>

      {/* One-time shared-script setup */}
      <GlobalSyncCard initial={globalConfig} />

      {/* Cirqle Studio operational glance (admin; loads on expand) */}
      <PluginHealthPanel />

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          className="w-full bg-secondary border border-border rounded-xl pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:border-violet-500/50"
          placeholder="Search clients…"
        />
      </div>

      {/* Client list — service-enabled first, then the rest */}
      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="bg-card border border-border rounded-2xl py-10 px-6 text-center">
            <Store className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm font-medium mb-1">{q ? 'No clients match your search' : 'No clients have the Offer Intake service yet'}</p>
            {!q && (
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                A client appears here once you assign them a service whose Intake Kind is{' '}
                <span className="text-foreground font-medium">Offer Intake</span> — set the kind in{' '}
                <Link href="/dashboard/settings?tab=services" className="text-violet-400 hover:text-violet-700 dark:text-violet-300 underline underline-offset-2">Settings → Services</Link>, then add that service to the client in{' '}
                <Link href="/dashboard/clients" className="text-violet-400 hover:text-violet-700 dark:text-violet-300 underline underline-offset-2">Clients</Link>.
              </p>
            )}
          </div>
        )}
        {[
          ...filtered.filter(c => isReady(c)),
          ...filtered.filter(c => !isReady(c)),
        ].map(client => (
          <ClientCard key={client.id} client={client} appUrl={appUrl} globalConfigured={globalConfigured} groups={groupsByClient[client.id] || []} />
        ))}
      </div>
    </div>
  )
}
