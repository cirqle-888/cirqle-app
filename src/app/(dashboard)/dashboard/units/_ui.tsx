'use client'

/**
 * Departments & Brands — the interactive pieces. People are shown by CQID only.
 */

import { useMemo, useState } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { Plus, Search, Trash2, X } from 'lucide-react'
import { Button, Field, useAction } from '../finance/profit-sharing/_components'
import { UNIT_KINDS, UNIT_KIND_LABEL, type UnitKind } from '@/lib/units/engine'
import { inputCls } from '../finance/profit-sharing/_format'
import {
  assignInvoice, deleteDepartment, findInvoices, saveDepartment, saveGeneralCategories, tagEntries,
  type DepartmentInput,
} from './actions'

const ROOT = '/dashboard/units'

// ═══ Month picker ═══════════════════════════════════════════════════════════

export function MonthPicker({ months, value, allLabel = 'Since start' }: { months: string[]; value: string; allLabel?: string | null }) {
  const router = useRouter()
  const path = usePathname()
  const sp = useSearchParams()
  const label = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return (
    <select
      aria-label="Period"
      value={value}
      onChange={e => {
        const next = new URLSearchParams(sp.toString())
        next.set('month', e.target.value)
        router.push(`${path}?${next.toString()}`)
      }}
      className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm"
    >
      {[...months].reverse().map(m => <option key={m} value={m}>{label(m)}</option>)}
      {allLabel && <option value="all">{allLabel}</option>}
    </select>
  )
}

// ═══ Department form ════════════════════════════════════════════════════════

export interface FormDefaults {
  id: string | null
  name: string
  kind: UnitKind
  color: string
  categoryIds: string[]
  revenueBasis: 'collected' | 'invoiced'
  sharesGeneralCosts: boolean
  startMonth: string
  endMonth: string
  notes: string
  isActive: boolean
  teamSeesResults: boolean
  partners: { employeeId: string; sharePct: number }[]
  members: { employeeId: string; role: 'lead' | 'member' }[]
}

