/**
 * Recruitment / Careers module — shared types.
 * DB shapes: migrations/020_recruitment.sql.
 */

export type PositionStatus = 'open' | 'on_hold' | 'closed'
export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'internship' | 'freelance'

export type ApplicationStage =
  | 'new' | 'screening' | 'interview_scheduled' | 'interview_completed'
  | 'technical_review' | 'selected' | 'offer_sent' | 'joined' | 'rejected'

export const STAGE_ORDER: ApplicationStage[] = [
  'new', 'screening', 'interview_scheduled', 'interview_completed',
  'technical_review', 'selected', 'offer_sent', 'joined', 'rejected',
]

export const STAGE_LABELS: Record<ApplicationStage, string> = {
  new: 'New',
  screening: 'Screening',
  interview_scheduled: 'Interview Scheduled',
  interview_completed: 'Interview Completed',
  technical_review: 'Technical Review',
  selected: 'Selected',
  offer_sent: 'Offer Sent',
  joined: 'Joined',
  rejected: 'Rejected',
}

export type InterviewStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show'
export type OfferStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired'

export interface JobPosition {
  id: string
  title: string
  department: string | null
  location: string | null
  isRemote: boolean
  employmentType: EmploymentType
  description: string | null
  requirements: string | null
  openings: number
  status: PositionStatus
  applicationCount?: number
  createdAt: string
  updatedAt: string
}

export interface EmployeeRef {
  id: string
  name: string
  cqid: string
}

export interface JobApplicationSummary {
  id: string
  referenceNumber: string
  positionId: string | null
  positionTitle: string
  fullName: string
  email: string
  phone: string | null
  stage: ApplicationStage
  source: string
  assignedTo: EmployeeRef | null
  createdAt: string
  updatedAt: string
}

export interface JobApplicationDetail extends JobApplicationSummary {
  country: string | null
  location: string | null
  experience: string | null
  expectedSalary: number | null
  availability: string | null
  portfolioUrl: string | null
  linkedinUrl: string | null
  resumeStoragePath: string | null
  coverLetter: string | null
  skills: string[]
  whyJoin: string | null
  rejectedReason: string | null
}

export interface ApplicationNoteRow {
  id: string
  applicationId: string
  note: string
  author: EmployeeRef | null
  createdAt: string
}

export interface ApplicationDocumentRow {
  id: string
  applicationId: string
  docType: 'resume' | 'cover_letter' | 'portfolio' | 'other'
  storagePath: string
  fileName: string | null
  mimeType: string | null
  sizeBytes: number | null
  uploadedBy: EmployeeRef | null
  createdAt: string
}

export interface ApplicationInterviewRow {
  id: string
  applicationId: string
  scheduledAt: string
  durationMinutes: number
  interviewer: EmployeeRef | null
  meetingLink: string | null
  status: InterviewStatus
  outcomeNotes: string | null
  createdAt: string
  // Denormalized for the Interviews list page:
  applicantName?: string
  applicationReference?: string
}

export interface ApplicationOfferRow {
  id: string
  applicationId: string
  positionTitle: string | null
  offeredSalary: number | null
  currency: string
  startDate: string | null
  expiryDate: string | null
  status: OfferStatus
  notes: string | null
  sentAt: string | null
  respondedAt: string | null
  createdAt: string
  applicantName?: string
  applicationReference?: string
}

export interface RecruitmentReports {
  applicationsThisMonth: number
  applicationsLastMonth: number
  bySource: { source: string; count: number }[]
  byStage: { stage: ApplicationStage; count: number }[]
  conversionRate: number        // selected+offer_sent+joined / total applications
  interviewSuccessRate: number  // interview_completed leading to technical_review+ / interviews held
  offerAcceptanceRate: number   // accepted / (accepted+declined)
  totalApplications: number
  totalInterviewsHeld: number
  totalOffersSent: number
}
