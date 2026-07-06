'use server'

/**
 * Public careers application actions — NO AUTH. This is the only file in the
 * recruitment module callable by an unauthenticated visitor, kept separate
 * from src/lib/recruitment/actions.ts (which is all requireView/requireEdit-
 * gated) so the public attack surface stays easy to audit in one place.
 *
 * Mirrors the existing public-token pattern (src/app/intake/[token]/actions.ts,
 * src/app/(dashboard)/dashboard/chat/actions.ts upload flow):
 *   1. getResumeUploadUrl() → signed upload URL, browser PUTs the file directly
 *      to Supabase Storage (server never touches file bytes)
 *   2. submitApplication() → validates + inserts the row, records the resume
 *      as an application_documents row, generates the reference number via
 *      the atomic generate_hr_reference_number() Postgres function, logs
 *      activity, and notifies admins. Never sends email — everything lands
 *      directly in the CRM as required.
 *
 * Basic abuse resistance (no external CAPTCHA service wired up yet — see
 * RECRUITMENT_MODULE.md "Hardening" section for what to add before high
 * traffic): a honeypot field that must stay empty, and a 10-minute duplicate
 * guard on (email + position).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { logActivity } from '@/lib/activity/log'
import { notifyAdmins } from '@/lib/notifications/create'

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

const RESUME_BUCKET = 'recruitment-resumes'
const ALLOWED_RESUME_EXT = ['pdf', 'doc', 'docx', 'rtf']
const MAX_RESUME_BYTES = 15 * 1024 * 1024

export interface PublicPosition {
  id: string
  title: string
  department: string | null
  location: string | null
  isRemote: boolean
  employmentType: string
}

/** Open positions for the "Position Applying For" dropdown. Falls back to a free-text "General Application" option client-side if this list is empty. */
export async function getOpenPositions(): Promise<Result<PublicPosition[]>> {
  try {
    const admin = createAdminClient()
    const { data, error } = await admin
      .from('job_positions')
      .select('id, title, department, location, is_remote, employment_type')
      .eq('status', 'open')
      .order('created_at', { ascending: false })
    if (error) return { ok: false, error: error.message }
    return {
      ok: true,
      data: (data ?? []).map(p => ({
        id: p.id, title: p.title, department: p.department, location: p.location,
        isRemote: !!p.is_remote, employmentType: p.employment_type,
      })),
    }
  } catch {
    return { ok: true, data: [] } // module not migrated yet — form still renders with "General Application"
  }
}

/** Step 1: get a signed upload URL for the resume file (path is server-generated, applicant never controls it). */
export async function getResumeUploadUrl(fileName: string): Promise<Result<{ signedUrl: string; token: string; storagePath: string }>> {
  const ext = (fileName.split('.').pop() || '').toLowerCase()
  if (!ALLOWED_RESUME_EXT.includes(ext)) {
    return { ok: false, error: 'Please upload a PDF, DOC, DOCX or RTF file.' }
  }
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120)
  const storagePath = `${new Date().getUTCFullYear()}/${crypto.randomUUID()}/${safeName}`

  const admin = createAdminClient()
  const { data, error } = await admin.storage.from(RESUME_BUCKET).createSignedUploadUrl(storagePath)
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not prepare upload.' }
  return { ok: true, data: { signedUrl: data.signedUrl, token: data.token, storagePath } }
}

export interface SubmitApplicationInput {
  positionId?: string | null
  positionTitle: string
  fullName: string
  email: string
  phone?: string
  country?: string
  location?: string
  experience?: string
  expectedSalary?: number | null
  availability?: string
  portfolioUrl?: string
  linkedinUrl?: string
  coverLetter?: string
  skills?: string
  whyJoin?: string
  resumeStoragePath?: string | null
  resumeFileName?: string | null
  resumeMimeType?: string | null
  resumeSizeBytes?: number | null
  /** Honeypot — must be empty. Real applicants never see or fill this field. */
  website?: string
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export async function submitApplication(input: SubmitApplicationInput): Promise<Result<{ referenceNumber: string }>> {
  // Honeypot: bots fill every field, humans never see this one.
  if (input.website) return { ok: true, data: { referenceNumber: 'CIRQLE-HR-0000-0000' } } // silently "succeed"

  if (!input.fullName?.trim()) return { ok: false, error: 'Full name is required.' }
  if (!input.email?.trim() || !isValidEmail(input.email.trim())) return { ok: false, error: 'A valid email is required.' }
  if (!input.positionTitle?.trim()) return { ok: false, error: 'Please select or enter a position.' }

  if (input.resumeSizeBytes && input.resumeSizeBytes > MAX_RESUME_BYTES) {
    return { ok: false, error: 'Resume file is too large (max 15MB).' }
  }

  const admin = createAdminClient()

  // Soft duplicate guard: same email + position within 10 minutes = likely a double-submit / retry.
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const { data: recent } = await admin
    .from('job_applications')
    .select('id, reference_number')
    .eq('email', input.email.trim().toLowerCase())
    .eq('position_title', input.positionTitle.trim())
    .gte('created_at', tenMinAgo)
    .limit(1)
  if (recent && recent.length > 0) {
    return { ok: true, data: { referenceNumber: recent[0].reference_number } }
  }

  const { data: refData, error: refErr } = await admin.rpc('generate_hr_reference_number')
  if (refErr || !refData) return { ok: false, error: 'Could not generate a reference number. Please try again.' }
  const referenceNumber = refData as string

  const skillsArr = (input.skills ?? '')
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean)

  const { data: appRow, error: insertErr } = await admin.from('job_applications').insert({
    reference_number: referenceNumber,
    position_id: input.positionId ?? null,
    position_title: input.positionTitle.trim(),
    full_name: input.fullName.trim(),
    email: input.email.trim().toLowerCase(),
    phone: input.phone?.trim() || null,
    country: input.country?.trim() || null,
    location: input.location?.trim() || null,
    experience: input.experience?.trim() || null,
    expected_salary: input.expectedSalary ?? null,
    availability: input.availability?.trim() || null,
    portfolio_url: input.portfolioUrl?.trim() || null,
    linkedin_url: input.linkedinUrl?.trim() || null,
    resume_storage_path: input.resumeStoragePath ?? null,
    cover_letter: input.coverLetter?.trim() || null,
    skills: skillsArr,
    why_join: input.whyJoin?.trim() || null,
    stage: 'new',
    source: 'careers_page',
  }).select('id').single()

  if (insertErr || !appRow) return { ok: false, error: insertErr?.message ?? 'Could not submit application. Please try again.' }

  if (input.resumeStoragePath) {
    await admin.from('application_documents').insert({
      application_id: appRow.id,
      doc_type: 'resume',
      storage_path: input.resumeStoragePath,
      file_name: input.resumeFileName ?? null,
      mime_type: input.resumeMimeType ?? null,
      size_bytes: input.resumeSizeBytes ?? null,
      uploaded_by: null, // applicant self-upload
    })
  }

  void logActivity({
    entityType: 'job_application', entityId: appRow.id, action: 'applied',
    detail: { label: input.fullName.trim(), reference: referenceNumber, position: input.positionTitle.trim() },
  })
  void notifyAdmins({
    type: 'application_received',
    title: `New application — ${input.positionTitle.trim()}`,
    message: `${input.fullName.trim()} applied (${referenceNumber}).`,
    link: `/dashboard/recruitment/applications/${appRow.id}`,
    sourceKey: `application_received:${appRow.id}`,
  })

  return { ok: true, data: { referenceNumber } }
}
