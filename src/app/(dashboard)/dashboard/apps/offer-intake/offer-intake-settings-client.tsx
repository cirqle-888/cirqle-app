'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Link2, Tag, Copy, Check, RefreshCw, Loader2,
  AlertTriangle, CheckCircle2, ExternalLink, Webhook,
  ChevronDown, ChevronUp, Search, ShieldAlert, FlaskConical,
  Package, Store, Upload,
} from 'lucide-react'
import {
  saveWebhookUrl, resetOfferToken, testSheetSync, ensureOfferToken,
  toggleOfferFlyerService,
} from './actions'

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

// ── Toggle switch ──────────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex w-9 h-5 rounded-full transition-colors shrink-0 ${
        checked ? 'gradient-bg' : 'bg-secondary border border-border'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  )
}

// ── Client card ───────────────────────────────────────────────────────────────

function ClientCard({
  client: initialClient, appUrl,
}: {
  client: {
    id: string; name: string; code?: string
    offer_intake_token: string | null
    offer_sheet_webhook_url: string | null
    has_offer_flyer_service: boolean
  }
  appUrl: string
}) {
  const [client, setClient] = useState(initialClient)
  const [expanded, setExpanded] = useState(false)
  const [webhookDraft, setWebhookDraft] = useState(client.offer_sheet_webhook_url || '')
  const [token, setToken] = useState(client.offer_intake_token || '')
  const [webhookSaving, setWebhookSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [togglingService, setTogglingService] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const intakeUrl = token ? `${appUrl}/intake/offer/${token}` : null
  const hasWebhook = !!client.offer_sheet_webhook_url
  const hasToken = !!token
  const serviceEnabled = client.has_offer_flyer_service
  const onboardingDone = hasWebhook && hasToken

  function flash(type: 'ok' | 'err', text: string) {
    setMsg({ type, text })
    setTimeout(() => setMsg(null), 4000)
  }

  async function handleToggleService(enabled: boolean) {
    setTogglingService(true)
    const res = await toggleOfferFlyerService(client.id, enabled)
    setTogglingService(false)
    if (res.ok) setClient(c => ({ ...c, has_offer_flyer_service: enabled }))
    else flash('err', res.error || 'Could not update service')
  }

  async function handleSaveWebhook() {
    setWebhookSaving(true)
    const res = await saveWebhookUrl(client.id, webhookDraft)
    setWebhookSaving(false)
    if (res.ok) flash('ok', 'Webhook URL saved ✓')
    else flash('err', res.error || 'Could not save')
  }

  async function handleResetToken() {
    if (!confirm('Reset token? The old intake link will stop working immediately.')) return
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
    if (res.ok) flash('ok', res.data?.message || 'Sync successful ✓')
    else flash('err', res.error || 'Sync failed')
  }

  return (
    <div className={`bg-card border rounded-2xl overflow-hidden transition-colors ${serviceEnabled ? 'border-violet-500/20' : 'border-border'}`}>
      {/* Header row */}
      <div
        role="button" tabIndex={0}
        onClick={() => setExpanded(e => !e)}
        onKeyDown={e => e.key === 'Enter' && setExpanded(e => !e)}
        className="px-5 py-4 flex items-center gap-3 cursor-pointer hover:bg-secondary/30 transition-colors"
      >
        <Store className={`w-4 h-4 shrink-0 ${serviceEnabled ? 'text-violet-400' : 'text-muted-foreground/30'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold truncate">{client.name}</p>
            {serviceEnabled && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-400 border border-violet-500/20 font-medium shrink-0">
                Offer Flyer
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {!serviceEnabled
              ? 'Service not enabled'
              : onboardingDone
              ? 'Fully set up'
              : [!hasToken && 'No intake link', !hasWebhook && 'No sheet webhook'].filter(Boolean).join(' · ')}
          </p>
        </div>

        {/* Status dots (only if service on) */}
        {serviceEnabled && (
          <div className="flex items-center gap-1 shrink-0">
            <StatusDot ok={hasToken} />
            <StatusDot ok={hasWebhook} />
          </div>
        )}

        {!serviceEnabled
          ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-secondary text-muted-foreground/50 border border-border font-medium shrink-0">Off</span>
          : onboardingDone
          ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 font-medium shrink-0">Ready</span>
          : <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/25 font-medium shrink-0">Setup needed</span>
        }
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </div>

      {expanded && (
        <div className="border-t border-border px-5 py-5 space-y-5">

          {/* Flash message */}
          {msg && (
            <div className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm ${
              msg.type === 'ok'
                ? 'bg-emerald-500/10 border border-emerald-500/25 text-emerald-300'
                : 'bg-red-500/10 border border-red-500/25 text-red-400'
            }`}>
              {msg.type === 'ok' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
              {msg.text}
            </div>
          )}

          {/* ── Service toggle ── */}
          <div className="flex items-center justify-between p-4 bg-secondary/40 rounded-xl border border-border">
            <div>
              <p className="text-sm font-semibold flex items-center gap-2">
                <Store className="w-4 h-4 text-violet-400" /> Offer Flyer Service
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Enable to give this client access to the campaign intake + product catalog
              </p>
            </div>
            {togglingService
              ? <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              : <Toggle checked={serviceEnabled} onChange={handleToggleService} />
            }
          </div>

          {/* Everything below is gated on service being enabled */}
          {!serviceEnabled ? (
            <p className="text-xs text-muted-foreground/50 text-center py-2">
              Enable the service above to configure intake settings.
            </p>
          ) : (
            <>
              {/* ── Product catalog shortcut ── */}
              <div className="flex items-center gap-3 p-4 bg-violet-500/5 border border-violet-500/15 rounded-xl">
                <Package className="w-5 h-5 text-violet-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">Product Catalog</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Manage global products · bulk import from Excel · upload images</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Link
                    href="/dashboard/catalog/import"
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-secondary border border-border hover:bg-secondary/70 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Upload className="w-3 h-3" /> Import
                  </Link>
                  <Link
                    href="/dashboard/catalog"
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg gradient-bg text-white hover:opacity-90 transition-opacity"
                  >
                    <Package className="w-3 h-3" /> Open catalog
                  </Link>
                </div>
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
                        Reset token (old link dies)
                      </button>
                      <p className="text-[11px] text-muted-foreground/50">Use only if the link is compromised</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 bg-amber-500/5 border border-amber-500/20 rounded-xl px-4 py-3">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                    <p className="text-sm text-amber-300 flex-1">No intake link yet</p>
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

              {/* ── Section 2: Webhook URL ── */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mb-3 flex items-center gap-1.5">
                  <Webhook className="w-3.5 h-3.5" /> Google Sheet Webhook
                </p>
                <div className="space-y-2">
                  <div>
                    <label className={labelCls}>Apps Script Web App URL</label>
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
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSaveWebhook}
                      disabled={webhookSaving || webhookDraft === (client.offer_sheet_webhook_url || '')}
                      className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg gradient-bg text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
                    >
                      {webhookSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                      Save URL
                    </button>
                    {!hasWebhook && (
                      <a
                        href="https://script.google.com"
                        target="_blank" rel="noopener noreferrer"
                        className="text-xs text-violet-400 hover:underline flex items-center gap-1"
                      >
                        Open Apps Script <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </div>
              </div>

              {/* ── Section 3: Test sync ── */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mb-3 flex items-center gap-1.5">
                  <FlaskConical className="w-3.5 h-3.5" /> Test Sheet Sync
                </p>
                {hasWebhook ? (
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
                  <p className="text-xs text-muted-foreground/50">Set the webhook URL first to enable test sync.</p>
                )}
              </div>

              {/* ── Onboarding checklist ── */}
              <div className="bg-secondary/30 rounded-xl px-4 py-3 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground/70 mb-2">Onboarding checklist</p>
                {[
                  { done: true, label: 'Offer Flyer service enabled' },
                  { done: hasToken, label: 'Intake link generated' },
                  { done: hasWebhook, label: 'Apps Script deployed & URL saved' },
                  { done: hasToken, label: 'Link sent to client via WhatsApp' },
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    {item.done
                      ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      : <div className="w-3.5 h-3.5 rounded-full border border-muted-foreground/30 shrink-0" />}
                    <span className={item.done ? 'text-foreground/70' : 'text-muted-foreground/50'}>{item.label}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function OfferIntakeSettingsClient({
  clients, appUrl,
}: {
  clients: any[]
  appUrl: string
}) {
  const [q, setQ] = useState('')

  const serviceClients = clients.filter(c => c.has_offer_flyer_service)
  const filtered = clients.filter(c =>
    c.name.toLowerCase().includes(q.toLowerCase()) ||
    (c.code || '').toLowerCase().includes(q.toLowerCase())
  )

  const readyCount = serviceClients.filter(c => c.offer_intake_token && c.offer_sheet_webhook_url).length

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
      <Link href="/dashboard/apps" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to Apps Directory
      </Link>

      <div className="flex items-center gap-3 mb-1">
        <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
          <Tag className="w-4.5 h-4.5 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-bold">Offer Intake Configuration</h1>
          <p className="text-xs text-muted-foreground">Enable per client · manage intake links, catalog, and sheet sync.</p>
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-4 mt-5 mb-5 px-4 py-3 bg-card border border-border rounded-2xl flex-wrap">
        <div className="flex items-center gap-2">
          <Store className="w-4 h-4 text-violet-400" />
          <span className="text-sm font-semibold">{serviceClients.length}</span>
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
          <div className="bg-card border border-border rounded-2xl py-10 text-center text-sm text-muted-foreground">
            No clients found.
          </div>
        )}
        {[
          ...filtered.filter(c => c.has_offer_flyer_service),
          ...filtered.filter(c => !c.has_offer_flyer_service),
        ].map(client => (
          <ClientCard key={client.id} client={client} appUrl={appUrl} />
        ))}
      </div>
    </div>
  )
}
