'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { usePrivacy } from '@/contexts/privacy-context'
import { X, Plus, Trash2, Calendar, Percent, FileText } from 'lucide-react'
import type { Employee, EmployeePerformanceHistory } from '@/types'

export function PerformanceHistoryModal({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const { dn } = usePrivacy()
  const [history, setHistory] = useState<EmployeePerformanceHistory[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const supabase = createClient()

  // New entry form state
  const [form, setForm] = useState({
    effective_from: new Date().toISOString().slice(0, 10),
    performance_rating: employee.performance_rating || 70,
    reason: ''
  })

  useEffect(() => {
    fetchHistory()
  }, [employee.id])

  async function fetchHistory() {
    setLoading(true)
    const { data, error } = await supabase
      .from('employee_performance_history')
      .select('*')
      .eq('employee_id', employee.id)
      .order('effective_from', { ascending: false })
    
    if (data) setHistory(data)
    setLoading(false)
  }

  async function handleAddEntry(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    
    const newEntry = {
      employee_id: employee.id,
      effective_from: form.effective_from,
      performance_rating: form.performance_rating,
      reason: form.reason
    }

    const { data, error } = await supabase
      .from('employee_performance_history')
      .insert([newEntry])
      .select()

    if (error) {
      alert(error.message)
    } else if (data) {
      setHistory(prev => [data[0], ...prev].sort((a, b) => b.effective_from.localeCompare(a.effective_from)))
      setForm(p => ({ ...p, reason: '' })) // reset reason, keep date/rating
    }
    
    setSaving(false)
  }

  async function handleDelete(id: string) {
    if (!confirm('Are you sure you want to delete this historical record?')) return
    
    const { error } = await supabase
      .from('employee_performance_history')
      .delete()
      .eq('id', id)

    if (error) {
      alert(error.message)
    } else {
      setHistory(prev => prev.filter(h => h.id !== id))
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-background rounded-xl w-[600px] max-w-full max-h-[90vh] flex flex-col shadow-2xl border border-border">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border bg-sidebar/50">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              Performance History Register
            </h2>
            <p className="text-sm text-muted-foreground">For {dn(employee)} ({employee.cqid})</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-secondary rounded-lg text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 flex flex-col gap-6 overflow-y-auto max-h-[70vh]">
          {/* Add New Form */}
          <form onSubmit={handleAddEntry} className="bg-secondary/50 rounded-xl p-4 border border-border flex flex-col gap-3">
            <h3 className="text-sm font-semibold mb-1 flex items-center gap-2">
              <Plus className="w-4 h-4 text-primary" /> Add Historical Record
            </h3>
            
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5" /> Effective From Date
                </label>
                <input
                  type="date"
                  required
                  value={form.effective_from}
                  onChange={e => setForm(p => ({ ...p, effective_from: e.target.value }))}
                  className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5">
                  <Percent className="w-3.5 h-3.5" /> Performance %
                </label>
                <input
                  type="number"
                  min="0" max="100" step="0.01"
                  required
                  value={form.performance_rating}
                  onChange={e => setForm(p => ({ ...p, performance_rating: parseFloat(e.target.value) || 0 }))}
                  className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
            </div>
            
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5" /> Notes / Reason <span className="text-[10px] opacity-60 font-normal">(Optional)</span>
              </label>
              <input
                type="text"
                value={form.reason}
                onChange={e => setForm(p => ({ ...p, reason: e.target.value }))}
                placeholder="e.g. Annual review, Promotion..."
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            
            <div className="flex justify-end mt-1">
              <button 
                disabled={saving}
                type="submit" 
                className="px-4 py-1.5 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Add Record'}
              </button>
            </div>
          </form>

          {/* History Table */}
          <div>
            <h3 className="text-sm font-semibold mb-3">Historical Records</h3>
            {loading ? (
              <p className="text-sm text-muted-foreground text-center py-4">Loading history...</p>
            ) : history.length === 0 ? (
              <div className="bg-secondary/30 rounded-xl p-6 border border-border border-dashed text-center">
                <p className="text-sm text-muted-foreground">No historical records found.</p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  The current profile rating ({employee.performance_rating}%) will be used for all tasks.
                </p>
              </div>
            ) : (
              <div className="border border-border rounded-xl overflow-hidden">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="bg-secondary/50 border-b border-border">
                      <th className="px-4 py-2 font-medium text-muted-foreground">Effective From</th>
                      <th className="px-4 py-2 font-medium text-muted-foreground">Rating %</th>
                      <th className="px-4 py-2 font-medium text-muted-foreground">Reason</th>
                      <th className="px-4 py-2 font-medium text-muted-foreground text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map(record => (
                      <tr key={record.id} className="border-b border-border last:border-0 hover:bg-secondary/20">
                        <td className="px-4 py-3 whitespace-nowrap">
                          {new Date(record.effective_from).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                        </td>
                        <td className="px-4 py-3 font-medium">
                          <span className="inline-flex items-center justify-center bg-primary/10 text-primary px-2 py-0.5 rounded text-xs">
                            {record.performance_rating}%
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {record.reason || '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => handleDelete(record.id)}
                            className="p-1.5 hover:bg-destructive/10 text-destructive/70 hover:text-destructive rounded transition-colors"
                            title="Delete record"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-4 bg-blue-500/10 text-blue-500 text-xs p-3 rounded-lg flex items-start gap-2">
              <span className="text-lg leading-none mt-0.5">ℹ️</span>
              <p>
                When calculating contributions, the system uses the <strong>most recent</strong> historical rating that was effective <strong>on or before</strong> the task date. If no record applies, the current active rating ({employee.performance_rating}%) is used.
              </p>
            </div>
          </div>
        </div>
      </div>
    </ModalOverlay>
  )
}
