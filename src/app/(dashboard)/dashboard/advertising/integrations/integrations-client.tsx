'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { disconnectProvider, refreshAdAccounts, fetchActiveClients } from './actions'
import { ModalOverlay } from '@/components/ui/modal-overlay'

import { Loader2, Plus, RefreshCw, Trash2, FolderPlus } from 'lucide-react'
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

export function IntegrationsClient({ initialConnections }: { initialConnections: any[] }) {
  const [connections, setConnections] = useState<ProviderConnection[]>(initialConnections)
  const [isRefreshing, setIsRefreshing] = useState<string | null>(null)
  const [isDisconnecting, setIsDisconnecting] = useState<string | null>(null)

  const [wizardOpen, setWizardOpen] = useState(false)
  const [selectedAccount, setSelectedAccount] = useState<any | null>(null)
  const [selectedClientId, setSelectedClientId] = useState<string>('')

  // Client Selection State
  const [isClientModalOpen, setIsClientModalOpen] = useState(false)
  const [clients, setClients] = useState<{id: string, name: string}[]>([])
  const [selectedClientForAuth, setSelectedClientForAuth] = useState<string>('')
  const [providerToConnect, setProviderToConnect] = useState<'meta' | 'google' | null>(null)

  const handleDisconnect = async (id: string) => {
    if (!confirm('Are you sure you want to disconnect this provider?')) return
    setIsDisconnecting(id)
    try {
      await disconnectProvider(id)
      setConnections(prev => prev.filter(c => c.id !== id))
      alert('Provider disconnected successfully')
    } catch (err: any) {
      alert(err.message || 'Failed to disconnect')
    } finally {
      setIsDisconnecting(null)
    }
  }

  const handleRefreshAccounts = async (id: string) => {
    setIsRefreshing(id)
    try {
      const res = await refreshAdAccounts(id)
      alert(`Successfully refreshed ${res.count} ad accounts`)
    } catch (err: any) {
      alert(err.message || 'Failed to refresh accounts')
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
      alert('Failed to load clients: ' + err.message)
    }
  }

  const handleProceedWithAuth = () => {
    if (!selectedClientForAuth || !providerToConnect) return
    setIsClientModalOpen(false)
    window.location.href = `/api/auth/${providerToConnect}/login?client_id=${selectedClientForAuth}`
  }

  return (
    <div className="space-y-6">
      
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => openClientSelector('meta')}>
          <Plus className="mr-2 h-4 w-4" /> Connect Meta Ads
        </Button>
        <Button variant="outline" onClick={() => openClientSelector('google')}>
          <Plus className="mr-2 h-4 w-4" /> Connect Google Ads
        </Button>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {connections.map(conn => {
          const isExpired = new Date(conn.token_expires_at) < new Date()
          
          return (
            <div key={conn.id} className="relative overflow-hidden rounded-xl border border-border bg-card">
              <div className="p-6 pb-4">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="capitalize text-xl font-semibold">{conn.provider} Ads</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Workspace: {conn.client?.name || conn.client_id}
                    </p>
                  </div>
                  <Badge variant={conn.status === 'active' && !isExpired ? 'default' : 'danger'}>
                    {isExpired ? 'Expired' : conn.status}
                  </Badge>
                </div>
              </div>
              
              <div className="p-6 pt-0 text-sm space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Last Auth:</span>
                  <span>{formatDistanceToNow(new Date(conn.last_auth_at))} ago</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Expires:</span>
                  <span className={isExpired ? 'text-red-500 font-semibold' : ''}>
                    {new Date(conn.token_expires_at).toLocaleDateString()}
                  </span>
                </div>
              </div>

              <div className="bg-muted/50 p-4 flex gap-2 justify-end mt-4">
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => handleRefreshAccounts(conn.id)}
                  disabled={isRefreshing === conn.id}
                >
                  {isRefreshing === conn.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                  Refresh Accounts
                </Button>
                
                <Button 
                  variant="destructive" 
                  size="sm" 
                  onClick={() => handleDisconnect(conn.id)}
                  disabled={isDisconnecting === conn.id}
                >
                  {isDisconnecting === conn.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          )
        })}

        {connections.length === 0 && (
          <div className="col-span-full py-12 text-center text-muted-foreground border border-dashed rounded-lg">
            No advertising providers connected.
          </div>
        )}
      </div>
      
      {/* Ad Accounts Section (flattened for display) */}
      {connections.some(c => c.ad_accounts && c.ad_accounts.length > 0) && (
        <div className="mt-12 space-y-4">
          <h2 className="text-2xl font-bold tracking-tight">Discovered Ad Accounts</h2>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {connections.flatMap(c => 
              (c.ad_accounts || []).map(acc => (
                <div key={acc.id} className="relative overflow-hidden rounded-xl border border-border bg-card p-6 flex flex-col justify-between">
                  <div>
                    <h3 className="font-semibold text-lg">{acc.name}</h3>
                    <p className="text-sm text-muted-foreground mb-4">ID: {acc.account_id}</p>
                    
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Currency:</span>
                        <span>{acc.currency || 'N/A'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Timezone:</span>
                        <span>{acc.timezone || 'N/A'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Status:</span>
                        <Badge variant={acc.is_active ? 'default' : 'info'}>{acc.is_active ? 'Active' : 'Inactive'}</Badge>
                      </div>
                    </div>
                  </div>
                  
                  <div className="mt-6 pt-4 border-t">
                    <Button 
                      className="w-full"
                      onClick={() => {
                        setSelectedAccount(acc)
                        setSelectedClientId(c.client_id)
                        setWizardOpen(true)
                      }}
                    >
                      <FolderPlus className="mr-2 h-4 w-4" /> Create Project
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

      {isClientModalOpen && (
        <ModalOverlay onClose={() => setIsClientModalOpen(false)}>
          <div className="bg-card text-card-foreground shadow-lg border rounded-2xl w-[400px] overflow-hidden flex flex-col">
            <div className="p-6 border-b">
              <h2 className="text-xl font-semibold">Select Workspace</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Choose the client workspace to connect {providerToConnect === 'meta' ? 'Meta' : 'Google'} Ads.
              </p>
            </div>
            <div className="p-6">
              <label className="text-sm font-medium mb-2 block">Client</label>
              <select 
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={selectedClientForAuth}
                onChange={(e) => setSelectedClientForAuth(e.target.value)}
              >
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className="p-6 border-t bg-muted/50 flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setIsClientModalOpen(false)}>Cancel</Button>
              <Button onClick={handleProceedWithAuth} disabled={!selectedClientForAuth}>
                Continue to {providerToConnect === 'meta' ? 'Meta' : 'Google'}
              </Button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
