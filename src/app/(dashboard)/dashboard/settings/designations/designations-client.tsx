'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2, Save, Check, X, ChevronDown, ChevronLeft, ShieldAlert } from 'lucide-react'
import { usePermissions } from '@/contexts/permission-context'
import { CRITICAL_PERMS } from '@/lib/permissions/keys'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast, ToastContainer } from '@/components/ui/toast'
import {
  createDesignation,
  updateDesignation,
  deleteDesignation,
  setPermission,
} from './actions'

// ─── Types (kept loose — they mirror DB rows) ────────────────────────────────
interface Designation {
  id: string
  name: string
  description: string | null
  is_admin: boolean
  is_system: boolean
  display_order: number
}

interface Permission {
  id: string
  module: string
  action: string
  key: string
  label: string
  description: string | null
  display_order: number
}

interface Assignment {
  designation_id: string
  permission_id: string
  allowed: boolean
}

interface Props {
  designations: Designation[]
  permissions: Permission[]
  assignments: Assignment[]
  memberCounts: Record<string, number>
}

// Module order — controls the section order in the right pane.
const MODULE_ORDER = [
  'dashboard', 'tasks', 'contributions', 'employees',
  'payroll', 'billing', 'cashbook', 'recruitment', 'reports', 'settings',
] as const

const MODULE_LABELS: Record<string, string> = {
  dashboard:     'Dashboard',
  tasks:         'Tasks',
  contributions: 'Contributions',
  employees:     'Employees',
  payroll:       'Payroll',
  billing:       'Billing',
  cashbook:      'Cashbook',
  recruitment:   'Recruitment',
  reports:       'Reports',
  settings:      'Settings',
}

const inputCls =
  'w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50'

