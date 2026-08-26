'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, Check, X as XIcon, Loader2, ShieldCheck } from 'lucide-react'
import Header from '@/components/layout/header'
import Combobox from '@/components/ui/combobox'
import { navSections, isNavItemVisible } from '@/lib/nav-sections'
import { previewEmployeeAccess, type AccessPreview } from './actions'
import { startViewAs } from '@/lib/permissions/view-as-actions'

interface EmployeeOption {
  id: string
  cqid: string
  designationName: string | null
  isArchived: boolean
}

export default function AccessPreviewClient({ employees }: { employees: EmployeeOption[] }) {
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<AccessPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [entering, setEntering] = useState(false)
  const router = useRouter()

  async function enterViewAs() {
    if (!selected) return
    setEntering(true)
    const res = await startViewAs(selected)
    if (!res.ok) { setEntering(false); setError(res.error ?? 'Could not start preview.'); return }
    // Land on the dashboard — their home, and the honest first thing to see
    // through their eyes. router.refresh() first so the layout re-reads the
    // cookie and paints the banner.
    router.refresh()
    router.push('/dashboard')
  }

  async function pick(id: string) {
    setSelected(id)
    setPreview(null); setError(null)
    if (!id) return
    setLoading(true)
    const res = await previewEmployeeAccess(id)
    setLoading(false)
    if (!res.ok || !res.data) { setError(res.error ?? 'Could not load access.'); return }
    setPreview(res.data)
  }

  // The SAME gate the sidebar, app launcher and command palette use. Reusing it
  // is the whole point: a preview that re-implemented the rule would drift from
  // what the employee actually sees the first time either side changed.
  const nav = useMemo(() => {
    if (!preview) return null
    const held = new Set(preview.permissionKeys)
    const can = (key: string) => preview.isAdmin || held.has(key)
    const visible: { section: string; label: string; href: string }[] = []
    const hidden: { section: string; label: string; reason: string }[] = []
    for (const section of navSections) {
      for (const item of section.items) {
        const sec = section.label ?? 'General'
        if (isNavItemVisible(item, can, preview.isAdmin)) {
          visible.push({ section: sec, label: item.label, href: item.href })
        } else {
          const reason = item.adminOnly && !preview.isAdmin
            ? 'admins only'
            : item.requiredPerm && !can(item.requiredPerm)
              ? `needs ${item.requiredPerm}`
              : item.requiredAnyPerm?.length
                ? `needs one of ${item.requiredAnyPerm.join(', ')}`
                : 'restricted'
          hidden.push({ section: sec, label: item.label, reason })
        }
      }
    }
    return { visible, hidden }
  }, [preview])

  const byModule = useMemo(() => {
    if (!preview) return []
    const groups: Record<string, string[]> = {}
    for (const k of preview.permissionKeys) {
      const mod = k.split('.')[0]
      ;(groups[mod] ||= []).push(k)
    }
    return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]))
  }, [preview])

  return (
    <div className="space-y-5 pb-10">
      <Header
        title="Access Preview"
        subtitle="See exactly what another employee can open — without signing in as them"
      />

      <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
        <label className="block text-xs font-medium text-muted-foreground">Employee</label>
        <div className="max-w-sm">
          <Combobox
            options={employees.map(e => ({
              id: e.id,
              label: e.cqid,
              sub: [e.designationName ?? 'no designation', e.isArchived ? 'archived' : null].filter(Boolean).join(' · '),
            }))}
            value={selected}
            onChange={pick}
            placeholder="Search by CQID…"
            sortKey="employees"
          />
        </div>
        <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-px" />
          Read-only. This resolves their designation and permissions the same way sign-in does;
          your own session is untouched and nothing can be done as them.
        </p>

        {preview && (
          <div className="pt-1 border-t border-border/60">
            <button
              onClick={enterViewAs}
              disabled={entering}
              className="inline-flex items-center gap-1.5 rounded-lg gradient-bg text-white px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              {entering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
              Browse the app as {preview.cqid}
            </button>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Opens the real app through their permissions so you can see their actual screens and data.
              Still read-only — every save, edit and delete is refused while previewing, and a banner
              stays on screen until you exit.
            </p>
          </div>
        )}
      </div>

      {loading && (
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <Loader2 className="w-5 h-5 animate-spin mx-auto text-primary" />
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</div>
      )}

      {preview && nav && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat value={preview.designationName ?? '—'} label="Designation" small />
            <Stat value={preview.isAdmin ? 'Yes' : 'No'} label="Admin" tone={preview.isAdmin ? 'amber' : undefined} />
            <Stat value={`${preview.permissionKeys.length} / ${preview.catalogSize}`} label="Permissions held" />
            <Stat value={String(nav.visible.length)} label="Pages they can open" tone="green" />
          </div>

          {preview.isAdmin && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-600 dark:text-amber-400">
              This designation is marked <strong>admin</strong>, which bypasses every permission check —
              they hold all {preview.catalogSize} keys regardless of what is granted explicitly.
            </div>
          )}
          {preview.isArchived && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-400">
              This employee is <strong>archived</strong>. Archived accounts are denied everything at sign-in,
              so in practice they can open nothing — whatever the list below says.
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Can open" count={nav.visible.length} tone="green">
              {nav.visible.map(i => (
                <Row key={i.href} icon={<Check className="w-3.5 h-3.5 text-green-500 shrink-0" />}
                     label={i.label} meta={i.section} />
              ))}
            </Panel>
            <Panel title="Hidden from them" count={nav.hidden.length} tone="muted">
              {nav.hidden.map(i => (
                <Row key={`${i.section}-${i.label}`} icon={<XIcon className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />}
                     label={i.label} meta={i.reason} dim />
              ))}
            </Panel>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="text-sm font-semibold mb-3">Permission keys held</p>
            {byModule.length === 0 ? (
              <p className="text-xs text-muted-foreground">None — this employee holds no permissions at all.</p>
            ) : (
              <div className="space-y-3">
                {byModule.map(([mod, keys]) => (
                  <div key={mod}>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">{mod}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {keys.map(k => (
                        <span key={k} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-secondary text-muted-foreground border border-border">
                          {k.split('.').slice(1).join('.')}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {!preview && !loading && !error && (
        <div className="rounded-2xl border border-border bg-card px-5 py-12 text-center">
          <Eye className="w-7 h-7 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">Pick an employee to see what they can reach.</p>
        </div>
      )}
    </div>
  )
}

function Stat({ value, label, tone, small }: { value: string; label: string; tone?: 'green' | 'amber'; small?: boolean }) {
  const colour = tone === 'green' ? 'text-green-500' : tone === 'amber' ? 'text-amber-500' : ''
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className={`font-bold ${small ? 'text-lg' : 'text-2xl'} ${colour} truncate`} title={value}>{value}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
    </div>
  )
}

function Panel({ title, count, tone, children }: {
  title: string; count: number; tone: 'green' | 'muted'; children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="text-sm font-semibold">{title}</span>
        <span className={`text-[11px] px-1.5 py-0.5 rounded-full border ${
          tone === 'green' ? 'bg-green-500/15 text-green-500 border-green-500/25' : 'bg-secondary text-muted-foreground border-border'
        }`}>{count}</span>
      </div>
      <div className="divide-y divide-border/60 max-h-80 overflow-y-auto">
        {count === 0 ? <p className="px-4 py-6 text-xs text-muted-foreground text-center">Nothing</p> : children}
      </div>
    </div>
  )
}

function Row({ icon, label, meta, dim }: { icon: React.ReactNode; label: string; meta: string; dim?: boolean }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      {icon}
      <span className={`text-sm flex-1 min-w-0 truncate ${dim ? 'text-muted-foreground' : ''}`}>{label}</span>
      <span className="text-[10px] text-muted-foreground/60 shrink-0 truncate max-w-[45%]" title={meta}>{meta}</span>
    </div>
  )
}
