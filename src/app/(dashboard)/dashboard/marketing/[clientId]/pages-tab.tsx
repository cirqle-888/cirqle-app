'use client'

/**
 * Pages tab — the client's Facebook Pages, Instagram accounts, ad accounts and
 * lead forms, and everything you can do to them without leaving the client:
 * sync now, switch publishing / insights on or off, open on Meta, and move an
 * asset to its rightful owner. Writes go through the existing actions (Social
 * and Asset Assignment), so their permission checks, logging and confirmation
 * rules apply unchanged.
 */

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  BarChart3, ClipboardList, ExternalLink, Grid3x3, Loader2, Lock, Megaphone, PlugZap, RefreshCw, Share2,
} from 'lucide-react'
import AppSelect from '@/components/ui/app-select'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { accountHealth, adsManagerUrl, socialProfileUrl } from '@/lib/marketing/hub'
import type { AssetKind } from '@/lib/assets/registry'
import type { AssetOwnerType } from '@/lib/assets/ownership'
import type { ClientMarketing, HubSocialAccount } from '@/lib/marketing/load'
import { assignAsset } from '../../assets/actions'
import { syncAccountNow, toggleAccountFlag } from '../../social/actions'
import type { MarketingAccess } from '../_access'
import { AccountAvatar, EmptyHint, HealthDot, compact, type HubClient } from '../_ui'

const CIRQLE = 'cirqle'
const UNASSIGNED = 'unassigned'

interface PendingMove { kind: AssetKind; id: string; name: string; ownerType: AssetOwnerType; clientId: string | null; message: string }

