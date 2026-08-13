'use client'

import { useState, useEffect } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { fetchSyncStatus, triggerManualSync, toggleSyncStatus } from './actions'
import { Play, Pause, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

export function SyncStatusPanel({ clientId }: { clientId?: string }) {
  const [projects, setProjects] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const loadData = async () => {
    try {
      const data = await fetchSyncStatus(clientId)
      setProjects(data)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
    // Poll every 10 seconds for sync updates
    const interval = setInterval(loadData, 10000)
    return () => clearInterval(interval)
  }, [clientId])

  const handleSyncNow = async (id: string) => {
    try {
      await triggerManualSync(id)
      loadData()
    } catch (e: any) {
      alert(e.message)
    }
  }

  const handleToggleSync = async (id: string, current: boolean) => {
    try {
      await toggleSyncStatus(id, !current)
      loadData()
    } catch (e: any) {
      alert(e.message)
    }
  }

  if (loading) return <div className="py-8 text-center text-muted-foreground animate-pulse">Loading sync status...</div>
  
  if (projects.length === 0) return null

  return (
    <div className="space-y-4 mt-12">
      <h2 className="text-2xl font-bold tracking-tight">Synchronization Center</h2>
      <div className="grid gap-4">
        {projects.map(p => (
          <div key={p.id} className="flex flex-col sm:flex-row items-center justify-between p-4 border rounded-xl bg-card gap-4">
            <div className="flex items-center gap-4 flex-1">
              <div className={`p-3 rounded-full ${p.sync_status === 'error' ? 'bg-red-100 text-red-600' : p.sync_status === 'running' ? 'bg-blue-100 text-blue-600 animate-pulse' : 'bg-green-100 text-green-600'}`}>
                {p.sync_status === 'error' ? <AlertTriangle className="h-6 w-6" /> : <CheckCircle2 className="h-6 w-6" />}
              </div>
              <div>
                <h3 className="font-semibold">{p.campaign_name}</h3>
                <p className="text-sm text-muted-foreground">
                  Account: {p.ad_account?.name} ({p.ad_account?.provider})
                </p>
                <div className="flex gap-2 items-center mt-1 text-xs">
                  <Badge variant={p.sync_enabled ? 'default' : 'info'}>
                    {p.sync_enabled ? 'Auto-Sync ON' : 'Auto-Sync OFF'}
                  </Badge>
                  <span className="text-muted-foreground">
                    Status: <span className="capitalize font-medium">{p.sync_status}</span>
                  </span>
                  {p.last_sync_at && (
                    <span className="text-muted-foreground">
                      • Last sync: {formatDistanceToNow(new Date(p.last_sync_at))} ago
                    </span>
                  )}
                </div>
                {p.last_sync_error && (
                  <p className="text-xs text-red-500 mt-1">Error: {p.last_sync_error}</p>
                )}
              </div>
            </div>

            <div className="flex gap-2 w-full sm:w-auto">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => handleToggleSync(p.id, p.sync_enabled)}
              >
                {p.sync_enabled ? <Pause className="h-4 w-4 mr-2" /> : <Play className="h-4 w-4 mr-2" />}
                {p.sync_enabled ? 'Pause' : 'Resume'}
              </Button>
              <Button 
                variant="default" 
                size="sm" 
                disabled={!p.sync_enabled || p.sync_status === 'running'}
                onClick={() => handleSyncNow(p.id)}
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${p.sync_status === 'running' ? 'animate-spin' : ''}`} />
                Sync Now
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
