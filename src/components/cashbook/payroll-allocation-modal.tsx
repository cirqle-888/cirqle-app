'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { X, Plus, Trash2, CheckCircle2, ShieldAlert } from 'lucide-react'
import Combobox from '@/components/ui/combobox'
import { usePrivacy } from '@/contexts/privacy-context'

interface Allocation {
  id: string
  payroll_id: string
  allocated_amount: number
  payroll?: {
    net_salary: number
    status: string
    month?: number
    year?: number
    payslip_number?: string
    employee?: { name: string; cqid: string }
  }
}

interface Props {
  entryId: string
  amountInr: number
  employees: any[]
  reference?: string
  onClose: () => void
  onUpdate: () => void
}

export default function PayrollAllocationModal({ entryId, amountInr, employees, reference, onClose, onUpdate }: Props) {
  const [allocations, setAllocations] = useState<Allocation[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [payrolls, setPayrolls] = useState<any[]>([])
  const supabase = createClient()
  const { dn } = usePrivacy()

  // Try to pre-select employee based on reference
  const initialEmployeeId = employees.find(e => reference?.toUpperCase().includes(e.cqid))?.id || ''
  const [selectedEmployee, setSelectedEmployee] = useState(initialEmployeeId)

  useEffect(() => {
    fetchAllocations()
  }, [])

  useEffect(() => {
    if (selectedEmployee) fetchPendingPayrolls(selectedEmployee)
    else setPayrolls([])
  }, [selectedEmployee])

  async function fetchAllocations() {
    setLoading(true)
    const { data } = await supabase
      .from('cashbook_payroll_allocations')
      .select(`
        id, 
        payroll_id, 
        allocated_amount,
        payroll:payroll(net_salary, status, month, year, payslip_number, employee:employees(name, cqid))
      `)
      .eq('cashbook_entry_id', entryId)
      .is('deleted_at', null)
    
    if (data) setAllocations(data as unknown as Allocation[])
    setLoading(false)
  }

  async function fetchPendingPayrolls(empId: string) {
    const { data: payrollsData } = await supabase
      .from('payroll')
      .select('id, net_salary, status, month, year, payslip_number')
      .eq('employee_id', empId)
      .eq('status', 'pending')
      .order('year', { ascending: true })
      .order('month', { ascending: true })
    
    if (payrollsData && payrollsData.length > 0) {
      const ids = payrollsData.map(p => p.id)
      const { data: allocData } = await supabase
        .from('cashbook_payroll_allocations')
        .select('payroll_id, allocated_amount')
        .in('payroll_id', ids)
        .is('deleted_at', null)
        
      const allocMap: Record<string, number> = {}
      if (allocData) {
        allocData.forEach(a => {
          allocMap[a.payroll_id] = (allocMap[a.payroll_id] || 0) + Number(a.allocated_amount)
        })
      }
      
      const filtered = payrollsData
        .map(p => {
          const net = Number(p.net_salary) || 0
          const allocated = allocMap[p.id] || 0
          return { ...p, remainingAmount: Math.max(0, net - allocated) }
        })
        .filter(p => p.remainingAmount > 0.01)
        
      setPayrolls(filtered)
    } else {
      setPayrolls([])
    }
  }

  const totalAllocated = allocations.reduce((sum, a) => sum + (Number(a.allocated_amount) || 0), 0)
  const unallocated = amountInr - totalAllocated

  const [newAllocPayroll, setNewAllocPayroll] = useState('')
  const [newAllocAmount, setNewAllocAmount] = useState('')

  async function handleAdd() {
    if (!newAllocPayroll || !newAllocAmount) return
    const amt = parseFloat(newAllocAmount)
    if (isNaN(amt) || amt <= 0) {
      setError('Amount must be greater than 0')
      return
    }
    if (amt > unallocated + 0.01) {
      setError('Cannot over-allocate payment amount')
      return
    }

    setSaving(true)
    setError('')
    
    const existing = allocations.find(a => a.payroll_id === newAllocPayroll)
    if (existing) {
       const { error: updErr } = await supabase
         .from('cashbook_payroll_allocations')
         .update({ allocated_amount: Number(existing.allocated_amount) + amt })
         .eq('id', existing.id)
       if (updErr) setError(updErr.message)
    } else {
       const { error: insErr } = await supabase
         .from('cashbook_payroll_allocations')
         .insert({
           cashbook_entry_id: entryId,
           payroll_id: newAllocPayroll,
           allocated_amount: amt
         })
       if (insErr) setError(insErr.message)
    }
    
    if (!error) {
      setNewAllocPayroll('')
      setNewAllocAmount('')
      await fetchAllocations()
      if (selectedEmployee) await fetchPendingPayrolls(selectedEmployee)
      onUpdate()
    }
    setSaving(false)
  }

  async function handleRemove(allocId: string) {
    if (!confirm('Remove this allocation?')) return
    setSaving(true)
    const { error } = await supabase
      .from('cashbook_payroll_allocations')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', allocId)
    
    if (!error) {
      await fetchAllocations()
      if (selectedEmployee) await fetchPendingPayrolls(selectedEmployee)
      onUpdate()
    } else {
      setError(error.message)
    }
    setSaving(false)
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85dvh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-secondary/30">
          <div>
            <h2 className="font-semibold">Manage Salary Allocations</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Distribute this payment across pending payrolls</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-6 flex-1 overflow-y-auto space-y-6">
          <div className="grid grid-cols-3 gap-4">
             <div className="bg-secondary/50 border border-border rounded-lg p-3 text-center">
               <p className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground mb-1">Total Payment</p>
               <p className="font-mono text-lg font-bold">₹{amountInr.toLocaleString('en-IN', {minimumFractionDigits:2})}</p>
             </div>
             <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 text-center">
               <p className="text-[10px] uppercase font-semibold tracking-wider text-green-500/80 mb-1">Allocated</p>
               <p className="font-mono text-lg font-bold text-green-500">₹{totalAllocated.toLocaleString('en-IN', {minimumFractionDigits:2})}</p>
             </div>
             <div className={`border rounded-lg p-3 text-center ${unallocated < 0 ? 'bg-red-500/10 border-red-500/20 text-red-500' : unallocated === 0 ? 'bg-secondary/50 border-border text-muted-foreground' : 'bg-amber-500/10 border-amber-500/20 text-amber-500'}`}>
               <p className="text-[10px] uppercase font-semibold tracking-wider mb-1">Unallocated</p>
               <p className="font-mono text-lg font-bold">₹{unallocated.toLocaleString('en-IN', {minimumFractionDigits:2})}</p>
             </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500 text-sm">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <p>{error}</p>
            </div>
          )}

          <div>
            <h3 className="text-sm font-medium mb-3">Current Allocations</h3>
            {loading ? (
              <p className="text-sm text-muted-foreground animate-pulse">Loading...</p>
            ) : allocations.length === 0 ? (
              <div className="text-center py-6 bg-secondary/30 rounded-lg border border-border border-dashed">
                <p className="text-sm text-muted-foreground">No payroll slips linked yet.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {allocations.map(a => (
                  <div key={a.id} className="flex items-center justify-between p-3 bg-secondary/30 border border-border rounded-lg group">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-primary">
                          {a.payroll?.payslip_number || 'PAY'}
                        </span>
                        <span className="font-medium text-sm">
                          {dn(a.payroll?.employee)}
                        </span>
                        {a.payroll?.status === 'paid' && <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {(() => {
                          const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
                          const sm = a.payroll?.month, sy = a.payroll?.year
                          if (!sm || !sy) return ''
                          const pm = sm === 12 ? 1 : sm + 1
                          const py = sm === 12 ? sy + 1 : sy
                          return `${MONTHS[pm - 1]} ${py} · `
                        })()}
                        Net: ₹{Number(a.payroll?.net_salary).toLocaleString('en-IN', {minimumFractionDigits:2})}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <p className="font-mono text-sm font-semibold">₹{Number(a.allocated_amount).toLocaleString('en-IN', {minimumFractionDigits:2})}</p>
                      <button onClick={() => handleRemove(a.id)} disabled={saving} className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {unallocated > 0.01 && (
            <div className="border-t border-border pt-5 mt-5 space-y-4">
              <h3 className="text-sm font-medium">Allocate Balance</h3>
              
              <div className="w-full">
                <label className="text-xs text-muted-foreground block mb-1">Select Employee</label>
                <select 
                  value={selectedEmployee} 
                  onChange={e => setSelectedEmployee(e.target.value)}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  <option value="">-- Choose Employee --</option>
                  {employees.map(e => (
                    <option key={e.id} value={e.id}>{dn(e)}</option>
                  ))}
                </select>
              </div>

              {selectedEmployee && (
                <div className="flex flex-col sm:flex-row gap-3 items-end">
                  <div className="flex-1 w-full space-y-1.5">
                    <label className="text-xs text-muted-foreground">Select Payroll Slip</label>
                    <Combobox
                      options={payrolls.map(p => {
                        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
                        // Use payment month (salary month + 1) for the label
                        const pm = p.month === 12 ? 1 : (p.month ?? 0) + 1
                        const py = p.month === 12 ? (p.year ?? 0) + 1 : (p.year ?? 0)
                        const payMonthName = p.month ? MONTHS[pm - 1] : '?'
                        const slipNum = p.payslip_number || ''
                        return {
                          id: p.id,
                          label: slipNum
                            ? `${slipNum} — ${payMonthName} ${py || ''}`
                            : `${payMonthName} ${py || ''} Payslip`,
                          sub: `Remaining: ₹${(p.remainingAmount).toLocaleString('en-IN')} (Net: ₹${Number(p.net_salary).toLocaleString('en-IN')})`,
                        }
                      })}
                      value={newAllocPayroll}
                      onChange={id => {
                        setNewAllocPayroll(id)
                        const p = payrolls.find(i => i.id === id)
                        if (p) {
                          const suggest = Math.min(unallocated, p.remainingAmount)
                          setNewAllocAmount(suggest > 0 ? suggest.toString() : unallocated.toString())
                        }
                      }}
                      placeholder="Search pending slips..."
                    />
                  </div>
                  <div className="w-full sm:w-32 space-y-1.5">
                    <label className="text-xs text-muted-foreground">Amount (₹)</label>
                    <input 
                      type="number" 
                      step="0.01" 
                      max={unallocated}
                      value={newAllocAmount}
                      onChange={e => setNewAllocAmount(e.target.value)}
                      className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                  <button 
                    onClick={handleAdd}
                    disabled={saving || !newAllocPayroll || !newAllocAmount}
                    className="w-full sm:w-auto flex items-center justify-center gap-1.5 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    <Plus className="w-4 h-4" />
                    Add
                  </button>
                </div>
              )}
              {selectedEmployee && payrolls.length === 0 && (
                <p className="text-xs text-muted-foreground italic">No pending payroll slips for this employee.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
