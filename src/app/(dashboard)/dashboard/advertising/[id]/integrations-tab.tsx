'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'

import { Loader2, RefreshCw } from 'lucide-react'
import { fetchProviderConnections } from '../integrations/actions'
import { fetchSyncLogs, triggerManualSync, saveCampaignMapping, fetchAdAccounts } from '../integrations/tab-actions'
import { formatDistanceToNow } from 'date-fns'

export function IntegrationsTab({ project, canEdit, onChange }: { project: any, canEdit: boolean, onChange: () => void }) {
  const [loading, setLoading] = useState(true)
  const [connections, setConnections] = useState<any[]>([])
  
  // Mapping state
  const [selectedProvider, setSelectedProvider] = useState<string>('')
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>('')
  const [adAccounts, setAdAccounts] = useState<any[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState<string>(project.ad_account_id || '')
  const [externalCampaignId, setExternalCampaignId] = useState<string>(project.external_campaign_id || '')
  
  const [syncing, setSyncing] = useState(false)

  const [logs, setLogs] = useState<any[]>([])

  useEffect(() => {
    loadConnections()
    loadLogs()
  }, [project.client_id])

  async function loadLogs() {
    try {
      const data = await fetchSyncLogs(project.id)
      setLogs(data)
    } catch (err) {
      console.error(err)
    }
  }

  async function loadConnections() {
    setLoading(true)
    try {
      const data = await fetchProviderConnections(project.client_id)
      setConnections(data)
      
      // If we already have an ad_account_id, find the connection for it
      if (project.ad_account_id) {
        // Find which connection this account belongs to, we would normally do this securely via backend
        // For now, let's just trigger loading accounts if connection is selected
      }
    } catch (err: any) {
      alert('Failed to load connections')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (selectedConnectionId) {
      loadAdAccounts(selectedConnectionId)
    } else {
      setAdAccounts([])
    }
  }, [selectedConnectionId])

  async function loadAdAccounts(connId: string) {
    try {
      const accs = await fetchAdAccounts(connId)
      setAdAccounts(accs)
    } catch (err) {
      console.error('Failed to load ad accounts', err)
    }
  }

  const handleSaveMapping = async () => {
    if (!selectedAccountId || !externalCampaignId) {
      alert('Please select an ad account and enter a campaign ID')
      return
    }
    try {
      await saveCampaignMapping(project.id, selectedAccountId, externalCampaignId)
      alert('Mapping saved successfully')
      onChange()
    } catch (err: any) {
      alert('Failed to save mapping: ' + err.message)
    }
  }

  const handleSyncNow = async () => {
    setSyncing(true)
    try {
      await triggerManualSync(project.id)
      alert('Sync job queued. It will complete shortly.')
      onChange()
    } catch (err: any) {
      alert('Sync failed: ' + err.message)
    } finally {
      setSyncing(false)
    }
  }

  if (loading) {
    return <div className="p-8 text-center text-muted-foreground">Loading integrations...</div>
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card">
        <div className="p-6 pb-4">
          <h3 className="text-lg font-semibold">Campaign Mapping</h3>
          <p className="text-sm text-muted-foreground mt-1">Link this project to an external advertising campaign to enable automatic synchronization.</p>
        </div>
        <div className="p-6 pt-0 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Provider Connection</label>
              <select 
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                value={selectedConnectionId}
                onChange={(e) => {
                  setSelectedConnectionId(e.target.value)
                  setSelectedAccountId('')
                }}
                disabled={!canEdit}
              >
                <option value="">Select connection...</option>
                {connections.map(c => (
                  <option key={c.id} value={c.id}>{c.provider} - {c.status}</option>
                ))}
              </select>
            </div>
            
            <div className="space-y-2">
              <label className="text-sm font-medium">Ad Account</label>
              <select 
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                disabled={!canEdit || !selectedConnectionId}
              >
                <option value="">Select account...</option>
                {adAccounts.map(a => (
                  <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">External Campaign ID</label>
              <input
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                type="text"
                placeholder="e.g. 2384123456789"
                value={externalCampaignId}
                onChange={e => setExternalCampaignId(e.target.value)}
                disabled={!canEdit}
              />
            </div>
          </div>
        </div>
        <div className="bg-muted/50 p-4 flex justify-between rounded-b-xl border-t border-border">
          <Button variant="outline" onClick={handleSyncNow} disabled={syncing || !project.external_campaign_id}>
            {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Sync Now
          </Button>
          <Button onClick={handleSaveMapping} disabled={!canEdit}>Save Mapping</Button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="p-6 pb-4">
          <h3 className="text-lg font-semibold">Sync History</h3>
          <p className="text-sm text-muted-foreground mt-1">Recent synchronization events for this project.</p>
        </div>
        <div className="p-6 pt-0">
          {logs.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="border-b">
                  <tr>
                    <th className="py-2">Date</th>
                    <th className="py-2">Provider</th>
                    <th className="py-2">Imported</th>
                    <th className="py-2">Updated</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {logs.map(log => (
                    <tr key={log.id}>
                      <td className="py-2 whitespace-nowrap">{formatDistanceToNow(new Date(log.sync_date))} ago</td>
                      <td className="py-2 capitalize">{log.provider}</td>
                      <td className="py-2">{log.records_imported}</td>
                      <td className="py-2">{log.records_updated}</td>
                      <td className="py-2">
                        <span className={`px-2 py-0.5 rounded-full text-xs ${log.status === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                          {log.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground border border-dashed rounded-lg p-8 text-center">
              No sync history available yet.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
