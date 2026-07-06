'use client'

/**
 * <RequestApprovalDialog> — shared approval-request form (Wave B).
 * Opened from chat (conversation pre-filled) and, later, from entity pages
 * (invoice/quotation/task menus pass entityType + entityId + title).
 */

import { useEffect, useState, useTransition } from 'react'
import { X } from 'lucide-react'
import { requestApproval, getApprovalFormOptions } from '@/lib/approvals/actions'
import { usePermissions } from '@/contexts/permission-context'
import { displayEmployee } from '@/lib/utils/employee-display'

const ENTITY_TYPES = [
  { key: 'other',           label: 'General' },
  { key: 'design',          label: 'Design / Poster' },
  { key: 'file',            label: 'File' },
  { key: 'invoice',         label: 'Invoice' },
  { key: 'quotation',       label: 'Quotation' },
  { key: 'task_completion', label: 'Task completion' },
  { key: 'expense',         label: 'Expense / Purchase' },
  { key: 'campaign',        label: 'Campaign' },
]

export function RequestApprovalDialog({ conversationId, defaults, onClose, onCreated }: {
  conversationId?: string | null
  defaults?: { entityType?: string; entityId?: string; title?: string; taskId?: string }
  onClose: () => void
  onCreated: (approvalId: string) => void
}) {
  const [title, setTitle] = useState(defaults?.title ?? '')
  const [description, setDescription] = useState('')
  const [entityType, setEntityType] = useState(defaults?.entityType ?? 'other')
  const [approverMode, setApproverMode] = useState<'admin' | 'person' | 'designation'>('admin')
  const [approverId, setApproverId] = useState('')
  const [designationId, setDesignationId] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [options, setOptions] = useState<{ employees: { id: string; name: string; cqid: string }[]; designations: { id: string; name: string }[] }>({ employees: [], designations: [] })
  const { revealNames } = usePermissions()
  const mask = (name?: string | null, cqid?: string | null) =>
    displayEmployee({ name: name ?? '', cqid: cqid ?? '' }, { revealNames, canReveal: true })
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    getApprovalFormOptions().then(res => { if (res.ok) setOptions(res.data) })
  }, [])

  const submit = () => {
    setError(null)
    if (!title.trim()) { setError('A title is required.'); return }
    if (approverMode === 'person' && !approverId) { setError('Pick an approver.'); return }
    if (approverMode === 'designation' && !designationId) { setError('Pick a designation.'); return }
    startTransition(async () => {
      const res = await requestApproval({
        entityType,
        entityId: defaults?.entityId ?? null,
        title,
        description,
        approver:
          approverMode === 'person'      ? { employeeId: approverId } :
          approverMode === 'designation' ? { designationId } :
          {}, // default rule: any admin
        conversationId: conversationId ?? null,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        taskId: defaults?.taskId ?? null,
      })
      if (res.ok) onCreated(res.data.approvalId)
      else setError(res.error)
    })
  }

  const inputCls = 'w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-border bg-background p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Request approval</h2>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && <p className="mb-3 text-xs text-destructive">{error}</p>}

        <div className="space-y-3">
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs approval?" className={inputCls} />
          <textarea value={description} onChange={e => setDescription(e.target.value)}
            placeholder="Details (optional)" rows={3} className={`${inputCls} resize-none`} />

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">Type</span>
              <select value={entityType} onChange={e => setEntityType(e.target.value)} className={inputCls}>
                {ENTITY_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">Due (optional)</span>
              <input type="date" value={dueAt} onChange={e => setDueAt(e.target.value)} className={inputCls} />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Who approves?</span>
            <select value={approverMode}
              onChange={e => setApproverMode(e.target.value as 'admin' | 'person' | 'designation')}
              className={inputCls}>
              <option value="admin">Any admin</option>
              <option value="person">A specific person</option>
              <option value="designation">Anyone in a designation</option>
            </select>
          </label>

          {approverMode === 'person' && (
            <select value={approverId} onChange={e => setApproverId(e.target.value)} className={inputCls}>
              <option value="">Choose person…</option>
              {options.employees.map(e => <option key={e.id} value={e.id}>{mask(e.name, e.cqid)}</option>)}
            </select>
          )}
          {approverMode === 'designation' && (
            <select value={designationId} onChange={e => setDesignationId(e.target.value)} className={inputCls}>
              <option value="">Choose designation…</option>
              {options.designations.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}

          <button onClick={submit} disabled={pending || !title.trim()}
            className="w-full rounded-lg bg-foreground py-2 text-sm font-medium text-background disabled:opacity-40">
            {pending ? 'Requesting…' : 'Send request'}
          </button>
          {conversationId && (
            <p className="text-center text-xs text-muted-foreground">Posts a card into this conversation.</p>
          )}
        </div>
      </div>
    </div>
  )
}
