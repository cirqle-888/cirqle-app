'use server'

/**
 * Recruitment / Careers module — CRM-side server actions.
 *
 * Every mutation follows the standard pattern from HANDOFF_CIRQLE_CONNECT.md:
 *   loadCurrentUser() + hasPermission() → admin client write →
 *   void logActivity(...) → createNotification()/notifyAdmins() where relevant.
 *
 * Permission model: recruitment.view (read everything below), recruitment.edit
 * (positions/pipeline/interviews/offers), recruitment.delete (hard delete),
 * recruitment.interview (be assignable + record outcomes — admins/edit holders
 * can already do this; this key exists for a narrower "interviewer only" role),
 * recruitment.admin (superset, mirrors other modules' *.admin conventions).
 *
 * Public submission (no auth) lives in src/app/careers/apply/actions.ts —
 * intentionally a separate file so the public/unauthenticated surface area is
 * easy to audit in one place.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { logActivity } from '@/lib/activity/log'
import { createNotification, notifyAdmins } from '@/lib/notifications/create'
import type {
  ApplicationDocumentRow, ApplicationInterviewRow, ApplicationOfferRow, ApplicationNoteRow,
  ApplicationStage, EmployeeRef, EmploymentType, InterviewStatus, JobApplicationDetail,
  JobApplicationSummary, JobPosition, OfferStatus, PositionStatus, RecruitmentReports,
} from './types'
import { STAGE_ORDER } from './types'

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

// ── Guards ────────────────────────────────────────────────────────────────────

async function requireView() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false as const, error: 'Not signed in.' }
  if (!hasPermission(me, 'recruitment.view')) return { ok: false as const, error: 'Permission denied.' }
  return { ok: true as const, me }
}

async function requireEdit() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false as const, error: 'Not signed in.' }
  if (!hasPermission(me, 'recruitment.edit') && !hasPermission(me, 'recruitment.admin')) {
    return { ok: false as const, error: 'Permission denied.' }
  }
  return { ok: true as const, me }
}

async function requireDelete() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false as const, error: 'Not signed in.' }
  if (!hasPermission(me, 'recruitment.delete') && !hasPermission(me, 'recruitment.admin')) {
    return { ok: false as const, error: 'Permission denied.' }
  }
  return { ok: true as const, me }
}

// ── Mapping helpers ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function empRef(raw: any): EmployeeRef | null {
  const e = Array.isArray(raw) ? raw[0] : raw
  if (!e?.id) return null
  return { id: e.id, name: e.name ?? '', cqid: e.cqid ?? '' }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapPosition(r: any): JobPosition {
  return {
    id: r.id,
    title: r.title,
    department: r.department ?? null,
    location: r.location ?? null,
    isRemote: !!r.is_remote,
    employmentType: r.employment_type,
    description: r.description ?? null,
    requirements: r.requirements ?? null,
    openings: r.openings ?? 1,
    status: r.status,
    applicationCount: r.application_count ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapApplicationSummary(r: any): JobApplicationSummary {
  return {
    id: r.id,
    referenceNumber: r.reference_number,
    positionId: r.position_id ?? null,
    positionTitle: r.position_title,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone ?? null,
    stage: r.stage,
    source: r.source,
    assignedTo: empRef(r.assignee),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapApplicationDetail(r: any): JobApplicationDetail {
  return {
    ...mapApplicationSummary(r),
    country: r.country ?? null,
    location: r.location ?? null,
    experience: r.experience ?? null,
    expectedSalary: r.expected_salary ?? null,
    availability: r.availability ?? null,
    portfolioUrl: r.portfolio_url ?? null,
    linkedinUrl: r.linkedin_url ?? null,
    resumeStoragePath: r.resume_storage_path ?? null,
    coverLetter: r.cover_letter ?? null,
    skills: r.skills ?? [],
    whyJoin: r.why_join ?? null,
    rejectedReason: r.rejected_reason ?? null,
  }
}

const APPLICATION_SELECT = `
  id, reference_number, position_id, position_title, full_name, email, phone,
  country, location, experience, expected_salary, availability, portfolio_url,
  linkedin_url, resume_storage_path, cover_letter, skills, why_join, stage,
  source, rejected_reason, assigned_to, created_at, updated_at,
  assignee:assigned_to(id, name, cqid)
`

// ── Employees (for assignee / interviewer pickers) ───────────────────────────

export async function listEmployeesForPicker(): Promise<Result<EmployeeRef[]>> {
  const guard = await requireView()
  if (!guard.ok) return guard
  const admin = createAdminClient()
  const { data, error } = await admin.from('employees')
    .select('id, name, cqid').eq('is_active', true).order('cqid')
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: (data ?? []).map(e => ({ id: e.id, name: e.name ?? '', cqid: e.cqid ?? '' })) }
}

// ── Positions ─────────────────────────────────────────────────────────────────

export async function listPositions(): Promise<Result<JobPosition[]>> {
  const guard = await requireView()
  if (!guard.ok) return guard
  const admin = createAdminClient()
  const { data: positions, error } = await admin
    .from('job_positions')
    .select('id, title, department, location, is_remote, employment_type, description, requirements, openings, status, created_at, updated_at')
    .order('created_at', { ascending: false })
  if (error) return { ok: false, error: error.message }

  const { data: counts } = await admin.from('job_applications').select('position_id')
  const countMap = new Map<string, number>()
  for (const row of counts ?? []) {
    const pid = (row as { position_id: string | null }).position_id
    if (pid) countMap.set(pid, (countMap.get(pid) ?? 0) + 1)
  }

  return {
    ok: true,
    data: (positions ?? []).map(p => mapPosition({ ...p, application_count: countMap.get(p.id) ?? 0 })),
  }
}

export interface PositionInput {
  title: string
  department?: string | null
  location?: string | null
  isRemote?: boolean
  employmentType?: EmploymentType
  description?: string | null
  requirements?: string | null
  openings?: number
  status?: PositionStatus
}

export async function createPosition(input: PositionInput): Promise<Result<JobPosition>> {
  const guard = await requireEdit()
  if (!guard.ok) return guard
  if (!input.title?.trim()) return { ok: false, error: 'Title is required.' }

  const admin = createAdminClient()
  const { data, error } = await admin.from('job_positions').insert({
    title: input.title.trim(),
    department: input.department ?? null,
    location: input.location ?? null,
    is_remote: input.isRemote ?? false,
    employment_type: input.employmentType ?? 'full_time',
    description: input.description ?? null,
    requirements: input.requirements ?? null,
    openings: input.openings ?? 1,
    status: input.status ?? 'open',
    created_by: guard.me.employeeId,
  }).select().single()
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not create position.' }

  void logActivity({
    actorId: guard.me.employeeId, entityType: 'job_position', entityId: data.id,
    action: 'position_created', detail: { label: data.title },
  })
  return { ok: true, data: mapPosition(data) }
}

export async function updatePosition(id: string, input: Partial<PositionInput>): Promise<Result<JobPosition>> {
  const guard = await requireEdit()
  if (!guard.ok) return guard

  const admin = createAdminClient()
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.title !== undefined) patch.title = input.title
  if (input.department !== undefined) patch.department = input.department
  if (input.location !== undefined) patch.location = input.location
  if (input.isRemote !== undefined) patch.is_remote = input.isRemote
  if (input.employmentType !== undefined) patch.employment_type = input.employmentType
  if (input.description !== undefined) patch.description = input.description
  if (input.requirements !== undefined) patch.requirements = input.requirements
  if (input.openings !== undefined) patch.openings = input.openings
  const closing = input.status === 'closed'
  if (input.status !== undefined) patch.status = input.status

  const { data, error } = await admin.from('job_positions').update(patch).eq('id', id).select().single()
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not update position.' }

  void logActivity({
    actorId: guard.me.employeeId, entityType: 'job_position', entityId: id,
    action: closing ? 'position_closed' : 'edited', detail: { label: data.title },
  })
  return { ok: true, data: mapPosition(data) }
}

export async function deletePosition(id: string): Promise<Result<void>> {
  const guard = await requireDelete()
  if (!guard.ok) return guard
  const admin = createAdminClient()
  const { error } = await admin.from('job_positions').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }
  void logActivity({ actorId: guard.me.employeeId, entityType: 'job_position', entityId: id, action: 'deleted' })
  return { ok: true, data: undefined }
}

// ── Applications ──────────────────────────────────────────────────────────────

export async function listApplications(filters?: { stage?: ApplicationStage; positionId?: string }): Promise<Result<JobApplicationSummary[]>> {
  const guard = await requireView()
  if (!guard.ok) return guard
  const admin = createAdminClient()
  let q = admin.from('job_applications').select(APPLICATION_SELECT).order('created_at', { ascending: false })
  if (filters?.stage) q = q.eq('stage', filters.stage)
  if (filters?.positionId) q = q.eq('position_id', filters.positionId)
  const { data, error } = await q
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: (data ?? []).map(mapApplicationSummary) }
}

export interface ApplicationProfile {
  application: JobApplicationDetail
  notes: ApplicationNoteRow[]
  documents: ApplicationDocumentRow[]
  interviews: ApplicationInterviewRow[]
  offers: ApplicationOfferRow[]
}

export async function getApplication(id: string): Promise<Result<ApplicationProfile>> {
  const guard = await requireView()
  if (!guard.ok) return guard
  const admin = createAdminClient()

  const [appRes, notesRes, docsRes, interviewsRes, offersRes] = await Promise.all([
    admin.from('job_applications').select(APPLICATION_SELECT).eq('id', id).maybeSingle(),
    admin.from('application_notes').select('id, application_id, note, created_at, author:author_id(id, name, cqid)').eq('application_id', id).order('created_at', { ascending: false }),
    admin.from('application_documents').select('id, application_id, doc_type, storage_path, file_name, mime_type, size_bytes, created_at, uploader:uploaded_by(id, name, cqid)').eq('application_id', id).order('created_at', { ascending: false }),
    admin.from('application_interviews').select('id, application_id, scheduled_at, duration_minutes, meeting_link, status, outcome_notes, created_at, interviewer:interviewer_id(id, name, cqid)').eq('application_id', id).order('scheduled_at', { ascending: false }),
    admin.from('application_offers').select('id, application_id, position_title, offered_salary, currency, start_date, expiry_date, status, notes, sent_at, responded_at, created_at').eq('application_id', id).order('created_at', { ascending: false }),
  ])

  if (appRes.error) return { ok: false, error: appRes.error.message }
  if (!appRes.data) return { ok: false, error: 'Application not found.' }

  return {
    ok: true,
    data: {
      application: mapApplicationDetail(appRes.data),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      notes: (notesRes.data ?? []).map((n: any) => ({
        id: n.id, applicationId: n.application_id, note: n.note, author: empRef(n.author), createdAt: n.created_at,
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      documents: (docsRes.data ?? []).map((d: any) => ({
        id: d.id, applicationId: d.application_id, docType: d.doc_type, storagePath: d.storage_path, fileName: d.file_name,
        mimeType: d.mime_type, sizeBytes: d.size_bytes, uploadedBy: empRef(d.uploader), createdAt: d.created_at,
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      interviews: (interviewsRes.data ?? []).map((i: any) => ({
        id: i.id, applicationId: i.application_id, scheduledAt: i.scheduled_at, durationMinutes: i.duration_minutes,
        interviewer: empRef(i.interviewer), meetingLink: i.meeting_link, status: i.status,
        outcomeNotes: i.outcome_notes, createdAt: i.created_at,
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      offers: (offersRes.data ?? []).map((o: any) => ({
        id: o.id, applicationId: o.application_id, positionTitle: o.position_title, offeredSalary: o.offered_salary,
        currency: o.currency, startDate: o.start_date, expiryDate: o.expiry_date, status: o.status,
        notes: o.notes, sentAt: o.sent_at, respondedAt: o.responded_at, createdAt: o.created_at,
      })),
    },
  }
}

/** Move an application to a new pipeline stage. Powers the kanban drag & drop. */
export async function moveApplicationStage(
  id: string, stage: ApplicationStage, opts?: { rejectedReason?: string },
): Promise<Result<void>> {
  const guard = await requireEdit()
  if (!guard.ok) return guard
  if (!STAGE_ORDER.includes(stage)) return { ok: false, error: 'Invalid stage.' }

  const admin = createAdminClient()
  const patch: Record<string, unknown> = { stage, updated_at: new Date().toISOString() }
  if (stage === 'rejected' && opts?.rejectedReason) patch.rejected_reason = opts.rejectedReason

  const { data, error } = await admin.from('job_applications').update(patch).eq('id', id)
    .select('id, full_name, reference_number, email').single()
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not update stage.' }

  void logActivity({
    actorId: guard.me.employeeId, entityType: 'job_application', entityId: id,
    action: 'stage_changed', detail: { label: data.full_name, to: stage },
  })

  if (stage === 'selected') {
    void notifyAdmins({
      type: 'candidate_selected',
      title: `Candidate selected — ${data.full_name}`,
      message: `${data.reference_number} moved to Selected.`,
      link: `/dashboard/recruitment/applications/${id}`,
      sourceKey: `candidate_selected:${id}`,
    })
  }
  return { ok: true, data: undefined }
}

