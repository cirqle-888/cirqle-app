import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import type { AutoResult, PerfAssessment, PerfCriterion } from '@/lib/performance/types'
import { computeAutoForEmployees } from '@/lib/performance/auto'
import PerformanceClient from './performance-client'

export const dynamic = 'force-dynamic'

/** Performance Scorecards — score employees and applicants, apply to pay. */
export default async function PerformancePage() {
  const me = await loadCurrentUser().catch(() => null)
  if (me && !me.isAdmin && !hasPermission(me, PERMS.PERFORMANCE_MANAGE)) redirect('/dashboard')

  const admin = createAdminClient()
  const [criteriaRes, employeesRes, applicantsRes, assessmentsRes, scoresRes] = await Promise.all([
    admin.from('perf_criteria').select('*').eq('is_active', true).order('sort'),
    // `name` is deliberately NOT selected — employee names are private and the
    // picker shows CQIDs only, so the name never reaches the browser at all.
    admin.from('employees').select('id, cqid, performance_rating, joined_date')
      .eq('is_active', true).eq('is_archived', false).order('cqid'),
    admin.from('job_applications').select('id, full_name, position_title, stage')
      .neq('stage', 'rejected').order('created_at', { ascending: false }).limit(100),
    admin.from('perf_assessments').select('*').order('created_at', { ascending: false }).limit(200),
    admin.from('perf_scores').select('assessment_id, criteria_id, value'),
  ])

  // Live Auto Performance Metrics for every active employee (read-only —
  // computed from tasks / contributions / requests already in the app).
  const employees = (employeesRes.data ?? []) as Array<{ id: string; joined_date: string | null }>
  const auto: Record<string, AutoResult> = await computeAutoForEmployees(admin, employees).catch(() => ({}))

  return (
    <PerformanceClient
      criteria={(criteriaRes.data ?? []) as PerfCriterion[]}
      employees={(employeesRes.data ?? []) as never[]}
      applicants={(applicantsRes.data ?? []) as never[]}
      assessments={(assessmentsRes.data ?? []) as PerfAssessment[]}
      scores={(scoresRes.data ?? []) as never[]}
      auto={auto}
    />
  )
}
