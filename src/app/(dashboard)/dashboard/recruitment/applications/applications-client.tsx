'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  DndContext, PointerSensor, useSensor, useSensors, useDraggable, useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core'
import { listApplications, moveApplicationStage } from '@/lib/recruitment/actions'
import { STAGE_ORDER, STAGE_LABELS, type ApplicationStage, type JobApplicationSummary } from '@/lib/recruitment/types'
import { usePermissions } from '@/contexts/permission-context'
import { displayEmployee } from '@/lib/utils/employee-display'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { Loader2 } from 'lucide-react'

const STAGE_COLORS: Record<ApplicationStage, string> = {
  new: 'border-t-blue-500/60',
  screening: 'border-t-sky-500/60',
  interview_scheduled: 'border-t-violet-500/60',
  interview_completed: 'border-t-purple-500/60',
  technical_review: 'border-t-amber-500/60',
  selected: 'border-t-emerald-500/60',
  offer_sent: 'border-t-teal-500/60',
  joined: 'border-t-green-600/60',
  rejected: 'border-t-red-500/60',
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function Card({ app }: { app: JobApplicationSummary }) {
  const { revealNames, user } = usePermissions()
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: app.id })
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined

  return (
    <div
      ref={setNodeRef} style={style} {...listeners} {...attributes}
      className={`rounded-xl border border-foreground/10 bg-card p-3 mb-2 cursor-grab active:cursor-grabbing shadow-sm hover:border-violet-500/30 transition-colors ${isDragging ? 'opacity-40' : ''}`}
    >
      <Link href={`/dashboard/recruitment/applications/${app.id}`} className="block" onClick={e => { if (isDragging) e.preventDefault() }}>
        <div className="text-sm font-medium text-foreground truncate">{app.fullName}</div>
        <div className="text-xs text-muted-foreground truncate mb-1.5">{app.positionTitle}</div>
        <div className="flex items-center justify-between text-[11px] text-muted-foreground/70">
          <span className="font-mono">{app.referenceNumber}</span>
          <span>{timeAgo(app.createdAt)}</span>
        </div>
        {app.assignedTo && (
          <div className="mt-1.5 text-[11px] text-violet-400">
            {displayEmployee(app.assignedTo, { revealNames, canReveal: user.isAdmin })}
          </div>
        )}
      </Link>
    </div>
  )
}

function Column({ stage, apps }: { stage: ApplicationStage; apps: JobApplicationSummary[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage })
  return (
    <div
      ref={setNodeRef}
      className={`flex-shrink-0 w-72 rounded-2xl border-t-4 ${STAGE_COLORS[stage]} bg-secondary/50 border border-foreground/10 flex flex-col max-h-[calc(100vh-220px)]`}
    >
      <div className={`px-3 py-2.5 flex items-center justify-between ${isOver ? 'bg-violet-500/10' : ''}`}>
        <span className="text-sm font-semibold text-foreground">{STAGE_LABELS[stage]}</span>
        <span className="text-xs text-muted-foreground bg-foreground/[0.06] rounded-full px-2 py-0.5">{apps.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2 min-h-[80px]">
        {apps.map(a => <Card key={a.id} app={a} />)}
        {apps.length === 0 && <div className="text-xs text-muted-foreground/50 text-center py-6">No applications</div>}
      </div>
    </div>
  )
}

export default function ApplicationsClient({ canEdit }: { canEdit: boolean }) {
  const [apps, setApps] = useState<JobApplicationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [, startTransition] = useTransition()
  const { toasts, dismiss, success, error: toastError } = useToast()

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  useEffect(() => {
    listApplications().then(res => {
      if (res.ok) setApps(res.data)
      else toastError('Could not load applications', res.error)
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const byStage = useMemo(() => {
    const map = {} as Record<ApplicationStage, JobApplicationSummary[]>
    for (const s of STAGE_ORDER) map[s] = []
    for (const a of apps) map[a.stage]?.push(a)
    return map
  }, [apps])

  function handleDragEnd(event: DragEndEvent) {
    if (!canEdit) return
    const { active, over } = event
    if (!over) return
    const newStage = over.id as ApplicationStage
    const app = apps.find(a => a.id === active.id)
    if (!app || app.stage === newStage) return

    const prevStage = app.stage
    setApps(prev => prev.map(a => a.id === app.id ? { ...a, stage: newStage } : a))

    startTransition(async () => {
      const res = await moveApplicationStage(app.id, newStage)
      if (!res.ok) {
        setApps(prev => prev.map(a => a.id === app.id ? { ...a, stage: prevStage } : a))
        toastError('Could not move application', res.error)
      } else {
        success(`Moved to ${STAGE_LABELS[newStage]}`)
      }
    })
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-foreground">Applications</h1>
        <p className="text-sm text-muted-foreground">
          {canEdit ? 'Drag a card to move it through the pipeline.' : 'View-only — you don’t have permission to move applications.'}
        </p>
      </div>
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {STAGE_ORDER.map(stage => <Column key={stage} stage={stage} apps={byStage[stage]} />)}
        </div>
      </DndContext>
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
