'use client'

import { useEffect, useState } from 'react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { usePrivacy } from '@/contexts/privacy-context'
import { X, RefreshCw, AlertTriangle, Check, CalendarIcon } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  employees: { id: string; name: string; cqid?: string | null }[]
}

export function RecalcCommissionsModal({ open, onClose, employees }: Props) {
  const { dn } = usePrivacy()
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ updated: number; inserted: number; totalProcessed: number } | null>(null)

  useEffect(() => {
    if (!open) return
    setDateFrom('')
    setDateTo('')
    setEmployeeId('')
    setError(null)
    setResult(null)
  }, [open])

  async function handleApply() {
    if (!dateFrom || !dateTo) {
      setError('Please select both start and end dates.')
      return
    }

    if (!confirm('Are you sure you want to recalculate commissions for the selected period? This will override existing commission scores but will keep previous values in the audit trail.')) {
      return
    }

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const res = await fetch('/api/recalc-commissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateFrom, dateTo, employeeId })
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Failed to recalculate')
      }

      setResult({
        updated: data.updated || 0,
        inserted: data.inserted || 0,
        totalProcessed: data.totalProcessed || 0
      })
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="font-semibold flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-violet-400" /> Bulk Recalculate Commissions
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Re-apply performance history and formulas to existing tasks.
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 flex gap-3 text-sm">
            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
            <div className="text-amber-200">
              <p className="font-semibold mb-1">Audit Trail Enabled</p>
              <p className="text-xs">
                This process will recalculate the commission scores for all tasks in the selected date range. Previous earnings and scores will be saved in the database for auditing purposes.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-1.5">
                Task Date From (Required)
              </label>
              <input 
                type="date" 
                value={dateFrom} 
                onChange={e => setDateFrom(e.target.value)}
                className="w-full bg-secondary border border-border rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:border-violet-500/50" 
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-1.5">
                Task Date To (Required)
              </label>
              <input 
                type="date" 
                value={dateTo} 
                onChange={e => setDateTo(e.target.value)}
                className="w-full bg-secondary border border-border rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:border-violet-500/50" 
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-1.5">
                Employee (Optional)
              </label>
              <select 
                value={employeeId} 
                onChange={e => setEmployeeId(e.target.value)}
                className="w-full bg-secondary border border-border rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:border-violet-500/50"
              >
                <option value="">All Employees</option>
                {employees.map(emp => (
                  <option key={emp.id} value={emp.id}>{dn(emp)}</option>
                ))}
              </select>
            </div>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          {result && (
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2 text-xs text-green-300 flex items-center gap-2">
              <Check className="w-4 h-4 shrink-0" />
              <div>
                Processed <strong>{result.totalProcessed}</strong> tasks. 
                Updated <strong>{result.updated}</strong> scores and inserted <strong>{result.inserted}</strong> missing scores.
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border shrink-0">
          <button 
            type="button" 
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
          <button 
            type="button" 
            onClick={handleApply} 
            disabled={loading || !dateFrom || !dateTo}
            className="px-4 py-2 flex items-center gap-2 rounded-lg gradient-bg text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {loading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Recalculating...
              </>
            ) : (
              'Recalculate'
            )}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
