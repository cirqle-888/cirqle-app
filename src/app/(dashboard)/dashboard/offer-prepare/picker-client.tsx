'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Search, Store, ChevronRight, AlertTriangle } from 'lucide-react'
import Header from '@/components/layout/header'

interface PickerClient {
  id: string
  name: string
  code?: string | null
  hasToken: boolean
  hasWebhook: boolean
}

export default function OfferPrepareClientPicker({ clients }: { clients: PickerClient[] }) {
  const [q, setQ] = useState('')
  const filtered = clients.filter(c =>
    c.name.toLowerCase().includes(q.toLowerCase()) ||
    (c.code || '').toLowerCase().includes(q.toLowerCase())
  )

  return (
    <div>
      <Header
        title="Prepare Offer"
        subtitle="Paste a client's WhatsApp offer list and generate their designer sheet"
      />
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            autoFocus
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search clients…"
            className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground/60"
          />
        </div>

        {filtered.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">
            No offer-service clients found.
          </p>
        )}

        <div className="space-y-2">
          {filtered.map(c => (
            <Link
              key={c.id}
              href={c.hasToken ? `/dashboard/offer-prepare/${c.id}` : '/dashboard/apps/offer-intake'}
              className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:border-violet-500/40 hover:bg-violet-500/5 transition-colors group"
            >
              <div className="w-9 h-9 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
                <Store className="w-4 h-4 text-violet-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{c.name}</p>
                {!c.hasToken ? (
                  <p className="text-xs text-amber-600 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> No intake token — set up in Offer Intake settings
                  </p>
                ) : !c.hasWebhook ? (
                  <p className="text-xs text-amber-600 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> No Google Sheet webhook — sheet sync won&apos;t run
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">Ready</p>
                )}
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-violet-500 shrink-0" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
