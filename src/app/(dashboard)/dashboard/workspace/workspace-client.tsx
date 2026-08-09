'use client'

import { useMemo, useState, useTransition } from 'react'
import { Plus, Check, Trash2, Calendar, NotebookPen, X } from 'lucide-react'
import Header from '@/components/layout/header'
import {
  addWorkspaceItem, updateWorkspaceItem, deleteWorkspaceItem,
  type WorkspaceItem,
} from './actions'

function todayStr(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type BucketKey = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'someday'
const BUCKET_META: Record<BucketKey, { label: string; tone: string }> = {
  overdue:  { label: 'Overdue',    tone: 'text-red-500' },
  today:    { label: 'Today',      tone: 'text-violet-500' },
  tomorrow: { label: 'Tomorrow',   tone: 'text-sky-500' },
  week:     { label: 'This week',  tone: 'text-emerald-500' },
  later:    { label: 'Later',      tone: 'text-muted-foreground' },
  someday:  { label: 'No date',    tone: 'text-muted-foreground' },
}
const BUCKET_ORDER: BucketKey[] = ['overdue', 'today', 'tomorrow', 'week', 'later', 'someday']

function bucketOf(dueDate: string | null): BucketKey {
  if (!dueDate) return 'someday'
  const today = todayStr(), tomorrow = todayStr(1), weekEnd = todayStr(7)
  if (dueDate < today) return 'overdue'
  if (dueDate === today) return 'today'
  if (dueDate === tomorrow) return 'tomorrow'
  if (dueDate <= weekEnd) return 'week'
  return 'later'
}

export function WorkspaceClient({ initialItems }: { initialItems: WorkspaceItem[] }) {
  const [items, setItems] = useState<WorkspaceItem[]>(initialItems)
  const [title, setTitle] = useState('')
  const [quickDue, setQuickDue] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [, startTransition] = useTransition()

  const active = items.filter(i => !i.isDone)
  const done = items.filter(i => i.isDone)

  const buckets = useMemo(() => {
    const map: Record<BucketKey, WorkspaceItem[]> = { overdue: [], today: [], tomorrow: [], week: [], later: [], someday: [] }
    for (const it of active) map[bucketOf(it.dueDate)].push(it)
    return map
  }, [active])

  const add = () => {
    const t = title.trim()
    if (!t) return
    setTitle(''); setQuickDue(null)
    const optimistic: WorkspaceItem = {
      id: `tmp-${Date.now()}`, kind: 'todo', title: t, body: null,
      dueDate: quickDue, remindAt: null, isDone: false, refType: null, refId: null,
      conversationId: null, sortOrder: 0, createdAt: new Date().toISOString(),
    }
    setItems(prev => [optimistic, ...prev])
    startTransition(async () => {
      const res = await addWorkspaceItem({ title: t, dueDate: quickDue })
      if (res.ok) setItems(prev => prev.map(i => i.id === optimistic.id ? res.data : i))
      else setItems(prev => prev.filter(i => i.id !== optimistic.id))
    })
  }

  const toggleDone = (it: WorkspaceItem) => {
    setItems(prev => prev.map(i => i.id === it.id ? { ...i, isDone: !i.isDone } : i))
    startTransition(async () => { await updateWorkspaceItem(it.id, { isDone: !it.isDone }) })
  }

  const remove = (it: WorkspaceItem) => {
    setItems(prev => prev.filter(i => i.id !== it.id))
    startTransition(async () => { await deleteWorkspaceItem(it.id) })
  }

  const setDue = (it: WorkspaceItem, dueDate: string | null) => {
    setItems(prev => prev.map(i => i.id === it.id ? { ...i, dueDate } : i))
    startTransition(async () => { await updateWorkspaceItem(it.id, { dueDate }) })
  }

  return (
    <div>
      <Header title="My Planner" subtitle="Your private to-dos, notes and reminders — only you can see this" />
      <div className="mx-auto max-w-2xl px-4 py-6">
        {/* Quick add */}
        <div className="mb-6 rounded-2xl border border-border bg-card p-3">
          <div className="flex items-center gap-2">
            <NotebookPen className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') add() }}
              placeholder="Add a task…  (Enter to save)"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <button onClick={add} disabled={!title.trim()}
              className="rounded-lg bg-foreground px-2.5 py-1.5 text-background disabled:opacity-30" aria-label="Add">
              <Plus className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-2 flex items-center gap-1.5 pl-6">
            {([['Today', todayStr()], ['Tomorrow', todayStr(1)], ['No date', null]] as [string, string | null][]).map(([label, val]) => (
              <button key={label} onClick={() => setQuickDue(val)}
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  quickDue === val ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}>{label}</button>
            ))}
            <input type="date" value={quickDue ?? ''} onChange={e => setQuickDue(e.target.value || null)}
              className="ml-1 rounded-md border border-border bg-transparent px-1.5 py-0.5 text-[11px] text-muted-foreground" />
          </div>
        </div>

        {/* Buckets */}
        {active.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">Nothing planned. Add your first task above.</p>
        )}
        {BUCKET_ORDER.map(key => buckets[key].length > 0 && (
          <section key={key} className="mb-5">
            <h2 className={`mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide ${BUCKET_META[key].tone}`}>
              {BUCKET_META[key].label}
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{buckets[key].length}</span>
            </h2>
            <div className="space-y-1.5">
              {buckets[key].map(it => (
                <ItemRow key={it.id} it={it} onToggle={() => toggleDone(it)} onRemove={() => remove(it)} onSetDue={d => setDue(it, d)} />
              ))}
            </div>
          </section>
        ))}

        {/* Done */}
        {done.length > 0 && (
          <section className="mt-6 border-t border-border pt-4">
            <button onClick={() => setShowDone(v => !v)}
              className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground">
              {showDone ? 'Hide' : 'Show'} completed ({done.length})
            </button>
            {showDone && (
              <div className="space-y-1.5">
                {done.map(it => (
                  <ItemRow key={it.id} it={it} onToggle={() => toggleDone(it)} onRemove={() => remove(it)} onSetDue={d => setDue(it, d)} />
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

function ItemRow({ it, onToggle, onRemove, onSetDue }: {
  it: WorkspaceItem
  onToggle: () => void
  onRemove: () => void
  onSetDue: (d: string | null) => void
}) {
  const [editingDue, setEditingDue] = useState(false)
  return (
    <div className="group flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2">
      <button onClick={onToggle}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors ${
          it.isDone ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-muted-foreground/40 hover:border-foreground'
        }`} aria-label={it.isDone ? 'Mark not done' : 'Mark done'}>
        {it.isDone && <Check className="h-3 w-3" />}
      </button>
      <span className={`min-w-0 flex-1 truncate text-sm ${it.isDone ? 'text-muted-foreground line-through' : ''}`}>{it.title}</span>

      {editingDue ? (
        <input type="date" autoFocus value={it.dueDate ?? ''}
          onChange={e => { onSetDue(e.target.value || null); setEditingDue(false) }}
          onBlur={() => setEditingDue(false)}
          className="rounded-md border border-border bg-transparent px-1.5 py-0.5 text-[11px]" />
      ) : (
        <button onClick={() => setEditingDue(true)}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100">
          <Calendar className="h-3 w-3" />
          {it.dueDate ? new Date(it.dueDate + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : 'Set date'}
        </button>
      )}
      {it.dueDate && !editingDue && (
        <button onClick={() => onSetDue(null)} className="shrink-0 text-muted-foreground/50 opacity-0 hover:text-foreground group-hover:opacity-100" aria-label="Clear date">
          <X className="h-3 w-3" />
        </button>
      )}
      <button onClick={onRemove} className="shrink-0 text-muted-foreground/50 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100" aria-label="Delete">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
