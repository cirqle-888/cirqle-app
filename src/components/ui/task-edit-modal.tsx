'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { X, Trash2, BarChart2, Clock } from 'lucide-react'
import { serverSaveTask, serverDeleteTask } from '@/app/(dashboard)/dashboard/tasks/actions'
import { ModalOverlay } from './modal-overlay'
import AppSelect from './app-select'
import Combobox from './combobox'
import { Button } from './button'
import { TaskBillingSection } from './task-billing-section'
import { useRetainerCoverage } from '@/lib/tasks/use-retainer-coverage'
import {
  computeTaskAmount, resolveTaskQuantity, resolveUnitPrice, effectiveBillingAmount,
  applyCoverageExtraPrice,
} from '@/lib/tasks/pricing'

const ContributionEntryPanel = dynamic(
  () => import('./contribution-entry-panel').then(m => m.ContributionEntryPanel),
  { ssr: false },
)
const ActivityPanel = dynamic(() => import('@/components/activity/activity-panel'), { ssr: false })
const DiscussButton = dynamic(() => import('@/components/chat/discuss-button').then(m => m.DiscussButton), { ssr: false })

interface TaskEditModalProps {
  task: any
  clients: { id: string; name: string; code?: string }[]
  services: { id: string; name: string; pricing_type?: string; default_price?: number; default_currency?: string }[]
  clientPricings?: { client_id: string; service_id: string; price: number; currency: string; commission_percentage?: number }[]
  showFinancials?: boolean
  /** Whether to show the Contributions tab at all */
  canViewContributions?: boolean
  /** Whether the user can enter/save contribution scores */
  canEditContributions?: boolean
  /** Whether the user can see ₹ earnings in contributions */
  showEarnings?: boolean
  /** 'all' = admin sees everyone; 'own' = employee sees only themselves */
  contribViewScope?: 'all' | 'own'
  /** The logged-in employee's id — used to scope 'own' view */
  currentEmployeeId?: string
  /** Which tab to open initially */
  initialTab?: 'details' | 'contributions'
  /** Reference data needed by the Contributions tab */
  employees?: { id: string; cqid: string; name: string | null; performance_rating?: number }[]
  groups?: { id: string; name: string; weight: number }[]
  parameters?: { id: string; name: string; group_id: string; weight: number; is_master?: boolean; input_type?: 'percentage' | 'count' }[]
  groupServices?: { group_id: string; service_id: string }[]
  onSaved: (updatedTask: any) => void
  onDeleted: (taskId: string) => void
  onClose: () => void
}

const MANUAL_STATUSES = ['pending', 'in_progress', 'delivered', 'done', 'cancelled']
const STATUS_LABELS: Record<string, string> = {
  pending: '⏳ New',
  in_progress: '🔄 In Progress',
  delivered: '↗️ Delivered',
  done: '✅ Done',
  invoiced: '🔒 Invoiced',
  cancelled: '❌ Cancelled',
}

const inputCls = 'w-full bg-background border border-input rounded-lg px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50'

