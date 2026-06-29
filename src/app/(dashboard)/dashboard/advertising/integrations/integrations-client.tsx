'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { disconnectProvider, refreshAdAccounts } from './actions'

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

  const handleConnectMeta = () => {
    // Hardcoded workspace for demo if multiple workspaces exist, but usually we'd have a workspace selector
    // In cirqle, we often have a context provider for the current client, or they pick one.
    // For now, let's use a dummy client ID if not provided, or prompt.
    // Assuming there's a client selection or it connects to a specific client.
    // In Phase A, we added provider_connections per client.
    const clientId = prompt('Enter Client ID to connect (UUID):')
    if (clientId) {
      window.location.href = `/api/auth/meta/login?client_id=${clientId}`
    }
  }

  const handleConnectGoogle = () => {
    const clientId = prompt('Enter Client ID to connect (UUID):')
    if (clientId) {
      window.location.href = `/api/auth/google/login?client_id=${clientId}`
    }
  }

  return (
    <div className="space-y-6">
      
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={handleConnectMeta}>
          <Plus className="mr-2 h-4 w-4" /> Connect Meta Ads
        </Button>
        <Button variant="outline" onClick={handleConnectGoogle}>
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
    </div>
  )
}
