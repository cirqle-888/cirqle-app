'use client'

/**
 * Brand switcher — "All brands" or one of Cirqle's brands at a time.
 *
 * Sits under the workspace switcher in the sidebar. Picking a brand narrows
 * the pages that honour the lens (Tasks, Clients) to that brand's work; "All
 * brands" shows everything together. A view, never a permission: it can only
 * hide things, not reveal them. Hidden while there is only one brand.
 */

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Check, ChevronsUpDown, Layers, Loader2, Settings2 } from 'lucide-react'
import { useBrandOptions } from './brand-select'
import { setBrandLens } from '@/app/(dashboard)/dashboard/cirqle-accounts/actions'
import { useWorkspace } from '@/contexts/workspace-context'

const COOKIE = 'cq_brand'

function readCookie(): string | null {
  if (typeof document === 'undefined') return null
  const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`))
  return m ? decodeURIComponent(m[1]) : null
}

export function BrandSwitcher({ isCollapsed }: { isCollapsed: boolean }) {
  const options = useBrandOptions()
  const router = useRouter()
  // A workspace that belongs to a brand decides the brand; the switcher shows
  // it and stays put until you leave that workspace.
  const { current: workspace } = useWorkspace()
  const lockedTo = workspace.brandId ?? null
  const [current, setCurrent] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { setCurrent(readCookie()) }, [])
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (options.length < 2) return null
  const active = options.find(o => o.id === (lockedTo ?? current)) ?? null

  async function pick(id: string | null) {
    setOpen(false); setBusy(true)
    const res = await setBrandLens(id)
    setBusy(false)
    if (res.ok) { setCurrent(id); router.refresh() }
  }

  const swatch = (color: string | null | undefined, cls = 'h-6 w-6') => (
    <span className={`flex ${cls} shrink-0 items-center justify-center rounded-md text-white`} style={{ background: color || '#64748b' }}>
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Layers className="h-3.5 w-3.5" />}
    </span>
  )

  return (
    <div ref={ref} className={`relative px-3 pb-2 ${isCollapsed ? 'px-2' : ''}`}>
      <button
        type="button"
        onClick={() => { if (!lockedTo) setOpen(o => !o) }}
        aria-disabled={!!lockedTo}
        title={lockedTo ? `Brand set by the ${workspace.name} workspace` : isCollapsed ? (active ? `Brand: ${active.name}` : 'All brands') : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex w-full items-center gap-2 rounded-lg border transition-colors hover:bg-sidebar-accent ${
          active ? 'border-primary/40 bg-primary/10' : 'border-sidebar-border bg-sidebar-accent/40'
        } ${isCollapsed ? 'justify-center p-2' : 'px-2.5 py-2'}`}
      >
        {swatch(active?.color ?? null)}
        {!isCollapsed && (
          <>
            <span className="min-w-0 flex-1 text-left">
              <span className="block text-[10px] uppercase tracking-wide text-muted-foreground leading-none">{lockedTo ? 'Brand · by workspace' : 'Brand'}</span>
              <span className="block truncate text-sm font-medium text-sidebar-foreground">{active ? active.name : 'All brands'}</span>
            </span>
            {!lockedTo && <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          </>
        )}
      </button>

      {open && !lockedTo && (
        <div role="listbox" aria-label="Brand"
          className={`absolute top-full z-30 mt-1 w-64 overflow-hidden rounded-xl border border-border bg-popover shadow-xl ${isCollapsed ? 'left-2' : 'left-3 right-3 w-auto'}`}>
          <div className="max-h-72 overflow-y-auto p-1">
            <button type="button" role="option" aria-selected={!active} onClick={() => void pick(null)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-500 text-white"><Layers className="h-3.5 w-3.5" /></span>
              <span className="min-w-0 flex-1 truncate">All brands</span>
              {!active && <Check className="h-4 w-4 shrink-0" />}
            </button>
            {options.map(o => (
              <button key={o.id} type="button" role="option" aria-selected={active?.id === o.id} onClick={() => void pick(o.id)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted">
                <span className="h-6 w-6 shrink-0 rounded-md" style={{ background: o.color || '#64748b' }} />
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                {active?.id === o.id && <Check className="h-4 w-4 shrink-0" />}
              </button>
            ))}
          </div>
          <Link href="/dashboard/cirqle-accounts" onClick={() => setOpen(false)}
            className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
            <Settings2 className="h-3.5 w-3.5" /> Brands overview
          </Link>
        </div>
      )}
    </div>
  )
}
