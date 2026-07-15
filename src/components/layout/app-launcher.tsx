'use client'

/**
 * Odoo-style application launcher — a searchable, section-grouped overlay of
 * tiles that mirrors the Sidebar 1:1: same navSections source, same
 * permission/admin gating, same active-page highlight, same Requests badge.
 * Opened from the header's grid icon. Presentation only — routing,
 * permissions, and the Command Palette are untouched.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { LayoutGrid, Search, X, type LucideIcon } from 'lucide-react'
import { usePermissions } from '@/contexts/permission-context'
import { useFavorites } from '@/contexts/favorites-context'
import { useRequestsBadge } from '@/contexts/requests-badge-context'
import { resolveFavoriteIcon } from '@/lib/favorites/icon-map'
import { navSections, isNavItemVisible, resolveActiveHref } from '@/lib/nav-sections'
import { ModalOverlay } from '@/components/ui/modal-overlay'

// ─── Types ──────────────────────────────────────────────────────────────────

type LauncherTile = {
  key: string
  href: string
  label: string
  icon: LucideIcon
  keywords?: string[]
}

type TileGroup = {
  key: string
  label: string
  items: LauncherTile[]
}

const ARROW_KEYS = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End']

function matchesQuery(tile: LauncherTile, sectionLabel: string, q: string): boolean {
  if (!q) return true
  const haystack = [tile.label, sectionLabel, tile.href, ...(tile.keywords ?? [])].join(' ').toLowerCase()
  return haystack.includes(q)
}

// ─── Tile ───────────────────────────────────────────────────────────────────

function TileButton({ tile, active, badge, onNavigate, setRef }: {
  tile: LauncherTile
  active: boolean
  badge?: number
  onNavigate: () => void
  setRef: (el: HTMLAnchorElement | null) => void
}) {
  const Icon = tile.icon
  return (
    <Link
      ref={setRef}
      href={tile.href}
      onClick={onNavigate}
      data-tile-key={tile.key}
      aria-current={active ? 'page' : undefined}
      className={`group relative flex flex-row sm:flex-col items-center gap-3 sm:gap-1.5 p-2.5 sm:p-3 rounded-xl text-left sm:text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        active ? 'bg-primary/10' : 'hover:bg-secondary'
      }`}
    >
      <span className={`relative w-10 h-10 sm:w-11 sm:h-11 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
        active ? 'bg-primary/15' : 'bg-secondary group-hover:bg-background'
      }`}>
        <Icon className={`w-5 h-5 ${active ? 'text-primary' : 'text-foreground'}`} />
        {!!badge && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      <span className={`text-xs sm:text-[11px] font-medium truncate w-full ${active ? 'text-primary font-semibold' : 'text-foreground'}`}>
        {tile.label}
      </span>
    </Link>
  )
}

// ─── Trigger + panel ────────────────────────────────────────────────────────

export function AppLauncherTrigger() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const router = useRouter()
  const pathname = usePathname()
  const { user, can } = usePermissions()
  const { favorites } = useFavorites()
  const requestsBadge = useRequestsBadge()
  const inputRef = useRef<HTMLInputElement>(null)
  const tileRefs = useRef<Map<string, HTMLAnchorElement>>(new Map())

  const close = () => setOpen(false)

  // Fresh search on every open, same as the Command Palette.
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  // Same permission/admin gate as the Sidebar — no separate visibility rules.
  const visibleSections = useMemo(
    () =>
      navSections
        .map(s => ({ label: s.label, items: s.items.filter(i => isNavItemVisible(i, can, user.isAdmin)) }))
        .filter(s => s.items.length > 0),
    [can, user.isAdmin],
  )

  const activeHref = useMemo(() => resolveActiveHref(visibleSections, pathname), [visibleSections, pathname])

  const allGroups = useMemo<TileGroup[]>(() => {
    const groups: TileGroup[] = []
    if (favorites.length > 0) {
      groups.push({
        key: '__favorites',
        label: 'Favorites',
        items: favorites.map(f => ({ key: `fav-${f.id}`, href: f.href, label: f.label, icon: resolveFavoriteIcon(f.iconKey) })),
      })
    }
    visibleSections.forEach((s, i) => {
      groups.push({
        key: s.label ?? `__section-${i}`,
        label: s.label ?? 'Home',
        items: s.items.map(i => ({ key: i.href, href: i.href, label: i.label, icon: i.icon, keywords: i.keywords })),
      })
    })
    return groups
  }, [favorites, visibleSections])

  const q = query.trim().toLowerCase()
  const filteredGroups = useMemo(() => {
    if (!q) return allGroups
    return allGroups
      .map(g => ({ ...g, items: g.items.filter(t => matchesQuery(t, g.label, q)) }))
      .filter(g => g.items.length > 0)
  }, [allGroups, q])

  const flatTiles = useMemo(() => filteredGroups.flatMap(g => g.items), [filteredGroups])

  // Roving arrow-key navigation across tiles (Tab still works — every tile
  // stays in the natural tab order via ModalOverlay's own focus trap).
  function handleResultsKeyDown(e: React.KeyboardEvent) {
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || !ARROW_KEYS.includes(e.key) || flatTiles.length === 0) return
    e.preventDefault()
    const currentIndex = flatTiles.findIndex(t => t.key === target.dataset.tileKey)
    let nextIndex = currentIndex
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, flatTiles.length - 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIndex = currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0)
    else if (e.key === 'Home') nextIndex = 0
    else if (e.key === 'End') nextIndex = flatTiles.length - 1
    const next = flatTiles[nextIndex]
    if (next) tileRefs.current.get(next.key)?.focus()
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && flatTiles.length > 0) {
      e.preventDefault()
      tileRefs.current.get(flatTiles[0].key)?.focus()
    } else if (e.key === 'Enter' && flatTiles.length > 0) {
      e.preventDefault()
      const first = flatTiles[0]
      close()
      router.push(first.href)
    }
  }

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

      {/* Portaled to <body> — the header this trigger lives in has
          backdrop-blur (a CSS filter), which creates a new containing block
          for `position: fixed` descendants and would otherwise shrink this
          overlay down to the header bar's own box instead of the viewport. */}
      {open && typeof document !== 'undefined' && createPortal(
        <ModalOverlay onClose={close} zIndex="z-[100]">
          <div className="w-full max-w-2xl max-h-[85dvh] bg-card border border-border rounded-2xl shadow-2xl flex flex-col animate-in fade-in zoom-in-95 duration-150">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
              <h2 className="font-semibold text-sm">All Apps</h2>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Search */}
            <div className="flex items-center gap-2.5 px-5 py-3 border-b border-border shrink-0">
              <Search className="w-4 h-4 text-muted-foreground/60 shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="Search apps…"
                aria-label="Search apps"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/40"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => { setQuery(''); inputRef.current?.focus() }}
                  aria-label="Clear search"
                  className="text-muted-foreground/50 hover:text-foreground transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Results */}
            <div onKeyDown={handleResultsKeyDown} className="flex-1 min-h-0 p-5 overflow-y-auto overscroll-contain">
              {filteredGroups.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground/40">
                  <Search className="w-8 h-8 opacity-30" />
                  <span className="text-sm">No apps match &ldquo;{query}&rdquo;</span>
                </div>
              )}
              {filteredGroups.map((group, gi) => (
                <div key={group.key} role="group" aria-label={group.label} className={gi > 0 ? 'mt-5' : ''}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-2.5 px-1">
                    {group.label}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-1 sm:gap-2.5 sm:rounded-xl sm:border sm:border-border/60 sm:bg-secondary/20 sm:p-3">
                    {group.items.map(tile => (
                      <TileButton
                        key={tile.key}
                        tile={tile}
                        active={tile.href === activeHref}
                        badge={tile.href === '/dashboard/requests' ? requestsBadge : undefined}
                        onNavigate={close}
                        setRef={el => {
                          if (el) tileRefs.current.set(tile.key, el)
                          else tileRefs.current.delete(tile.key)
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Footer hint */}
            <div className="hidden sm:flex items-center justify-between px-5 py-2.5 border-t border-border text-[10px] text-muted-foreground/30 font-mono shrink-0">
              <span>↑↓←→ navigate · ↵ open</span>
              <span>ESC to close</span>
            </div>
          </div>
        </ModalOverlay>,
        document.body,
      )}
    </>
  )
}
