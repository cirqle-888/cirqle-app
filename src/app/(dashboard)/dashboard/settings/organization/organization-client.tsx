'use client'

/**
 * Organization — one flat list of units, each expanding to its managers,
 * members and revenue scopes.
 *
 * Deliberately minimal UI over a complete model: a single owner needs almost
 * none of this today, but the moment a second branch or a team lead exists,
 * it is configuration rather than a schema migration.
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2, ChevronDown, Crown, Loader2 } from 'lucide-react'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import AppSelect from '@/components/ui/app-select'
import { ORG_UNIT_TYPES, ORG_UNIT_TYPE_LABEL, type OrgUnit, type OrgMember, type OrgUnitType } from '@/lib/org/units'
import { saveUnit, deleteUnit, saveMember, removeMember, addScope, removeScope } from './actions'

interface ScopeRow {
  id: string
  unit_id: string
  client_id: string | null
  service_category_id: string | null
  service_id: string | null
}

interface Props {
  units: OrgUnit[]
  members: OrgMember[]
  scopeRows: ScopeRow[]
  employees: { id: string; cqid: string }[]
  clients: { id: string; name: string }[]
  services: { id: string; name: string }[]
  categories: { id: string; name: string }[]
  migrated: boolean
}

export default function OrganizationClient(p: Props) {
  const router = useRouter()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [unitModal, setUnitModal] = useState<OrgUnit | 'new' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const refresh = () => startTransition(() => router.refresh())

  const cqid = (id: string) => p.employees.find(e => e.id === id)?.cqid ?? '—'
  const scopeLabel = (s: ScopeRow) =>
    s.client_id ? `Client: ${p.clients.find(c => c.id === s.client_id)?.name ?? '—'}`
    : s.service_category_id ? `Department: ${p.categories.find(c => c.id === s.service_category_id)?.name ?? '—'}`
    : `Service: ${p.services.find(x => x.id === s.service_id)?.name ?? '—'}`

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <div className="pl-14 md:pl-0 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Organization</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Departments, teams, branches, regions and client groups. Add one only when you
            actually need it — nothing here is required, and ownership rules can target the
            whole company, a client or a service without any of it.
          </p>
        </div>
        <button onClick={() => setUnitModal('new')}
          className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3 py-2 text-sm font-medium text-white hover:opacity-90">
          <Plus className="h-4 w-4" /> New unit
        </button>
      </div>

      {p.units.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
          <p className="text-sm font-medium">No units yet — and that is fine</p>
          <p className="mt-1 text-xs text-muted-foreground max-w-md mx-auto">
            Create one when you have a real team or branch to model. A unit becomes useful once
            you map revenue to it, which lets an ownership rule pay a percentage of that unit&rsquo;s billing.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {p.units.map(u => {
          const unitMembers = p.members.filter(m => m.unitId === u.id)
          const unitScopes = p.scopeRows.filter(s => s.unit_id === u.id)
          const open = expanded === u.id
          const parent = u.parentId ? p.units.find(x => x.id === u.parentId) : null
          return (
            <div key={u.id} className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-3">
                <button onClick={() => setExpanded(open ? null : u.id)} className="flex items-center gap-2 min-w-0 text-left">
                  <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} />
                  <span className="font-semibold truncate">{u.name}</span>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                    {ORG_UNIT_TYPE_LABEL[u.type]}
                  </span>
                  {parent && <span className="text-xs text-muted-foreground">in {parent.name}</span>}
                  <span className="text-xs text-muted-foreground">
                    · {unitMembers.length} member{unitMembers.length === 1 ? '' : 's'} · {unitScopes.length} scope{unitScopes.length === 1 ? '' : 's'}
                  </span>
                </button>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => setUnitModal(u)}
                    className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium hover:bg-secondary">Edit</button>
                  <button onClick={async () => {
                    if (!confirm(`Delete "${u.name}"? Its members and revenue mappings go with it.`)) return
                    setBusy(u.id)
                    const res = await deleteUnit(u.id)
                    setBusy(null)
                    if (!res.ok) { toastError('Could not delete', res.error); return }
                    success('Unit deleted'); refresh()
                  }} disabled={busy === u.id}
                    className="rounded-md p-1.5 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 disabled:opacity-50">
                    {busy === u.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>

              {open && (
                <div className="grid gap-4 p-4 sm:grid-cols-2">
                  {/* Members — several managers per unit are expected. */}
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">People</h3>
                    <div className="space-y-1.5">
                      {unitMembers.length === 0 && <p className="text-xs text-muted-foreground">Nobody assigned.</p>}
                      {unitMembers.map(m => (
                        <div key={m.employeeId} className="flex items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm">
                          <span className="inline-flex items-center gap-1.5 min-w-0">
                            {m.isManager && <Crown className="h-3 w-3 text-amber-500 shrink-0" aria-label="Manager" />}
                            <span className="truncate">{cqid(m.employeeId)}</span>
                            {m.roleLabel && <span className="text-xs text-muted-foreground truncate">· {m.roleLabel}</span>}
                          </span>
                          <button onClick={async () => {
                            const res = await removeMember(u.id, m.employeeId)
                            if (!res.ok) { toastError('Could not remove', res.error); return }
                            refresh()
                          }} className="rounded p-1 text-muted-foreground hover:text-red-500 shrink-0">
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                    <AddMember unitId={u.id} employees={p.employees} taken={unitMembers.map(m => m.employeeId)}
                      onDone={refresh} onError={m => toastError('Could not add', m)} />
                  </div>

                  {/* Revenue scopes — what makes a unit-scoped rule computable. */}
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Revenue it owns</h3>
                    <div className="space-y-1.5">
                      {unitScopes.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          Nothing mapped — a rule scoped to this unit would pay nothing.
                        </p>
                      )}
                      {unitScopes.map(s => (
                        <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm">
                          <span className="truncate">{scopeLabel(s)}</span>
                          <button onClick={async () => {
                            const res = await removeScope(s.id)
                            if (!res.ok) { toastError('Could not remove', res.error); return }
                            refresh()
                          }} className="rounded p-1 text-muted-foreground hover:text-red-500 shrink-0">
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                    <AddScope unitId={u.id} clients={p.clients} services={p.services} categories={p.categories}
                      onDone={refresh} onError={m => toastError('Could not add', m)} />
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {unitModal && (
        <UnitModal
          initial={unitModal === 'new' ? null : unitModal}
          units={p.units}
          onClose={() => setUnitModal(null)}
          onSaved={() => { setUnitModal(null); success('Unit saved'); refresh() }}
          onError={m => toastError('Could not save', m)}
        />
      )}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

function AddMember({ unitId, employees, taken, onDone, onError }: {
  unitId: string; employees: { id: string; cqid: string }[]; taken: string[]
  onDone: () => void; onError: (m?: string) => void
}) {
  const [employeeId, setEmployeeId] = useState('')
  const [isManager, setIsManager] = useState(false)
  const [roleLabel, setRoleLabel] = useState('')
  const available = employees.filter(e => !taken.includes(e.id))
  if (available.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <AppSelect value={employeeId} onChange={e => setEmployeeId(e.target.value)}>
        <option value="">— add person —</option>
        {available.map(e => <option key={e.id} value={e.id}>{e.cqid}</option>)}
      </AppSelect>
      <input value={roleLabel} onChange={e => setRoleLabel(e.target.value)} placeholder="role (optional)"
        className="w-28 rounded-lg border border-border bg-background px-2 py-1.5 text-xs" />
      <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <input type="checkbox" checked={isManager} onChange={e => setIsManager(e.target.checked)} /> manager
      </label>
      <button disabled={!employeeId} onClick={async () => {
        const res = await saveMember({ unitId, employeeId, isManager, roleLabel: roleLabel || null })
        if (!res.ok) { onError(res.error); return }
        setEmployeeId(''); setRoleLabel(''); setIsManager(false); onDone()
      }} className="rounded-lg border border-border px-2 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50">
        Add
      </button>
    </div>
  )
}

function AddScope({ unitId, clients, services, categories, onDone, onError }: {
  unitId: string
  clients: { id: string; name: string }[]
  services: { id: string; name: string }[]
  categories: { id: string; name: string }[]
  onDone: () => void; onError: (m?: string) => void
}) {
  const [kind, setKind] = useState<'client' | 'category' | 'service'>('client')
  const [id, setId] = useState('')
  const list = kind === 'client' ? clients : kind === 'category' ? categories : services
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <AppSelect value={kind} onChange={e => { setKind(e.target.value as typeof kind); setId('') }}>
        <option value="client">Client</option>
        <option value="category">Department</option>
        <option value="service">Service</option>
      </AppSelect>
      <AppSelect value={id} onChange={e => setId(e.target.value)}>
        <option value="">— select —</option>
        {list.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
      </AppSelect>
      <button disabled={!id} onClick={async () => {
        const res = await addScope({
          unitId,
          clientId: kind === 'client' ? id : null,
          serviceCategoryId: kind === 'category' ? id : null,
          serviceId: kind === 'service' ? id : null,
        })
        if (!res.ok) { onError(res.error); return }
        setId(''); onDone()
      }} className="rounded-lg border border-border px-2 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50">
        Map
      </button>
    </div>
  )
}

function UnitModal({ initial, units, onClose, onSaved, onError }: {
  initial: OrgUnit | null
  units: OrgUnit[]
  onClose: () => void; onSaved: () => void; onError: (m?: string) => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<OrgUnitType>(initial?.type ?? 'team')
  const [parentId, setParentId] = useState(initial?.parentId ?? '')
  const [saving, setSaving] = useState(false)
  const field = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm'

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="w-full sm:max-w-md bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="font-semibold">{initial ? 'Edit unit' : 'New unit'}</h2>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} className={field}
              placeholder="e.g. Design Team, Kochi Branch" autoFocus />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">Type</label>
            <AppSelect value={type} onChange={e => setType(e.target.value as OrgUnitType)}>
              {ORG_UNIT_TYPES.map(t => <option key={t} value={t}>{ORG_UNIT_TYPE_LABEL[t]}</option>)}
            </AppSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Inside <span className="text-muted-foreground/60">(optional — a team can sit in a branch)</span>
            </label>
            <AppSelect value={parentId} onChange={e => setParentId(e.target.value)}>
              <option value="">— top level —</option>
              {units.filter(u => u.id !== initial?.id).map(u => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </AppSelect>
          </div>
        </div>
        <div className="flex gap-3 px-6 py-4 border-t border-border">
          <button onClick={onClose} className="flex-1 rounded-lg border border-border py-2 text-sm font-medium hover:bg-secondary">Cancel</button>
          <button onClick={async () => {
            setSaving(true)
            const res = await saveUnit({ id: initial?.id, name, type, parentId: parentId || null })
            setSaving(false)
            if (!res.ok) { onError(res.error); return }
            onSaved()
          }} disabled={saving || !name.trim()}
            className="flex-1 rounded-lg gradient-bg py-2 text-sm font-medium text-white disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
