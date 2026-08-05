'use client'

import { useState, useTransition } from 'react'
import * as Icons from 'lucide-react'
import { Plus, Trash2, X, Check, Lock } from 'lucide-react'
import { navSections } from '@/lib/nav-sections'
import { WORKSPACE_ICONS, WORKSPACE_COLORS, DASHBOARD_WIDGET_KEYS } from '@/lib/workspaces/catalogue'
import { createWorkspace, updateWorkspace, deleteWorkspace, type Workspace } from '@/lib/workspaces/actions'
import { useToast, ToastContainer } from '@/components/ui/toast'
import Header from '@/components/layout/header'

const COLOR_SWATCH: Record<string, string> = {
  violet: 'bg-violet-500', blue: 'bg-blue-500', emerald: 'bg-emerald-500',
  amber: 'bg-amber-500', rose: 'bg-rose-500', cyan: 'bg-cyan-500',
  orange: 'bg-orange-500', pink: 'bg-pink-500', slate: 'bg-slate-500',
}

function DynIcon({ name, className }: { name: string; className?: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Cmp = (Icons as any)[name] as React.ElementType | undefined
  return Cmp ? <Cmp className={className} /> : <Icons.LayoutGrid className={className} />
}

const ALL_NAV_ITEMS = navSections.flatMap(s => s.items.map(i => ({ ...i, section: s.label ?? 'Home' })))

/** CQID only — employee names are private and never fetched for this picker. */
interface Employee { id: string; cqid: string }

export function WorkspacesClient({ initialWorkspaces, employees }: {
  initialWorkspaces: Workspace[]
  employees: Employee[]
}) {
  const [list, setList] = useState<Workspace[]>(initialWorkspaces)
  const [editing, setEditing] = useState<Workspace | 'new' | null>(null)
  const { toasts, dismiss, success: toastSuccess, error: toastErr } = useToast()
  const [, startTransition] = useTransition()

  const remove = (ws: Workspace) => {
    if (ws.isSystem) return
    if (!confirm(`Delete workspace "${ws.name}"? Anyone using it falls back to "All Workspace".`)) return
    setList(prev => prev.filter(w => w.id !== ws.id))
    startTransition(async () => {
      const res = await deleteWorkspace(ws.id)
      if (!res.ok) { toastErr(res.error); setList(initialWorkspaces) }
      else toastSuccess('Workspace deleted')
    })
  }

  return (
    <div>
      <Header title="Workspaces" subtitle="Configure focused UI contexts — HR, Sales, Accounts, and any others you need" />
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-4 flex justify-end">
          <button onClick={() => setEditing('new')}
            className="flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background">
            <Plus className="h-4 w-4" /> New workspace
          </button>
        </div>

        <div className="space-y-2">
          {list.map(ws => (
            <div key={ws.id} className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white ${COLOR_SWATCH[ws.color] ?? 'bg-slate-500'}`}>
                <DynIcon name={ws.icon} className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
                  {ws.name}
                  {ws.isSystem && <Lock className="h-3 w-3 text-muted-foreground" />}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {ws.isSystem ? 'Everyone · shows everything you have access to' : (
                    ws.sidebarModuleHrefs ? `${ws.sidebarModuleHrefs.length} modules` : 'All modules'
                  )}
                  {!ws.isSystem && ` · ${ws.memberIds.length} member${ws.memberIds.length === 1 ? '' : 's'}`}
                </p>
              </div>
              <button onClick={() => setEditing(ws)} className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted">
                Edit
              </button>
              {!ws.isSystem && (
                <button onClick={() => remove(ws)} className="rounded-lg p-1.5 text-muted-foreground hover:text-destructive" aria-label="Delete">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {editing && (
        <WorkspaceEditor
          workspace={editing === 'new' ? null : editing}
          employees={employees}
          onClose={() => setEditing(null)}
          onSaved={(ws) => {
            setList(prev => editing === 'new' ? [...prev, ws] : prev.map(w => w.id === ws.id ? ws : w))
            setEditing(null)
            toastSuccess('Workspace saved')
          }}
          onError={(msg) => toastErr(msg)}
        />
      )}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

function WorkspaceEditor({ workspace, employees, onClose, onSaved, onError }: {
  workspace: Workspace | null
  employees: Employee[]
  onClose: () => void
  onSaved: (ws: Workspace) => void
  onError: (msg: string) => void
}) {
  const [name, setName] = useState(workspace?.name ?? '')
  const [icon, setIcon] = useState(workspace?.icon ?? 'LayoutGrid')
  const [color, setColor] = useState(workspace?.color ?? 'violet')
  const [hrefs, setHrefs] = useState<Set<string>>(new Set(workspace?.sidebarModuleHrefs ?? []))
  const [restrictModules, setRestrictModules] = useState(!!workspace?.sidebarModuleHrefs)
  const [widgets, setWidgets] = useState<Set<string>>(new Set(workspace?.dashboardWidgetKeys ?? []))
  const [restrictWidgets, setRestrictWidgets] = useState(!!workspace?.dashboardWidgetKeys)
  const [landing, setLanding] = useState(workspace?.defaultLandingHref ?? '/dashboard')
  const [members, setMembers] = useState<Set<string>>(new Set(workspace?.memberIds ?? []))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, val: string) => {
    const next = new Set(set)
    next.has(val) ? next.delete(val) : next.add(val)
    setter(next)
  }

  const landingOptions = restrictModules && hrefs.size
    ? ALL_NAV_ITEMS.filter(i => hrefs.has(i.href))
    : ALL_NAV_ITEMS

  const submit = async () => {
    setError(null)
    if (!name.trim()) { setError('A name is required.'); return }
    setSaving(true)
    const payload = {
      name, icon, color,
      sidebarModuleHrefs: restrictModules ? Array.from(hrefs) : null,
      dashboardWidgetKeys: restrictWidgets ? Array.from(widgets) : null,
      defaultLandingHref: landing,
      memberIds: Array.from(members),
    }
    const res = workspace
      ? await updateWorkspace(workspace.id, payload)
      : await createWorkspace(payload)
    setSaving(false)
    if (!res.ok) { setError(res.error); return }
    const id = workspace ? workspace.id : (res.data && 'id' in res.data ? res.data.id : '')
    onSaved({ id, isSystem: workspace?.isSystem ?? false, ...payload })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-background p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{workspace ? `Edit ${workspace.name}` : 'New workspace'}</h2>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>

        {error && <p className="mb-3 text-xs text-destructive">{error}</p>}

        <div className="space-y-4">
          {!workspace?.isSystem ? (
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Workspace name (e.g. HR, Sales, Marketing)"
              className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40" />
          ) : (
            <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">All Workspace (built-in, always shows everything)</p>
          )}

          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">Icon</p>
            <div className="flex flex-wrap gap-1.5">
              {WORKSPACE_ICONS.map(ic => (
                <button key={ic} onClick={() => setIcon(ic)}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${icon === ic ? 'border-foreground bg-muted' : 'border-border hover:bg-muted/50'}`}>
                  <DynIcon name={ic} className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">Color</p>
            <div className="flex flex-wrap gap-1.5">
              {WORKSPACE_COLORS.map(c => (
                <button key={c} onClick={() => setColor(c)}
                  className={`h-7 w-7 rounded-full ${COLOR_SWATCH[c]} ${color === c ? 'ring-2 ring-offset-2 ring-offset-background ring-foreground' : ''}`} />
              ))}
            </div>
          </div>

          {!workspace?.isSystem && (
            <>
              <div>
                <label className="mb-1.5 flex items-center gap-2 text-xs font-medium">
                  <input type="checkbox" checked={restrictModules} onChange={e => setRestrictModules(e.target.checked)} />
                  Restrict sidebar to specific modules
                </label>
                {restrictModules && (
                  <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
                    {navSections.map(section => (
                      <div key={section.label ?? 'home'}>
                        <p className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{section.label ?? 'Home'}</p>
                        {section.items.map(item => (
                          <label key={item.href} className="flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-muted">
                            <input type="checkbox" checked={hrefs.has(item.href)} onChange={() => toggle(hrefs, setHrefs, item.href)} />
                            {item.label}
                          </label>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label className="mb-1.5 flex items-center gap-2 text-xs font-medium">
                  <input type="checkbox" checked={restrictWidgets} onChange={e => setRestrictWidgets(e.target.checked)} />
                  Restrict dashboard widgets
                </label>
                {restrictWidgets && (
                  <div className="space-y-1 rounded-lg border border-border p-2">
                    {DASHBOARD_WIDGET_KEYS.map(w => (
                      <label key={w.key} className="flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-muted">
                        <input type="checkbox" checked={widgets.has(w.key)} onChange={() => toggle(widgets, setWidgets, w.key)} />
                        {w.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <label className="block">
                <span className="mb-1 block text-xs text-muted-foreground">Default landing page</span>
                <select value={landing} onChange={e => setLanding(e.target.value)}
                  className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none">
                  {landingOptions.map(i => <option key={i.href} value={i.href}>{i.label}</option>)}
                </select>
              </label>

              <div>
                <p className="mb-1.5 text-xs text-muted-foreground">Who can switch into this workspace</p>
                <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                  {employees.map(e => (
                    <label key={e.id} className="flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-muted">
                      <input type="checkbox" checked={members.has(e.id)} onChange={() => toggle(members, setMembers, e.id)} />
                      {e.cqid}
                    </label>
                  ))}
                  {employees.length === 0 && <p className="px-1 text-xs text-muted-foreground">No employees found.</p>}
                </div>
              </div>
            </>
          )}

          <button onClick={submit} disabled={saving}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-foreground py-2 text-sm font-medium text-background disabled:opacity-40">
            {saving ? 'Saving…' : <><Check className="h-4 w-4" /> Save workspace</>}
          </button>
        </div>
      </div>
    </div>
  )
}
