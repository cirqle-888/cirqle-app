'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { disconnectProvider, refreshAdAccounts, fetchActiveClients } from './actions'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Loader2, Plus, RefreshCw, Trash2, FolderPlus,
  CheckCircle, XCircle, AlertTriangle, Link2, Zap, ListChecks,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { CreateProjectWizard } from './CreateProjectWizard'
import { SyncStatusPanel } from './SyncStatusPanel'

interface ProviderConnection {
  id: string
  provider: string
  client_id: string
  status: string
  last_auth_at: string
  token_expires_at: string
  client: { name: string } | null
  ad_accounts?: any[]
}

const ERROR_MESSAGES: Record<string, string> = {
  auth_failed:    'Meta authentication failed — please try again.',
  auth_denied:    'You cancelled the Meta connection.',
  not_configured: 'Meta OAuth is not configured on this server. Contact your admin.',
  server_error:   'A server error occurred. Check logs and try again.',
}

export function IntegrationsClient({
  initialConnections,
  oauthSuccess,
  oauthError,
}: {
  initialConnections: any[]
  oauthSuccess?: string
  oauthError?: string
}) {
  const [connections, setConnections] = useState<ProviderConnection[]>(initialConnections)
  const [isRefreshing, setIsRefreshing] = useState<string | null>(null)
  const [isDisconnecting, setIsDisconnecting] = useState<string | null>(null)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(() => {
    if (oauthSuccess === 'meta_connected') {
      return { type: 'success', message: 'Meta Ads connected! Ad accounts have been discovered.' }
    }
    if (oauthError) {
      return { type: 'error', message: ERROR_MESSAGES[oauthError] || 'An unknown error occurred.' }
    }
    return null
  })

  useEffect(() => {
    if (oauthSuccess || oauthError) {
      const url = new URL(window.location.href)
      url.searchParams.delete('success')
      url.searchParams.delete('error')
      window.history.replaceState({}, '', url.toString())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [wizardOpen, setWizardOpen] = useState(false)
  const [selectedAccount, setSelectedAccount] = useState<any | null>(null)
  const [selectedClientId, setSelectedClientId] = useState<string>('')

  const [isClientModalOpen, setIsClientModalOpen] = useState(false)
  const [clients, setClients] = useState<{ id: string; name: string }[]>([])
  const [selectedClientForAuth, setSelectedClientForAuth] = useState<string>('')
  const [providerToConnect, setProviderToConnect] = useState<'meta' | 'google' | null>(null)
  // In-app confirmation. NOT window.confirm: the desktop shell returns false
  // from it immediately without ever drawing a dialog, so Disconnect would
  // silently do nothing there.
  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null)

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message })
    setTimeout(() => setToast(null), 5000)
  }

  const handleDisconnect = async (id: string) => {
    setIsDisconnecting(id)
    try {
      await disconnectProvider(id)
      setConnections(prev => prev.filter(c => c.id !== id))
      showToast('success', 'Provider disconnected.')
    } catch (err: any) {
      showToast('error', err.message || 'Failed to disconnect.')
    } finally {
      setIsDisconnecting(null)
    }
  }

  const handleRefreshAccounts = async (id: string) => {
    setIsRefreshing(id)
    try {
      const res = await refreshAdAccounts(id)
      showToast('success', `Refreshed ${res.count} ad account${res.count !== 1 ? 's' : ''}.`)
    } catch (err: any) {
      showToast('error', err.message || 'Failed to refresh accounts.')
    } finally {
      setIsRefreshing(null)
    }
  }

  const openClientSelector = async (provider: 'meta' | 'google') => {
    setProviderToConnect(provider)
    try {
      const data = await fetchActiveClients()
      setClients(data)
      if (data.length > 0) setSelectedClientForAuth(data[0].id)
      setIsClientModalOpen(true)
    } catch (err: any) {
      showToast('error', 'Failed to load clients: ' + err.message)
    }
  }

  const handleProceedWithAuth = () => {
    if (!selectedClientForAuth || !providerToConnect) return
    setIsClientModalOpen(false)
    window.location.href = `/api/auth/${providerToConnect}/login?client_id=${selectedClientForAuth}`
  }

  return (
    <div className="space-y-6">

      {/* ── Flash banner ── */}
      {toast && (
        <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${
          toast.type === 'success'
            ? 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400'
            : 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400'
        }`}>
          {toast.type === 'success'
            ? <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />
            : <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
          <span className="flex-1">{toast.message}</span>
          <button onClick={() => setToast(null)} className="ml-auto text-current opacity-60 hover:opacity-100">×</button>
        </div>
      )}

      {/* ── Connect buttons ── */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Link2 className="h-5 w-5 text-pink-500" />
          <h2 className="font-semibold">Connect an Ad Platform</h2>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* Meta */}
          <button
            onClick={() => openClientSelector('meta')}
            className="flex items-center gap-3 rounded-xl border border-border bg-secondary/30 p-4 hover:border-pink-500/40 hover:bg-secondary/60 transition-all text-left group"
          >
            <div className="h-10 w-10 rounded-xl bg-blue-500/10 flex items-center justify-center shrink-0">
              <svg className="h-6 w-6" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M20 3.333C10.8 3.333 3.333 10.8 3.333 20S10.8 36.667 20 36.667 36.667 29.2 36.667 20 29.2 3.333 20 3.333z" fill="#1877F2"/>
                <path d="M27.5 20h-4.167v13.333h-5V20H15v-4.167h3.333v-2.5c0-3.533 1.617-5.633 5.2-5.633h3.634v4.167h-2.284c-1.666 0-1.716.616-1.716 1.75v2.216H27.5L27.5 20z" fill="white"/>
              </svg>
            </div>
            <div>
              <div className="font-medium text-sm">Meta Ads</div>
              <div className="text-xs text-muted-foreground">Facebook &amp; Instagram campaigns</div>
            </div>
            <Plus className="h-4 w-4 text-muted-foreground ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
          </button>

          {/* Google */}
          <button
            onClick={() => openClientSelector('google')}
            className="flex items-center gap-3 rounded-xl border border-border bg-secondary/30 p-4 hover:border-pink-500/40 hover:bg-secondary/60 transition-all text-left group"
          >
            <div className="h-10 w-10 rounded-xl bg-green-500/10 flex items-center justify-center shrink-0">
              <svg className="h-6 w-6" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
            </div>
            <div>
              <div className="font-medium text-sm">Google Ads</div>
              <div className="text-xs text-muted-foreground">Search, Display &amp; YouTube campaigns</div>
            </div>
            <Plus className="h-4 w-4 text-muted-foreground ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
          </button>
        </div>
      </div>

      {/* ── Connected providers ── */}
      {connections.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Connected Providers</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {connections.map(conn => {
              const isExpired = new Date(conn.token_expires_at) < new Date()

              return (
                <div key={conn.id} className="rounded-xl border border-border bg-card overflow-hidden">
                  <div className="p-5">
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <div className="capitalize font-semibold">{conn.provider} Ads</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {conn.client?.name || conn.client_id}
                        </div>
                      </div>
                      <Badge variant={conn.status === 'active' && !isExpired ? 'default' : 'danger'}>
                        {isExpired ? 'Expired' : conn.status}
                      </Badge>
                    </div>
                    <div className="text-xs space-y-1.5 text-muted-foreground">
                      <div className="flex justify-between">
                        <span>Last auth</span>
                        <span className="text-foreground">{formatDistanceToNow(new Date(conn.last_auth_at))} ago</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Token expires</span>
                        <span className={isExpired ? 'text-red-500 font-semibold' : 'text-foreground'}>
                          {new Date(conn.token_expires_at).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Ad accounts</span>
                        <span className="text-foreground">{conn.ad_accounts?.length || 0}</span>
                      </div>
                    </div>

                    {isExpired && (
                      <div className="mt-3 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-lg px-3 py-2">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        Token expired — reconnect to resume syncing.
                      </div>
                    )}
                  </div>

                  <div className="border-t border-border bg-muted/40 px-5 py-3 flex gap-2 justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRefreshAccounts(conn.id)}
                      disabled={isRefreshing === conn.id}
                    >
                      {isRefreshing === conn.id
                        ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                      Refresh
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDisconnectTarget(conn.id)}
                      disabled={isDisconnecting === conn.id}
                    >
                      {isDisconnecting === conn.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {connections.length === 0 && (
        <div className="py-10 text-center text-sm text-muted-foreground border border-dashed rounded-xl">
          No ad providers connected yet — use the buttons above to link Meta or Google Ads.
        </div>
      )}

      {/* ── Discovered ad accounts ── */}
      {connections.some(c => c.ad_accounts && c.ad_accounts.length > 0) && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-pink-500" />
            <h2 className="font-semibold">Discovered Ad Accounts</h2>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {connections.flatMap(c =>
              (c.ad_accounts || []).map(acc => (
                <div key={acc.id} className="rounded-xl border border-border bg-card p-5 flex flex-col justify-between">
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div>
                        <div className="font-semibold">{acc.name}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">ID: {acc.account_id}</div>
                      </div>
                      <Badge variant={acc.is_active ? 'default' : 'info'}>{acc.is_active ? 'Active' : 'Inactive'}</Badge>
                    </div>
                    <div className="text-xs space-y-1 text-muted-foreground">
                      <div className="flex justify-between">
                        <span>Currency</span>
                        <span className="text-foreground">{acc.currency || 'N/A'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Timezone</span>
                        <span className="text-foreground">{acc.timezone || 'N/A'}</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 space-y-2">
                    <Link
                      href={`/dashboard/advertising/integrations/${acc.id}/campaigns`}
                      className={buttonVariants({ className: 'w-full' })}
                    >
                      <ListChecks className="mr-2 h-4 w-4" />
                      Map Campaigns
                    </Link>
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => {
                        setSelectedAccount(acc)
                        setSelectedClientId(c.client_id)
                        setWizardOpen(true)
                      }}
                    >
                      <FolderPlus className="mr-2 h-4 w-4" />
                      Create Single Project
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <SyncStatusPanel clientId={initialConnections[0]?.client_id} />

      <CreateProjectWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        adAccount={selectedAccount}
        clientId={selectedClientId}
      />

      {/* ── Client selector modal ── */}
      {isClientModalOpen && (
        <ModalOverlay onClose={() => setIsClientModalOpen(false)}>
          <div className="bg-card text-card-foreground shadow-lg border rounded-2xl w-[400px] overflow-hidden flex flex-col">
            <div className="p-6 border-b">
              <div className="flex items-center gap-3 mb-1">
                {providerToConnect === 'meta'
                  ? <span className="text-xl">📘</span>
                  : <span className="text-xl">🎯</span>}
                <h2 className="text-lg font-semibold">
                  Connect {providerToConnect === 'meta' ? 'Meta Ads' : 'Google Ads'}
                </h2>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Select the client workspace to associate with this ad account.
              </p>
            </div>
            <div className="p-6">
              <label className="text-sm font-medium mb-2 block">Client Workspace</label>
              <select
                className="flex h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={selectedClientForAuth}
                onChange={e => setSelectedClientForAuth(e.target.value)}
              >
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-2">
                You&apos;ll be redirected to {providerToConnect === 'meta' ? 'Facebook' : 'Google'} to authorise access.
              </p>
            </div>
            <div className="p-6 border-t bg-muted/50 flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setIsClientModalOpen(false)}>Cancel</Button>
              <Button onClick={handleProceedWithAuth} disabled={!selectedClientForAuth}>
                Continue →
              </Button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {disconnectTarget && (
        <ConfirmDialog
          title="Disconnect this ad account?"
          body="Spend and performance figures stop updating for every campaign linked to it, and the numbers already pulled stay frozen at their last sync. You can reconnect later, but you will need to authorise access again."
          confirmLabel="Disconnect"
          danger
          onConfirm={() => { const id = disconnectTarget; setDisconnectTarget(null); void handleDisconnect(id) }}
          onCancel={() => setDisconnectTarget(null)}
        />
      )}
    </div>
  )
}
