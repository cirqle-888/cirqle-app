'use client'

import { useEffect, useState, useTransition } from 'react'
import { Plus, Loader2, MapPin, Users as UsersIcon, Trash2, Pencil, X } from 'lucide-react'
import { listPositions, createPosition, updatePosition, deletePosition, type PositionInput } from '@/lib/recruitment/actions'
import type { JobPosition, PositionStatus, EmploymentType } from '@/lib/recruitment/types'
import { useToast, ToastContainer } from '@/components/ui/toast'

const inputCls = 'w-full bg-secondary border border-foreground/15 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/40'

const STATUS_STYLE: Record<PositionStatus, string> = {
  open: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  on_hold: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  closed: 'bg-foreground/[0.06] text-muted-foreground border-foreground/10',
}

const emptyForm: PositionInput = {
  title: '', department: '', location: '', isRemote: false, employmentType: 'full_time',
  description: '', requirements: '', openings: 1, status: 'open',
}

export default function PositionsClient({ canEdit, canDelete }: { canEdit: boolean; canDelete: boolean }) {
  const [positions, setPositions] = useState<JobPosition[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<PositionInput>(emptyForm)
  const [, startTransition] = useTransition()
  const { toasts, dismiss, success, error: toastError } = useToast()

  function load() {
    listPositions().then(res => {
      if (res.ok) setPositions(res.data)
      else toastError('Could not load positions', res.error)
      setLoading(false)
    })
  }
  useEffect(load, []) // eslint-disable-line react-hooks/exhaustive-deps

  function startEdit(p: JobPosition) {
    setEditingId(p.id)
    setForm({
      title: p.title, department: p.department ?? '', location: p.location ?? '', isRemote: p.isRemote,
      employmentType: p.employmentType, description: p.description ?? '', requirements: p.requirements ?? '',
      openings: p.openings, status: p.status,
    })
    setShowForm(true)
  }

  function handleSave() {
    startTransition(async () => {
      const res = editingId ? await updatePosition(editingId, form) : await createPosition(form)
      if (res.ok) {
        success(editingId ? 'Position updated' : 'Position created')
        setShowForm(false); setEditingId(null); setForm(emptyForm); load()
      } else toastError('Could not save', res.error)
    })
  }

  function handleDelete(id: string) {
    if (!confirm('Delete this position? Existing applications keep a snapshot of the title.')) return
    startTransition(async () => {
      const res = await deletePosition(id)
      if (res.ok) { success('Position deleted'); load() } else toastError('Could not delete', res.error)
    })
  }

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Open Positions</h1>
          <p className="text-sm text-muted-foreground">Manage job postings that feed the public careers page.</p>
        </div>
        {canEdit && (
          <button
            onClick={() => { setEditingId(null); setForm(emptyForm); setShowForm(v => !v) }}
            className="flex items-center gap-1.5 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-lg px-3 py-2"
          >
            <Plus className="h-4 w-4" />New Position
          </button>
        )}
      </div>

      {showForm && (
        <div className="rounded-2xl border border-foreground/10 bg-card p-4 sm:p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{editingId ? 'Edit position' : 'New position'}</h2>
            <button onClick={() => setShowForm(false)}><X className="h-4 w-4 text-muted-foreground" /></button>
          </div>
          <input className={inputCls} placeholder="Title" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
          <div className="grid grid-cols-2 gap-3">
            <input className={inputCls} placeholder="Department" value={form.department ?? ''} onChange={e => setForm(f => ({ ...f, department: e.target.value }))} />
            <input className={inputCls} placeholder="Location" value={form.location ?? ''} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <select className={inputCls} value={form.employmentType} onChange={e => setForm(f => ({ ...f, employmentType: e.target.value as EmploymentType }))}>
              <option value="full_time">Full-time</option>
              <option value="part_time">Part-time</option>
              <option value="contract">Contract</option>
              <option value="internship">Internship</option>
              <option value="freelance">Freelance</option>
            </select>
            <input type="number" min={1} className={inputCls} placeholder="Openings" value={form.openings} onChange={e => setForm(f => ({ ...f, openings: Number(e.target.value) }))} />
            <select className={inputCls} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as PositionStatus }))}>
              <option value="open">Open</option>
              <option value="on_hold">On Hold</option>
              <option value="closed">Closed</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={form.isRemote} onChange={e => setForm(f => ({ ...f, isRemote: e.target.checked }))} />Remote-friendly
          </label>
          <textarea className={inputCls} rows={3} placeholder="Description" value={form.description ?? ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          <textarea className={inputCls} rows={2} placeholder="Requirements" value={form.requirements ?? ''} onChange={e => setForm(f => ({ ...f, requirements: e.target.value }))} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="text-sm text-muted-foreground px-3 py-2">Cancel</button>
            <button onClick={handleSave} disabled={!form.title.trim()} className="text-sm bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white rounded-lg px-4 py-2">Save</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {positions.map(p => (
          <div key={p.id} className="rounded-xl border border-foreground/10 bg-card p-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold text-foreground">{p.title}</h3>
                <span className={`text-[11px] border rounded-full px-2 py-0.5 ${STATUS_STYLE[p.status]}`}>{p.status.replace('_', ' ')}</span>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1 flex-wrap">
                {p.department && <span>{p.department}</span>}
                {p.location && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{p.location}{p.isRemote ? ' · Remote' : ''}</span>}
                <span className="flex items-center gap-1"><UsersIcon className="h-3 w-3" />{p.applicationCount ?? 0} applicant{(p.applicationCount ?? 0) === 1 ? '' : 's'}</span>
              </div>
            </div>
            {canEdit && (
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => startEdit(p)} className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg hover:bg-foreground/[0.06]"><Pencil className="h-3.5 w-3.5" /></button>
                {canDelete && <button onClick={() => handleDelete(p.id)} className="p-1.5 text-muted-foreground hover:text-destructive rounded-lg hover:bg-destructive/10"><Trash2 className="h-3.5 w-3.5" /></button>}
              </div>
            )}
          </div>
        ))}
        {positions.length === 0 && <p className="text-sm text-muted-foreground text-center py-10">No positions yet. Create one to start receiving applications.</p>}
      </div>
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
