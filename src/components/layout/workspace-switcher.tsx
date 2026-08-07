'use client'

/**
 * Workspace switcher — dropdown in the sidebar to jump between saved UI
 * contexts (All Workspace, HR, Sales, ...). Never changes permissions, only
 * which sidebar items / dashboard widgets are shown.
 */
import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import * as Icons from 'lucide-react'
import { ChevronsUpDown, Check, Settings2, Loader2 } from 'lucide-react'
import { useWorkspace } from '@/contexts/workspace-context'

const COLOR_DOT: Record<string, string> = {
  violet: 'bg-violet-500', blue: 'bg-blue-500', emerald: 'bg-emerald-500',
  amber: 'bg-amber-500', rose: 'bg-rose-500', cyan: 'bg-cyan-500',
  orange: 'bg-orange-500', pink: 'bg-pink-500', slate: 'bg-slate-500',
}

function DynIcon({ name, className }: { name: string; className?: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Cmp = (Icons as any)[name] as React.ElementType | undefined
  return Cmp ? <Cmp className={className} /> : <Icons.LayoutGrid className={className} />
}

export function WorkspaceSwitcher({ isCollapsed }: { isCollapsed: boolean }) {
  const { current, available, canManage, switchTo, switching } = useWorkspace()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  // Always rendered: even with a single workspace the dropdown is the way to
  // "My workspaces", where any employee can design their own personal one.

  return (
    <div ref={ref} className={`relative px-3 pb-2 ${isCollapsed ? 'px-2' : ''}`}>
      <button
        onClick={() => setOpen(o => !o)}
        title={isCollapsed ? current.name : undefined}
        className={`flex w-full items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent/40 transition-colors hover:bg-sidebar-accent ${
          isCollapsed ? 'justify-center p-2' : 'px-2.5 py-2'
        }`}
      >
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white ${COLOR_DOT[current.color] ?? 'bg-slate-500'}`}>
          {switching ? <Loader2 className="h-3 w-3 animate-spin" /> : <DynIcon name={current.icon} className="h-3.5 w-3.5" />}
        </span>
        {!isCollapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-sidebar-foreground">{current.name}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </>
        )}
      </button>

      {open && (
        <div className={`absolute top-full z-30 mt-1 w-64 overflow-hidden rounded-xl border border-border bg-popover shadow-xl ${isCollapsed ? 'left-2' : 'left-3 right-3 w-auto'}`}>
          <div className="max-h-72 overflow-y-auto p-1">
            {available.map(ws => (
              <button
                key={ws.id}
                onClick={() => { setOpen(false); void switchTo(ws.isSystem ? null : ws.id) }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted"
              >
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white ${COLOR_DOT[ws.color] ?? 'bg-slate-500'}`}>
                  <DynIcon name={ws.icon} className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                {ws.id === current.id && <Check className="h-4 w-4 shrink-0 text-foreground" />}
              </button>
            ))}
          </div>
          {/* Managers administer the shared workspaces; everyone else designs
              their own personal ones on the same page (scoped there). */}
          <Link
            href="/dashboard/settings/workspaces"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Settings2 className="h-3.5 w-3.5" /> {canManage ? 'Manage workspaces' : 'My workspaces'}
          </Link>
        </div>
      )}
    </div>
  )
}
