'use client'

/**
 * The Access map — who is on which unit, which clients belong where, and what
 * one person will actually see. People by CQID only.
 */

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Eye, Search, Shuffle } from 'lucide-react'
import { Badge, Button, Card, Empty, Table, useAction } from '../../finance/profit-sharing/_components'
import { inputCls, td } from '../../finance/profit-sharing/_format'
import { startViewAs } from '@/lib/permissions/view-as-actions'
import { checkPerson, setClientDepartment, setUnitMember, type PersonCheck } from '../actions'

type Reach = 'admin' | 'units' | 'all' | 'org_unit' | 'assigned' | 'nothing'

export interface AccessProps {
  units: { id: string; name: string; color: string | null; kind: 'department' | 'brand'; hasWork: boolean }[]
  departments: { id: string; name: string; unitId: string | null }[]
  people: { id: string; cqid: string; designationName: string | null; reach: Reach; units: Record<string, 'lead' | 'member'>; assignedDepartmentIds: string[] }[]
  clients: { id: string; name: string; boughtDepartmentIds: string[]; pinnedDepartmentId: string | null; unitIds: string[]; mixed: boolean }[]
  designationsWithoutReach: { id: string; name: string; people: string[] }[]
}

const REACH: Record<Reach, { label: string; tone: 'good' | 'info' | 'warn' | 'bad' | 'muted' }> = {
  admin: { label: 'Admin · everything', tone: 'good' },
  all: { label: 'View all', tone: 'good' },
  units: { label: 'Unit team', tone: 'info' },
  org_unit: { label: 'Org unit', tone: 'muted' },
  assigned: { label: 'Assigned departments', tone: 'warn' },
  nothing: { label: 'Sees nothing', tone: 'bad' },
}

export function AccessMap(props: AccessProps) {
  const [tab, setTab] = useState<'people' | 'clients' | 'check'>('people')
  const nothing = props.people.filter(p => p.reach === 'nothing')
  const mixed = props.clients.filter(c => c.mixed).length
  const orphan = props.clients.filter(c => c.unitIds.length === 0).length

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-4">
        <Tile label="Units" value={props.units.length} />
        <Tile label="People who see nothing" value={nothing.length} warn={nothing.length > 0} />
        <Tile label="Mixed clients" value={mixed} hint="in more than one unit" />
        <Tile label="Clients in no unit" value={orphan} warn={orphan > 0} hint="only View-all staff see them" />
      </div>

      {props.designationsWithoutReach.length > 0 && (
        <div className="flex gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">These designations give no reach of their own — their staff see only their assigned departments, or nothing:</p>
            <ul className="list-disc pl-4">
              {props.designationsWithoutReach.map(d => <li key={d.id}>{d.name}: {d.people.join(', ')}</li>)}
            </ul>
            <p>Put each person on a unit&apos;s team below, or give the office designations <b>View all</b> (Settings → Designations).</p>
          </div>
        </div>
      )}

      <nav className="flex gap-1 border-b border-border" aria-label="Access map sections">
        {([['people', 'People'], ['clients', 'Clients'], ['check', 'Check a person']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{l}</button>
        ))}
      </nav>

      {tab === 'people' && <People {...props} />}
      {tab === 'clients' && <Clients {...props} />}
      {tab === 'check' && <Check people={props.people} />}
    </div>
  )
}

