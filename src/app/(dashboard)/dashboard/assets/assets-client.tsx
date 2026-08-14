'use client'

/**
 * Asset Assignment.
 *
 * Unassigned assets lead — they are the only ones costing anything by sitting
 * there, because until an asset has an owner its reach, leads and spend appear
 * in nobody's report. Everything else is grouped by owner underneath.
 *
 * Moves that change money or reclassify data as internal ask for confirmation;
 * the server decides which those are (@/lib/assets/ownership), so the rule
 * cannot drift between the button and the write.
 */

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Header from '@/components/layout/header'
import AppSelect from '@/components/ui/app-select'
import { EmptyState } from '@/components/ui/empty-state'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { ASSET_KIND_LABEL, type AssetRow } from '@/lib/assets/registry'
import type { AssetOwnerType } from '@/lib/assets/ownership'
import { assignAsset } from './actions'
import { Megaphone, ClipboardList, Building2, Lock, AlertTriangle } from 'lucide-react'
import { PlatformIcon } from '@/components/social-hub/platform-icon'

/** Social kinds reuse the shared PlatformIcon; the rest are plain lucide. */
function KindIcon({ kind, className }: { kind: string; className?: string }) {
  if (kind === 'facebook_page' || kind === 'instagram') {
    return <PlatformIcon platform={kind} className={className} />
  }
  const Icon = kind === 'ad_account' ? Megaphone : kind === 'lead_form' ? ClipboardList : Building2
  return <Icon className={className} />
}

/** The select's value encodes both dimensions: owner type AND which client. */
const CIRQLE = 'cirqle'
const UNASSIGNED = 'unassigned'

interface PendingMove {
  asset: AssetRow
  ownerType: AssetOwnerType
  clientId: string | null
  message: string
}