export default function DesignationsClient(props: Props) {
  const router = useRouter()
  const { can } = usePermissions()
  const canManage = can('settings.manage_designations')
  const { toasts, dismiss, success, error: toastError } = useToast()

  const [designations, setDesignations] = useState(props.designations)
  const [selectedId, setSelectedId] = useState<string | null>(
    props.designations[0]?.id ?? null,
  )

  // Lookup: designationId → Set of allowed permissionIds.
  // Optimistic state — toggles flip immediately and revert on server error.
  const [assignmentMap, setAssignmentMap] = useState<Record<string, Set<string>>>(() => {
    const m: Record<string, Set<string>> = {}
    for (const a of props.assignments) {
      if (!a.allowed) continue
      if (!m[a.designation_id]) m[a.designation_id] = new Set()
      m[a.designation_id]!.add(a.permission_id)
    }
    return m
  })

  const [showNewModal, setShowNewModal] = useState(false)

  // In-app confirmation. NOT window.confirm: the desktop shell and embedded
  // browser views return false from it immediately without ever showing a
  // dialog, which silently swallowed every "grant a CRITICAL permission" and
  // every designation delete — the toggle simply refused to move with no
  // error and nothing in the console.
  const [confirmPrompt, setConfirmPrompt] = useState<{
    title: string
    body: string
    confirmLabel: string
    danger?: boolean
    onConfirm: () => void
  } | null>(null)

  // Mobile-only pane switcher. The desktop layout always shows both panes
  // side by side; on phones we show one at a time so neither gets squeezed
  // into ~50% of an already-narrow screen. Defaults to 'list' so users see
  // the directory first, not the auto-selected detail.
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list')

  const selected = designations.find(d => d.id === selectedId) ?? null

  // Group permissions by module, in the canonical order.
  const groupedPermissions = useMemo(() => {
    const byModule: Record<string, Permission[]> = {}
    for (const p of props.permissions) {
      if (!byModule[p.module]) byModule[p.module] = []
      byModule[p.module]!.push(p)
    }
    const result: { module: string; label: string; perms: Permission[] }[] = []
    for (const m of MODULE_ORDER) {
      if (byModule[m]) {
        result.push({ module: m, label: MODULE_LABELS[m] ?? m, perms: byModule[m]! })
      }
    }
    // Append any modules not in the canonical list (defensive).
    for (const m of Object.keys(byModule)) {
      if (!(MODULE_ORDER as readonly string[]).includes(m)) {
        result.push({ module: m, label: MODULE_LABELS[m] ?? m, perms: byModule[m]! })
      }
    }
    return result
  }, [props.permissions])

  // Critical grants (pricing, earnings, salaries, private names — see
  // CRITICAL_PERMS) get a red badge and a confirm step, so a role can't
  // silently accumulate confidential access.
  const criticalPermIds = useMemo(
    () => new Set(props.permissions.filter(p => CRITICAL_PERMS.has(p.key)).map(p => p.id)),
    [props.permissions],
  )
  const criticalCountFor = (designationId: string) => {
    let n = 0
    for (const id of assignmentMap[designationId] ?? []) if (criticalPermIds.has(id)) n++
    return n
  }

  // ─── Optimistic toggle ─────────────────────────────────────────────────────
  function togglePermission(designationId: string, permissionId: string, nextAllowed: boolean) {
    if (!canManage) return
    const designation = designations.find(d => d.id === designationId)
    if (!designation) return
    if (designation.is_admin) {
      toastError('Admin permissions are immutable.')
      return
    }
    if (nextAllowed && criticalPermIds.has(permissionId)) {
      const perm = props.permissions.find(p => p.id === permissionId)
      const members = props.memberCounts[designationId] ?? 0
      setConfirmPrompt({
        title: `Grant “${perm?.label ?? 'this permission'}”?`,
        // The permission's OWN description, not a blanket "exposes pricing,
        // earnings or personal data" — that over-warned on keys carrying no
        // money at all (contributions.view_unit widens whose score rows you
        // see; the ₹ per row stays behind contributions.view_earnings). A
        // confirmation that overstates what it is guarding trains people to
        // click through it.
        body:
          'Critical access. ' +
          `${perm?.description ? perm.description.trim() + ' ' : ''}` +
          `Everyone with the “${designation.name}” designation${members ? ` (${members} ${members === 1 ? 'member' : 'members'})` : ''} will get it.`,
        confirmLabel: 'Grant',
        danger: true,
        onConfirm: () => applyToggle(designationId, permissionId, nextAllowed),
      })
      return
    }

    applyToggle(designationId, permissionId, nextAllowed)
  }

  /** The flip itself, split out so the confirm dialog can resume it. */
  function applyToggle(designationId: string, permissionId: string, nextAllowed: boolean) {
    // Optimistic flip.
    setAssignmentMap(prev => {
      const next = { ...prev }
      const set = new Set(next[designationId] ?? [])
      if (nextAllowed) set.add(permissionId)
      else set.delete(permissionId)
      next[designationId] = set
      return next
    })

    setPermission(designationId, permissionId, nextAllowed).then(res => {
      if (!res.ok) {
        // Revert.
        setAssignmentMap(prev => {
          const next = { ...prev }
          const set = new Set(next[designationId] ?? [])
          if (nextAllowed) set.delete(permissionId)
          else set.add(permissionId)
          next[designationId] = set
          return next
        })
        toastError('Could not save', res.error)
      }
    })
  }

  // ─── Designation create / delete / update wrappers ─────────────────────────
  async function handleCreate(input: { name: string; description?: string; copyFromId?: string | null }) {
    const res = await createDesignation(input)
    if (!res.ok) {
      toastError('Create failed', res.error)
      return false
    }
    success('Designation created.')
    router.refresh()
    return true
  }

  function handleDelete(id: string) {
    const d = designations.find(x => x.id === id)
    if (!d) return
    if (d.is_system) {
      toastError('System designations cannot be deleted.')
      return
    }
    const members = props.memberCounts[id] ?? 0
    setConfirmPrompt({
      title: `Delete “${d.name}”?`,
      body: members
        ? `${members} ${members === 1 ? 'person holds' : 'people hold'} this designation. This cannot be undone.`
        : 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => { void applyDelete(id) },
    })
  }

  async function applyDelete(id: string) {
    const res = await deleteDesignation(id)
    if (!res.ok) {
      toastError('Delete failed', res.error)
      return
    }
    setDesignations(prev => prev.filter(x => x.id !== id))
    if (selectedId === id) setSelectedId(designations[0]?.id ?? null)
    success('Designation deleted.')
    router.refresh()
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  // Layout:
  //   - md+ : original 2-column (list rail + detail pane), fixed height.
  //   - <md : single-pane stack. `mobileView` decides which pane is visible.
  return (
    <div className="md:flex md:h-[calc(100dvh-4rem)] md:min-h-[600px]">
      {/* ── Left rail ──────────────────────────────────────────────────────── */}
      <aside
        className={
          'md:w-72 md:shrink-0 md:border-r md:border-border md:bg-sidebar/50 md:flex md:flex-col md:h-full ' +
          (mobileView === 'list' ? 'flex flex-col' : 'hidden md:flex')
        }
      >
        {/* pl-14 on mobile clears the global sidebar hamburger (fixed top-left,
            16-52px) that was covering the 'Designations' heading; md:px-4
            restores desktop padding where the hamburger is md:hidden. */}
        <div className="pl-14 pr-4 md:px-4 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-foreground">Designations</h2>
          {canManage && (
            <button
              onClick={() => setShowNewModal(true)}
              className="gradient-bg text-white text-xs font-medium rounded-lg px-2.5 py-1.5 inline-flex items-center gap-1 hover:opacity-90 transition-opacity"
            >
              <Plus className="w-3.5 h-3.5" /> New
            </button>
          )}
        </div>

        <div className="md:flex-1 md:overflow-y-auto py-2 px-2 space-y-1">
          {designations.length === 0 && (
            <p className="text-xs text-muted-foreground px-3 py-4">No designations yet.</p>
          )}
          {designations.map(d => {
            const isSelected = d.id === selectedId
            const count = props.memberCounts[d.id] ?? 0
            return (
              <button
                key={d.id}
                onClick={() => { setSelectedId(d.id); setMobileView('detail') }}
                className={
                  'w-full text-left px-3 py-2.5 rounded-lg transition-colors flex items-start gap-2 ' +
                  (isSelected
                    ? 'bg-primary/15 border border-primary/40 text-foreground'
                    : 'border border-transparent hover:bg-secondary text-muted-foreground hover:text-foreground')
                }
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate">{d.name}</span>
                    {d.is_admin && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-700 dark:text-violet-300 font-medium uppercase tracking-wide">Admin</span>
                    )}
                    {!d.is_admin && d.is_system && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-medium uppercase tracking-wide">System</span>
                    )}
                    {/* Red flag: this role carries confidential access — the
                        at-a-glance warning before assigning it to someone. */}
                    {!d.is_admin && criticalCountFor(d.id) > 0 && (
                      <span
                        title={`${criticalCountFor(d.id)} critical permission${criticalCountFor(d.id) === 1 ? '' : 's'} (pricing / earnings / personal data)`}
                        className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-700 dark:text-red-400 font-semibold uppercase tracking-wide"
                      >
                        <ShieldAlert className="w-3 h-3" /> {criticalCountFor(d.id)}
                      </span>
                    )}
                  </div>
                  {d.description && (
                    <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{d.description}</p>
                  )}
                </div>
                <span
                  className={
                    'text-[11px] font-medium rounded-full px-2 py-0.5 shrink-0 ' +
                    (isSelected ? 'bg-primary/20 text-foreground' : 'bg-secondary text-muted-foreground')
                  }
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      </aside>

      {/* ── Right pane ─────────────────────────────────────────────────────── */}
      <main
        className={
          'md:flex-1 md:overflow-y-auto md:h-full md:block ' +
          (mobileView === 'detail' ? 'block' : 'hidden md:block')
        }
      >
        {/* Mobile-only back button to return to the list pane. pl-14 clears
            the fixed global sidebar hamburger so the 'Back' label isn't
            partly hidden under it (the button is full-width so it was
            tappable regardless, but the leading text was occluded). */}
        <button
          onClick={() => setMobileView('list')}
          className="md:hidden w-full flex items-center gap-1.5 pl-14 pr-4 py-2.5 text-sm font-medium text-primary border-b border-border bg-sidebar/40"
        >
          <ChevronLeft className="w-4 h-4" /> Back to designations
        </button>
        {selected ? (
          <DesignationDetail
            key={selected.id}
            designation={selected}
            permissionsByModule={groupedPermissions}
            allowedIds={assignmentMap[selected.id] ?? new Set()}
            criticalPermIds={criticalPermIds}
            memberCount={props.memberCounts[selected.id] ?? 0}
            canManage={canManage}
            onTogglePermission={togglePermission}
            onSaveMeta={async (changes) => {
              const res = await updateDesignation(selected.id, changes)
              if (!res.ok) {
                toastError('Save failed', res.error)
                return false
              }
              setDesignations(prev => prev.map(d => d.id === selected.id ? { ...d, ...changes, description: changes.description ?? d.description, name: changes.name ?? d.name } : d))
              success('Saved.')
              router.refresh()
              return true
            }}
            onDelete={() => handleDelete(selected.id)}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            Select a designation to view its permissions.
          </div>
        )}
      </main>

      {showNewModal && (
        <NewDesignationModal
          designations={designations}
          onClose={() => setShowNewModal(false)}
          onCreate={async (input) => {
            const ok = await handleCreate(input)
            if (ok) setShowNewModal(false)
          }}
        />
      )}

      {confirmPrompt && (
        <ConfirmDialog
          title={confirmPrompt.title}
          body={confirmPrompt.body}
          confirmLabel={confirmPrompt.confirmLabel}
          danger={confirmPrompt.danger}
          onConfirm={() => { const run = confirmPrompt.onConfirm; setConfirmPrompt(null); run() }}
          onCancel={() => setConfirmPrompt(null)}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

// ─── Right-pane detail view ────────────────────────────────────────────────
function DesignationDetail({
  designation,
  permissionsByModule,
  allowedIds,
  criticalPermIds,
  memberCount,
  canManage,
  onTogglePermission,
  onSaveMeta,
  onDelete,
}: {
  designation: Designation
  permissionsByModule: { module: string; label: string; perms: Permission[] }[]
  allowedIds: Set<string>
  criticalPermIds: Set<string>
  memberCount: number
  canManage: boolean
  onTogglePermission: (designationId: string, permissionId: string, allowed: boolean) => void
  onSaveMeta: (changes: { name?: string; description?: string }) => Promise<boolean>
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState(designation.name)
  const [descDraft, setDescDraft] = useState(designation.description ?? '')
  const [pending, startTransition] = useTransition()

  const canEditMeta = canManage && !designation.is_admin && !designation.is_system

  async function save() {
    const changes: { name?: string; description?: string } = {}
    if (nameDraft.trim() !== designation.name) changes.name = nameDraft
    if ((descDraft || '') !== (designation.description ?? '')) changes.description = descDraft
    if (Object.keys(changes).length === 0) {
      setEditing(false)
      return
    }
    startTransition(async () => {
      const ok = await onSaveMeta(changes)
      if (ok) setEditing(false)
    })
  }

  function cancel() {
    setNameDraft(designation.name)
    setDescDraft(designation.description ?? '')
    setEditing(false)
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header card */}
      <div className="bg-card border border-border rounded-2xl p-5">
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            {editing && canEditMeta ? (
              <div className="space-y-3">
                <input
                  value={nameDraft}
                  onChange={e => setNameDraft(e.target.value)}
                  className={inputCls}
                  placeholder="Name"
                  autoFocus
                />
                <textarea
                  value={descDraft}
                  onChange={e => setDescDraft(e.target.value)}
                  className={inputCls + ' min-h-[60px]'}
                  placeholder="Description (optional)"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={save}
                    disabled={pending}
                    className="gradient-bg text-white text-sm font-medium rounded-lg px-3 py-1.5 inline-flex items-center gap-1 hover:opacity-90 disabled:opacity-60"
                  >
                    <Save className="w-4 h-4" /> Save
                  </button>
                  <button
                    onClick={cancel}
                    disabled={pending}
                    className="text-sm rounded-lg px-3 py-1.5 border border-border hover:bg-secondary inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-4 h-4" /> Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-xl font-semibold text-foreground">{designation.name}</h1>
                  {designation.is_admin && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-700 dark:text-violet-300 font-medium uppercase tracking-wide">Admin</span>
                  )}
                  {!designation.is_admin && designation.is_system && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-medium uppercase tracking-wide">System</span>
                  )}
                  <span className="text-xs text-muted-foreground ml-2">
                    {memberCount} {memberCount === 1 ? 'member' : 'members'}
                  </span>
                </div>
                {designation.description && (
                  <p className="text-sm text-muted-foreground mt-1.5">{designation.description}</p>
                )}
                {canEditMeta && (
                  <button
                    onClick={() => setEditing(true)}
                    className="mt-3 text-xs text-violet-700 dark:text-violet-300 hover:text-violet-700 dark:text-violet-200"
                  >
                    Edit name & description
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Admin banner */}
      {designation.is_admin ? (
        <div className="bg-violet-500/10 border border-violet-500/30 rounded-2xl p-4 flex items-start gap-3">
          <Check className="w-5 h-5 text-violet-700 dark:text-violet-300 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-foreground">Admin always has every permission</p>
            <p className="text-xs text-muted-foreground mt-1">
              The Admin designation has unrestricted access. Its permissions cannot be toggled or removed.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Critical-access summary: names every confidential grant this role
              holds, so "Reviewer quietly includes client pricing" is visible
              BEFORE the role is handed to a new hire. */}
          {(() => {
            const critical = permissionsByModule
              .flatMap(g => g.perms)
              .filter(p => allowedIds.has(p.id) && criticalPermIds.has(p.id))
            if (critical.length === 0) return null
            return (
              <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 flex items-start gap-3">
                <ShieldAlert className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="font-medium text-foreground">
                    This designation includes {critical.length} critical {critical.length === 1 ? 'permission' : 'permissions'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Confidential pricing, earnings or personal data. Assign it only to people who must see these:
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {critical.map(p => (
                      <span key={p.id} className="text-[11px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-700 dark:text-red-300 font-medium">
                        {p.label}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )
          })()}
          {permissionsByModule.map(group => (
            <PermissionModuleCard
              key={group.module}
              label={group.label}
              perms={group.perms}
              allowedIds={allowedIds}
              criticalPermIds={criticalPermIds}
              canManage={canManage}
              onToggle={(permId, next) => onTogglePermission(designation.id, permId, next)}
            />
          ))}
        </div>
      )}

      {/* Delete button */}
      {canManage && !designation.is_system && (
        <div className="pt-2 border-t border-border">
          <button
            onClick={onDelete}
            className="inline-flex items-center gap-2 text-sm rounded-lg px-3 py-2 bg-red-500/10 text-red-700 dark:text-red-300 hover:bg-red-500/20 border border-red-500/30"
          >
            <Trash2 className="w-4 h-4" /> Delete designation
          </button>
          <p className="text-xs text-muted-foreground mt-2">
            You can only delete designations that have no members.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Module card (collapsible) ─────────────────────────────────────────────
function PermissionModuleCard({
  label,
  perms,
  allowedIds,
  criticalPermIds,
  canManage,
  onToggle,
}: {
  label: string
  perms: Permission[]
  allowedIds: Set<string>
  criticalPermIds: Set<string>
  canManage: boolean
  onToggle: (permId: string, next: boolean) => void
}) {
  const [open, setOpen] = useState(true)
  const allowedCount = perms.reduce((n, p) => n + (allowedIds.has(p.id) ? 1 : 0), 0)
  const criticalAllowed = perms.reduce((n, p) => n + (allowedIds.has(p.id) && criticalPermIds.has(p.id) ? 1 : 0), 0)

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-secondary/40 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="font-medium text-foreground">{label}</span>
          <span className="text-xs text-muted-foreground">
            {allowedCount}/{perms.length}
          </span>
          {criticalAllowed > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-700 dark:text-red-400 font-semibold uppercase tracking-wide">
              <ShieldAlert className="w-3 h-3" /> {criticalAllowed} critical
            </span>
          )}
        </div>
        <ChevronDown
          className={'w-4 h-4 text-muted-foreground transition-transform ' + (open ? 'rotate-180' : '')}
        />
      </button>

      {open && (
        <div className="border-t border-border divide-y divide-border">
          {perms.map(p => {
            const allowed = allowedIds.has(p.id)
            const critical = criticalPermIds.has(p.id)
            return (
              <div key={p.id} className={'px-5 py-3 flex items-start gap-4' + (critical && allowed ? ' bg-red-500/[0.04]' : '')}>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground inline-flex items-center gap-1.5 flex-wrap">
                    {p.label}
                    {critical && (
                      <span
                        title="Exposes confidential pricing, earnings or personal data — grant deliberately."
                        className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-700 dark:text-red-400 font-semibold uppercase tracking-wide"
                      >
                        <ShieldAlert className="w-3 h-3" /> Critical
                      </span>
                    )}
                  </p>
                  {p.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{p.description}</p>
                  )}
                  <p className="text-[10px] font-mono text-muted-foreground/60 mt-0.5">{p.key}</p>
                </div>
                <ToggleSwitch
                  checked={allowed}
                  disabled={!canManage}
                  onChange={next => onToggle(p.id, next)}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Toggle switch ─────────────────────────────────────────────────────────
function ToggleSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ' +
        (checked ? 'bg-violet-500' : 'bg-secondary border border-border')
      }
    >
      <span
        className={
          'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform ' +
          (checked ? 'translate-x-5' : 'translate-x-0.5') +
          ' mt-0.5'
        }
      />
    </button>
  )
}

// ─── New-designation modal ─────────────────────────────────────────────────
function NewDesignationModal({
  designations,
  onClose,
  onCreate,
}: {
  designations: Designation[]
  onClose: () => void
  onCreate: (input: { name: string; description?: string; copyFromId?: string | null }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [copyFromId, setCopyFromId] = useState<string>('') // '' = start blank
  const [submitting, setSubmitting] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim() || undefined,
        copyFromId: copyFromId || null,
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-md shadow-2xl max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="font-semibold">New designation</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={submit} className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className={inputCls}
              placeholder="e.g. Team Lead"
              required
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Description
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              className={inputCls + ' min-h-[60px]'}
              placeholder="What does this designation do?"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Copy permissions from
            </label>
            <select
              value={copyFromId}
              onChange={e => setCopyFromId(e.target.value)}
              className={inputCls}
            >
              <option value="">Start blank (no permissions)</option>
              {designations.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Tip — pre-built role presets are available to copy from:
              <br />• <b>Operations</b> — tasks + contributions, no ₹
              <br />• <b>Accounts</b> — full finance access incl. amounts
              <br />• <b>HR</b> — payroll workflow without salary figures
              <br />• <b>Reviewer</b> — read-only across all modules
              <br />• <b>Management</b> — sees everything, no settings access
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="text-sm rounded-lg px-3 py-2 border border-border hover:bg-secondary text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="gradient-bg text-white text-sm font-medium rounded-lg px-4 py-2 inline-flex items-center gap-1.5 hover:opacity-90 disabled:opacity-60"
            >
              <Plus className="w-4 h-4" /> {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </ModalOverlay>
  )
}