export async function assignApplication(id: string, employeeId: string | null): Promise<Result<void>> {
  const guard = await requireEdit()
  if (!guard.ok) return guard
  const admin = createAdminClient()
  const { error } = await admin.from('job_applications')
    .update({ assigned_to: employeeId, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  void logActivity({ actorId: guard.me.employeeId, entityType: 'job_application', entityId: id, action: 'edited', detail: { field: 'assigned_to', to: employeeId } })
  return { ok: true, data: undefined }
}

export async function deleteApplication(id: string): Promise<Result<void>> {
  const guard = await requireDelete()
  if (!guard.ok) return guard
  const admin = createAdminClient()
  const { error } = await admin.from('job_applications').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }
  void logActivity({ actorId: guard.me.employeeId, entityType: 'job_application', entityId: id, action: 'deleted' })
  return { ok: true, data: undefined }
}

// ── Notes (internal only) ─────────────────────────────────────────────────────

export async function addNote(applicationId: string, note: string): Promise<Result<ApplicationNoteRow>> {
  const guard = await requireEdit()
  if (!guard.ok) return guard
  if (!note?.trim()) return { ok: false, error: 'Note cannot be empty.' }

  const admin = createAdminClient()
  const { data, error } = await admin.from('application_notes').insert({
    application_id: applicationId, author_id: guard.me.employeeId, note: note.trim(),
  }).select('id, application_id, note, created_at').single()
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not add note.' }

  void logActivity({ actorId: guard.me.employeeId, entityType: 'job_application', entityId: applicationId, action: 'note_added' })
  return {
    ok: true,
    data: { id: data.id, applicationId: data.application_id, note: data.note, createdAt: data.created_at, author: { id: guard.me.employeeId, name: guard.me.name, cqid: guard.me.cqid } },
  }
}

// ── Interviews ────────────────────────────────────────────────────────────────

export interface ScheduleInterviewInput {
  applicationId: string
  scheduledAt: string
  durationMinutes?: number
  interviewerId?: string | null
  meetingLink?: string | null
}

export async function scheduleInterview(input: ScheduleInterviewInput): Promise<Result<ApplicationInterviewRow>> {
  const guard = await requireEdit()
  if (!guard.ok) return guard
  if (!input.scheduledAt) return { ok: false, error: 'A date/time is required.' }

  const admin = createAdminClient()
  const { data, error } = await admin.from('application_interviews').insert({
    application_id: input.applicationId,
    scheduled_at: input.scheduledAt,
    duration_minutes: input.durationMinutes ?? 30,
    interviewer_id: input.interviewerId ?? null,
    meeting_link: input.meetingLink ?? null,
    created_by: guard.me.employeeId,
  }).select('id, application_id, scheduled_at, duration_minutes, meeting_link, status, outcome_notes, created_at').single()
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not schedule interview.' }

  // Auto-advance the pipeline stage (only forward, never overwrite a later stage).
  const { data: app } = await admin.from('job_applications').select('id, full_name, stage').eq('id', input.applicationId).maybeSingle()
  if (app && (app.stage === 'new' || app.stage === 'screening')) {
    await admin.from('job_applications').update({ stage: 'interview_scheduled', updated_at: new Date().toISOString() }).eq('id', input.applicationId)
  }

  void logActivity({
    actorId: guard.me.employeeId, entityType: 'job_application', entityId: input.applicationId,
    action: 'interview_scheduled', detail: { label: app?.full_name ?? '', scheduledAt: input.scheduledAt },
  })
  if (input.interviewerId) {
    void createNotification({
      employeeId: input.interviewerId, type: 'interview_scheduled',
      title: `Interview scheduled — ${app?.full_name ?? 'candidate'}`,
      message: new Date(input.scheduledAt).toLocaleString('en-IN'),
      link: `/dashboard/recruitment/applications/${input.applicationId}`,
      sourceKey: `interview_scheduled:${data.id}`,
    })
  }

  return {
    ok: true,
    data: {
      id: data.id, applicationId: data.application_id, scheduledAt: data.scheduled_at, durationMinutes: data.duration_minutes,
      interviewer: input.interviewerId ? { id: input.interviewerId, name: '', cqid: '' } : null,
      meetingLink: data.meeting_link, status: data.status, outcomeNotes: data.outcome_notes, createdAt: data.created_at,
    },
  }
}

export interface UpdateInterviewInput {
  status?: InterviewStatus
  outcomeNotes?: string | null
  scheduledAt?: string
  interviewerId?: string | null
  meetingLink?: string | null
}

export async function updateInterview(id: string, input: UpdateInterviewInput): Promise<Result<void>> {
  const guard = await requireEdit()
  if (!guard.ok) return guard
  const admin = createAdminClient()

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.status !== undefined) patch.status = input.status
  if (input.outcomeNotes !== undefined) patch.outcome_notes = input.outcomeNotes
  if (input.scheduledAt !== undefined) patch.scheduled_at = input.scheduledAt
  if (input.interviewerId !== undefined) patch.interviewer_id = input.interviewerId
  if (input.meetingLink !== undefined) patch.meeting_link = input.meetingLink

  const { data, error } = await admin.from('application_interviews').update(patch).eq('id', id)
    .select('id, application_id, status').single()
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not update interview.' }

  if (input.status === 'completed') {
    const { data: app } = await admin.from('job_applications').select('id, full_name, stage').eq('id', data.application_id).maybeSingle()
    if (app && app.stage === 'interview_scheduled') {
      await admin.from('job_applications').update({ stage: 'interview_completed', updated_at: new Date().toISOString() }).eq('id', data.application_id)
    }
    void logActivity({ actorId: guard.me.employeeId, entityType: 'job_application', entityId: data.application_id, action: 'interview_completed', detail: { label: app?.full_name ?? '' } })
  } else if (input.status === 'cancelled') {
    void logActivity({ actorId: guard.me.employeeId, entityType: 'job_application', entityId: data.application_id, action: 'interview_cancelled' })
  }
  return { ok: true, data: undefined }
}

