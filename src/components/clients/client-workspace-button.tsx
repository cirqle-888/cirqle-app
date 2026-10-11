'use client'
import { useEffect, useState } from 'react'
import { PanelsTopLeft } from 'lucide-react'
import { desktop } from '@/lib/desktop'
import { usePermissions } from '@/contexts/permission-context'
import { usePrivacy } from '@/contexts/privacy-context'
import { canOpenHref } from '@/lib/nav-sections'
interface Client { id: string; name: string; code?: string; phone?: string | null; country?: string | null }
export default function ClientWorkspaceButton({ client }: { client: Client }) {
  const [supported, setSupported] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { ds, isUnlocked, forceLock } = usePrivacy()
  const { can, user } = usePermissions()
  useEffect(() => { setSupported(typeof desktop()?.openClientWorkspace === 'function') }, [])
  if (!supported) return null
  async function open() {
    setBusy(true); setError('')
    try {
      const result = await desktop()?.openClientWorkspace?.({
        id: client.id, name: ds(client.name, client.code), code: client.code,
        phone: isUnlocked && !forceLock ? client.phone || undefined : undefined, country: client.country || undefined,
        showTasks: canOpenHref('/dashboard/tasks', can, user.isAdmin),
        showInvoices: canOpenHref('/dashboard/invoices', can, user.isAdmin),
      })
      if (!result?.ok && result?.reason !== 'cancelled') setError(result?.reason || 'Could not open the workspace. Try again.')
    } catch { setError('Could not open the workspace. Try again.') }
    finally { setBusy(false) }
  }
  return (
    <span className="inline-flex flex-col gap-1" onClick={event => event.stopPropagation()}>
      <button data-client-workspace-action type="button" disabled={busy} onClick={() => void open()}
        className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50">
        <PanelsTopLeft className="h-4 w-4" />{busy ? 'Opening…' : 'Open client workspace'}
      </button>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </span>
  )
}
