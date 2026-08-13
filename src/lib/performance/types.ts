/** Performance Scorecards — shared types (migration 028). */

export type PerfUnit = 'percent' | 'level' | 'years' | 'time' | 'count'

export interface PerfCriterion {
  id: string
  parent_id: string | null      // null = group
  name: string
  weight: number
  unit: PerfUnit
  target: number | null         // years/time(min)/count for a full score
  sort: number
  is_active: boolean
}

export type PerfStatus = 'draft' | 'final'

/** One automatic metric, computed read-only from existing app data. */
export interface AutoMetric {
  key: string
  label: string
  /** Human-readable raw value, e.g. "2.4 yrs", "31/34 tasks", "72%". */
  display: string
  /** Normalized 0–100, or null when there is no data for it. */
  score: number | null
}

/** Composite of the available auto metrics (weights re-normalized). */
export interface AutoResult {
  score: number | null
  metrics: AutoMetric[]
}

export interface PerfAssessment {
  id: string
  employee_id: string | null
  application_id: string | null
  subject_name: string | null
  status: PerfStatus
  final_score: number | null
  breakdown: PerfBreakdownGroup[] | null
  note: string | null
  /** Auto Performance Score snapshot taken at finalize (migration 029). */
  auto_score: number | null
  auto_metrics: AutoMetric[] | null
  applied_history_id: string | null
  applied_at: string | null
  created_at: string
  updated_at: string
}

export interface PerfScore {
  assessment_id: string
  criteria_id: string
  value: number
}

export interface PerfBreakdownGroup {
  group_id: string
  name: string
  weight: number
  score: number | null
}

/** Slim subject lists for the picker. */
export interface PerfEmployeeOption {
  id: string
  name: string
  cqid: string
  performance_rating: number
}
export interface PerfApplicantOption {
  id: string
  full_name: string
  position_title: string
  stage: string
}

export const UNIT_LABEL: Record<PerfUnit, string> = {
  percent: '%',
  level: 'Level 1–5',
  years: 'Years',
  time: 'Minutes',
  count: 'Count',
}
