'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { Loader2, BadgeCheck } from 'lucide-react'
import { listOffers, updateOfferStatus } from '@/lib/recruitment/actions'
import type { ApplicationOfferRow, OfferStatus } from '@/lib/recruitment/types'
import { useToast, ToastContainer } from '@/components/ui/toast'

const STATUS_STYLE: Record<OfferStatus, string> = {
  draft: 'bg-foreground/[0.06] text-muted-foreground border-foreground/10',
  sent: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  accepted: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  declined: 'bg-red-500/10 text-red-400 border-red-500/20',
  expired: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
}

export default function OffersClient({ canEdit }: { canEdit: boolean }) {
  const [offers, setOffers] = useState<ApplicationOfferRow[]>([])
  const [loading, setLoading] = useState(true)
  const [, startTransition] = useTransition()
  const { toasts, dismiss, error: toastError } = useToast()

  function load() {
    listOffers().then(res => {
      if (res.ok) setOffers(res.data)
      else toastError('Could not load offers', res.error)
      setLoading(false)
    })
  }
  useEffect(load, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Offers</h1>
        <p className="text-sm text-muted-foreground">All offers issued across every application.</p>
      </div>

      <div className="space-y-2">
        {offers.map(o => (
          <div key={o.id} className="rounded-xl border border-foreground/10 bg-card p-4 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Link href={`/dashboard/recruitment/applications/${o.applicationId}`} className="text-sm font-semibold text-foreground hover:text-violet-400 truncate block">
                {o.applicantName} <span className="text-muted-foreground font-normal font-mono text-xs">{o.applicationReference}</span>
              </Link>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
                <BadgeCheck className="h-3 w-3" />
                {o.positionTitle ?? '—'} · {o.currency} {o.offeredSalary?.toLocaleString('en-IN') ?? '—'}
              </div>
            </div>
            {canEdit ? (
              <select
                className={`text-xs border rounded-full px-2 py-1 bg-transparent ${STATUS_STYLE[o.status]}`} value={o.status}
                onChange={e => startTransition(async () => {
                  const res = await updateOfferStatus(o.id, e.target.value as OfferStatus)
                  if (res.ok) load()
                })}
              >
                <option value="draft">Draft</option>
                <option value="sent">Sent</option>
                <option value="accepted">Accepted</option>
                <option value="declined">Declined</option>
                <option value="expired">Expired</option>
              </select>
            ) : (
              <span className={`text-[11px] border rounded-full px-2 py-0.5 ${STATUS_STYLE[o.status]}`}>{o.status}</span>
            )}
          </div>
        ))}
        {offers.length === 0 && <p className="text-sm text-muted-foreground text-center py-10">No offers yet.</p>}
      </div>
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