export default function PagesTab({ client, clients, hub, access }: {
  client: HubClient
  clients: HubClient[]
  hub: ClientMarketing
  access: MarketingAccess
}) {
  const router = useRouter()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingMove | null>(null)

  async function move(kind: AssetKind, id: string, name: string, raw: string, confirmed = false) {
    const ownerType: AssetOwnerType = raw === CIRQLE ? 'cirqle' : raw === UNASSIGNED ? 'unassigned' : 'client'
    const clientId = ownerType === 'client' ? raw : null
    if (ownerType === 'client' && clientId === client.id) return
    setBusy(id)
    try {
      const res = await assignAsset({ kind, assetId: id, ownerType, clientId, confirmed })
      if (res.needsConfirmation) {
        setPending({ kind, id, name, ownerType, clientId, message: res.confirmationMessage ?? 'Confirm this move?' })
        return
      }
      if (!res.ok) { toastError('Could not move', res.error); return }
      const to = ownerType === 'cirqle' ? 'Cirqle’s own accounts' : ownerType === 'unassigned' ? 'Unassigned'
        : clients.find(c => c.id === clientId)?.name ?? 'another client'
      success('Moved', `${name} → ${to}`)
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  async function sync(a: HubSocialAccount) {
    setBusy(`sync:${a.id}`)
    try {
      const res = await syncAccountNow(a.id)
      if (res.ok) success('Synced', `${a.name}: ${res.data?.dailyRows ?? 0} days, ${res.data?.mediaItems ?? 0} posts updated`)
      else toastError('Sync failed', res.error)
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  async function toggle(a: HubSocialAccount, field: 'publishing_enabled' | 'insights_enabled', value: boolean) {
    setBusy(`${field}:${a.id}`)
    try {
      const res = await toggleAccountFlag(a.id, field, value)
      if (!res.ok) toastError('Could not update', res.error)
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const ownerSelect = (kind: AssetKind, id: string, name: string, wide = false) => access.assets ? (
    <AppSelect
      value={client.id}
      disabled={busy === id}
      onChange={e => void move(kind, id, name, e.target.value)}
      wrapperClassName={wide ? 'min-w-0 flex-1' : 'w-full sm:w-52'}
      aria-label={`Owner of ${name}`}
    >
      <option value={client.id}>{client.name}</option>
      <option value={CIRQLE}>Cirqle (our own)</option>
      <option value={UNASSIGNED}>— Unassigned —</option>
      <optgroup label="Move to client">
        {clients.filter(c => c.id !== client.id && c.isActive).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </optgroup>
    </AppSelect>
  ) : null

  const nothing = hub.accounts.length + hub.adAccounts.length + hub.leadForms.length === 0

  return (
    <div className="space-y-6">
      {/* Social accounts */}
      {access.social || access.assets ? (
        <section aria-labelledby="pg-social" className="space-y-3">
          <h2 id="pg-social" className="flex items-center gap-2 text-sm font-semibold">
            <Share2 className="h-4 w-4 text-muted-foreground" /> Facebook Pages & Instagram
            <span className="text-xs font-normal text-muted-foreground">{hub.accounts.length}</span>
          </h2>
          {hub.accounts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card/50 p-4">
              <EmptyHint text="No Page or Instagram account belongs to this client yet." />
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {hub.accounts.map(a => {
                const h = accountHealth(a)
                const profile = socialProfileUrl(a.platform, a.external_id, a.username)
                return (
                  <article key={a.id} className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4">
                    <div className="flex items-start gap-3">
                      <AccountAvatar url={a.profile_picture_url} platform={a.platform} size={48} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate font-semibold">{a.name}</p>
                          {a.assigned_at && (
                            <span title="Assigned by hand — sync will not change its owner"><Lock className="h-3 w-3 text-muted-foreground/60" /></span>
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {a.username ? `@${a.username}` : a.platform === 'instagram' ? 'Instagram' : 'Facebook Page'}
                          {a.external_id && <> · {a.external_id}</>}
                        </p>
                        <p className="mt-1 inline-flex items-center gap-1.5 text-xs">
                          <HealthDot state={h.state} />
                          <span className={h.state === 'red' ? 'text-red-500' : h.state === 'amber' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
                            {h.state === 'green' ? `Synced ${relTime(a.last_synced_at)}` : h.reason}
                          </span>
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-4 gap-2 text-center">
                      <Mini label="Followers" value={compact(a.followers_count)} />
                      <Mini label="Reach 30d" value={compact(a.reach30)} />
                      <Mini label="Engaged" value={compact(a.interactions30)} />
                      <Mini label="Posts 30d" value={String(a.posts30)} />
                    </div>

                    {access.socialConnect && (
                      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
                        <Switch label="Publishing" checked={a.publishing_enabled !== false} busy={busy === `publishing_enabled:${a.id}`}
                          onChange={v => void toggle(a, 'publishing_enabled', v)} />
                        <Switch label="Insights" checked={a.insights_enabled !== false} busy={busy === `insights_enabled:${a.id}`}
                          onChange={v => void toggle(a, 'insights_enabled', v)} />
                        {(a.scheduled > 0 || a.failed > 0) && (
                          <span className="text-muted-foreground">
                            {a.scheduled > 0 && `${a.scheduled} scheduled`}{a.scheduled > 0 && a.failed > 0 && ' · '}
                            {a.failed > 0 && <span className="text-red-500">{a.failed} failed</span>}
                          </span>
                        )}
                      </div>
                    )}

                    <div className="space-y-3 border-t border-border/60 pt-3">
                      <div className="flex flex-wrap gap-1.5">
                        {access.socialInsights && (
                          <>
                            <Link href={`/dashboard/social/accounts/${a.id}`} className={BTN}><BarChart3 className="h-3.5 w-3.5" /> Insights</Link>
                            <button onClick={() => void sync(a)} disabled={busy === `sync:${a.id}`} className={BTN}>
                              {busy === `sync:${a.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Sync
                            </button>
                          </>
                        )}
                        {a.platform === 'instagram' && access.social && (
                          <Link href={`/dashboard/social/feed?account=${a.id}`} className={BTN}><Grid3x3 className="h-3.5 w-3.5" /> Feed</Link>
                        )}
                        {profile && (
                          <a href={profile} target="_blank" rel="noopener noreferrer" className={BTN}>
                            <ExternalLink className="h-3.5 w-3.5" /> {a.platform === 'instagram' ? 'Instagram' : 'Facebook'}
                          </a>
                        )}
                      </div>
                      {access.assets && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="shrink-0">Belongs to</span>
                          {ownerSelect(a.platform, a.id, a.name, true)}
                        </div>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>
      ) : null}

      {/* Ad accounts */}
      {(access.ads || access.assets) && (
        <section aria-labelledby="pg-ads" className="space-y-3">
          <h2 id="pg-ads" className="flex items-center gap-2 text-sm font-semibold">
            <Megaphone className="h-4 w-4 text-muted-foreground" /> Ad accounts
            <span className="text-xs font-normal text-muted-foreground">{hub.adAccounts.length}</span>
          </h2>
          {hub.adAccounts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card/50 p-4">
              <EmptyHint text="No ad account belongs to this client yet." />
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {hub.adAccounts.map(a => (
                <div key={a.id} className="flex flex-col gap-2 border-t border-border/60 px-4 py-3 first:border-t-0 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-pink-500/10 text-pink-500"><Megaphone className="h-4 w-4" /></span>
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                        {a.name && a.name !== a.account_id ? a.name : `Ad account ${a.account_id}`}
                        {a.assigned_at && <Lock className="h-3 w-3 text-muted-foreground/60" />}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        act_{a.account_id}{a.currency && ` · ${a.currency}`} · {a.campaigns} campaign{a.campaigns === 1 ? '' : 's'} in Cirqle
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <a href={adsManagerUrl(a.account_id)} target="_blank" rel="noopener noreferrer" className={BTN}>
                      <ExternalLink className="h-3.5 w-3.5" /> Ads Manager
                    </a>
                    {ownerSelect('ad_account', a.id, a.name && a.name !== a.account_id ? a.name : `act_${a.account_id}`)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Lead forms */}
      {hub.leadForms.length > 0 && (
        <section aria-labelledby="pg-forms" className="space-y-3">
          <h2 id="pg-forms" className="flex items-center gap-2 text-sm font-semibold">
            <ClipboardList className="h-4 w-4 text-muted-foreground" /> Lead forms
            <span className="text-xs font-normal text-muted-foreground">{hub.leadForms.length}</span>
          </h2>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {hub.leadForms.map(f => (
              <div key={f.id} className="flex flex-col gap-2 border-t border-border/60 px-4 py-3 first:border-t-0 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{f.name}</p>
                  {f.external_id && <p className="text-xs text-muted-foreground">{f.external_id}</p>}
                </div>
                {ownerSelect('lead_form', f.id, f.name)}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Getting more in */}
      {(access.connections || access.assets) && (
        <div className={`flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center ${nothing ? 'border-primary/30 bg-primary/[0.04]' : 'border-border bg-card'}`}>
          <PlugZap className="h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Missing a Page, Instagram or ad account?</p>
            <p className="text-xs text-muted-foreground">
              Connect Meta once in Connections (tick the Page when Facebook asks), then give it to this client from Asset Assignment.
            </p>
          </div>
          <div className="flex gap-2">
            {access.connections && <Link href="/dashboard/connections" className={BTN}>Connections</Link>}
            {access.assets && <Link href="/dashboard/assets" className={BTN}>Asset Assignment</Link>}
          </div>
        </div>
      )}

      {pending && (
        <ConfirmDialog
          title="Confirm this move"
          body={pending.message}
          confirmLabel="Move it"
          danger
          onConfirm={() => {
            const p = pending
            setPending(null)
            void move(p.kind, p.id, p.name, p.ownerType === 'client' ? (p.clientId ?? '') : p.ownerType, true)
          }}
          onCancel={() => setPending(null)}
        />
      )}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

const BTN = 'inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:opacity-50'

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-secondary/50 px-1 py-2">
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  )
}

function Switch({ label, checked, busy, onChange }: { label: string; checked: boolean; busy: boolean; onChange: (v: boolean) => void }) {
  return (
    <span className="inline-flex items-center gap-2 text-muted-foreground">
      <button
        type="button" role="switch" aria-checked={checked} aria-label={label} disabled={busy}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-emerald-500' : 'bg-secondary border border-border'}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
      {label}
    </span>
  )
}

function relTime(iso: string | null): string {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}
