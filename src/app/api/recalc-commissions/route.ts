import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { calculateCommission } from '@/lib/calculations/commission'
import { getEffectivePerformanceRating } from '@/lib/calculations/performance-history'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'

export async function POST(req: NextRequest) {
  try {
    const user = await loadCurrentUser()
    if (!user || (!user.isAdmin && !hasPermission(user, 'settings_write'))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    const body = await req.json()
    const { dateFrom, dateTo, employeeId } = body
    if (!dateFrom || !dateTo) {
      return NextResponse.json({ error: 'dateFrom and dateTo are required' }, { status: 400 })
    }

    const supabase = createAdminClient()

    // 1. Fetch reference data
    const [
      employeesRes, groupsRes, parametersRes, toolsRes, toolServicesRes, groupServicesRes, pricingRes, historyRes
    ] = await Promise.all([
      supabase.from('employees').select('id, cqid, name, performance_rating, role'),
      supabase.from('contribution_groups').select('*'),
      supabase.from('parameters').select('*'),
      supabase.from('tools').select('*'),
      supabase.from('tool_services').select('tool_id, service_id'),
      supabase.from('group_services').select('group_id, service_id'),
      supabase.from('client_service_pricing').select('client_id, service_id, commission_percentage'),
      supabase.from('employee_performance_history').select('*').order('effective_from', { ascending: false })
    ])

    const employees = employeesRes.data || []
    const groups = groupsRes.data || []
    const parameters = parametersRes.data || []
    const tools = toolsRes.data || []
    const toolServices = toolServicesRes.data || []
    const groupServices = groupServicesRes.data || []
    const pricingMatrix = pricingRes.data || []
    const performanceHistory = historyRes.data || []

    // 2. Fetch tasks in date range with their raw contributions, tool usage, and previous scores
    let tasksQuery = supabase
      .from('tasks')
      .select('id, client_id, service_id, billing_amount_inr, task_date, status')
      .gte('task_date', dateFrom)
      .lte('task_date', dateTo)

    const { data: tasks } = await tasksQuery
    if (!tasks || tasks.length === 0) {
      return NextResponse.json({ updated: 0, message: 'No tasks found in date range' })
    }

    const taskIds = tasks.map(t => t.id)

    // Chunk fetching for large arrays if needed, but assuming reasonable range < 2000 tasks
    const [contribsRes, taskToolsRes, scoresRes] = await Promise.all([
      supabase.from('contributions').select('task_id, employee_id, parameter_id, value').in('task_id', taskIds).gt('value', 0),
      supabase.from('task_tools').select('task_id, tool_id').in('task_id', taskIds),
      supabase.from('contribution_scores').select('*').in('task_id', taskIds)
    ])

    const allContribs = contribsRes.data || []
    const allTaskTools = taskToolsRes.data || []
    const oldScores = scoresRes.data || []

    const byTask: Record<string, typeof allContribs> = {}
    allContribs.forEach(c => {
      if (!byTask[c.task_id]) byTask[c.task_id] = []
      byTask[c.task_id].push(c)
    })

    const toolsByTask: Record<string, Set<string>> = {}
    allTaskTools.forEach(tt => {
      if (!toolsByTask[tt.task_id]) toolsByTask[tt.task_id] = new Set()
      toolsByTask[tt.task_id].add(tt.tool_id)
    })

    const scoresByTaskEmp: Record<string, typeof oldScores[0]> = {}
    oldScores.forEach(s => {
      scoresByTaskEmp[`${s.task_id}:${s.employee_id}`] = s
    })

    // 3. Process each task
    let updateCount = 0
    let insertCount = 0
    let totalProcessed = 0

    const upsertBatch: any[] = []

    for (const task of tasks) {
      const contribs = byTask[task.id]
      if (!contribs || contribs.length === 0) continue // Skip tasks without contributions

      // If filtering by employee, only process tasks where this employee contributed
      if (employeeId && !contribs.some(c => c.employee_id === employeeId)) continue

      const linkedGroupIds = groupServices
        .filter(gs => gs.service_id === task.service_id)
        .map(gs => gs.group_id)
      const taskGroups = linkedGroupIds.length > 0
        ? groups.filter(g => linkedGroupIds.includes(g.id))
        : groups
      const taskParams = parameters.filter(p => taskGroups.some(g => g.id === p.group_id))

      const pricing = pricingMatrix.find(
        p => p.client_id === task.client_id && p.service_id === task.service_id
      )
      const commPct = pricing?.commission_percentage ?? 50

      const usedToolIds = toolsByTask[task.id] || new Set()
      const linkedToolIds = toolServices
        .filter(ts => ts.service_id === task.service_id)
        .map(ts => ts.tool_id)
      const taskToolsForCalc = tools
        .filter(t => linkedToolIds.length > 0 ? linkedToolIds.includes(t.id) : true)
        .map(t => ({ tool: t, used: usedToolIds.has(t.id) }))

      const contribArray = contribs.map(c => ({
        id: '', task_id: c.task_id, parameter_id: c.parameter_id,
        employee_id: c.employee_id, value: c.value,
        locked: false, created_at: '', updated_at: '',
      }))

      // Apply historical performance
      const effectiveEmployees = employees.map(emp => ({
        ...emp,
        performance_rating: getEffectivePerformanceRating(emp.id, task.task_date, performanceHistory, emp.performance_rating)
      }))

      try {
        const result = calculateCommission({
          taskId: task.id,
          billingAmountINR: task.billing_amount_inr || 0,
          serviceCommissionPct: commPct,
          employees: effectiveEmployees as any,
          groups: taskGroups as any,
          parameters: taskParams as any,
          toolsUsed: taskToolsForCalc,
          contributions: contribArray as any,
        })

        totalProcessed++

        if (result.employeeEarnings.length > 0) {
          result.employeeEarnings.forEach(e => {
            const oldScore = scoresByTaskEmp[`${task.id}:${e.employeeId}`]
            
            // Recompute what performance rating was used for this run
            const perfUsed = getEffectivePerformanceRating(e.employeeId, task.task_date, performanceHistory, employees.find(em => em.id === e.employeeId)?.performance_rating ?? 100)

            if (oldScore) {
              if (oldScore.is_manual_override) {
                // Do not recalculate manually locked override scores
                return;
              }

              const hasDiff = 
                Math.abs((oldScore.earnings_inr || 0) - e.earnings) > 0.01 ||
                Math.abs((oldScore.score_percentage || 0) - e.scorePercentage) > 0.01

              if (hasDiff) {
                // Keep history of previous values
                upsertBatch.push({
                  task_id: task.id,
                  employee_id: e.employeeId,
                  score_percentage: e.scorePercentage,
                  earnings_inr: e.earnings,
                  previous_earnings_inr: oldScore.earnings_inr || 0,
                  previous_score_percentage: oldScore.score_percentage || 0,
                  previous_performance_rating_used: oldScore.previous_performance_rating_used || 100, // if no previous value exists
                  recalculated_at: new Date().toISOString(),
                  recalculated_by: user.employeeId
                })
                updateCount++
              } else {
                // Unchanged - we don't necessarily need to touch it
              }
            } else {
              // Completely new score
              upsertBatch.push({
                task_id: task.id,
                employee_id: e.employeeId,
                score_percentage: e.scorePercentage,
                earnings_inr: e.earnings,
                // No previous values to log since it didn't exist
              })
              insertCount++
            }
          })
        }
      } catch (err) {
        console.error(`Failed to calculate task ${task.id}:`, err)
      }
    }

    // Upsert the results
    if (upsertBatch.length > 0) {
      // Chunking upserts
      const BATCH_SIZE = 500
      for (let i = 0; i < upsertBatch.length; i += BATCH_SIZE) {
        const chunk = upsertBatch.slice(i, i + BATCH_SIZE)
        const { error } = await supabase.from('contribution_scores').upsert(chunk, {
          onConflict: 'task_id,employee_id'
        })
        if (error) {
          console.error("Upsert chunk error:", error)
          return NextResponse.json({ error: error.message }, { status: 500 })
        }
      }
    }

    return NextResponse.json({
      success: true,
      totalProcessed,
      updated: updateCount,
      inserted: insertCount
    })

  } catch (error: any) {
    console.error('Recalc API Error:', error)
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 })
  }
}
