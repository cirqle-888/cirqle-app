'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import {
  Loader2, RefreshCw, Search, Check, X, EyeOff, Eye, ExternalLink,
  AlertTriangle, ListChecks, ArrowLeft,
} from 'lucide-react'
import { CIRQLE_CAMPAIGN_TYPES, metaObjectiveToCampaignType } from '@/lib/advertising/campaign-objective'
import {
  discoverCampaigns, fetchAccountCampaigns, fetchLinkableProjects,
  mapCampaign, bulkMapCampaigns, unmapCampaign, ignoreCampaign,
} from '../../mapping-actions'

type Row = any
type Toast = { type: 'success' | 'error'; message: string }

const MAPPING_TABS = [
  { key: 'unmapped', label: 'Unmapped' },
  { key: 'mapped',   label: 'Mapped' },
  { key: 'ignored',  label: 'Ignored' },
  { key: 'all',      label: 'All' },
] as const

export function CampaignMappingClient({
  accountId, account, initialCampaigns, clients, notReady,
}: {
  accountId: string
  account: any
  initialCampaigns: Row[]
  clients: { id: string; name: string }[]
  notReady: boolean
}) {
  const [rows, setRows] = useState<Row[]>(initialCampaigns)
  const [tab, setTab] = useState<typeof MAPPING_TABS[number]['key']>('unmapped')
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState<Toast | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Per-row draft selections (client + objective + optional existing project).
  const [draft, setDraft] = useState<Record<string, { clientId: string; campaignType: string; projectId: string }>>({})
  // Lazily-loaded linkable projects per client.
  const [linkable, setLinkable] = useState<Record<string, { id: string; campaign_name: string }[]>>({})

  // Bulk
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkClient, setBulkClient] = useState('')
  const [bulkType, setBulkType] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)

  function flash(t: Toast) { setToast(t); setTimeout(() => setToast(null), 4000) }

  function defaultsFor(r: Row) {
    return {
      clientId: r?.client_id ?? '',
      campaignType: r?.campaign_type ?? metaObjectiveToCampaignType(r?.objective) ?? '',
      projectId: '',
    }
  }
  function rowDraft(r: Row) {
    return draft[r.id] ?? defaultsFor(r)
  }
  function setRowDraft(id: string, patch: Partial<{ clientId: string; campaignType: string; projectId: string }>) {
    const defaults = defaultsFor(rows.find(r => r.id === id))
    setDraft(d => ({ ...d, [id]: { ...defaults, ...d[id], ...patch } }))
  }

  async function loadLinkable(clientId: string) {
    if (!clientId || linkable[clientId]) return
    try {
      const projects = await fetchLinkableProjects(clientId)
      setLinkable(l => ({ ...l, [clientId]: projects as any }))
    } catch { /* non-fatal */ }
  }

  async function refresh() {
    try { setRows(await fetchAccountCampaigns(accountId) as Row[]) }
    catch { /* keep current */ }
  }

  async function onDiscover() {
    setDiscovering(true)
    try {
      const res = await discoverCampaigns(accountId)
      if ((res as any).error) flash({ type: 'error', message: (res as any).error })
      else flash({ type: 'success', message: `Discovered ${res.discovered} campaigns (${res.created} new)` })
      await refresh()
    } catch (e: any) {
      flash({ type: 'error', message: e.message })
    } finally { setDiscovering(false) }
  }

  async function onMap(r: Row) {
    const d = rowDraft(r)
    if (!d.clientId) { flash({ type: 'error', message: 'Pick a client first' }); return }
    setBusyId(r.id)
    try {
      const res = await mapCampaign({
        campaignId: r.id, clientId: d.clientId, campaignType: d.campaignType,
        projectMode: d.projectId ? 'existing' : 'create', existingProjectId: d.projectId || undefined,
      })
      if (!res.success) flash({ type: 'error', message: res.error })
      else { flash({ type: 'success', message: `Mapped "${r.name}"` }); setSelected(s => { const n = new Set(s); n.delete(r.id); return n }) }
      await refresh()
    } catch (e: any) { flash({ type: 'error', message: e.message }) }
    finally { setBusyId(null) }
  }

  async function onUnmap(r: Row, deleteProject: boolean) {
    setBusyId(r.id)
    try {
      const res = await unmapCampaign(r.id, { deleteProject })
      if (!res.success) flash({ type: 'error', message: res.error })
      else flash({ type: 'success', message: `Unmapped "${r.name}"` })
      await refresh()
    } catch (e: any) { flash({ type: 'error', message: e.message }) }
    finally { setBusyId(null) }
  }

  async function onIgnore(r: Row, ignored: boolean) {
    setBusyId(r.id)
    try {
      const res = await ignoreCampaign(r.id, ignored)
      if (!res.success) flash({ type: 'error', message: res.error })
      await refresh()
    } catch (e: any) { flash({ type: 'error', message: e.message }) }
    finally { setBusyId(null) }
  }

  async function onBulkMap() {
    if (!bulkClient) { flash({ type: 'error', message: 'Pick a client for bulk mapping' }); return }
    setBulkBusy(true)
    try {
      const res = await bulkMapCampaigns({ campaignIds: [...selected], clientId: bulkClient, campaignType: bulkType })
      if (!res.success) flash({ type: 'error', message: res.error })
      else flash({ type: res.failed ? 'error' : 'success', message: `Mapped ${res.mapped}${res.failed ? `, ${res.failed} failed` : ''}` })
      setSelected(new Set()); setBulkClient(''); setBulkType('')
      await refresh()
    } catch (e: any) { flash({ type: 'error', message: e.message }) }
    finally { setBulkBusy(false) }
  }

  const counts = useMemo(() => {
    const c = { unmapped: 0, mapped: 0, ignored: 0 }
    for (const r of rows) c[r.mapping_status as keyof typeof c] = (c[r.mapping_status as keyof typeof c] ?? 0) + 1
    return c
  }, [rows])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter(r =>
      (tab === 'all' || r.mapping_status === tab) &&
      (!q || r.name?.toLowerCase().includes(q)),
    )
  }, [rows, tab, search])

  const selectableVisible = visible.filter(r => r.mapping_status === 'unmapped')
  const allSelected = selectableVisible.length > 0 && selectableVisible.every(r => selected.has(r.id))

  if (notReady) {
    return (
      <EmptyShell accountName={account?.name}>
        <div className="flex items-center gap-2 text-amber-600">
          <AlertTriangle className="h-5 w-5" />
          <span>Campaign mapping isn’t ready yet — apply migration <code>20260630140000_ad_campaign_mapping.sql</code> in Supabase, then reload.</span>
        </div>
      </EmptyShell>
    )
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <Link href="/dashboard/connections" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-2">
          <ArrowLeft className="h-3.5 w-3.5" /> Integrations
        </Link>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ListChecks className="h-6 w-6 text-pink-500" /> Map Campaigns
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {account?.name ?? 'Ad account'} · {account?.account_id} · assign each campaign to a client, objective &amp; project.
            </p>
          </div>
          <Button onClick={onDiscover} disabled={discovering}>
            {discovering ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Discover campaigns
          </Button>
        </div>
      </div>

      {toast && (
        <div className={`rounded-lg border px-4 py-2 text-sm flex items-center gap-2 ${toast.type === 'success' ? 'border-green-300 bg-green-50 text-green-700' : 'border-red-300 bg-red-50 text-red-700'}`}>
          {toast.type === 'success' ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
          {toast.message}
        </div>
      )}

      {/* Tabs + search */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1 rounded-lg border border-border p-1">
          {MAPPING_TABS.map(t => {
            const n = t.key === 'all' ? rows.length : counts[t.key as keyof typeof counts]
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`px-3 py-1 text-sm rounded-md ${tab === t.key ? 'bg-pink-500 text-white' : 'text-muted-foreground hover:text-foreground'}`}>
                {t.label} <span className="opacity-70">{n}</span>
              </button>
            )
          })}
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search campaigns…"
            className="pl-8 pr-3 py-1.5 text-sm rounded-md border border-border bg-background w-56" />
        </div>
      </div>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="rounded-lg border border-pink-300 bg-pink-50 px-4 py-3 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium text-pink-800">{selected.size} selected</span>
          <select value={bulkClient} onChange={e => setBulkClient(e.target.value)} className="text-sm rounded-md border border-border bg-background px-2 py-1.5">
            <option value="">Assign client…</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={bulkType} onChange={e => setBulkType(e.target.value)} className="text-sm rounded-md border border-border bg-background px-2 py-1.5">
            <option value="">Objective (optional)…</option>
            {CIRQLE_CAMPAIGN_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <Button onClick={onBulkMap} disabled={bulkBusy || !bulkClient}>
            {bulkBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
            Map {selected.size}
          </Button>
          <button onClick={() => setSelected(new Set())} className="text-sm text-muted-foreground hover:text-foreground ml-auto">Clear</button>
        </div>
      )}

      {/* Table — bulk-select + per-row mapping controls (admin/integrations
          setup flow, not a daily workflow). overflow-x-auto contains any
          overflow to the table instead of it breaking the page layout on
          phones; min-w gives the 6 columns + checkbox room to stay legible. */}
      <div className="rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="w-9 p-3">
                <input type="checkbox" checked={allSelected}
                  onChange={e => {
                    setSelected(prev => {
                      const n = new Set(prev)
                      selectableVisible.forEach(r => e.target.checked ? n.add(r.id) : n.delete(r.id))
                      return n
                    })
                  }} />
              </th>
              <th className="text-left p-3 font-medium">Campaign</th>
              <th className="text-left p-3 font-medium">Client</th>
              <th className="text-left p-3 font-medium">Objective</th>
              <th className="text-left p-3 font-medium">Project</th>
              <th className="text-right p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">
                No campaigns. Click <strong>Discover campaigns</strong> to pull them from {account?.provider ?? 'the provider'}.
              </td></tr>
            )}
            {visible.map(r => {
              const d = rowDraft(r)
              const mapped = r.mapping_status === 'mapped'
              const ignored = r.mapping_status === 'ignored'
              const busy = busyId === r.id
              const project = Array.isArray(r.project) ? r.project[0] : r.project
              return (
                <tr key={r.id} className={`border-t border-border ${r.mapping_status === 'unmapped' ? 'bg-amber-50/40' : ''}`}>
                  <td className="p-3 align-top">
                    {!mapped && !ignored && (
                      <input type="checkbox" checked={selected.has(r.id)}
                        onChange={e => setSelected(prev => { const n = new Set(prev); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n })} />
                    )}
                  </td>
                  <td className="p-3 align-top">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-muted-foreground flex gap-2 mt-0.5">
                      <span>{r.objective ?? '—'}</span>
                      <StatusChip status={r.status} />
                      <MappingChip status={r.mapping_status} />
                    </div>
                  </td>
                  {/* Client */}
                  <td className="p-3 align-top">
                    {mapped ? (
                      <span>{(Array.isArray(r.client) ? r.client[0]?.name : r.client?.name) ?? '—'}</span>
                    ) : (
                      <select value={d.clientId} disabled={busy}
                        onChange={e => { setRowDraft(r.id, { clientId: e.target.value, projectId: '' }); loadLinkable(e.target.value) }}
                        className="text-sm rounded-md border border-border bg-background px-2 py-1.5 w-40">
                        <option value="">Select…</option>
                        {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    )}
                  </td>
                  {/* Objective */}
                  <td className="p-3 align-top">
                    {mapped ? (
                      <span className="capitalize">{r.campaign_type ?? '—'}</span>
                    ) : (
                      <select value={d.campaignType} disabled={busy}
                        onChange={e => setRowDraft(r.id, { campaignType: e.target.value })}
                        className="text-sm rounded-md border border-border bg-background px-2 py-1.5 w-36">
                        <option value="">—</option>
                        {CIRQLE_CAMPAIGN_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    )}
                  </td>
                  {/* Project */}
                  <td className="p-3 align-top">
                    {mapped && project ? (
                      <div className="space-y-0.5">
                        <Link href={`/dashboard/advertising/${project.id}`} className="text-pink-600 hover:underline inline-flex items-center gap-1">
                          {project.campaign_name} <ExternalLink className="h-3 w-3" />
                        </Link>
                        <SyncChip status={project.sync_status} error={project.last_sync_error} />
                      </div>
                    ) : !mapped && !ignored ? (
                      <select value={d.projectId} disabled={busy || !d.clientId}
                        onChange={e => setRowDraft(r.id, { projectId: e.target.value })}
                        className="text-sm rounded-md border border-border bg-background px-2 py-1.5 w-44">
                        <option value="">➕ New project (auto)</option>
                        {(linkable[d.clientId] ?? []).map(p => <option key={p.id} value={p.id}>{p.campaign_name}</option>)}
                      </select>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  {/* Actions */}
                  <td className="p-3 align-top text-right whitespace-nowrap">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin inline" /> : mapped ? (
                      <button onClick={() => onUnmap(r, false)} className="text-xs text-muted-foreground hover:text-red-600">Unmap</button>
                    ) : (
                      <div className="inline-flex items-center gap-2">
                        <Button onClick={() => onMap(r)} disabled={!d.clientId} className="h-7 px-3 text-xs">
                          <Check className="h-3.5 w-3.5 mr-1" /> Map
                        </Button>
                        <button onClick={() => onIgnore(r, !ignored)} title={ignored ? 'Un-ignore' : 'Ignore'}
                          className="text-muted-foreground hover:text-foreground">
                          {ignored ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}

function EmptyShell({ accountName, children }: { accountName?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <Link href="/dashboard/connections" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Integrations
      </Link>
      <h1 className="text-2xl font-bold flex items-center gap-2"><ListChecks className="h-6 w-6 text-pink-500" /> Map Campaigns</h1>
      <div className="text-sm text-muted-foreground">{accountName}</div>
      <div className="rounded-xl border border-border bg-card p-6">{children}</div>
    </div>
  )
}

function StatusChip({ status }: { status?: string }) {
  if (!status) return null
  const active = /ACTIVE/i.test(status)
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{status}</span>
}

function MappingChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    unmapped: 'bg-amber-100 text-amber-700',
    mapped:   'bg-green-100 text-green-700',
    ignored:  'bg-gray-100 text-gray-500',
  }
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium capitalize ${map[status] ?? ''}`}>{status}</span>
}

function SyncChip({ status, error }: { status?: string; error?: string }) {
  if (!status) return null
  const tone = status === 'error' ? 'text-red-600' : status === 'running' || status === 'queued' ? 'text-blue-600' : 'text-muted-foreground'
  return <div className={`text-[11px] ${tone}`} title={error ?? ''}>sync: {status}{error ? ' ⚠' : ''}</div>
}