export async function listInterviews(filters?: { upcomingOnly?: boolean }): Promise<Result<ApplicationInterviewRow[]>> {
  const guard = await requireView()
  if (!guard.ok) return guard
  const admin = createAdminClient()
  let q = admin.from('application_interviews')
    .select('id, application_id, scheduled_at, duration_minutes, meeting_link, status, outcome_notes, created_at, interviewer:interviewer_id(id, name, cqid), application:application_id(full_name, reference_number)')
    .order('scheduled_at', { ascending: true })
  if (filters?.upcomingOnly) q = q.eq('status', 'scheduled').gte('scheduled_at', new Date().toISOString())
  const { data, error } = await q
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: (data ?? []).map((i: any) => {
      const app = Array.isArray(i.application) ? i.application[0] : i.application
      return {
        id: i.id, applicationId: i.application_id, scheduledAt: i.scheduled_at, durationMinutes: i.duration_minutes,
        interviewer: empRef(i.interviewer), meetingLink: i.meeting_link, status: i.status, outcomeNotes: i.outcome_notes,
        createdAt: i.created_at, applicantName: app?.full_name, applicationReference: app?.reference_number,
      }
    }),
  }
}

// ── Offers ────────────────────────────────────────────────────────────────────

export interface CreateOfferInput {
  applicationId: string
  positionTitle?: string | null
  offeredSalary?: number | null
  currency?: string
  startDate?: string | null
  expiryDate?: string | null
  notes?: string | null
}