export default function AssetsClient({
  assets: initialAssets, clients, canAssign,
}: {
  assets: AssetRow[]
  clients: { id: string; name: string }[]
  canAssign: boolean
}) {
  const router = useRouter()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const [assets, setAssets] = useState(initialAssets)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingMove | null>(null)

  const groups = useMemo(() => {
    const unassigned = assets.filter(a => a.ownerType === 'unassigned')
    const cirqle = assets.filter(a => a.ownerType === 'cirqle')
    const byClient = new Map<string, { name: string; rows: AssetRow[] }>()
    for (const a of assets) {
      if (a.ownerType !== 'client' || !a.clientId) continue
      const g = byClient.get(a.clientId) ?? { name: a.clientName ?? 'Unknown client', rows: [] }
      g.rows.push(a)
      byClient.set(a.clientId, g)
    }
    return {
      unassigned,
      cirqle,
      clients: [...byClient.entries()].sort((x, y) => x[1].name.localeCompare(y[1].name)),
    }
  }, [assets])

  const valueFor = (a: AssetRow) =>
    a.ownerType === 'client' ? (a.clientId ?? '') : a.ownerType

  async function commit(asset: AssetRow, ownerType: AssetOwnerType, clientId: string | null, confirmed: boolean) {
    setBusyId(asset.id)
    try {
      const res = await assignAsset({
        kind: asset.kind, assetId: asset.id, ownerType, clientId, confirmed,
      })
      if (res.needsConfirmation) {
        setPending({ asset, ownerType, clientId, message: res.confirmationMessage ?? 'Confirm this change?' })
        return
      }
      if (!res.ok) { toastError('Could not assign', res.error); return }

      const clientName = clientId ? clients.find(c => c.id === clientId)?.name ?? null : null
      setAssets(prev => prev.map(x => x.id === asset.id
        ? { ...x, ownerType, clientId, clientName, assignedAt: new Date().toISOString() }
        : x))
      success(
        'Assigned',
        ownerType === 'cirqle' ? `${asset.name} → Cirqle's own accounts`
          : ownerType === 'unassigned' ? `${asset.name} → unassigned`
            : `${asset.name} → ${clientName}`,
      )
      router.refresh()
    } finally {
      setBusyId(null)
    }
  }

  function onPick(asset: AssetRow, raw: string) {
    if (raw === CIRQLE) return commit(asset, 'cirqle', null, false)
    if (raw === UNASSIGNED) return commit(asset, 'unassigned', null, false)
    return commit(asset, 'client', raw, false)
  }

  const AssetRowView = ({ a }: { a: AssetRow }) => {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 border-t border-border/60 first:border-t-0">
        <KindIcon kind={a.kind} className="w-4 h-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm truncate">{a.name}</p>
          <p className="text-[11px] text-muted-foreground truncate">
            {ASSET_KIND_LABEL[a.kind]}
            {a.externalId && <> · {a.externalId}</>}
            {a.currency && <> · {a.currency}</>}
          </p>
        </div>
        {/* A locked asset is one a human has decided — sync will not touch it. */}
        {a.assignedAt && (
          <span title="Assigned by hand — sync and rediscovery will not change it"
            className="shrink-0 text-muted-foreground/60">
            <Lock className="w-3 h-3" />
          </span>
        )}
        {canAssign ? (
          <AppSelect
            value={valueFor(a)}
            disabled={busyId === a.id}
            onChange={e => onPick(a, e.target.value)}
            wrapperClassName="w-56 shrink-0"
          >
            <option value={UNASSIGNED}>— Unassigned —</option>
            <option value={CIRQLE}>Cirqle (our own)</option>
            <optgroup label="Clients">
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </optgroup>
          </AppSelect>
        ) : (
          <span className="text-xs text-muted-foreground shrink-0">
            {a.ownerType === 'cirqle' ? 'Cirqle' : a.clientName ?? 'Unassigned'}
          </span>
        )}
      </div>
    )
  }

  const Section = ({ title, subtitle, rows, tone }: {
    title: string; subtitle?: string; rows: AssetRow[]; tone?: 'warn' | 'agency'
  }) => (
    <div className={`rounded-xl border bg-card overflow-hidden ${
      tone === 'warn' ? 'border-amber-500/40' : tone === 'agency' ? 'border-primary/30' : 'border-border'
    }`}>
      <div className="px-4 py-2.5 flex items-center gap-2 border-b border-border/60">
        {tone === 'warn' && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
        <p className="text-xs font-semibold">{title}</p>
        <span className="text-[11px] text-muted-foreground tabular-nums">{rows.length}</span>
        {subtitle && <span className="text-[11px] text-muted-foreground ml-auto">{subtitle}</span>}
      </div>
      {rows.map(a => <AssetRowView key={a.id} a={a} />)}
    </div>
  )

  return (
    <>
      <Header
        title="Asset Assignment"
        subtitle="Every connected Page, Instagram account, ad account and lead form — and whose it is"
      />

      <div className="p-4 md:p-6 space-y-4 max-w-4xl">
        {assets.length === 0 ? (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState
              icon={Building2}
              title="No assets discovered yet"
              body="Connect Meta or Google in Connections. Everything the login can reach appears here, and you decide which client each asset belongs to — or mark it as one of Cirqle's own."
              action={{ label: 'Go to Connections', onClick: () => { window.location.href = '/dashboard/connections' } }}
            />
          </div>
        ) : (
          <>
            {/* Unassigned leads: until triaged, these appear in nobody's report. */}
            {groups.unassigned.length > 0 && (
              <Section
                title="Unassigned"
                subtitle="not in any report until assigned"
                rows={groups.unassigned}
                tone="warn"
              />
            )}

            {groups.cirqle.length > 0 && (
              <Section
                title="Cirqle — our own accounts"
                subtitle="excluded from all client reporting"
                rows={groups.cirqle}
                tone="agency"
              />
            )}

            {groups.clients.map(([id, g]) => (
              <Section key={id} title={g.name} rows={g.rows} />
            ))}
          </>
        )}
      </div>

      {pending && (
        <ConfirmDialog
          title="Confirm this move"
          body={pending.message}
          confirmLabel="Move it"
          danger
          onConfirm={() => {
            const p = pending
            setPending(null)
            void commit(p.asset, p.ownerType, p.clientId, true)
          }}
          onCancel={() => setPending(null)}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </>
  )
}
