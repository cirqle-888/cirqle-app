'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import Header from '@/components/layout/header'
import { Search, X, RefreshCw, Users2 } from 'lucide-react'
import { upsertMatrixCell } from '../settings/actions'

const RecalcBillingModal = dynamic(() => import('../settings/recalc-billing-modal').then(mod => mod.RecalcBillingModal), { ssr: false })

interface ClientRow {
  id: string
  name: string
  code: string | null
  is_active: boolean | null
  default_currency: string | null
  pricing_pending: boolean
  service_pricings?: { service_id: string; price: number | null; commission_percentage: number | null; currency: string | null }[]
}

interface ServiceRow {
  id: string
  name: string
  is_active: boolean | null
  pricing_type?: string | null
  default_price?: number | null
  pricing_pending?: boolean
}

interface Props {
  clients: ClientRow[]
  services: ServiceRow[]
}

type MatrixCell = { price: string; commission_percentage: string; currency: string }

// ── Module-level search bar (stable reference — never defined inside a component) ──
function SearchBar({ value, onChange, placeholder = 'Search…', className = '' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string
}) {
  return (
    <div className={`flex items-center gap-2 bg-secondary border border-border/0 hover:border-border rounded-lg px-2.5 py-1.5 transition-colors focus-within:border-primary/50 ${className}`}>
      <Search className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-transparent text-sm outline-none flex-1 placeholder:text-muted-foreground/40"
      />
      {value && (
        <button type="button" onClick={() => onChange('')} className="text-muted-foreground/50 hover:text-foreground">
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

export default function PricingMatrixClient({ clients, services }: Props) {
  const [clientSearch, setClientSearch] = useState('')
  const [serviceSearch, setServiceSearch] = useState('')
  const [showRecalcModal, setShowRecalcModal] = useState(false)

  const [matrix, setMatrix] = useState<Record<string, MatrixCell>>(() => {
    const m: Record<string, MatrixCell> = {}
    clients.forEach((c) => {
      c.service_pricings?.forEach((p) => {
        m[`${c.id}::${p.service_id}`] = {
          price: p.price != null ? String(p.price) : '',
          commission_percentage: p.commission_percentage != null ? String(p.commission_percentage) : '',
          currency: p.currency || c.default_currency || 'INR',
        }
      })
    })
    return m
  })
  const [matrixSaving, setMatrixSaving] = useState<string | null>(null)

  // Flatten the matrix into the array shape the recalc modal expects
  const clientPricingsArray = useMemo(() => {
    return Object.entries(matrix).flatMap(([key, cell]) => {
      const [client_id, service_id] = key.split('::')
      if (!client_id || !service_id) return []
      const priceNum = cell.price === '' ? null : parseFloat(cell.price)
      return [{
        client_id,
        service_id,
        price: priceNum,
        percentage_rate: null,  // matrix UI doesn't expose percentage_rate yet; modal falls back to default
        currency: cell.currency,
      }]
    })
  }, [matrix])

  async function saveMatrixCell(clientId: string, serviceId: string, cell: MatrixCell) {
    const key = `${clientId}::${serviceId}`
    setMatrixSaving(key)
    // Blank means "not agreed yet", not 0. `|| 0` destroyed that distinction:
    // editing only the commission cell dragged a blank price along as 0, which
    // then suppressed the service-default fallback in task billing. And a 0
    // commission is a REAL value to every reader (`?? 50` never fires), so
    // coercing it silently zeroed the pair's historical earnings pool.
    const numOrNull = (raw: string) => {
      const s = (raw ?? '').trim()
      if (s === '') return null
      const n = parseFloat(s)
      return Number.isFinite(n) ? n : null
    }
    await upsertMatrixCell(
      clientId,
      serviceId,
      numOrNull(cell.price),
      numOrNull(cell.commission_percentage),
      cell.currency || 'INR',
    )
    setMatrixSaving(null)
  }

  function updateMatrix(clientId: string, serviceId: string, field: keyof MatrixCell, value: string) {
    const key = `${clientId}::${serviceId}`
    setMatrix(prev => ({ ...prev, [key]: { ...((prev[key]) || { price: '', commission_percentage: '', currency: 'INR' }), [field]: value } }))
  }

  const allActiveClients = clients.filter((c) => c.is_active)
  const allActiveServices = services.filter((s) => s.is_active)

  const activeClients = clientSearch
    ? allActiveClients.filter((c) => c.name?.toLowerCase().includes(clientSearch.toLowerCase()) || c.code?.toLowerCase().includes(clientSearch.toLowerCase()))
    : allActiveClients
  const activeServices = serviceSearch
    ? allActiveServices.filter((s) => s.name?.toLowerCase().includes(serviceSearch.toLowerCase()))
    : allActiveServices

  return (
    <>
      <Header
        title="Pricing Matrix"
        subtitle={`${allActiveClients.length} client${allActiveClients.length === 1 ? '' : 's'} · ${allActiveServices.length} service${allActiveServices.length === 1 ? '' : 's'}`}
        actions={
          <>
            <Link href="/dashboard/clients"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
              <Users2 className="w-4 h-4" /> Clients
            </Link>
            <button type="button" onClick={() => setShowRecalcModal(true)} title="Apply the current Pricing Matrix to existing tasks (one-time / on-demand maintenance)"
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-200 hover:bg-violet-500/20 shrink-0">
              <RefreshCw className="w-3.5 h-3.5" />
              Recalculate Task Billing
            </button>
          </>
        }
      />

      <div className="p-4 md:p-6 space-y-4">
        {(allActiveClients.length === 0 || allActiveServices.length === 0) ? (
          <p className="text-sm text-muted-foreground">Add clients and services first.</p>
        ) : (
          <div>
            <div className="mb-1">
              <p className="text-xs text-muted-foreground">Click any cell to edit. Changes auto-save when you leave the field.</p>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 my-3">
              <SearchBar value={clientSearch} onChange={setClientSearch} placeholder="Filter clients…" className="flex-1" />
              <SearchBar value={serviceSearch} onChange={setServiceSearch} placeholder="Filter services…" className="flex-1" />
              {(clientSearch || serviceSearch) && (
                <button type="button" onClick={() => { setClientSearch(''); setServiceSearch('') }}
                  className="text-xs text-muted-foreground hover:text-foreground px-2.5 py-1.5 rounded-lg bg-secondary border border-border shrink-0">
                  Clear
                </button>
              )}
            </div>
            <div className="overflow-auto rounded-xl border border-border max-h-[calc(100dvh-260px)]">
              <table className="text-xs w-full border-collapse">
                <thead className="sticky top-0 z-20 bg-card">
                  <tr>
                    <th className="px-4 py-2.5 text-left sticky left-0 bg-card border-r border-b border-border z-30">
                      <div>Client</div>
                      <div className="text-[10px] font-normal text-muted-foreground mt-0.5">
                        {activeClients.length}{clientSearch ? `/${allActiveClients.length}` : ''} clients
                      </div>
                    </th>
                    {activeServices.map((svc) => (
                      <th key={svc.id} className="border-r border-b border-border last:border-r-0 p-0 min-w-[140px]">
                        <div className="px-2 py-1.5 text-center font-medium truncate">{svc.name}</div>
                        <div className="grid grid-cols-2 divide-x divide-border border-t border-border text-[10px] font-normal text-muted-foreground">
                          <div className="py-1 text-center">Price</div>
                          <div className="py-1 text-center">Comm%</div>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {activeClients.map((client) => (
                    <tr key={client.id} className="hover:bg-secondary/10 group">
                      <td className="px-4 py-2.5 sticky left-0 bg-card group-hover:bg-secondary/10 border-r border-border z-10">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-primary font-semibold">{client.code}</span>
                          <span className="text-foreground truncate max-w-[160px]">{client.name}</span>
                        </div>
                      </td>
                      {activeServices.map((svc) => {
                        const key = `${client.id}::${svc.id}`
                        const cell = matrix[key] || { price: '', commission_percentage: '', currency: client.default_currency || 'INR' }
                        const isSaving = matrixSaving === key
                        return (
                          <td key={svc.id} className={`border-r border-border last:border-r-0 p-0 ${isSaving ? 'bg-primary/5' : ''}`}>
                            <div className="grid grid-cols-2 divide-x divide-border">
                              <input type="number" min="0" step="0.01" value={cell.price}
                                onChange={e => updateMatrix(client.id, svc.id, 'price', e.target.value)}
                                onBlur={e => { if (e.target.value !== '') saveMatrixCell(client.id, svc.id, { ...cell, price: e.target.value }) }}
                                placeholder="—" className="w-full bg-transparent px-2 py-2.5 text-center focus:outline-none focus:bg-primary/10 placeholder-muted-foreground/30 transition-colors" />
                              <div className="relative">
                                <input type="number" min="0" max="100" step="0.1" value={cell.commission_percentage}
                                  onChange={e => updateMatrix(client.id, svc.id, 'commission_percentage', e.target.value)}
                                  onBlur={e => { if (e.target.value !== '') saveMatrixCell(client.id, svc.id, { ...cell, commission_percentage: e.target.value }) }}
                                  placeholder="—" className="w-full bg-transparent px-2 py-2.5 text-center focus:outline-none focus:bg-primary/10 placeholder-muted-foreground/30 transition-colors pr-5" />
                                {cell.commission_percentage && <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 pointer-events-none">%</span>}
                              </div>
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground mt-3">Price is billed amount per creative / per unit. Commission % is what comes off the top before employee calculation.</p>
          </div>
        )}
      </div>

      <RecalcBillingModal
        open={showRecalcModal}
        onClose={() => setShowRecalcModal(false)}
        clients={clients}
        services={services}
        clientPricings={clientPricingsArray}
      />
    </>
  )
}