export async function createOffer(input: CreateOfferInput): Promise<Result<ApplicationOfferRow>> {
  const guard = await requireEdit()
  if (!guard.ok) return guard
  const admin = createAdminClient()
  const { data, error } = await admin.from('application_offers').insert({
    application_id: input.applicationId,
    position_title: input.positionTitle ?? null,
    offered_salary: input.offeredSalary ?? null,
    currency: input.currency ?? 'INR',
    start_date: input.startDate ?? null,
    expiry_date: input.expiryDate ?? null,
    notes: input.notes ?? null,
    created_by: guard.me.employeeId,
  }).select('id, application_id, position_title, offered_salary, currency, start_date, expiry_date, status, notes, sent_at, responded_at, created_at').single()
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not create offer.' }
  return {
    ok: true,
    data: {
      id: data.id, applicationId: data.application_id, positionTitle: data.position_title, offeredSalary: data.offered_salary,
      currency: data.currency, startDate: data.start_date, expiryDate: data.expiry_date, status: data.status,
      notes: data.notes, sentAt: data.sent_at, respondedAt: data.responded_at, createdAt: data.created_at,
    },
  }
}

export async function updateOfferStatus(id: string, status: OfferStatus): Promise<Result<void>> {
  const guard = await requireEdit()
  if (!guard.ok) return guard
  const admin = createAdminClient()

  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() }
  if (status === 'sent') patch.sent_at = new Date().toISOString()
  if (status === 'accepted' || status === 'declined') patch.responded_at = new Date().toISOString()

  const { data, error } = await admin.from('application_offers').update(patch).eq('id', id)
    .select('id, application_id').single()
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not update offer.' }

  const { data: app } = await admin.from('job_applications').select('id, full_name').eq('id', data.application_id).maybeSingle()

  if (status === 'sent') {
    await admin.from('job_applications').update({ stage: 'offer_sent', updated_at: new Date().toISOString() }).eq('id', data.application_id)
    void logActivity({ actorId: guard.me.employeeId, entityType: 'job_application', entityId: data.application_id, action: 'offer_sent', detail: { label: app?.full_name ?? '' } })
  } else if (status === 'accepted') {
    await admin.from('job_applications').update({ stage: 'joined', updated_at: new Date().toISOString() }).eq('id', data.application_id)
    void logActivity({ actorId: guard.me.employeeId, entityType: 'job_application', entityId: data.application_id, action: 'offer_accepted', detail: { label: app?.full_name ?? '' } })
    void notifyAdmins({
      type: 'offer_accepted', title: `Offer accepted — ${app?.full_name ?? 'candidate'}`,
      message: 'The candidate accepted the offer.', link: `/dashboard/recruitment/applications/${data.application_id}`,
      sourceKey: `offer_accepted:${id}`,
    })
  } else if (status === 'declined') {
    void logActivity({ actorId: guard.me.employeeId, entityType: 'job_application', entityId: data.application_id, action: 'offer_declined', detail: { label: app?.full_name ?? '' } })
  }
  return { ok: true, data: undefined }
}