function Tile({ label, value, hint, warn }: { label: string; value: number; hint?: string; warn?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${warn ? 'border-amber-500/50 bg-amber-500/5' : 'border-border bg-card'}`}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

// ═══ People ═════════════════════════════════════════════════════════════════

function People({ units, departments, people }: AccessProps) {
  const { run, busy, host } = useAction()
  const deptName = new Map(departments.map(d => [d.id, d.name]))
  return (
    <Card title="Who is on which unit"
      subtitle="A unit's team sees only that unit's clients and work, and only the unit-team pages. Office staff stay off units: give their designation View all, or assign them departments.">
      {host}
      {people.length === 0 ? <Empty>No active staff.</Empty> : (
        <Table head={['Person', 'Designation', 'Reach', ...units.map(u => u.name), 'Assigned departments']}>
          {people.map(p => (
            <tr key={p.id} className="border-b border-border/60 last:border-0">
              <td className={`${td} font-medium`}>{p.cqid}</td>
              <td className={td}><span className="text-xs text-muted-foreground">{p.designationName ?? '—'}</span></td>
              <td className={td}><Badge tone={REACH[p.reach].tone}>{REACH[p.reach].label}</Badge></td>
              {units.map(u => (
                <td key={u.id} className={td}>
                  <select
                    aria-label={`${p.cqid} on ${u.name}`}
                    disabled={!!busy || (!u.hasWork && !p.units[u.id])}
                    title={!u.hasWork ? 'Pick the work this unit covers first' : undefined}
                    value={p.units[u.id] ?? ''}
                    onChange={e => {
                      const v = e.target.value as '' | 'lead' | 'member'
                      run(`${p.id}${u.id}`, () => setUnitMember(u.id, p.id, v || null), v ? `${p.cqid} → ${u.name}` : `${p.cqid} off ${u.name}`)
                    }}
                    className={`rounded-md border px-2 py-1 text-xs ${p.units[u.id] ? 'border-primary/50 bg-primary/10 font-medium' : 'border-border bg-card text-muted-foreground'}`}
                  >
                    <option value="">—</option>
                    <option value="member">Member</option>
                    <option value="lead">Lead</option>
                  </select>
                </td>
              ))}
              <td className={td}>
                <span className="text-xs text-muted-foreground">{p.assignedDepartmentIds.map(id => deptName.get(id)).filter(Boolean).join(', ') || '—'}</span>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}

// ═══ Clients ════════════════════════════════════════════════════════════════

function Clients({ units, departments, clients }: AccessProps) {
  const { run, busy, host } = useAction()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'mixed' | 'none' | string>('all')
  const deptName = new Map(departments.map(d => [d.id, d.name]))
  const unit = new Map(units.map(u => [u.id, u]))
  const rows = useMemo(() => clients.filter(c =>
    (!q || c.name.toLowerCase().includes(q.toLowerCase()))
    && (filter === 'all' || (filter === 'mixed' ? c.mixed : filter === 'none' ? c.unitIds.length === 0 : c.unitIds.includes(filter))),
  ), [clients, q, filter])

  return (
    <div className="space-y-4">
      {host}
      <div className="flex gap-2 rounded-xl border border-border bg-card p-3 text-xs text-muted-foreground">
        <Shuffle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          <b className="text-foreground">How a mixed client works</b> (one that buys from more than one unit, e.g. flyers and social media):
          both teams see the client, but each team sees only <b>its own</b> tasks, requests and plans for it — the other team&apos;s
          work stays hidden. Its invoices are split between the units by line. To keep a client to one team, <b>pin</b> it to a
          department: it then belongs there alone. A client in no unit is seen only by Admins and View-all staff.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input className={`${inputCls} pl-9`} placeholder="Find a client" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <select aria-label="Show" value={filter} onChange={e => setFilter(e.target.value)} className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <option value="all">All clients</option>
          <option value="mixed">Mixed only</option>
          <option value="none">In no unit</option>
          {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>

      <Card title={`Clients (${rows.length})`}>
        {rows.length === 0 ? <Empty>No clients match.</Empty> : (
          <Table head={['Client', 'Buys from', 'Seen by', 'Belongs to']}>
            {rows.map(c => (
              <tr key={c.id} className="border-b border-border/60 last:border-0">
                <td className={`${td} font-medium`}>{c.name} {c.mixed && <Badge tone="info">Mixed</Badge>}</td>
                <td className={td}><span className="text-xs text-muted-foreground">{c.boughtDepartmentIds.map(id => deptName.get(id)).filter(Boolean).join(', ') || 'Nothing set up'}</span></td>
                <td className={td}>
                  {c.unitIds.length ? (
                    <span className="flex flex-wrap gap-1">
                      {c.unitIds.map(id => (
                        <span key={id} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px]">
                          <span className="h-2 w-2 rounded-full" style={{ background: unit.get(id)?.color ?? '#7c3aed' }} />{unit.get(id)?.name}
                        </span>
                      ))}
                    </span>
                  ) : <span className="text-xs text-amber-600">No unit</span>}
                </td>
                <td className={td}>
                  <select
                    aria-label={`Where ${c.name} belongs`}
                    disabled={!!busy}
                    value={c.pinnedDepartmentId ?? ''}
                    onChange={e => run(c.id, () => setClientDepartment(c.id, e.target.value || null), 'Saved')}
                    className="max-w-[200px] rounded-md border border-border bg-card px-2 py-1 text-xs"
                  >
                    <option value="">By what it buys</option>
                    {departments.map(d => <option key={d.id} value={d.id}>Only {d.name}{d.unitId ? ` (${unit.get(d.unitId)?.name})` : ''}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  )
}

// ═══ Check a person ═════════════════════════════════════════════════════════

function Check({ people }: { people: AccessProps['people'] }) {
  const router = useRouter()
  const [id, setId] = useState('')
  const [res, setRes] = useState<PersonCheck | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [viewing, setViewing] = useState(false)

  async function check(personId: string) {
    setId(personId); setRes(null); setErr(null)
    if (!personId) return
    setLoading(true)
    const r = await checkPerson(personId)
    setLoading(false)
    if (r.ok) setRes(r.data ?? null); else setErr(r.error)
  }

  return (
    <Card title="What will this person see?" subtitle="Worked out from their unit, designation and assignments — the same rules the app applies.">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Person" value={id} onChange={e => check(e.target.value)} className="min-w-[200px] rounded-lg border border-border bg-card px-3 py-2 text-sm">
            <option value="">Choose a CQID…</option>
            {people.filter(p => p.reach !== 'admin').map(p => <option key={p.id} value={p.id}>{p.cqid}</option>)}
          </select>
          {id && (
            <Button busy={viewing} onClick={async () => {
              setViewing(true)
              const r = await startViewAs(id)
              setViewing(false)
              if (r.ok) router.push('/dashboard/my-work'); else setErr(r.error ?? 'Could not open the preview.')
            }}><Eye className="h-3.5 w-3.5" /> Open the app as this person</Button>
          )}
        </div>
        {loading && <p className="text-sm text-muted-foreground">Checking…</p>}
        {err && <p className="text-sm text-red-600">{err}</p>}
        {res && (
          <div className="space-y-4 text-sm">
            <p><span className="font-semibold">{res.cqid}</span> <span className="text-muted-foreground">· {res.designation ?? 'No designation'}</span></p>
            <p className="rounded-lg border border-border bg-background/50 px-3 py-2">{res.reach}</p>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Pages ({res.pages.length})</div>
                {res.pages.length ? <ul className="list-disc space-y-0.5 pl-4 text-xs">{res.pages.map(p => <li key={p}>{p}</li>)}</ul> : <p className="text-xs text-muted-foreground">None</p>}
              </div>
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Clients ({res.clients === null ? `all ${res.clientCount}` : res.clientCount})
                </div>
                {res.clients === null
                  ? <p className="text-xs text-muted-foreground">Every client.</p>
                  : res.clients.length ? <ul className="max-h-72 list-disc space-y-0.5 overflow-y-auto pl-4 text-xs">{res.clients.map(c => <li key={c}>{c}</li>)}</ul>
                  : <p className="text-xs text-muted-foreground">None.</p>}
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
