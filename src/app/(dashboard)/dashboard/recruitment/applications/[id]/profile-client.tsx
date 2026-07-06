'use client'

import { useEffect, useState, useTransition, useCallback } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Mail, Phone, MapPin, Globe, Link2, FileText, Loader2, Plus,
  CalendarClock, BadgeCheck, Trash2, ExternalLink,
} from 'lucide-react'
import {
  getApplication, moveApplicationStage, assignApplication, addNote, deleteApplication,
  scheduleInterview, updateInterview, createOffer, updateOfferStatus, getDocumentUrl,
  listEmployeesForPicker, type ApplicationProfile,
} from '@/lib/recruitment/actions'
import { STAGE_ORDER, STAGE_LABELS, type ApplicationStage, type EmployeeRef, type InterviewStatus, type OfferStatus } from '@/lib/recruitment/types'
import { TimelineTab } from '@/components/activity/timeline-tab'
import { usePermissions } from '@/contexts/permission-context'
import { displayEmployee } from '@/lib/utils/employee-display'
import Combobox from '@/components/ui/combobox'
import { useToast, ToastContainer } from '@/components/ui/toast'

interface Props {
  applicationId: string
  canEdit: boolean
  canDelete: boolean
}

const inputCls = 'w-full bg-secondary border border-foreground/15 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/40'
const sectionCls = 'rounded-2xl border border-foreground/10 bg-card p-4 sm:p-5'

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export default function ApplicantProfileClient({ applicationId, canEdit, canDelete }: Props) {
  const [profile, setProfile] = useState<ApplicationProfile | null>(null)
  const [employees, setEmployees] = useState<EmployeeRef[]>([])
  const [loading, setLoading] = useState(true)
  const [noteText, setNoteText] = useState('')
  const [showInterviewForm, setShowInterviewForm] = useState(false)
  const [showOfferForm, setShowOfferForm] = useState(false)
  const [isPending, startTransition] = useTransition()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const { revealNames, user } = usePermissions()

  const load = useCallback(() => {
    getApplication(applicationId).then(res => {
      if (res.ok) setProfile(res.data)
      else toastError('Could not load application', res.error)
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationId])

  useEffect(() => { load() }, [load])
  useEffect(() => { listEmployeesForPicker().then(res => { if (res.ok) setEmployees(res.data) }) }, [])

  function mask(e: EmployeeRef | null) {
    return displayEmployee(e, { revealNames, canReveal: user.isAdmin })
  }

  function handleStageChange(stage: ApplicationStage) {
    startTransition(async () => {
      const res = await moveApplicationStage(applicationId, stage)
      if (res.ok) { success(`Moved to ${STAGE_LABELS[stage]}`); load() }
      else toastError('Could not update stage', res.error)
    })
  }

  function handleAssign(employeeId: string) {
    startTransition(async () => {
      const res = await assignApplication(applicationId, employeeId || null)
      if (res.ok) { success('Assignee updated'); load() }
      else toastError('Could not assign', res.error)
    })
  }

  function handleAddNote() {
    if (!noteText.trim()) return
    startTransition(async () => {
      const res = await addNote(applicationId, noteText)
      if (res.ok) { setNoteText(''); success('Note added'); load() }
      else toastError('Could not add note', res.error)
    })
  }

  function handleOpenResume(path: string | null) {
    if (!path) return
    startTransition(async () => {
      const res = await getDocumentUrl(path)
      if (res.ok) window.open(res.data.url, '_blank')
      else toastError('Could not open document', res.error)
    })
  }

  function handleDelete() {
    if (!confirm('Permanently delete this application? This cannot be undone.')) return
    startTransition(async () => {
      const res = await deleteApplication(applicationId)
      if (res.ok) { success('Application deleted'); window.location.href = '/dashboard/recruitment/applications' }
      else toastError('Could not delete', res.error)
    })
  }

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  if (!profile) return <div className="p-6 text-sm text-muted-foreground">Application not found.</div>

  const { application: app, notes, documents, interviews, offers } = profile

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/recruitment/applications" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold text-foreground truncate">{app.fullName}</h1>
          <p className="text-sm text-muted-foreground">{app.positionTitle} · <span className="font-mono">{app.referenceNumber}</span></p>
        </div>
        {canDelete && (
          <button onClick={handleDelete} className="text-muted-foreground hover:text-destructive p-2 rounded-lg hover:bg-destructive/10" title="Delete application">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left: contact + details */}
        <div className="lg:col-span-1 space-y-4">
          <div className={sectionCls}>
            <h2 className="text-sm font-semibold mb-3">Contact</h2>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground"><Mail className="h-3.5 w-3.5 shrink-0" /><a href={`mailto:${app.email}`} className="truncate hover:text-foreground">{app.email}</a></div>
              {app.phone && <div className="flex items-center gap-2 text-muted-foreground"><Phone className="h-3.5 w-3.5 shrink-0" />{app.phone}</div>}
              {app.location && <div className="flex items-center gap-2 text-muted-foreground"><MapPin className="h-3.5 w-3.5 shrink-0" />{app.location}{app.country ? `, ${app.country}` : ''}</div>}
              {app.portfolioUrl && <div className="flex items-center gap-2 text-muted-foreground"><Globe className="h-3.5 w-3.5 shrink-0" /><a href={app.portfolioUrl} target="_blank" rel="noreferrer" className="truncate hover:text-violet-400">Portfolio</a></div>}
              {app.linkedinUrl && <div className="flex items-center gap-2 text-muted-foreground"><Link2 className="h-3.5 w-3.5 shrink-0" /><a href={app.linkedinUrl} target="_blank" rel="noreferrer" className="truncate hover:text-violet-400">LinkedIn</a></div>}
            </div>
          </div>

          <div className={sectionCls}>
            <h2 className="text-sm font-semibold mb-3">Pipeline</h2>
            <label className="block text-xs text-muted-foreground mb-1">Stage</label>
            <select
              className={inputCls} value={app.stage} disabled={!canEdit}
              onChange={e => handleStageChange(e.target.value as ApplicationStage)}
            >
              {STAGE_ORDER.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
            </select>

            <label className="block text-xs text-muted-foreground mt-3 mb-1">Assigned to</label>
            <Combobox
              options={employees.map(e => ({ id: e.id, label: mask(e) }))}
              value={app.assignedTo?.id ?? ''}
              onChange={handleAssign}
              placeholder="Unassigned"
              disabled={!canEdit}
            />
          </div>

          <div className={sectionCls}>
            <h2 className="text-sm font-semibold mb-3">Details</h2>
            <dl className="space-y-2 text-sm">
              {app.experience && <div><dt className="text-xs text-muted-foreground">Experience</dt><dd>{app.experience}</dd></div>}
              {app.expectedSalary != null && <div><dt className="text-xs text-muted-foreground">Expected Salary</dt><dd>₹{app.expectedSalary.toLocaleString('en-IN')}</dd></div>}
              {app.availability && <div><dt className="text-xs text-muted-foreground">Availability</dt><dd>{app.availability}</dd></div>}
              {app.skills.length > 0 && (
                <div>
                  <dt className="text-xs text-muted-foreground mb-1">Skills</dt>
                  <dd className="flex flex-wrap gap-1">
                    {app.skills.map(s => <span key={s} className="text-[11px] bg-violet-500/10 text-violet-400 border border-violet-500/20 rounded-full px-2 py-0.5">{s}</span>)}
                  </dd>
                </div>
              )}
              <div className="text-xs text-muted-foreground pt-1">Applied {fmtDate(app.createdAt)} via {app.source}</div>
            </dl>
          </div>

          {(app.whyJoin || app.coverLetter) && (
            <div className={sectionCls}>
              {app.whyJoin && <><h2 className="text-sm font-semibold mb-1.5">Why join Cirqle?</h2><p className="text-sm text-muted-foreground whitespace-pre-wrap mb-3">{app.whyJoin}</p></>}
              {app.coverLetter && <><h2 className="text-sm font-semibold mb-1.5">Cover Letter</h2><p className="text-sm text-muted-foreground whitespace-pre-wrap">{app.coverLetter}</p></>}
            </div>
          )}
        </div>

        {/* Middle + right: documents, interviews, offers, notes, timeline */}
        <div className="lg:col-span-2 space-y-4">
          <div className={sectionCls}>
            <h2 className="text-sm font-semibold mb-3">Resume &amp; Documents</h2>
            {app.resumeStoragePath && (
              <button onClick={() => handleOpenResume(app.resumeStoragePath)} className="flex items-center gap-2 text-sm text-violet-400 hover:text-violet-300 mb-2">
                <FileText className="h-4 w-4" />Preview resume<ExternalLink className="h-3 w-3" />
              </button>
            )}
            <div className="space-y-1.5">
              {documents.map(d => (
                <div key={d.id} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground truncate">{d.fileName ?? d.docType}</span>
                  <button onClick={() => handleOpenResume(d.storagePath)} className="text-violet-400 hover:text-violet-300 text-xs">View</button>
                </div>
              ))}
              {documents.length === 0 && !app.resumeStoragePath && <p className="text-xs text-muted-foreground/60">No documents uploaded.</p>}
            </div>
          </div>

          <div className={sectionCls}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold">Interview History</h2>
              {canEdit && (
                <button onClick={() => setShowInterviewForm(v => !v)} className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300">
                  <Plus className="h-3.5 w-3.5" />Schedule
                </button>
              )}
            </div>
            {showInterviewForm && (
              <InterviewForm
                employees={employees} mask={mask}
                onCancel={() => setShowInterviewForm(false)}
                onSubmit={(input) => startTransition(async () => {
                  const res = await scheduleInterview({ applicationId, ...input })
                  if (res.ok) { success('Interview scheduled'); setShowInterviewForm(false); load() }
                  else toastError('Could not schedule', res.error)
                })}
              />
            )}
            <div className="space-y-2">
              {interviews.map(i => (
                <div key={i.id} className="flex items-center justify-between text-sm border border-foreground/10 rounded-lg px-3 py-2">
                  <div>
                    <div className="flex items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />{fmtDateTime(i.scheduledAt)} ({i.durationMinutes}m)</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {i.interviewer ? `Interviewer: ${mask(i.interviewer)}` : 'No interviewer assigned'}
                      {i.meetingLink && <> · <a href={i.meetingLink} target="_blank" rel="noreferrer" className="text-violet-400">Meeting link</a></>}
                    </div>
                  </div>
                  <select
                    className="bg-secondary border border-foreground/15 rounded-lg px-2 py-1 text-xs" value={i.status} disabled={!canEdit}
                    onChange={e => startTransition(async () => {
                      const res = await updateInterview(i.id, { status: e.target.value as InterviewStatus })
                      if (res.ok) load(); else toastError('Could not update', res.error)
                    })}
                  >
                    <option value="scheduled">Scheduled</option>
                    <option value="completed">Completed</option>
                    <option value="cancelled">Cancelled</option>
                    <option value="no_show">No Show</option>
                  </select>
                </div>
              ))}
              {interviews.length === 0 && <p className="text-xs text-muted-foreground/60">No interviews scheduled yet.</p>}
            </div>
          </div>

          <div className={sectionCls}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold">Offers</h2>
              {canEdit && (
                <button onClick={() => setShowOfferForm(v => !v)} className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300">
                  <Plus className="h-3.5 w-3.5" />New offer
                </button>
              )}
            </div>
            {showOfferForm && (
              <OfferForm
                onCancel={() => setShowOfferForm(false)}
                onSubmit={(input) => startTransition(async () => {
                  const res = await createOffer({ applicationId, ...input })
                  if (res.ok) { success('Offer created'); setShowOfferForm(false); load() }
                  else toastError('Could not create offer', res.error)
                })}
              />
            )}
            <div className="space-y-2">
              {offers.map(o => (
                <div key={o.id} className="flex items-center justify-between text-sm border border-foreground/10 rounded-lg px-3 py-2">
                  <div>
                    <div className="flex items-center gap-1.5"><BadgeCheck className="h-3.5 w-3.5 text-muted-foreground" />{o.currency} {o.offeredSalary?.toLocaleString('en-IN') ?? '—'}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {o.startDate ? `Starts ${fmtDate(o.startDate)}` : ''}{o.expiryDate ? ` · Expires ${fmtDate(o.expiryDate)}` : ''}
                    </div>
                  </div>
                  {canEdit ? (
                    <select
                      className="bg-secondary border border-foreground/15 rounded-lg px-2 py-1 text-xs" value={o.status}
                      onChange={e => startTransition(async () => {
                        const res = await updateOfferStatus(o.id, e.target.value as OfferStatus)
                        if (res.ok) load(); else toastError('Could not update', res.error)
                      })}
                    >
                      <option value="draft">Draft</option>
                      <option value="sent">Sent</option>
                      <option value="accepted">Accepted</option>
                      <option value="declined">Declined</option>
                      <option value="expired">Expired</option>
                    </select>
                  ) : <span className="text-xs text-muted-foreground capitalize">{o.status}</span>}
                </div>
              ))}
              {offers.length === 0 && <p className="text-xs text-muted-foreground/60">No offers yet.</p>}
            </div>
          </div>

          <div className={sectionCls}>
            <h2 className="text-sm font-semibold mb-1">Internal Notes</h2>
            <p className="text-xs text-muted-foreground/70 mb-3">Visible to employees only — never shown to the applicant.</p>
            {canEdit && (
              <div className="flex gap-2 mb-3">
                <input className={inputCls} placeholder="Add a note…" value={noteText} onChange={e => setNoteText(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAddNote()} />
                <button onClick={handleAddNote} disabled={isPending} className="shrink-0 bg-violet-600 hover:bg-violet-500 text-white text-sm rounded-lg px-3 disabled:opacity-50">Add</button>
              </div>
            )}
            <div className="space-y-2">
              {notes.map(n => (
                <div key={n.id} className="text-sm border-l-2 border-violet-500/30 pl-3">
                  <p className="text-foreground">{n.note}</p>
                  <p className="text-xs text-muted-foreground/70 mt-0.5">{mask(n.author)} · {fmtDateTime(n.createdAt)}</p>
                </div>
              ))}
              {notes.length === 0 && <p className="text-xs text-muted-foreground/60">No internal notes yet.</p>}
            </div>
          </div>

          <div className={sectionCls}>
            <h2 className="text-sm font-semibold mb-3">Activity Timeline</h2>
            <TimelineTab scope={{ applicationId }} variant="compact" />
          </div>
        </div>
      </div>
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

function InterviewForm({ employees, mask, onSubmit, onCancel }: {
  employees: EmployeeRef[]
  mask: (e: EmployeeRef | null) => string
  onSubmit: (input: { scheduledAt: string; durationMinutes: number; interviewerId: string | null; meetingLink: string | null }) => void
  onCancel: () => void
}) {
  const [scheduledAt, setScheduledAt] = useState('')
  const [duration, setDuration] = useState(30)
  const [interviewerId, setInterviewerId] = useState('')
  const [meetingLink, setMeetingLink] = useState('')
  return (
    <div className="border border-foreground/10 rounded-lg p-3 mb-3 space-y-2">
      <input type="datetime-local" className={inputCls} value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} />
      <div className="grid grid-cols-2 gap-2">
        <input type="number" min={15} step={15} className={inputCls} value={duration} onChange={e => setDuration(Number(e.target.value))} placeholder="Minutes" />
        <input className={inputCls} value={meetingLink} onChange={e => setMeetingLink(e.target.value)} placeholder="Meeting link" />
      </div>
      <Combobox options={employees.map(e => ({ id: e.id, label: mask(e) }))} value={interviewerId} onChange={setInterviewerId} placeholder="Interviewer" />
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="text-xs text-muted-foreground px-3 py-1.5">Cancel</button>
        <button
          onClick={() => scheduledAt && onSubmit({ scheduledAt: new Date(scheduledAt).toISOString(), durationMinutes: duration, interviewerId: interviewerId || null, meetingLink: meetingLink || null })}
          className="text-xs bg-violet-600 hover:bg-violet-500 text-white rounded-lg px-3 py-1.5"
        >Schedule</button>
      </div>
    </div>
  )
}

function OfferForm({ onSubmit, onCancel }: {
  onSubmit: (input: { positionTitle: string | null; offeredSalary: number | null; startDate: string | null; expiryDate: string | null; notes: string | null }) => void
  onCancel: () => void
}) {
  const [positionTitle, setPositionTitle] = useState('')
  const [salary, setSalary] = useState('')
  const [startDate, setStartDate] = useState('')
  const [expiryDate, setExpiryDate] = useState('')
  return (
    <div className="border border-foreground/10 rounded-lg p-3 mb-3 space-y-2">
      <input className={inputCls} value={positionTitle} onChange={e => setPositionTitle(e.target.value)} placeholder="Position title" />
      <div className="grid grid-cols-2 gap-2">
        <input type="number" className={inputCls} value={salary} onChange={e => setSalary(e.target.value)} placeholder="Offered salary (₹)" />
        <input type="date" className={inputCls} value={startDate} onChange={e => setStartDate(e.target.value)} />
      </div>
      <input type="date" className={inputCls} value={expiryDate} onChange={e => setExpiryDate(e.target.value)} placeholder="Offer expires" />
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="text-xs text-muted-foreground px-3 py-1.5">Cancel</button>
        <button
          onClick={() => onSubmit({ positionTitle: positionTitle || null, offeredSalary: salary ? Number(salary) : null, startDate: startDate || null, expiryDate: expiryDate || null, notes: null })}
          className="text-xs bg-violet-600 hover:bg-violet-500 text-white rounded-lg px-3 py-1.5"
        >Create Offer</button>
      </div>
    </div>
  )
}