export async function listOffers(): Promise<Result<ApplicationOfferRow[]>> {
  const guard = await requireView()
  if (!guard.ok) return guard
  const admin = createAdminClient()
  const { data, error } = await admin.from('application_offers')
    .select('id, application_id, position_title, offered_salary, currency, start_date, expiry_date, status, notes, sent_at, responded_at, created_at, application:application_id(full_name, reference_number)')
    .order('created_at', { ascending: false })
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: (data ?? []).map((o: any) => {
      const app = Array.isArray(o.application) ? o.application[0] : o.application
      return {
        id: o.id, applicationId: o.application_id, positionTitle: o.position_title, offeredSalary: o.offered_salary,
        currency: o.currency, startDate: o.start_date, expiryDate: o.expiry_date, status: o.status, notes: o.notes,
        sentAt: o.sent_at, respondedAt: o.responded_at, createdAt: o.created_at,
        applicantName: app?.full_name, applicationReference: app?.reference_number,
      }
    }),
  }
}

// ── Resume / document signed URLs ────────────────────────────────────────────

export async function getDocumentUrl(storagePath: string): Promise<Result<{ url: string }>> {
  const guard = await requireView()
  if (!guard.ok) return guard
  const admin = createAdminClient()
  const { data, error } = await admin.storage.from('recruitment-resumes').createSignedUrl(storagePath, 3600)
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not open document.' }
  return { ok: true, data: { url: data.signedUrl } }
}

