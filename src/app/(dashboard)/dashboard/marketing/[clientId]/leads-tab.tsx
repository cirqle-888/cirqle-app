'use client'

/**
 * Leads tab — this client's leads, newest first, with the one thing you most
 * often do to a lead (move it along) right on the row. Assignment, notes,
 * automation and bulk work stay in the Leads CRM, opened on this client.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Mail, Phone, UserPlus } from 'lucide-react'
import AppSelect from '@/components/ui/app-select'
import { useToast, ToastContainer } from '@/components/ui/toast'
import type { ClientMarketing, HubLead } from '@/lib/marketing/load'
import { updateLeadStatus } from '../../leads/actions'
import type { MarketingAccess } from '../_access'
import { EmptyHint, type HubClient } from '../_ui'

const STATUSES: HubLead['status'][] = ['new', 'contacted', 'qualified', 'won', 'lost']
const LABEL: Record<HubLead['status'], string> = { new: 'New', contacted: 'Contacted', qualified: 'Qualified', won: 'Won', lost: 'Lost' }
const STYLE: Record<HubLead['status'], string> = {
  new: 'bg-violet-500/15 text-violet-500 border-violet-500/25',
  contacted: 'bg-blue-500/15 text-blue-500 border-blue-500/25',
  qualified: 'bg-yellow-500/15 text-yellow-600 border-yellow-500/25',
  won: 'bg-green-500/15 text-green-600 border-green-500/25',
  lost: 'bg-gray-500/15 text-gray-500 border-gray-500/25',
}

export default function LeadsTab({ client, hub, access }: { client: HubClient; hub: ClientMarketing; access: MarketingAccess }) {
  const { toasts, dismiss, error: toastError } = useToast()
  const [leads, setLeads] = useState(hub.leads)
  const [filter, setFilter] = useState<HubLead['status'] | 'all'>('all')
  const [busy, setBusy] = useState<string | null>(null)

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: leads.length }
    for (const s of STATUSES) c[s] = leads.filter(l => l.status === s).length
    return c
  }, [leads])
  const shown = filter === 'all' ? leads : leads.filter(l => l.status === filter)

  async function setStatus(l: HubLead, status: HubLead['status']) {
    const before = l.status
    setBusy(l.id)
    setLeads(prev => prev.map(x => (x.id === l.id ? { ...x, status } : x)))
    const res = await updateLeadStatus(l.id, status)
    setBusy(null)
    if (!res.ok) {
      setLeads(prev => prev.map(x => (x.id === l.id ? { ...x, status: before } : x)))
      toastError('Could not update lead', res.error)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(['all', ...STATUSES] as const).map(s => (
          <button key={s} onClick={() => setFilter(s)} aria-pressed={filter === s}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              filter === s ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground hover:text-foreground'
            }`}>
            {s === 'all' ? 'All' : LABEL[s]} <span className="tabular-nums opacity-70">{counts[s]}</span>
          </button>
        ))}
        <Link href={`/dashboard/leads?client=${client.id}`}
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          Open in Leads CRM <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {shown.length === 0 ? (
          <div className="p-6">
            <EmptyHint text={leads.length === 0
              ? 'No leads for this client yet. Leads from their Meta lead forms arrive here automatically; you can also add one in the Leads CRM.'
              : 'No leads with this status.'} />
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {shown.map(l => (
              <li key={l.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold">
                    {(l.full_name ?? '?').slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{l.full_name || 'Unnamed lead'}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {l.campaign_name || l.form_name || l.source || 'Direct'} · {new Date(l.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {l.phone && (
                    <a href={`tel:${l.phone}`} title={l.phone} className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground">
                      <Phone className="h-3.5 w-3.5" /><span className="sr-only">Call {l.phone}</span>
                    </a>
                  )}
                  {l.email && (
                    <a href={`mailto:${l.email}`} title={l.email} className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground">
                      <Mail className="h-3.5 w-3.5" /><span className="sr-only">Email {l.email}</span>
                    </a>
                  )}
                  {access.leadsManage ? (
                    <AppSelect value={l.status} disabled={busy === l.id}
                      onChange={e => void setStatus(l, e.target.value as HubLead['status'])}
                      wrapperClassName="w-36" aria-label={`Status of ${l.full_name ?? 'lead'}`}>
                      {STATUSES.map(s => <option key={s} value={s}>{LABEL[s]}</option>)}
                    </AppSelect>
                  ) : (
                    <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${STYLE[l.status]}`}>{LABEL[l.status]}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {leads.length >= 200 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <UserPlus className="h-3.5 w-3.5" /> Showing the latest 200 — the Leads CRM has the full list.
        </p>
      )}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