export function TaskEditModal({
  task, clients, services, clientPricings = [], showFinancials = true,
  canViewContributions = false, canEditContributions = false, showEarnings = false,
  contribViewScope = 'all', currentEmployeeId,
  initialTab = 'details',
  employees = [], groups = [], parameters = [], groupServices = [],
  onSaved, onDeleted, onClose,
}: TaskEditModalProps) {
  const [activeTab, setActiveTab] = useState<'details' | 'contributions' | 'activity'>(
    canViewContributions && initialTab === 'contributions' ? 'contributions' : 'details'
  )

  const [form, setForm] = useState({
    task_number: String(task.task_number ?? ''),
    title: task.title ?? '',
    client_id: task.client_id ?? '',
    service_id: task.service_id ?? '',
    task_date: task.task_date ?? '',
    quantity: String(task.quantity ?? 1),
    hours: String(task.quantity ?? 1),
    spend: String(task.billing_amount_inr ?? 0),
    description: task.description ?? '',
    status: task.status ?? 'pending',
    bill_as_extra: !!task.bill_as_extra,
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // On iOS, the overlay uses items-end (sheetOnMobile). When the keyboard opens,
  // window.innerHeight stays fixed while visualViewport.height shrinks by the
  // keyboard height. Setting marginBottom = keyboard height shifts the modal
  // exactly above the keyboard. Only fires on touch devices; no-ops on desktop.
  const [kbOffset, setKbOffset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setKbOffset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update) }
  }, [])

  // Pricing + coverage come from the shared engine/hook — never re-derived here.
  const basePrice = resolveUnitPrice({
    services, clientPricings, clientId: form.client_id, serviceId: form.service_id,
  })
  const coverage = useRetainerCoverage(form.client_id, form.service_id, form.task_date)
  // "Bill as extra" prices from the agreement's extra rate when one is agreed.
  const { pricingType: pt, unitPrice, currency: unitCurrency } =
    applyCoverageExtraPrice(basePrice, coverage, form.bill_as_extra)

  // Variant tasks (revision / concept / size) bill as a derived share of their
  // PARENT task and freeze that amount at creation. Editing them here must NEVER
  // recompute from the service pricing matrix — otherwise the derived price
  // (e.g. ₹40 = 20% of parent) gets overwritten with the full service price (₹200).
  const isVariant = !!task.parent_task_id
  const variantBillingInr = Number(task.billing_amount_inr ?? 0)
  const VARIANT_MODE_LABEL: Record<string, string> = {
    percent_of_parent: '% of parent',
    parameter_driven:  'parameter-driven',
    fixed:             'fixed amount',
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaveError(null)

    // qty is always derived from the employee-visible input fields so that
    // non-admin edits also update the quantity column correctly.
    const qty = resolveTaskQuantity({ pricingType: pt, ...form })
    // The pricing matrix says what the work is worth; coverage decides what the
    // CLIENT is charged. Sending the raw matrix price over a retainer-covered
    // task's zero is what made every save here fail — including edits that
    // touched nothing financial at all.
    const amount = effectiveBillingAmount(
      computeTaskAmount({ pricingType: pt, unitPrice, ...form }),
      { covered: !!coverage, billAsExtra: form.bill_as_extra },
    )

    const res = await serverSaveTask({
      taskId:           task.id,
      taskNumber:       form.task_number ? parseInt(form.task_number, 10) : null,
      title:            form.title,
      description:      form.description || null,
      clientId:         form.client_id || null,
      serviceId:        form.service_id || null,
      status:           form.status,
      // Variant: preserve frozen billing but still save updated quantity.
      // Non-admin (showFinancials=false): save quantity only — billing fields
      // are omitted so the server keeps the existing price untouched.
      // Admin + original task: recompute from matrix as before.
      ...(isVariant ? { quantity: qty } : {
        ...(showFinancials ? {
          billingAmount:    amount,
          currency:         unitCurrency,
        } : {}),
        quantity: qty,
      }),
      // A billing decision: sent only by pricing-visible users, and only once
      // coverage is known — so a save can never silently start (or stop)
      // charging a client. Employees without pricing access never send it, and
      // their rows may not even load the flag.
      ...(showFinancials && (coverage || form.bill_as_extra)
        ? { billAsExtra: form.bill_as_extra } : {}),
      taskDate:         form.task_date || null,
    })

    setSaving(false)
    if (res.ok && res.data) { onSaved(res.data); onClose() }
    else setSaveError(res.error ?? 'Save failed. Please try again.')
  }

  async function handleDelete() {
    setDeleting(true)
    const res = await serverDeleteTask(task.id, task.title ?? '')
    setDeleting(false)
    if (res.ok) {
      onDeleted(task.id)
      onClose()
    } else {
      setSaveError(res.error ?? 'Could not delete task. Please try again.')
      setConfirmDelete(false)
    }
  }

  return (
    // sheetOnMobile → items-end on mobile so marginBottom shifts modal above keyboard.
    // On desktop it stays a centered dialog (items-center, p-4, rounded-2xl).
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div
        className="w-full sm:max-w-lg bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[90dvh] sm:max-h-[85dvh] overflow-hidden"
        style={kbOffset > 0 ? { marginBottom: kbOffset } : undefined}
      >
        {/* Header — always visible, never scrolls */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card rounded-t-2xl shrink-0">
            <div className="min-w-0">
              <h2 className="font-semibold">Edit Task</h2>
              <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-72">{task.title}</p>
            </div>
            {/* Discuss lives in the header, not only under the Activity tab:
                the question you want to ask about a task ("is this price
                right?") occurs while you are looking at the Details tab, and
                the panel now shifts this dialog aside instead of covering it. */}
            <div className="flex items-center gap-1 shrink-0">
              <DiscussButton entityType="task" entityId={task.id} variant="icon"
                label="Discuss this task" panelTitle={task.title} />
              <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
          </div>

          {/* Tab bar — Details + Activity always; Contributions when permitted */}
          <div className="flex shrink-0 border-b border-border px-6 bg-card">
            {([
              'details',
              ...(canViewContributions ? ['contributions'] as const : []),
              'activity',
            ] as const).map(tab => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`py-2.5 px-1 mr-5 text-sm font-medium border-b-2 transition-colors capitalize ${
                  activeTab === tab
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab === 'contributions' ? (
                  <span className="flex items-center gap-1.5">
                    <BarChart2 className="w-3.5 h-3.5" /> Contributions
                  </span>
                ) : tab === 'activity' ? (
                  <span className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" /> Activity
                  </span>
                ) : tab}
              </button>
            ))}
          </div>

          {/* ── Details tab ── */}
          {activeTab === 'details' && (
          <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
            {/* Scrollable body — grows to fill space between header and footer */}
            <div className="overflow-y-auto p-6 space-y-4 flex-1">

              {/* Task # + Title */}
              <div className="flex flex-col sm:grid sm:grid-cols-[110px_1fr] gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Task #</label>
                  <input type="number" min="1" value={form.task_number} onChange={e => setForm(p => ({ ...p, task_number: e.target.value }))} className={inputCls} placeholder="—" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Title *</label>
                  <input value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} required className={inputCls} autoFocus />
                </div>
              </div>

              {/* Client + Service */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Client</label>
                  <Combobox
                    options={clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))}
                    value={form.client_id}
                    onChange={id => setForm(p => ({ ...p, client_id: id }))}
                    placeholder="Search client…"
                    sortKey="clients"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Service</label>
                  <Combobox
                    options={services.map(s => ({ id: s.id, label: s.name }))}
                    value={form.service_id}
                    onChange={id => setForm(p => ({ ...p, service_id: id }))}
                    placeholder="Search service…"
                    sortKey="services"
                  />
                </div>
              </div>

              {/* Task Date + Status */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Task Date</label>
                  {/* inputMode="none" prevents the text keyboard from appearing;
                      iOS still opens its native date-wheel picker for type="date". */}
                  <input
                    type="date"
                    value={form.task_date}
                    onChange={e => setForm(p => ({ ...p, task_date: e.target.value }))}
                    className={inputCls + ' cursor-pointer'}
                    inputMode="none"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Status</label>
                  <AppSelect value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
                    {MANUAL_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s] ?? s}</option>)}
                    {form.status === 'invoiced' && <option value="invoiced" disabled>🔒 Invoiced (system-managed)</option>}
                  </AppSelect>
                </div>
              </div>

              {/* Financial section — the SAME component the Add Task form uses.
                  Never inline billing JSX here; see task-billing-section.tsx. */}
              <TaskBillingSection
                services={services}
                clientPricings={clientPricings}
                clientId={form.client_id}
                serviceId={form.service_id}
                quantity={form.quantity}
                hours={form.hours}
                spend={form.spend}
                onChange={patch => setForm(p => ({ ...p, ...patch }))}
                coverage={coverage}
                billAsExtra={form.bill_as_extra}
                onBillAsExtraChange={v => setForm(p => ({ ...p, bill_as_extra: v }))}
                showFinancials={showFinancials}
                lockedAmount={isVariant ? variantBillingInr : null}
                lockedCurrency={(task.currency as string) || 'INR'}
                lockedNote={
                  <>
                    Variant price is <strong>locked</strong> — derived from the parent task
                    {task.billing_mode ? ` (${VARIANT_MODE_LABEL[task.billing_mode] ?? task.billing_mode})` : ''}.
                    Editing here won’t change it, so it can’t be overwritten with the full service price.
                  </>
                }
              />

              {/* Description */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Description</label>
                <textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} rows={2} className={inputCls + ' resize-none'} placeholder="Optional notes…" />
              </div>

              {/* Delete confirmation zone */}
              {confirmDelete ? (
                <div className="bg-red-500/10 border border-red-500/25 rounded-xl p-3 space-y-2">
                  <p className="text-xs font-medium text-red-400">Delete this task permanently? This cannot be undone.</p>
                  <div className="flex gap-2 mt-3">
                    <Button type="button" variant="outline" onClick={() => setConfirmDelete(false)} className="flex-1">Keep task</Button>
                    <Button type="button" variant="destructive" onClick={handleDelete} loading={deleting} className="flex-1">
                      Yes, delete
                    </Button>
                  </div>
                </div>
              ) : (
                <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)} className="text-red-400/60 hover:text-red-400 hover:bg-red-500/10 h-auto py-1 px-2 text-xs">
                  <Trash2 className="w-3 h-3 mr-1" /> Delete this task
                </Button>
              )}

              {saveError && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{saveError}</p>
              )}

              {/* Sticky footer — pinned to bottom of scroll area */}
              <div
                className="sticky bottom-0 -mx-6 -mb-6 px-6 pt-4 bg-card/95 backdrop-blur border-t border-border flex gap-3 sm:rounded-b-2xl mt-4"
                style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 24px)' }}
              >
                <Button type="button" variant="outline" onClick={onClose} className="flex-1" size="lg">Cancel</Button>
                <Button type="submit" loading={saving} className="flex-1 bg-gradient-to-r from-primary to-violet-600 hover:from-primary/90 hover:to-violet-600/90 text-primary-foreground" size="lg">
                  Save Changes
                </Button>
              </div>
            </div>
          </form>
          )}

          {/* ── Contributions tab ── */}
          {activeTab === 'contributions' && canViewContributions && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="overflow-y-auto flex-1 relative">
                <ContributionEntryPanel
                  task={task}
                  employees={employees}
                  groups={groups}
                  parameters={parameters}
                  groupServices={groupServices}
                  canEdit={canEditContributions}
                  showEarnings={showEarnings}
                  viewScope={contribViewScope}
                  currentEmployeeId={currentEmployeeId}
                  onSaved={() => onSaved(task)}
                />
                <div
                  className="sticky bottom-0 bg-card/95 backdrop-blur border-t border-border flex gap-3 px-6 pt-4 pb-6 sm:rounded-b-2xl"
                  style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 24px)' }}
                >
                  <Button type="button" variant="outline" onClick={onClose} className="flex-1" size="lg">Close</Button>
                  <a
                    href={`/dashboard/contributions?highlight=${task.id}`}
                    className="flex-1 flex items-center justify-center gap-2 text-sm font-medium py-2 rounded-lg border border-input shadow-sm hover:bg-accent hover:text-accent-foreground transition-colors"
                  >
                    <BarChart2 className="w-4 h-4" /> Full report
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* ── Activity tab ── */}
          {activeTab === 'activity' && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="overflow-y-auto flex-1 p-6">
                {/* Discuss moved to the modal header — reachable from every
                    tab now, so a second copy here would just be duplication. */}
                <ActivityPanel entityType="task" entityId={task.id} />
              </div>
              <div
                className="flex gap-3 px-6 pt-3 border-t border-border bg-card sm:rounded-b-2xl shrink-0"
                style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 12px)' }}
              >
                <Button type="button" variant="outline" onClick={onClose} className="flex-1" size="lg">Close</Button>
              </div>
            </div>
          )}
      </div>
    </ModalOverlay>
  )
}