// ── Reports ───────────────────────────────────────────────────────────────────

export async function getReports(): Promise<Result<RecruitmentReports>> {
  const guard = await requireView()
  if (!guard.ok) return guard
  const admin = createAdminClient()

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()

  const [allApps, interviews, offers] = await Promise.all([
    admin.from('job_applications').select('id, stage, source, created_at'),
    admin.from('application_interviews').select('id, status'),
    admin.from('application_offers').select('id, status'),
  ])
  if (allApps.error) return { ok: false, error: allApps.error.message }

  const apps = allApps.data ?? []
  const applicationsThisMonth = apps.filter(a => a.created_at >= monthStart).length
  const applicationsLastMonth = apps.filter(a => a.created_at >= lastMonthStart && a.created_at < monthStart).length

  const sourceCounts = new Map<string, number>()
  const stageCounts = new Map<string, number>()
  for (const a of apps) {
    sourceCounts.set(a.source, (sourceCounts.get(a.source) ?? 0) + 1)
    stageCounts.set(a.stage, (stageCounts.get(a.stage) ?? 0) + 1)
  }

  const advancedStages = new Set(['selected', 'offer_sent', 'joined'])
  const advancedCount = apps.filter(a => advancedStages.has(a.stage)).length
  const conversionRate = apps.length ? advancedCount / apps.length : 0

  const interviewRows = interviews.data ?? []
  const held = interviewRows.filter(i => i.status === 'completed').length
  const heldOrScheduled = interviewRows.filter(i => i.status === 'completed' || i.status === 'scheduled').length
  const interviewSuccessRate = heldOrScheduled ? held / heldOrScheduled : 0

  const offerRows = offers.data ?? []
  const decided = offerRows.filter(o => o.status === 'accepted' || o.status === 'declined')
  const accepted = offerRows.filter(o => o.status === 'accepted').length
  const offerAcceptanceRate = decided.length ? accepted / decided.length : 0

  return {
    ok: true,
    data: {
      applicationsThisMonth,
      applicationsLastMonth,
      bySource: [...sourceCounts.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
      byStage: [...stageCounts.entries()].map(([stage, count]) => ({ stage: stage as ApplicationStage, count })),
      conversionRate,
      interviewSuccessRate,
      offerAcceptanceRate,
      totalApplications: apps.length,
      totalInterviewsHeld: held,
      totalOffersSent: offerRows.filter(o => o.status !== 'draft').length,
    },
  }
}
