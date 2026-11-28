'use client'

/**
 * Office team — the roster (who is on Cirqle's office team) and, for the
 * person picked, what they can open: data reach plus every permission area of
 * their role. People by CQID only.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Building2, ChevronRight, Search, ShieldCheck } from 'lucide-react'
import { Badge, Card, useAction } from '../../finance/profit-sharing/_components'
import { inputCls } from '../../finance/profit-sharing/_format'
import { groupPermissions, REACH_KEY, type CatalogPerm, type OfficePerson } from '@/lib/units/office'
import type { OfficeTeamData } from '@/lib/units/office-load'
import { setOfficeStaff, setPersonPermission } from './actions'

export function OfficeTeam({ listInstalled, roster, catalog, roleKeys, units, initialPerson }: OfficeTeamData & { initialPerson: string | null }) {
  const unitName = useMemo(() => new Map(units.map(u => [u.id, u.name])), [units])
  const firstOffice = roster.find(p => p.office && !p.isAdmin) ?? roster.find(p => p.office) ?? roster[0]
  const [picked, setPicked] = useState<string | null>(roster.some(p => p.employeeId === initialPerson) ? initialPerson : firstOffice?.employeeId ?? null)
  const person = roster.find(p => p.employeeId === picked) ?? null
  const { run, busy, host } = useAction()

  const office = roster.filter(p => p.office)
  const others = roster.filter(p => !p.office)

  const row = (p: OfficePerson) => (
    <li key={p.employeeId}>
      <div className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${picked === p.employeeId ? 'bg-primary/10' : 'hover:bg-secondary'}`}>
        <label className="flex items-center" title={listInstalled ? (p.office ? 'Take off the office team' : 'Put on the office team') : 'Needs the office list migration'}>
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={p.office} disabled={!listInstalled || busy !== null}
            aria-label={`${p.cqid} is office staff`}
            onChange={e => run(`office-${p.employeeId}`, () => setOfficeStaff(p.employeeId, e.target.checked), e.target.checked ? `${p.cqid} is on the office team` : `${p.cqid} is off the office team`)} />
        </label>
        <button type="button" onClick={() => setPicked(p.employeeId)} className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left">
          <span className="min-w-0">
            <span className="block text-sm font-medium">{p.cqid}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {p.isAdmin ? 'Admin' : p.roleName ?? 'No role'}
              {p.unitIds.length ? ` · ${p.unitIds.map(u => unitName.get(u)).join(', ')}` : ''}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {p.unplaced && <Badge tone="warn">no team</Badge>}
            {p.sharedWith.length > 0 && !p.isAdmin && <Badge>shared role</Badge>}
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
        </button>
      </div>
    </li>
  )

  return (
    <>
      {host}
      {!listInstalled && (
        <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          The office list needs a one-time database update (supabase/migrations/20261128160000_unit_office_staff.sql).
          Until then, everyone on no unit&apos;s team counts as office staff. Permissions can be set already.
        </p>
      )}
      <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
        <Card title="People" subtitle="Tick the people who work for Cirqle itself.">
          <div className="space-y-4">
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"><Building2 className="h-3.5 w-3.5" /> Office team · {office.length}</div>
              {office.length ? <ul className="space-y-0.5">{office.map(row)}</ul> : <p className="px-2 text-xs text-muted-foreground">No one yet.</p>}
            </div>
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Everyone else · {others.length}</div>
              <ul className="space-y-0.5">{others.map(row)}</ul>
            </div>
          </div>
        </Card>
        {person ? <PersonPermissions key={person.employeeId} person={person} catalog={catalog} on={roleKeys[person.roleId ?? ''] ?? []} unitName={unitName} /> : (
          <Card><p className="py-10 text-center text-sm text-muted-foreground">Pick a person.</p></Card>
        )}
      </div>
    </>
  )
}

function PersonPermissions({ person, catalog, on: initialOn, unitName }: {
  person: OfficePerson; catalog: CatalogPerm[]; on: string[]; unitName: Map<string, string>
}) {
  const { run, busy, host } = useAction()
  const [on, setOn] = useState(() => new Set(initialOn))
  const [query, setQuery] = useState('')
  const [sharedOk, setSharedOk] = useState(false)
  const groups = useMemo(() => groupPermissions(catalog, on), [catalog, on])
  const reach = on.has(REACH_KEY)
  const hasReachKey = catalog.some(p => p.key === REACH_KEY)
  const q = query.trim().toLowerCase()
  const shared = person.sharedWith.length > 0
  const editable = !person.isAdmin && !!person.roleId && (!shared || sharedOk)

  async function toggle(key: string, allowed: boolean, label: string) {
    const before = new Set(on)
    const next = new Set(on)
    if (allowed) next.add(key); else next.delete(key)
    setOn(next)
    const ok = await run(`p-${key}`, () => setPersonPermission(person.employeeId, key, allowed), `${label}: ${allowed ? 'on' : 'off'} for ${person.cqid}`)
    if (!ok) setOn(before)
  }

  return (
    <div className="space-y-4">
      {host}
      <Card title={<span className="flex items-center gap-2">{person.cqid}{person.office && <Badge tone="info">Office team</Badge>}</span>}
        subtitle={<>
          Role: <strong>{person.isAdmin ? 'Admin' : person.roleName ?? 'none'}</strong>
          {person.unitIds.length > 0 && <> · on the team of {person.unitIds.map(u => unitName.get(u)).join(', ')}</>}
        </>}>
        {person.isAdmin ? (
          <p className="flex items-start gap-2 text-sm"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> Admin — sees and does everything. An Admin role cannot be narrowed here.</p>
        ) : !person.roleId ? (
          <p className="text-sm text-muted-foreground">No role yet, so this person can open nothing. Give them a role in <Link href="/dashboard/settings" className="text-primary hover:underline">Settings → Employees</Link>.</p>
        ) : (
          <div className="space-y-3 text-sm">
            {shared && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <span><strong>{person.sharedWith.join(', ')}</strong> {person.sharedWith.length === 1 ? 'has' : 'have'} the same role. A change here changes theirs too.
                  For a different set, make a new role in <Link href="/dashboard/settings/designations" className="text-primary hover:underline">Settings → Designations</Link> and
                  move {person.cqid} to it — their ownership program, chat access and approvals follow the role, so check those after.</span>
                </p>
                <label className="mt-2 flex items-center gap-2 text-xs">
                  <input type="checkbox" className="h-4 w-4 accent-primary" checked={sharedOk} onChange={e => setSharedOk(e.target.checked)} />
                  I understand — let me change the shared role
                </label>
              </div>
            )}
            {hasReachKey && (
              <div className="rounded-lg border border-border p-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Data reach</div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {[
                    { value: true, title: 'All of Cirqle', text: 'Every unit’s clients and work, within what the permissions below allow.' },
                    { value: false, title: 'Only what is assigned', text: 'Only the services and clients given to them in the Access map.' },
                  ].map(o => (
                    <label key={String(o.value)} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 ${reach === o.value ? 'border-primary bg-primary/5' : 'border-border'} ${!editable ? 'cursor-not-allowed opacity-60' : ''}`}>
                      <input type="radio" name="reach" className="mt-0.5 accent-primary" checked={reach === o.value} disabled={!editable || busy !== null}
                        onChange={() => toggle(REACH_KEY, o.value, 'Data reach')} />
                      <span><span className="block font-medium">{o.title}</span><span className="block text-xs text-muted-foreground">{o.text}</span></span>
                    </label>
                  ))}
                </div>
                {!reach && <p className="mt-2 text-xs text-muted-foreground">Assign their services and clients in the <Link href="/dashboard/units/access" className="text-primary hover:underline">Access map</Link>.</p>}
              </div>
            )}
          </div>
        )}
      </Card>

      {!person.isAdmin && person.roleId && (
        <Card title="What they can open" subtitle={`${groups.reduce((t, g) => t + g.on, 0)} permissions on. Changes apply within a minute.`}
          actions={<div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a permission" className={`${inputCls} h-8 w-48 pl-8 text-xs`} /></div>}>
          <div className="space-y-2">
            {groups.map(g => {
              const perms = q ? g.perms.filter(p => `${p.label ?? ''} ${p.key} ${p.description ?? ''} ${g.label}`.toLowerCase().includes(q)) : g.perms
              if (!perms.length) return null
              return (
                <details key={g.module} open={!!q} className="rounded-lg border border-border">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="flex items-center gap-2 font-medium">{g.label}{g.sensitive && <Badge tone="warn">sensitive</Badge>}</span>
                    <span className={`text-xs ${g.on ? 'text-foreground' : 'text-muted-foreground'}`}>{g.on} of {g.perms.length} on</span>
                  </summary>
                  <ul className="divide-y divide-border/60 border-t border-border">
                    {perms.map(p => (
                      <li key={p.key}>
                        <label className={`flex items-start gap-3 px-3 py-2 ${editable ? 'cursor-pointer hover:bg-secondary/50' : 'cursor-not-allowed opacity-70'}`}>
                          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={on.has(p.key)} disabled={!editable || busy !== null}
                            onChange={e => toggle(p.key, e.target.checked, p.label ?? p.key)} />
                          <span className="min-w-0">
                            <span className="block text-sm">{p.label ?? p.key}</span>
                            {p.description && <span className="block text-xs text-muted-foreground">{p.description}</span>}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </details>
              )
            })}
          </div>
        </Card>
      )}
    </div>
  )
}
