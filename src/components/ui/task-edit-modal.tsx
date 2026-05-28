'use client'

import { useState } from 'react'
import { X, Trash2 } from 'lucide-react'
import { serverSaveTask, serverDeleteTask } from '@/app/(dashboard)/dashboard/tasks/actions'
import { ModalOverlay } from './modal-overlay'
import AppSelect from './app-select'
import Combobox from './combobox'
import type { Currency } from '@/types'

interface TaskEditModalProps {
  task: any
  clients: { id: string; name: string; code?: string }[]
  services: { id: string; name: string; pricing_type?: string; default_price?: number; default_currency?: string }[]
  clientPricings?: { client_id: string; service_id: string; price: number; currency: string; commission_percentage?: number }[]
  showFinancials?: boolean
  onSaved: (updatedTask: any) => void
  onDeleted: (taskId: string) => void
  onClose: () => void
}

const MANUAL_STATUSES = ['pending', 'in_progress', 'done', 'cancelled']
const STATUS_LABELS: Record<string, string> = {
  pending: '⏳ Pending',
  in_progress: '🔄 In Progress',
  done: '✅ Done',
  invoiced: '🔒 Invoiced',
  cancelled: '❌ Cancelled',
}

const inputCls = 'w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50'

export function TaskEditModal({
  task, clients, services, clientPricings = [], showFinancials = true, onSaved, onDeleted, onClose,
}: TaskEditModalProps) {
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
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const svc = services.find(s => s.id === form.service_id)
  const pt = svc?.pricing_type || 'fixed_per_creative'
  const cp = clientPricings.find(p => p.client_id === form.client_id && p.service_id === form.service_id)
  const unitPrice = cp?.price ?? svc?.default_price ?? 0
  const unitCurrency = (cp?.currency || svc?.default_currency || 'INR') as Currency

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaveError(null)

    let amount = unitPrice
    let qty = 1
    if (pt === 'fixed_per_creative') { qty = parseFloat(form.quantity) || 1; amount = unitPrice * qty }
    else if (pt === 'hourly') { qty = parseFloat(form.hours) || 1; amount = unitPrice * qty }
    else if (pt === 'percentage_of_spend') { qty = parseFloat(form.spend) || 0; amount = qty * (unitPrice / 100) }

    const res = await serverSaveTask({
      taskId:           task.id,
      taskNumber:       form.task_number ? parseInt(form.task_number, 10) : null,
      title:            form.title,
      description:      form.description || null,
      clientId:         form.client_id || null,
      serviceId:        form.service_id || null,
      status:           form.status,
      billingAmount:    amount,
      billingAmountInr: amount,
      quantity:         qty,
      currency:         unitCurrency,
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
    if (res.ok) { onDeleted(task.id); onClose() }
  }

  return (
    <ModalOverlay onClose={onClose}>
      {/* flex-col with max-h-[90vh] so the form body can scroll while the
          header and footer (Cancel/Save) stay pinned. Previously the whole
          modal scrolled, pushing the action buttons off-screen on mobile. */}
      <div className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card rounded-t-2xl shrink-0">
          <div>
            <h2 className="font-semibold">Edit Task</h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-72">{task.title}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
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
              {/* No custom overlay icon: iOS Safari + Chrome both render their
                  own native date picker indicator. Layering `pl-9` + a custom
                  CalendarDays icon caused the field to render visibly wider
                  than its siblings on iPhone. Native chrome is enough. */}
              <input type="date" value={form.task_date} onChange={e => setForm(p => ({ ...p, task_date: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">Status</label>
              <AppSelect value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
                {MANUAL_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s] ?? s}</option>)}
                {form.status === 'invoiced' && <option value="invoiced" disabled>🔒 Invoiced (system-managed)</option>}
              </AppSelect>
            </div>
          </div>

          {/* Quantity / Hours / Spend + Price */}
          {showFinancials && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {pt === 'fixed_per_creative' && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Creatives</label>
                  <input type="number" min="1" step="1" value={form.quantity} onChange={e => setForm(p => ({ ...p, quantity: e.target.value }))} className={inputCls} />
                </div>
              )}
              {pt === 'hourly' && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Hours</label>
                  <input type="number" min="0.5" step="0.5" value={form.hours} onChange={e => setForm(p => ({ ...p, hours: e.target.value }))} className={inputCls} />
                </div>
              )}
              {pt === 'percentage_of_spend' && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Ad Spend ({unitCurrency})</label>
                  <input type="number" min="0" step="0.01" value={form.spend} onChange={e => setForm(p => ({ ...p, spend: e.target.value }))} className={inputCls} placeholder="e.g. 1000" />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Price ({unitCurrency})</label>
                <input readOnly value={unitPrice} className={inputCls + ' opacity-60 cursor-not-allowed'} />
              </div>
            </div>
          )}

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">Description</label>
            <textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} rows={2} className={inputCls + ' resize-none'} placeholder="Optional notes…" />
          </div>

          {/* Delete confirmation zone */}
          {confirmDelete ? (
            <div className="bg-red-500/10 border border-red-500/25 rounded-xl p-3 space-y-2">
              <p className="text-xs font-medium text-red-400">Delete this task permanently? This cannot be undone.</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setConfirmDelete(false)} className="flex-1 bg-secondary text-xs font-medium px-3 py-2 rounded-lg hover:bg-secondary/80 transition-colors">Keep task</button>
                <button type="button" onClick={handleDelete} disabled={deleting} className="flex-1 bg-red-500 text-white text-xs font-semibold px-3 py-2 rounded-lg hover:bg-red-600 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5">
                  {deleting ? <span className="w-3.5 h-3.5 border-2 border-foreground/30 border-t-white rounded-full animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Yes, delete
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="text-xs text-red-400/60 hover:text-red-400 flex items-center gap-1 transition-colors">
              <Trash2 className="w-3 h-3" /> Delete this task
            </button>
          )}

          {saveError && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{saveError}</p>
          )}
          </div>

          {/* Sticky footer — buttons stay visible on mobile while the form
              body scrolls above. shrink-0 prevents the flex parent from
              squashing it; the border-t reads as a visual divider. */}
          <div className="flex gap-3 px-6 py-3 border-t border-border bg-card rounded-b-2xl shrink-0">
            <button type="button" onClick={onClose} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 gradient-bg text-white text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </ModalOverlay>
  )
}
