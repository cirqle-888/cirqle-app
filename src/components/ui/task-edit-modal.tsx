'use client'

import { useState } from 'react'
import { X, Trash2, CalendarDays } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
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
  const supabase = createClient()
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

    let amount = unitPrice
    let qty = 1
    if (pt === 'fixed_per_creative') { qty = parseFloat(form.quantity) || 1; amount = unitPrice * qty }
    else if (pt === 'hourly') { qty = parseFloat(form.hours) || 1; amount = unitPrice * qty }
    else if (pt === 'percentage_of_spend') { qty = parseFloat(form.spend) || 0; amount = qty * (unitPrice / 100) }

    const { data, error } = await supabase
      .from('tasks')
      .update({
        ...(form.task_number ? { task_number: parseInt(form.task_number, 10) } : {}),
        title: form.title,
        description: form.description || null,
        client_id: form.client_id || null,
        service_id: form.service_id || null,
        status: form.status,
        billing_amount: amount,
        billing_amount_inr: amount,
        quantity: qty,
        currency: unitCurrency,
        task_date: form.task_date || null,
      })
      .eq('id', task.id)
      .select('*, client:clients(id, name, code), service:services(id, name)')
      .single()

    setSaving(false)
    if (!error && data) { onSaved(data); onClose() }
  }

  async function handleDelete() {
    setDeleting(true)
    const deletedAt = new Date().toISOString()
    await supabase.from('tasks').update({ deleted_at: deletedAt }).eq('id', task.id)
    setDeleting(false)
    onDeleted(task.id)
    onClose()
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-card rounded-t-2xl z-10">
          <div>
            <h2 className="font-semibold">Edit Task</h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-72">{task.title}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
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
              <div className="relative">
                <CalendarDays className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input type="date" value={form.task_date} onChange={e => setForm(p => ({ ...p, task_date: e.target.value }))} className={inputCls + ' pl-9'} />
              </div>
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
                  {deleting ? <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Yes, delete
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="text-xs text-red-400/60 hover:text-red-400 flex items-center gap-1 transition-colors">
              <Trash2 className="w-3 h-3" /> Delete this task
            </button>
          )}

          <div className="flex gap-3 pt-2 border-t border-border">
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