export function DepartmentForm({ defaults, categories, takenCategories, employees }: {
  defaults: FormDefaults
  categories: { id: string; name: string; brand: string | null }[]
  /** category id → the other unit that already has it */
  takenCategories: Record<string, string>
  employees: { id: string; cqid: string }[]
}) {
  const router = useRouter()
  const { run, busy, host } = useAction()
  const [f, setF] = useState(defaults)
  const set = <K extends keyof FormDefaults>(k: K, v: FormDefaults[K]) => setF(prev => ({ ...prev, [k]: v }))
  const total = Math.round(f.partners.reduce((s, p) => s + (Number(p.sharePct) || 0), 0) * 1000) / 1000
  const usedEmployees = new Set(f.partners.map(p => p.employeeId))
  const onTeam = new Set(f.members.map(m => m.employeeId))
  // A new unit starts without an agreement; ticking it offers the owner at 100 %.
  const [agreement, setAgreement] = useState(defaults.id ? defaults.partners.length > 0 : false)

  const byBrand = useMemo(() => {
    const m = new Map<string, typeof categories>()
    for (const c of categories) {
      const k = c.brand ?? 'Cirqle Works'
      m.set(k, [...(m.get(k) ?? []), c])
    }
    return [...m]
  }, [categories])

  async function submit() {
    const input: DepartmentInput = {
      id: f.id, name: f.name, kind: f.kind, color: f.color || null, categoryIds: f.categoryIds, revenueBasis: f.revenueBasis,
      sharesGeneralCosts: f.sharesGeneralCosts, teamSeesResults: f.teamSeesResults,
      startMonth: f.startMonth, endMonth: f.endMonth || null, notes: f.notes || null, isActive: f.isActive,
      partners: agreement ? f.partners.filter(p => p.employeeId).map(p => ({ employeeId: p.employeeId, sharePct: Number(p.sharePct) })) : [],
      members: f.members.filter(m => m.employeeId),
    }
    let slug: string | undefined
    const ok = await run('save', async () => {
      const r = await saveDepartment(input)
      if (r.ok) slug = r.data?.slug
      return r
    }, 'Saved')
    if (ok && slug) router.push(`${ROOT}/${slug}`)
  }

  return (
    <div className="space-y-6">
      {host}
      <div className="grid gap-4 md:grid-cols-[1fr_200px_120px]">
        <Field label="Name">
          <input className={inputCls} value={f.name} onChange={e => set('name', e.target.value)} placeholder="Social Media & Creative" />
        </Field>
        <Field label="Type">
          <select className={inputCls} value={f.kind} onChange={e => set('kind', e.target.value as FormDefaults['kind'])}>
            {UNIT_KINDS.map(k => <option key={k} value={k}>{UNIT_KIND_LABEL[k].of}</option>)}
          </select>
        </Field>
        <Field label="Colour">
          <input type="color" className="h-[38px] w-full cursor-pointer rounded-lg border border-border bg-secondary" value={f.color || '#7c3aed'} onChange={e => set('color', e.target.value)} />
        </Field>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">Which work counts here</div>
        <p className="text-[11px] text-muted-foreground">
          Invoices, tasks and clients belong to a unit through their service&apos;s category (Settings → Departments).
          A category can count in only one unit. The team sees only this work.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {byBrand.map(([brand, list]) => (
            <div key={brand} className="rounded-lg border border-border p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{brand}</div>
              <div className="space-y-1.5">
                {list.map(c => {
                  const taken = takenCategories[c.id]
                  const checked = f.categoryIds.includes(c.id)
                  return (
                    <label key={c.id} className={`flex items-center gap-2 text-sm ${taken && !checked ? 'opacity-50' : ''}`}>
                      <input type="checkbox" aria-label={c.name} checked={checked} disabled={!!taken && !checked}
                        onChange={e => set('categoryIds', e.target.checked ? [...f.categoryIds, c.id] : f.categoryIds.filter(x => x !== c.id))} />
                      <span>{c.name}</span>
                      {taken && <span className="text-[11px] text-muted-foreground">· in {taken}</span>}
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">Team — who runs this unit</div>
        <p className="text-[11px] text-muted-foreground">
          Team members (except Admins) see only this unit: its clients, tasks, requests, social calendar and chats,
          and none of Cirqle&apos;s other units. Leave the office team out — what they see comes from their designation.
        </p>
        <div className="space-y-2">
          {f.members.map((m, i) => (
            <div key={i} className="flex items-center gap-2">
              <select className={inputCls} value={m.employeeId} aria-label="Team member"
                onChange={e => set('members', f.members.map((x, j) => j === i ? { ...x, employeeId: e.target.value } : x))}>
                <option value="">Choose a CQID…</option>
                {employees.filter(e => e.id === m.employeeId || !onTeam.has(e.id)).map(e => <option key={e.id} value={e.id}>{e.cqid}</option>)}
              </select>
              <select className={`${inputCls} w-32 shrink-0`} value={m.role} aria-label="Role"
                onChange={e => set('members', f.members.map((x, j) => j === i ? { ...x, role: e.target.value as 'lead' | 'member' } : x))}>
                <option value="member">Member</option>
                <option value="lead">Lead</option>
              </select>
              <button type="button" aria-label="Remove from team" className="rounded-lg p-2 text-muted-foreground hover:bg-secondary"
                onClick={() => set('members', f.members.filter((_, j) => j !== i))}><X className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
        <Button onClick={() => set('members', [...f.members, { employeeId: '', role: f.members.length ? 'member' : 'lead' }])}>
          <Plus className="h-3.5 w-3.5" /> Add to team
        </Button>
        <label className="flex items-start gap-2 pt-1 text-sm">
          <input type="checkbox" className="mt-0.5" checked={f.teamSeesResults} onChange={e => set('teamSeesResults', e.target.checked)} />
          <span>
            The team can see this unit&apos;s results
            <span className="block text-[11px] text-muted-foreground">Read-only: its income, costs, its part of General costs and each partner&apos;s share. Never another unit&apos;s.</span>
          </span>
        </label>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={agreement} onChange={e => setAgreement(e.target.checked)} />
        <span>
          This unit has a profit-and-loss agreement
          <span className="block text-[11px] text-muted-foreground">Without one (like Cirqle Flyers) the unit&apos;s result stays with Cirqle.</span>
        </span>
      </label>

      {agreement && <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium text-muted-foreground">Partners — who shares the profit and the loss</div>
          <span className={`text-xs font-semibold tabular-nums ${Math.abs(total - 100) < 0.001 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600'}`}>
            Total {total}%
          </span>
        </div>
        <div className="space-y-2">
          {f.partners.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <select className={inputCls} value={p.employeeId} aria-label="Partner"
                onChange={e => set('partners', f.partners.map((x, j) => j === i ? { ...x, employeeId: e.target.value } : x))}>
                <option value="">Choose a CQID…</option>
                {employees.filter(e => e.id === p.employeeId || !usedEmployees.has(e.id)).map(e => <option key={e.id} value={e.id}>{e.cqid}</option>)}
              </select>
              <div className="relative w-32 shrink-0">
                <input type="number" min={0} max={100} step="0.5" className={`${inputCls} pr-7 text-right`} value={p.sharePct} aria-label="Share %"
                  onChange={e => set('partners', f.partners.map((x, j) => j === i ? { ...x, sharePct: Number(e.target.value) } : x))} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
              </div>
              <button type="button" aria-label="Remove partner" className="rounded-lg p-2 text-muted-foreground hover:bg-secondary"
                onClick={() => set('partners', f.partners.filter((_, j) => j !== i))}><X className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
        <Button onClick={() => set('partners', [...f.partners, { employeeId: '', sharePct: Math.max(0, Math.round((100 - total) * 1000) / 1000) }])}>
          <Plus className="h-3.5 w-3.5" /> Add partner
        </Button>
      </div>}

      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Results from" hint="Results are worked out from this month.">
          <input type="month" className={inputCls} value={f.startMonth} onChange={e => set('startMonth', e.target.value)} />
        </Field>
        <Field label="Ends (optional)">
          <input type="month" className={inputCls} value={f.endMonth} onChange={e => set('endMonth', e.target.value)} />
        </Field>
        <Field label="Count income when" hint="Collected = money actually received.">
          <select className={inputCls} value={f.revenueBasis} onChange={e => set('revenueBasis', e.target.value as FormDefaults['revenueBasis'])}>
            <option value="collected">Payment is collected</option>
            <option value="invoiced">Invoice is issued</option>
          </select>
        </Field>
      </div>

      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={f.sharesGeneralCosts} onChange={e => set('sharesGeneralCosts', e.target.checked)} />
          <span>
            Carries an equal part of General costs
            <span className="block text-[11px] text-muted-foreground">GPT and other subscriptions, tools, domains — split equally between every unit ticked here.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={f.isActive} onChange={e => set('isActive', e.target.checked)} />
          <span>Active</span>
        </label>
      </div>

      <Field label="Notes (optional)" hint="What this unit does, and any agreement in a sentence or two.">
        <textarea className={`${inputCls} min-h-[72px]`} value={f.notes} onChange={e => set('notes', e.target.value)} />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" busy={busy === 'save'} onClick={submit}>{f.id ? 'Save changes' : 'Create unit'}</Button>
        <Button onClick={() => router.back()}>Cancel</Button>
        {f.id && <DeleteDepartment id={f.id} name={f.name} />}
      </div>
    </div>
  )
}

function DeleteDepartment({ id, name }: { id: string; name: string }) {
  const router = useRouter()
  const { run, busy, host } = useAction()
  return (
    <>
      {host}
      <Button variant="danger" busy={busy === 'del'} onClick={async () => {
        if (!confirm(`Delete ${name}? Its team, agreement, invoice assignments and Cash Book tags are deleted too, and its team is no longer confined to it. Invoices and Cash Book entries are not touched. This cannot be undone.`)) return
        const ok = await run('del', () => deleteDepartment(id), 'Deleted')
        if (ok) router.push(ROOT)
      }}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
    </>
  )
}

// ═══ Invoices ═══════════════════════════════════════════════════════════════

/** Per-invoice control: automatic split, this/another department, or none. */
export function InvoiceAssign({ invoiceId, current, departments }: {
  invoiceId: string
  /** undefined = automatic; null = in no department; else a department id */
  current: string | null | undefined
  departments: { id: string; name: string }[]
}) {
  const { run, busy, host } = useAction()
  const value = current === undefined ? 'auto' : current === null ? 'none' : current
  return (
    <>
      {host}
      <select
        aria-label="Department for this invoice"
        disabled={!!busy}
        value={value}
        onChange={e => {
          const v = e.target.value
          run('a', () => assignInvoice(invoiceId, v === 'auto' ? 'auto' : v === 'none' ? null : v), 'Updated')
        }}
        className="max-w-[180px] rounded-md border border-border bg-card px-2 py-1 text-xs"
      >
        <option value="auto">Automatic (by services)</option>
        {departments.map(d => <option key={d.id} value={d.id}>Whole invoice → {d.name}</option>)}
        <option value="none">Not in any department</option>
      </select>
    </>
  )
}

/** Find any invoice (an Offer Flyer client's big request) and count it whole in this department. */
export function InvoiceAdder({ departmentId, departmentName }: { departmentId: string; departmentName: string }) {
  const { run, busy, host } = useAction()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<{ id: string; number: string | null; client: string | null; issueDate: string | null; totalInr: number; status: string }[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function search() {
    setSearching(true); setErr(null)
    const r = await findInvoices(q)
    setSearching(false)
    if (r.ok) setResults(r.data ?? []); else setErr(r.error)
  }

  if (!open) return <Button onClick={() => setOpen(true)}><Plus className="h-3.5 w-3.5" /> Add an invoice from another department</Button>
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      {host}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input autoFocus className={`${inputCls} pl-9`} placeholder="Client name or invoice number" value={q}
            onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search() }} />
        </div>
        <Button busy={searching} onClick={search}>Search</Button>
        <button type="button" aria-label="Close" className="rounded-lg p-2 text-muted-foreground hover:bg-secondary" onClick={() => { setOpen(false); setResults(null) }}><X className="h-4 w-4" /></button>
      </div>
      <p className="text-[11px] text-muted-foreground">The whole invoice&apos;s own revenue (not ad spend or rebilled costs) will count in {departmentName}.</p>
      {err && <p className="text-xs text-red-600">{err}</p>}
      {results && (results.length === 0
        ? <p className="text-xs text-muted-foreground">No invoices found.</p>
        : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {results.map(r => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{r.number ?? 'Invoice'}</span>
                  <span className="text-muted-foreground"> · {r.client ?? '—'} · {r.issueDate ?? ''} · {r.status}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums text-xs">₹{r.totalInr.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                  <Button busy={busy === r.id} onClick={() => run(r.id, () => assignInvoice(r.id, departmentId), `Added to ${departmentName}`)}>Add</Button>
                </span>
              </li>
            ))}
          </ul>
        ))}
    </div>
  )
}

// ═══ Cash Book tags ═════════════════════════════════════════════════════════

/** Buttons on one entry: move it to this department, General, or back. */
export function EntryActions({ entryId, departmentId, departmentName, mode }: {
  entryId: string
  departmentId: string
  departmentName: string
  /** untagged: offer both; otherwise how the entry counts here now */
  mode: 'untagged' | 'direct-tagged' | 'direct-auto' | 'general-tagged' | 'general-auto'
}) {
  const { run, busy, host } = useAction()
  const btn = 'rounded-md border border-border px-2 py-0.5 text-[11px] font-medium hover:bg-secondary disabled:opacity-50'
  const toDept = <button className={btn} disabled={!!busy} onClick={() => run('d', () => tagEntries([entryId], { departmentId }), `Moved to ${departmentName}`)}>{departmentName}</button>
  const toGeneral = <button className={btn} disabled={!!busy} onClick={() => run('g', () => tagEntries([entryId], 'general'), 'Marked General')}>General</button>
  const remove = <button className={btn} disabled={!!busy} onClick={() => run('u', () => tagEntries([entryId], 'auto'), 'Tag removed')}>Remove</button>
  const leaveOut = (
    <button className={btn} disabled={!!busy} title="Counts here automatically. Leave it out of every department."
      onClick={() => run('x', () => tagEntries([entryId], 'exclude'), 'Left out')}>Leave out</button>
  )
  return (
    <span className="inline-flex flex-wrap gap-1">
      {host}
      {mode === 'untagged' && <>{toDept}{toGeneral}</>}
      {mode === 'direct-tagged' && <>{remove}{toGeneral}</>}
      {mode === 'direct-auto' && <>{leaveOut}{toGeneral}</>}
      {mode === 'general-tagged' && <>{remove}{toDept}</>}
      {mode === 'general-auto' && <>{leaveOut}{toDept}</>}
    </span>
  )
}

/** Tag several untagged entries at once. */
export function BulkTagger({ entryIds, departmentId, departmentName }: { entryIds: string[]; departmentId: string; departmentName: string }) {
  const { run, busy, host } = useAction()
  if (entryIds.length < 2) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs">
      {host}
      <span className="text-muted-foreground">All {entryIds.length}:</span>
      <Button busy={busy === 'd'} onClick={() => run('d', () => tagEntries(entryIds, { departmentId }), `Added to ${departmentName}`)}>{departmentName}</Button>
      <Button busy={busy === 'g'} onClick={() => run('g', () => tagEntries(entryIds, 'general'), 'Marked General')}>General</Button>
    </span>
  )
}

// ═══ General categories ═════════════════════════════════════════════════════

export function GeneralCategories({ categories, selected }: {
  categories: { id: string; name: string; type: string | null; group: string | null }[]
  selected: string[]
}) {
  const { run, busy, host } = useAction()
  const [sel, setSel] = useState<string[]>(selected)
  const outflow = categories.filter(c => c.type !== 'inflow')
  const changed = sel.length !== selected.length || sel.some(s => !selected.includes(s))
  return (
    <div className="space-y-3">
      {host}
      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {outflow.map(c => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sel.includes(c.id)} onChange={e => setSel(e.target.checked ? [...sel, c.id] : sel.filter(x => x !== c.id))} />
            <span>{c.name}</span>
            {c.group && <span className="text-[11px] text-muted-foreground">· {c.group}</span>}
          </label>
        ))}
      </div>
      <Button variant="primary" disabled={!changed} busy={busy === 's'} onClick={() => run('s', () => saveGeneralCategories(sel), 'Saved')}>Save General categories</Button>
    </div>
  )
}
