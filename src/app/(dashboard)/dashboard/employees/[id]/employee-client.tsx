'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient as createSupabaseClient } from '@/lib/supabase/client'
import Header from '@/components/layout/header'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import AppSelect from '@/components/ui/app-select'
import { ChevronLeft, Plus, Edit2, Archive, ArchiveRestore } from 'lucide-react'
import type { CommissionAgreement } from '@/lib/agreements/resolve-earning'

export default function EmployeeProfileClient({ employee, agreements: initialAgreements, clients, services, canManageAgreements }: any) {
  const [activeTab, setActiveTab] = useState<'details' | 'agreements'>('details')
  const [agreements, setAgreements] = useState<CommissionAgreement[]>(initialAgreements)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  
  const [form, setForm] = useState<any>({})
  const toast = useToast()
  const supabase = createSupabaseClient()

  const openForm = (a?: CommissionAgreement) => {
    if (a) {
      setEditingId(a.id)
      setForm({
        client_id: a.client_id || '',
        service_id: a.service_id || '',
        agreement_type: a.agreement_type,
        agreement_value: String(a.agreement_value),
        currency: a.currency,
        effective_from: a.effective_from,
        effective_to: a.effective_to || '',
        notes: a.notes || '',
        is_active: a.is_active
      })
    } else {
      setEditingId(null)
      const today = new Date().toISOString().slice(0, 10)
      setForm({
        client_id: '',
        service_id: '',
        agreement_type: 'fixed_per_task',
        agreement_value: '',
        currency: 'INR',
        effective_from: today,
        effective_to: '',
        notes: '',
        is_active: true
      })
    }
    setShowForm(true)
  }

  const saveAgreement = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canManageAgreements) {
      return toast.error('Unauthorized to manage agreements')
    }
    
    // Warn on percentage > 100
    if (
      (form.agreement_type === 'percentage_of_billing' || form.agreement_type === 'percentage_of_pool') &&
      Number(form.agreement_value) > 100
    ) {
      if (!window.confirm('Percentage is greater than 100%. Are you sure?')) return
    }
    
    const payload = {
      employee_id: employee.id,
      client_id: form.client_id || null,
      service_id: form.service_id || null,
      agreement_type: form.agreement_type,
      agreement_value: Number(form.agreement_value) || 0,
      currency: form.currency,
      effective_from: form.effective_from,
      effective_to: form.effective_to || null,
      notes: form.notes,
      is_active: form.is_active
    }

    if (editingId) {
      const { error } = await supabase.from('employee_commission_agreements').update(payload).eq('id', editingId)
      if (error) return toast.error('Failed to update agreement')
      setAgreements(agreements.map(a => a.id === editingId ? { ...a, ...payload } : a))
      toast.success('Agreement updated')
    } else {
      const { data, error } = await supabase.from('employee_commission_agreements').insert(payload).select().single()
      if (error) return toast.error('Failed to create agreement')
      setAgreements([data, ...agreements])
      toast.success('Agreement created')
    }
    
    setShowForm(false)
  }

  return (
    <main className="min-h-screen bg-background">
      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
      <Header title="Employee Profile" />
      
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/dashboard/settings" className="p-2 -ml-2 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
              <ChevronLeft className="w-5 h-5" />
            </Link>
            <div>
              {/* eslint-disable-next-line no-restricted-syntax -- deliberate: showing name on the dedicated employee profile page */}
              <h1 className="text-2xl font-bold">{employee.name}</h1>
              <p className="text-sm text-muted-foreground">{employee.cqid} • {employee.role}</p>
            </div>
          </div>
        </div>

        <div className="flex border-b border-border mb-6">
          <button
            onClick={() => setActiveTab('details')}
            className={`px-4 py-2 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'details' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            Details
          </button>
          {canManageAgreements && (
            <button
              onClick={() => setActiveTab('agreements')}
              className={`px-4 py-2 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'agreements' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              Commission Agreements
            </button>
          )}
        </div>

        {activeTab === 'details' && (
          <div className="bg-card border border-border rounded-xl p-6">
            <p className="text-sm text-muted-foreground">
              To edit the core details (Role, Designation, Services), please use the quick-edit form on the Settings → Employees page.
            </p>
            <div className="mt-6 grid grid-cols-2 gap-4 max-w-lg">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Email</p>
                <p className="font-medium text-sm">{employee.email || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Phone</p>
                <p className="font-medium text-sm">{employee.phone || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Salary Type</p>
                <p className="font-medium text-sm">{employee.salary_type || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Base Salary</p>
                <p className="font-medium text-sm">₹{employee.base_salary || 0}</p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'agreements' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold">Special Commission Agreements</h2>
              <button
                onClick={() => openForm()}
                className="flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors"
              >
                <Plus className="w-4 h-4" /> Add Agreement
              </button>
            </div>
            
            <p className="text-sm text-muted-foreground max-w-3xl">
              Agreements allow this employee to earn a special commission rate on tasks for a specific client/service, overriding their normal contribution-based earning. 
              The task must still be saved with this employee as a contributor to trigger the agreement.
            </p>

            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm text-left">
                <thead className="bg-secondary/50 text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Client</th>
                    <th className="px-4 py-3 font-medium">Service</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Value</th>
                    <th className="px-4 py-3 font-medium">From</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {agreements.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                        No agreements found.
                      </td>
                    </tr>
                  ) : agreements.map(a => {
                    const client = clients.find((c: any) => c.id === a.client_id)
                    const service = services.find((s: any) => s.id === a.service_id)
                    
                    let typeDisplay = ''
                    if (a.agreement_type === 'fixed_per_task') typeDisplay = 'Fixed per task'
                    if (a.agreement_type === 'percentage_of_billing') typeDisplay = '% of billing'
                    if (a.agreement_type === 'percentage_of_pool') typeDisplay = '% of pool'
                    
                    let valDisplay = ''
                    if (a.agreement_type === 'fixed_per_task') valDisplay = `${a.currency} ${a.agreement_value}`
                    else valDisplay = `${a.agreement_value}%`
                    
                    return (
                      <tr key={a.id} className="hover:bg-secondary/20 transition-colors">
                        <td className="px-4 py-3 font-medium">{client ? client.name : <span className="text-muted-foreground italic">All Clients</span>}</td>
                        <td className="px-4 py-3">{service ? service.name : <span className="text-muted-foreground italic">All Services</span>}</td>
                        <td className="px-4 py-3 text-muted-foreground">{typeDisplay}</td>
                        <td className="px-4 py-3 font-medium">{valDisplay}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(a.effective_from).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                        </td>
                        <td className="px-4 py-3">
                          {a.is_active ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-secondary text-muted-foreground">
                              Inactive
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button onClick={() => openForm(a)} className="p-1.5 text-muted-foreground hover:text-foreground rounded-md hover:bg-secondary transition-colors">
                            <Edit2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {showForm && (
        <ModalOverlay onClose={() => setShowForm(false)}>
          <div className="w-full max-w-md bg-card border border-border rounded-xl shadow-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-5 py-4 border-b border-border bg-secondary/30 flex justify-between items-center shrink-0">
              <h2 className="text-lg font-semibold">{editingId ? 'Edit Agreement' : 'New Agreement'}</h2>
            </div>
            
            <form onSubmit={saveAgreement} className="p-5 overflow-y-auto space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Client</label>
                <AppSelect value={form.client_id} onChange={e => setForm({ ...form, client_id: e.target.value })}>
                  <option value="">All Clients (Wildcard)</option>
                  {clients.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </AppSelect>
              </div>
              
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Service</label>
                <AppSelect value={form.service_id} onChange={e => setForm({ ...form, service_id: e.target.value })}>
                  <option value="">All Services (Wildcard)</option>
                  {services.map((s: any) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </AppSelect>
              </div>

              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Agreement Type</label>
                <AppSelect value={form.agreement_type} onChange={e => setForm({ ...form, agreement_type: e.target.value })}>
                  <option value="fixed_per_task">Fixed Amount per Task</option>
                  <option value="percentage_of_billing">Percentage of Task Billing</option>
                  <option value="percentage_of_pool">Percentage of Commission Pool</option>
                </AppSelect>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Value</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    value={form.agreement_value}
                    onChange={e => setForm({ ...form, agreement_value: e.target.value })}
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                  />
                </div>
                {form.agreement_type === 'fixed_per_task' && (
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1.5">Currency</label>
                    <AppSelect value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value })}>
                      <option value="INR">INR</option>
                      <option value="USD">USD</option>
                      <option value="AED">AED</option>
                      <option value="GBP">GBP</option>
                    </AppSelect>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Effective From</label>
                  <input
                    type="date"
                    required
                    value={form.effective_from}
                    onChange={e => setForm({ ...form, effective_from: e.target.value })}
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Effective To (optional)</label>
                  <input
                    type="date"
                    value={form.effective_to}
                    onChange={e => setForm({ ...form, effective_to: e.target.value })}
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                  />
                </div>
              </div>
              
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Notes (optional)</label>
                <textarea
                  rows={2}
                  value={form.notes}
                  onChange={e => setForm({ ...form, notes: e.target.value })}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                />
              </div>

              <div className="flex items-center gap-2 pt-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={form.is_active}
                  onChange={e => setForm({ ...form, is_active: e.target.checked })}
                  className="rounded border-border text-primary focus:ring-primary"
                />
                <label htmlFor="isActive" className="text-sm font-medium">Active Agreement</label>
              </div>

              <div className="pt-4 flex justify-end gap-3 border-t border-border">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors">
                  Save
                </button>
              </div>
            </form>
          </div>
        </ModalOverlay>
      )}
    </main>
  )
}
