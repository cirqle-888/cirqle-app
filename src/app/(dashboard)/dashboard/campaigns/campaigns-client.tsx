'use client'

import { useState } from 'react'
import { CampaignCard } from '@/components/campaigns/campaign-card'

export default function CampaignsClient({
  campaigns: initialCampaigns,
  clients,
}: {
  campaigns: any[]
  clients: { id: string; name: string }[]
}) {
  const [campaigns] = useState(initialCampaigns)
  const [filterClient, setFilterClient] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  function refresh() { setRefreshKey(k => k + 1) }

  const filtered = campaigns.filter(c => {
    if (filterClient && c.client?.id !== filterClient) return false
    if (filterStatus && c.status !== filterStatus) return false
    return true
  })

  const unackedTotal = campaigns.reduce((sum, c) =>
    sum + (c.logs || []).filter((l: any) => !l.acknowledged).length, 0)

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            Offer Campaigns
            {unackedTotal > 0 && (
              <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                {unackedTotal} to review
              </span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Client offer submissions — review changes and mark as reflected in design
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <select
          value={filterClient}
          onChange={e => setFilterClient(e.target.value)}
          className="bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none"
        >
          <option value="">All clients</option>
          {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          className="bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="finalised">Finalised</option>
        </select>
      </div>

      {/* Campaign list */}
      <div className="space-y-3">
        {filtered.length === 0 && (
          <div className="bg-card border border-border rounded-2xl py-12 text-center text-sm text-muted-foreground">
            No campaigns yet. Share a client's offer link for them to submit products.
          </div>
        )}
        {filtered.map(campaign => (
          <CampaignCard
            key={`${campaign.id}-${refreshKey}`}
            campaign={campaign}
            onRefresh={refresh}
          />
        ))}
      </div>
    </div>
  )
}
