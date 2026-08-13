'use client'

/**
 * Social Hub landing — connected accounts grouped by client, health chips,
 * 30-day rollups and quick actions (sync, toggle publishing, disconnect,
 * refresh discovery, connect new).
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { usePermissions } from '@/contexts/permission-context'
import { PERMS } from '@/lib/permissions/keys'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ToastContainer, useToast } from '@/components/ui/toast'
import { formatDistanceToNow } from 'date-fns'
import {
  RefreshCw, Loader2, BarChart3, Users, AlertTriangle,
  CalendarClock, XCircle, Share2, Plus, Unplug,
} from 'lucide-react'
import { PlatformIcon } from '@/components/social-hub/platform-icon'
import {
  syncAccountNow, toggleAccountFlag, disconnectSocialAccount,
  refreshSocialAccountsForConnection, assignAccountClient,
} from './actions'

export interface SocialAccountRow {
  id: string
  client_id: string
  connection_id: string | null
  platform: 'facebook_page' | 'instagram'
  external_id: string
  name: string
  username: string | null
  profile_picture_url: string | null
  followers_count: number | null
  status: 'connected' | 'disconnected' | 'needs_reauth' | 'error'
  publishing_enabled: boolean
  insights_enabled: boolean
  last_synced_at: string | null
  last_error: string | null
  client_name: string
  reach30: number
  views30: number
  interactions30: number
  scheduled_count: number
  failed_count: number
}

const OAUTH_ERRORS: Record<string, string> = {
  auth_failed: 'Meta authentication failed — please try again.',
  auth_denied: 'You cancelled the Meta connection.',
  not_configured: 'Meta OAuth is not configured on this server. Contact your admin.',
  server_error: 'A server error occurred. Check logs and try again.',
}

type Health = 'green' | 'amber' | 'red'

function accountHealth(a: SocialAccountRow): Health {
  if (a.status === 'needs_reauth' || a.status === 'error' || a.status === 'disconnected') return 'red'
  const syncedRecently = a.last_synced_at
    && Date.now() - new Date(a.last_synced_at).getTime() < 48 * 3600_000
  if (!syncedRecently || a.last_error) return 'amber'
  return 'green'
}

const HEALTH_DOT: Record<Health, string> = {
  green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500',
}
const HEALTH_LABEL: Record<Health, string> = {
  green: 'Healthy', amber: 'Stale', red: 'Attention',
}

const fmtNum = (n: number | null | undefined) => {
  const v = Number(n ?? 0)
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 10_000) return `${(v / 1_000).toFixed(1)}K`
  return v.toLocaleString('en-IN')
}

export default function SocialClient({
  accounts: initialAccounts, clients, canConnect, canViewInsights,
  scheduledThisWeek, failedTotal, oauthSuccess, oauthError,
}: {
  accounts: SocialAccountRow[]
  clients: { id: string; name: string }[]
  canConnect: boolean
  canViewInsights: boolean
  scheduledThisWeek: number
  failedTotal: number
  oauthSuccess?: string
  oauthError?: string
}) {
  const { can } = usePermissions()
  const toast = useToast()
  const [accounts, setAccounts] = useState(initialAccounts)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<SocialAccountRow | null>(null)

  // Flash message from the OAuth redirect, then clean the URL.
  useEffect(() => {
    if (oauthSuccess === 'meta_connected') {
      toast.success('Meta connected', 'Pages and Instagram accounts were discovered.')
    } else if (oauthError) {
      toast.error('Connection failed', OAUTH_ERRORS[oauthError] || 'Unknown error.')
    }
    if (oauthSuccess || oauthError) {
      const url = new URL(window.location.href)
      url.searchParams.delete('success')
      url.searchParams.delete('error')
      window.history.replaceState({}, '', url.toString())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const byClient = useMemo(() => {
    const m = new Map<string, { name: string; accounts: SocialAccountRow[] }>()
    for (const a of accounts) {
      const g = m.get(a.client_id) ?? { name: a.client_name, accounts: [] }
      g.accounts.push(a)
      m.set(a.client_id, g)
    }
    return [...m.entries()].sort((x, y) => x[1].name.localeCompare(y[1].name))
  }, [accounts])

  const summary = useMemo(() => ({
    total: accounts.length,
    followers: accounts.reduce((s, a) => s + Number(a.followers_count ?? 0), 0),
    attention: accounts.filter(a => accountHealth(a) !== 'green').length,
  }), [accounts])

  const [assigningId, setAssigningId] = useState<string | null>(null)
  const handleAssign = async (a: SocialAccountRow, clientId: string) => {
    if (clientId === a.client_id) return
    setAssigningId(a.id)
    try {
      const res = await assignAccountClient(a.id, clientId)
      if (res.ok) {
        const clientName = clients.find(c => c.id === clientId)?.name ?? '—'
        // Move the card to its new client group immediately.
        setAccounts(prev => prev.map(x => x.id === a.id
          ? { ...x, client_id: clientId, client_name: clientName }
          : x))
        toast.success('Account assigned', `${a.name} → ${clientName}`)
      } else {
        toast.error('Could not assign', res.error)
      }
    } finally {
      setAssigningId(null)
    }
  }

  const handleSync = async (a: SocialAccountRow) => {
    setSyncing(a.id)
    try {
      const res = await syncAccountNow(a.id)
      if (res.ok) {
        toast.success('Sync complete', `${res.data?.dailyRows ?? 0} daily rows, ${res.data?.mediaItems ?? 0} media items.`)
        setAccounts(prev => prev.map(x => x.id === a.id
          ? { ...x, last_synced_at: new Date().toISOString(), last_error: null }
          : x))
      } else {
        toast.error('Sync failed', res.error)
      }
    } finally {
      setSyncing(null)
    }
  }

  const handleToggle = async (a: SocialAccountRow, field: 'publishing_enabled' | 'insights_enabled') => {
    const next = !a[field]
    setToggling(`${a.id}:${field}`)
    // Optimistic
    setAccounts(prev => prev.map(x => x.id === a.id ? { ...x, [field]: next } : x))
    try {
      const res = await toggleAccountFlag(a.id, field, next)
      if (!res.ok) {
        setAccounts(prev => prev.map(x => x.id === a.id ? { ...x, [field]: !next } : x))
        toast.error('Update failed', res.error)
      }
    } finally {
      setToggling(null)
    }
  }

  const handleDisconnect = async () => {
    const a = disconnectTarget
    if (!a) return
    setDisconnectTarget(null)
    const res = await disconnectSocialAccount(a.id)
    if (res.ok) {
      setAccounts(prev => prev.map(x => x.id === a.id ? { ...x, status: 'disconnected' } : x))
      toast.success('Account disconnected', `${a.name} will no longer sync or publish.`)
    } else {
      toast.error('Disconnect failed', res.error)
    }
  }

  const handleRefreshDiscovery = async (connectionId: string) => {
    setRefreshing(connectionId)
    try {
      const res = await refreshSocialAccountsForConnection(connectionId)
      if (res.ok) {
        toast.success(
          'Accounts refreshed',
          `${res.data?.pages ?? 0} Pages, ${res.data?.instagramAccounts ?? 0} Instagram accounts.`,
        )
      } else {
        toast.error('Refresh failed', res.error)
      }
    } finally {
      setRefreshing(null)
    }
  }

  const showConnect = canConnect && can(PERMS.SOCIAL_CONNECT)

  return (
    <>
      <Header
        title="Social Hub"
        subtitle="Connected Facebook Pages & Instagram accounts"
        actions={showConnect ? (
          /* Connecting is owned by Connections — one place holds the tokens,
             refresh and deletion. This is a signpost, not a second flow. */
          <Link href="/dashboard/connections">
            <Button size="sm">
              <Plus className="w-4 h-4 mr-1.5" /> Connect Meta
            </Button>
          </Link>
        ) : undefined}
      />

      <div className="p-4 lg:p-6 space-y-6">
        {/* ── Summary strip ── */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          {[
            { label: 'Accounts', value: String(summary.total), icon: Share2 },
            { label: 'Total followers', value: fmtNum(summary.followers), icon: Users },
            { label: 'Need attention', value: String(summary.attention), icon: AlertTriangle, warn: summary.attention > 0 },
            { label: 'Scheduled this week', value: String(scheduledThisWeek), icon: CalendarClock },
            { label: 'Failed posts', value: String(failedTotal), icon: XCircle, warn: failedTotal > 0 },
          ].map(k => (
            <div key={k.label} className="bg-card border border-border rounded-xl px-4 py-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <k.icon className="w-3.5 h-3.5" /> {k.label}
              </div>
              <p className={`text-xl font-semibold mt-1 ${k.warn ? 'text-amber-500' : ''}`}>{k.value}</p>
            </div>
          ))}
        </div>

        {/* ── Quick links ── */}
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href="/dashboard/social/calendar"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 hover:bg-secondary/60 transition-colors">
            <CalendarClock className="w-4 h-4 text-muted-foreground" /> Publishing calendar
          </Link>
        </div>

        {/* ── Accounts grouped by client ── */}
        {accounts.length === 0 ? (
          <div className="bg-card border border-border rounded-2xl">
            <EmptyState
              icon={Share2}
              title="No social accounts connected"
              body={showConnect
                ? 'Connect a client\'s Meta assets to pull Facebook Pages and Instagram accounts into the hub.'
                : 'No Meta assets have been connected yet. Ask someone with the Connect Social Accounts permission to link a client.'}
              action={showConnect
                ? { label: 'Connect Meta', onClick: () => { window.location.href = '/dashboard/connections' } }
                : undefined}
            />
          </div>
        ) : (
          byClient.map(([clientId, group]) => (
            <div key={clientId} className="space-y-3">
              <div className="flex items-center justify-between">
                <Link href={`/dashboard/clients/${clientId}`}
                  className="text-sm font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors">
                  {group.name}
                </Link>
                {showConnect && group.accounts[0]?.connection_id && (
                  <button
                    onClick={() => handleRefreshDiscovery(group.accounts[0].connection_id!)}
                    disabled={refreshing === group.accounts[0].connection_id}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                  >
                    {refreshing === group.accounts[0].connection_id
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <RefreshCw className="w-3 h-3" />}
                    Refresh accounts
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {group.accounts.map(a => {
                  const health = accountHealth(a)
                  return (
                    <div key={a.id} className="rounded-xl border border-border bg-card overflow-hidden flex flex-col">
                      <div className="p-4 flex-1">
                        <div className="flex items-start gap-3">
                          <div className="relative shrink-0">
                            {a.profile_picture_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={a.profile_picture_url} alt="" className="h-10 w-10 rounded-full object-cover border border-border" />
                            ) : (
                              <div className="h-10 w-10 rounded-full bg-secondary flex items-center justify-center">
                                <PlatformIcon platform={a.platform} className={a.platform === 'instagram' ? 'w-5 h-5 text-pink-500' : 'w-5 h-5 text-blue-500'} />
                              </div>
                            )}
                            <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-card p-0.5">
                              <PlatformIcon platform={a.platform} className={a.platform === 'instagram' ? 'w-3.5 h-3.5 text-pink-500' : 'w-3.5 h-3.5 text-blue-500'} />
                            </span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold truncate">{a.name}</p>
                            <p className="text-xs text-muted-foreground truncate">
                              {a.username ? `@${a.username}` : a.platform === 'facebook_page' ? 'Facebook Page' : 'Instagram'}
                            </p>
                          </div>
                          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground shrink-0">
                            <span className={`h-2 w-2 rounded-full ${HEALTH_DOT[health]}`} />
                            {HEALTH_LABEL[health]}
                          </span>
                        </div>

                        <div className="grid grid-cols-3 gap-2 mt-4 text-center">
                          <div>
                            <p className="text-sm font-semibold">{fmtNum(a.followers_count)}</p>
                            <p className="text-[10px] text-muted-foreground">Followers</p>
                          </div>
                          <div>
                            <p className="text-sm font-semibold">{fmtNum(a.reach30)}</p>
                            <p className="text-[10px] text-muted-foreground">Reach 30d</p>
                          </div>
                          <div>
                            <p className="text-sm font-semibold">{fmtNum(a.views30)}</p>
                            <p className="text-[10px] text-muted-foreground">Views 30d</p>
                          </div>
                        </div>

                        {/*
                          One agency login sees every client's Pages, so
                          discovery can only guess the owner. This is where the
                          guess gets corrected — and re-discovery preserves it.
                        */}
                        {canConnect && (
                          <div className="mt-3 flex items-center gap-2">
                            <span className="text-[10px] text-muted-foreground shrink-0">Client</span>
                            <select
                              value={a.client_id}
                              disabled={assigningId === a.id}
                              onChange={e => handleAssign(a, e.target.value)}
                              className="flex-1 min-w-0 rounded-md border border-border bg-background px-2 py-1 text-[11px] disabled:opacity-50"
                            >
                              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                          </div>
                        )}

                        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <span>
                            {a.last_synced_at
                              ? `Synced ${formatDistanceToNow(new Date(a.last_synced_at))} ago`
                              : 'Never synced'}
                          </span>
                          {a.scheduled_count > 0 && <Badge variant="purple">{a.scheduled_count} scheduled</Badge>}
                          {a.failed_count > 0 && <Badge variant="danger">{a.failed_count} failed</Badge>}
                          {!a.publishing_enabled && <Badge>publishing off</Badge>}
                        </div>

                        {a.last_error && (
                          <div className="mt-3 flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-lg px-2.5 py-1.5">
                            <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                            <span className="line-clamp-2">{a.last_error}</span>
                          </div>
                        )}
                      </div>

                      <div className="border-t border-border bg-muted/40 px-3 py-2 flex items-center gap-1.5">
                        {canViewInsights && can(PERMS.SOCIAL_VIEW_INSIGHTS) && (
                          <>
                            <Link href={`/dashboard/social/accounts/${a.id}`}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-secondary transition-colors">
                              <BarChart3 className="w-3.5 h-3.5" /> Dashboard
                            </Link>
                            <button
                              onClick={() => handleSync(a)}
                              disabled={syncing === a.id || a.status === 'disconnected'}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-secondary transition-colors disabled:opacity-50"
                            >
                              {syncing === a.id
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                : <RefreshCw className="w-3.5 h-3.5" />}
                              Sync
                            </button>
                          </>
                        )}
                        <div className="ml-auto flex items-center gap-1.5">
                          {showConnect && (
                            <>
                              <button
                                onClick={() => handleToggle(a, 'publishing_enabled')}
                                disabled={toggling === `${a.id}:publishing_enabled`}
                                title={a.publishing_enabled ? 'Disable publishing' : 'Enable publishing'}
                                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                                  a.publishing_enabled
                                    ? 'text-emerald-500 hover:bg-emerald-500/10'
                                    : 'text-muted-foreground hover:bg-secondary'
                                }`}
                              >
                                <span className={`h-1.5 w-1.5 rounded-full ${a.publishing_enabled ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} />
                                Publish
                              </button>
                              {a.status !== 'disconnected' && (
                                <button
                                  onClick={() => setDisconnectTarget(a)}
                                  title="Disconnect account"
                                  className="inline-flex items-center rounded-md p-1 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
                                >
                                  <Unplug className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {disconnectTarget && (
        <ConfirmDialog
          title={`Disconnect ${disconnectTarget.name}?`}
          body="The account stops syncing and publishing. Historical insights are kept. You can reconnect it later by refreshing accounts or re-running the Meta connect flow."
          confirmLabel="Disconnect"
          danger
          onConfirm={handleDisconnect}
          onCancel={() => setDisconnectTarget(null)}
        />
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  )
}
