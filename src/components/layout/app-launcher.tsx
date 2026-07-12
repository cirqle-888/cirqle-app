'use client'

/**
 * Odoo-style icon-grid app launcher — a full-screen overlay of tiles, one per
 * nav destination (same navSections/permission source as the sidebar), plus
 * Favorites first for quick access. Opened from the sidebar's search/
 * notifications icon row.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { LayoutGrid, X } from 'lucide-react'
import { usePermissions } from '@/contexts/permission-context'
import { useFavorites } from '@/contexts/favorites-context'
import { resolveFavoriteIcon } from '@/lib/favorites/icon-map'
import { navSections } from '@/lib/nav-sections'

function Tile({ href, label, icon: Icon, onClick, muted = false }: {
  href: string; label: string; icon: typeof LayoutGrid; onClick: () => void; muted?: boolean
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-secondary transition-colors text-center"
    >
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${muted ? 'bg-secondary' : 'bg-primary/10'}`}>
        <Icon className={`w-5 h-5 ${muted ? 'text-foreground' : 'text-primary'}`} />
      </div>
      <span className="text-xs font-medium text-foreground truncate w-full">{label}</span>
    </Link>
  )
}

export function AppLauncherTrigger() {
  const [open, setOpen] = useState(false)
  const { user, can } = usePermissions()
  const { favorites } = useFavorites()

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const tiles = useMemo(() => {
    const flat = navSections.flatMap(s => s.items).filter(i =>
      (!i.requiredPerm || can(i.requiredPerm)) && (!i.adminOnly || user.isAdmin),
    )
    const seen = new Set<string>()
    return flat.filter(i => (seen.has(i.href) ? false : (seen.add(i.href), true)))
  }, [can, user.isAdmin])

  const close = () => setOpen(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative flex items-center justify-center h-8 w-8 rounded-lg text-muted-foreground/60 bg-foreground/[0.03] border border-foreground/[0.06] hover:border-foreground/[0.12] hover:text-muted-foreground transition-all shrink-0"
        title="All apps"
      >
        <LayoutGrid className="w-3.5 h-3.5" />
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 backdrop-blur-sm p-4 pt-[10vh] overflow-y-auto"
          onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}
        >
          <div className="bg-card border border-border rounded-2xl w-full max-w-2xl shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <p className="font-semibold text-sm">All Apps</p>
              <button onClick={close} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 max-h-[70dvh] overflow-y-auto">
              {favorites.length > 0 && (
                <>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-3">Favorites</p>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-3 mb-6">
                    {favorites.map(fav => (
                      <Tile key={fav.id} href={fav.href} label={fav.label} icon={resolveFavoriteIcon(fav.iconKey)} onClick={close} />
                    ))}
                  </div>
                </>
              )}
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-3">All Modules</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                {tiles.map(tile => (
                  <Tile key={tile.href} href={tile.href} label={tile.label} icon={tile.icon} onClick={close} muted />
                ))}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
