import { createAdminClient } from '@/lib/supabase/server'
import { calculateCommission } from '@/lib/calculations/commission'
import { getEffectivePerformanceRating } from '@/lib/calculations/performance-history'
import { syncTaskAgreementEarnings } from '@/lib/sync/agreement-earnings'
import { getInvoiceDateForTaskMonth, toSequenceMonth } from '@/lib/invoices/numbering'

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * Fallback refresh for tasks that have contribution SCORES but no raw
 * `contributions` rows (e.g. scores entered via CSV score% import). The full
 * engine in recalcTaskCommissions needs raw contributions; without them the
 * stored `earnings_inr` goes stale after a billing/pricing/rating change.
 *
 * This recomputes earnings_inr with the SAME formula the Contribution Analysis
 * report uses — `remainingPool × score% × rating%` from CURRENT billing — so
 * stored earnings (and therefore payroll) match the report.
 *
 * SAFETY: only scores with score_percentage > 0 are touched. Earnings-only
 * imports (score_percentage = 0, a flat rupee amount) are left exactly as-is,
 * so historical imported earnings are never zeroed out.
 */
export async function refreshStoredEarningsFromBilling(taskId: string) {
  const supabase = createAdminClient()

  const { data: task } = await supabase
    .from('tasks')
    .select('id, billing_amount_inr, client_id, service_id')
    .eq('id', taskId)
    .single()
  if (!task) return { updated: 0, message: 'Task not found' }

  const { data: scores } = await supabase
    .from('contribution_scores')
    .select('employee_id, score_percentage, earnings_inr')
    .eq('task_id', taskId)
  if (!scores || scores.length === 0) return { updated: 0, message: 'No scores' }

  // Current commission % (pricing matrix), default 50 to mirror the report.
  let commPct = 50
  if (task.client_id && task.service_id) {
    const { data: pricing } = await supabase
      .from('client_service_pricing')
      .select('commission_percentage')
      .eq('client_id', task.client_id)
      .eq('service_id', task.service_id)
      .maybeSingle()
    if (pricing?.commission_percentage != null) commPct = pricing.commission_percentage
  }

  // Tool deductions (Σ active tool fixed_percentage), a flat % off the pool.
  let toolPct = 0
  const { data: taskTools } = await supabase.from('task_tools').select('tool_id').eq('task_id', taskId)
  if (taskTools && taskTools.length) {
    const { data: tools } = await supabase
      .from('tools').select('fixed_percentage, is_active').in('id', taskTools.map(t => t.tool_id))
    toolPct = (tools || []).reduce((s, t) => s + (t.is_active !== false ? Number(t.fixed_percentage) || 0 : 0), 0)
  }

  // Current performance ratings for the contributing employees.
  const empIds = Array.from(new Set(scores.map(s => s.employee_id)))
  const { data: emps } = await supabase.from('employees').select('id, performance_rating').in('id', empIds)
  const rating = new Map<string, number>()
  for (const e of (emps || [])) rating.set(e.id, Number(e.performance_rating) || 100)

  const pool = (task.billing_amount_inr || 0) * commPct / 100
  const remainingPool = pool * (1 - toolPct / 100)

  let updated = 0
  for (const s of scores) {
    // SAFETY: never recompute earnings-only imports (score% = 0).
    if (!(s.score_percentage && s.score_percentage > 0)) continue
    const newEarn = r2(remainingPool * (s.score_percentage / 100) * ((rating.get(s.employee_id) ?? 100) / 100))
    if (Math.abs((s.earnings_inr || 0) - newEarn) > 0.01) {
      await supabase.from('contribution_scores')
        .update({ earnings_inr: newEarn })
        .eq('task_id', taskId).eq('employee_id', s.employee_id)
      updated++
    }
  }

  // Layer employee commission agreements on top (no-op without agreements).
  await syncTaskAgreementEarnings(taskId)

  return { updated, message: `Refreshed ${updated} score(s) from current billing` }
}

/**
 * Automatically recalculates contribution scores for a given task, if raw contributions exist.
 * This should be called whenever a task's billing amount, service_id, or task_date changes.
 */
export async function recalcTaskCommissions(taskId: string, userId?: string) {
  const supabase = createAdminClient()

  // 1. Fetch Task
  const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single()
  if (!task) return { error: 'Task not found' }

  // 2. Fetch Contributions
  const { data: contribs } = await supabase.from('contributions').select('*').eq('task_id', taskId).gt('value', 0)
  // No raw contributions → fall back to refreshing stored earnings from the
  // current billing (keeps score-only tasks in sync with the report + payroll).
  if (!contribs || contribs.length === 0) {
    return await refreshStoredEarningsFromBilling(taskId)
  }

  // 3. Fetch Reference Data
  const [
    employeesRes, groupsRes, parametersRes, toolsRes, toolServicesRes, groupServicesRes, pricingRes, historyRes, taskToolsRes, oldScoresRes
  ] = await Promise.all([
    supabase.from('employees').select('id, cqid, name, performance_rating, role'),
    supabase.from('contribution_groups').select('*'),
    supabase.from('parameters').select('*'),
    supabase.from('tools').select('*'),
    supabase.from('tool_services').select('tool_id, service_id'),
    supabase.from('group_services').select('group_id, service_id'),
    supabase.from('client_service_pricing').select('client_id, service_id, commission_percentage'),
    supabase.from('employee_performance_history').select('*').order('effective_from', { ascending: false }),
    supabase.from('task_tools').select('tool_id').eq('task_id', taskId),
    supabase.from('contribution_scores').select('*').eq('task_id', taskId)
  ])

  const employees = employeesRes.data || []
  const groups = groupsRes.data || []
  const parameters = parametersRes.data || []
  const tools = toolsRes.data || []
  const toolServices = toolServicesRes.data || []
  const groupServices = groupServicesRes.data || []
  const pricingMatrix = pricingRes.data || []
  const performanceHistory = historyRes.data || []
  const taskToolsData = taskToolsRes.data || []
  const oldScores = oldScoresRes.data || []

  const linkedGroupIds = groupServices.filter(gs => gs.service_id === task.service_id).map(gs => gs.group_id)
  const taskGroups = linkedGroupIds.length > 0 ? groups.filter(g => linkedGroupIds.includes(g.id)) : groups
  const taskParams = parameters.filter(p => taskGroups.some(g => g.id === p.group_id))

  const pricing = pricingMatrix.find(p => p.client_id === task.client_id && p.service_id === task.service_id)
  const commPct = pricing?.commission_percentage ?? 50

  const usedToolIds = new Set(taskToolsData.map(tt => tt.tool_id))
  const linkedToolIds = toolServices.filter(ts => ts.service_id === task.service_id).map(ts => ts.tool_id)
  const taskToolsForCalc = tools
    .filter(t => linkedToolIds.length > 0 ? linkedToolIds.includes(t.id) : true)
    .map(t => ({ tool: t, used: usedToolIds.has(t.id) }))

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
      contributions: contribs as any,
    })

    const upsertBatch: any[] = []

    result.employeeEarnings.forEach(e => {
      const oldScore = oldScores.find(s => s.employee_id === e.employeeId)
      
      if (oldScore) {
        if (oldScore.is_manual_override) return // Do not touch manual overrides

        const hasDiff = 
          Math.abs((oldScore.earnings_inr || 0) - e.earnings) > 0.01 ||
          Math.abs((oldScore.score_percentage || 0) - e.scorePercentage) > 0.01

        if (hasDiff) {
          upsertBatch.push({
            task_id: task.id,
            employee_id: e.employeeId,
            score_percentage: e.scorePercentage,
            earnings_inr: e.earnings,
            previous_earnings_inr: oldScore.earnings_inr || 0,
            previous_score_percentage: oldScore.score_percentage || 0,
            previous_performance_rating_used: oldScore.previous_performance_rating_used || 100,
            recalculated_at: new Date().toISOString(),
            recalculated_by: userId || null
          })
        }
      } else {
        upsertBatch.push({
          task_id: task.id,
          employee_id: e.employeeId,
          score_percentage: e.scorePercentage,
          earnings_inr: e.earnings,
        })
      }
    })

    if (upsertBatch.length > 0) {
      await supabase.from('contribution_scores').upsert(upsertBatch, { onConflict: 'task_id,employee_id' })
    }

    // Layer employee commission agreements on top (no-op without agreements).
    await syncTaskAgreementEarnings(taskId)

    return { success: true, updatedCount: upsertBatch.length }
  } catch (err) {
    console.error('Task recalc error:', err)
    return { error: 'Failed to calculate commission' }
  }
}

/**
 * Automatically syncs draft invoice items with updated task details.
 * If a task's billing_amount_inr changes, we update the `unit_price` and `total` of linked invoice items,
 * and recalculate the total of the parent draft invoice.
 */
export async function syncDraftInvoices(taskId: string) {
  const supabase = createAdminClient()

  const { data: task } = await supabase.from('tasks')
    .select('id, title, status, client_id, task_date, billing_amount_inr, currency, billing_amount')
    .eq('id', taskId).single()
  
  if (!task) return { error: 'Task not found' }

  // 1. Find all existing invoice items linked to this task
  const { data: items } = await supabase.from('invoice_items').select('id, invoice_id, quantity').eq('task_id', taskId)
  const taskAmt = task.billing_amount || 0
  const invoiceIdsToRecalculate = new Set<string>()

  if (items && items.length > 0) {
    // Extract unique invoice IDs
    const invoiceIds = Array.from(new Set(items.map(i => i.invoice_id)))

    // Find which of these invoices are in 'draft' status
    const { data: invoices } = await supabase.from('invoices').select('id, status').in('id', invoiceIds).eq('status', 'draft')
    if (invoices && invoices.length > 0) {
      const draftInvoiceIds = new Set(invoices.map(inv => inv.id))
      const draftItemsToUpdate = items.filter(i => draftInvoiceIds.has(i.invoice_id))
      
      for (const item of draftItemsToUpdate) {
        const newTotal = taskAmt * (item.quantity || 1)
        
        // Update the invoice item with latest task details
        await supabase.from('invoice_items').update({
          unit_price: taskAmt,
          description: task.title,
          total: newTotal
        }).eq('id', item.id)
        
        invoiceIdsToRecalculate.add(item.invoice_id)
      }
    }
  } else if (task.status === 'done' && task.client_id && task.task_date) {
    // 2. Task is done but not on any invoice. Try to add it to an existing draft invoice for this month.
    const fromDateObj = new Date(task.task_date)
    const taskMonth = `${fromDateObj.getFullYear()}-${String(fromDateObj.getMonth() + 1).padStart(2, '0')}`
    const invoiceDate = getInvoiceDateForTaskMonth(taskMonth)
    const sequenceMonth = toSequenceMonth(invoiceDate)

    const { data: draftInvoice } = await supabase
      .from('invoices')
      .select('id')
      .eq('client_id', task.client_id)
      .eq('status', 'draft')
      .like('invoice_number', `INV-${sequenceMonth}-%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (draftInvoice) {
      // Determine the next display order
      const { data: existingItemsInInv } = await supabase.from('invoice_items').select('display_order').eq('invoice_id', draftInvoice.id)
      const nextOrder = existingItemsInInv?.length ? Math.max(...existingItemsInInv.map(i => i.display_order || 0)) + 1 : 0
      
      const { error } = await supabase.from('invoice_items').insert({
        invoice_id: draftInvoice.id,
        task_id: task.id,
        description: task.title,
        quantity: 1,
        unit_price: taskAmt,
        total: taskAmt,
        currency: task.currency || 'INR',
        display_order: nextOrder
      })
      
      if (!error) {
        invoiceIdsToRecalculate.add(draftInvoice.id)
      }
    }
  }

  // 3. Recalculate totals for all affected draft invoices
  for (const invId of invoiceIdsToRecalculate) {
    const { data: allItems } = await supabase.from('invoice_items').select('total').eq('invoice_id', invId)
    const { data: allExps } = await supabase.from('invoice_expense_items').select('amount').eq('invoice_id', invId)
    const { data: inv } = await supabase.from('invoices').select('discount_amount, tax_amount, previous_balance').eq('id', invId).single()
    
    const taskTotal = (allItems || []).reduce((sum, it) => sum + (it.total || 0), 0)
    const expTotal = (allExps || []).reduce((sum, e) => sum + (e.amount || 0), 0)
    const discount = inv?.discount_amount || 0
    const tax = inv?.tax_amount || 0
    const prevBal = inv?.previous_balance || 0
    
    const subtotal = r2(taskTotal + expTotal)
    const total_amount = r2(subtotal - discount + tax + prevBal)
    
    await supabase.from('invoices').update({
      subtotal,
      total_amount
    }).eq('id', invId)
  }

  return { success: true, updatedInvoices: invoiceIdsToRecalculate.size }
}

export async function syncDraftInvoiceExpenses(entryId: string) {
  const supabase = createAdminClient()

  // 1. Get the entry
  const { data: entry } = await supabase.from('cashbook_entries')
    .select('id, type, amount, amount_inr, currency, description, client_id, entry_date, deleted_at')
    .eq('id', entryId).single()
    
  if (!entry || entry.deleted_at || entry.type !== 'outflow' || !entry.client_id || !entry.entry_date) {
    return { success: false, reason: 'Not applicable for auto-invoicing' }
  }

  const invoiceIdsToRecalculate = new Set<string>()

  // 2. Check if this entry is already an expense item
  const { data: existingExp } = await supabase.from('invoice_expense_items')
    .select('id, invoice_id, amount, amount_inr, currency, original_amount, original_amount_inr, markup_type')
    .eq('cashbook_entry_id', entry.id)
    .maybeSingle()

  if (existingExp) {
    const { data: inv } = await supabase.from('invoices').select('status, currency, exchange_rate').eq('id', existingExp.invoice_id).single()
    if (inv && inv.status === 'draft') {
      let newBilling = entry.amount
      let newBillingInr = entry.amount_inr
      
      // If markup was none, we update the billing amount to match the new original amount.
      // But we need to ensure it's in the invoice currency.
      if (entry.currency !== inv.currency) {
          const invRate = inv.exchange_rate || 1
          newBilling = r2(entry.amount_inr / invRate)
      }

      if (existingExp.markup_type !== 'none') {
          // If it had a markup, we don't recalculate the billing amount automatically here
          // to avoid overwriting a custom manual markup value. Just update the original costs.
          newBilling = existingExp.amount
          newBillingInr = existingExp.amount_inr
      }
      
      await supabase.from('invoice_expense_items').update({
        original_amount: entry.amount,
        original_amount_inr: entry.amount_inr,
        amount: newBilling,
        amount_inr: newBillingInr,
        description: entry.description || ''
      }).eq('id', existingExp.id)

      invoiceIdsToRecalculate.add(existingExp.invoice_id)
    }
  } else {
    // 3. Try to add to a draft invoice for this month
    const fromDateObj = new Date(entry.entry_date)
    const entryMonth = `${fromDateObj.getFullYear()}-${String(fromDateObj.getMonth() + 1).padStart(2, '0')}`
    const invoiceDate = getInvoiceDateForTaskMonth(entryMonth)
    const sequenceMonth = toSequenceMonth(invoiceDate)

    const { data: draftInvoice } = await supabase
      .from('invoices')
      .select('id, currency, exchange_rate')
      .eq('client_id', entry.client_id)
      .eq('status', 'draft')
      .like('invoice_number', `INV-${sequenceMonth}-%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (draftInvoice) {
      let billing = entry.amount
      if (entry.currency !== draftInvoice.currency) {
          const invRate = draftInvoice.exchange_rate || 1
          billing = r2(entry.amount_inr / invRate)
      }

      const { error } = await supabase.from('invoice_expense_items').insert({
        invoice_id: draftInvoice.id,
        cashbook_entry_id: entry.id,
        description: entry.description || 'Expense',
        amount: billing,
        amount_inr: entry.amount_inr,
        currency: draftInvoice.currency || 'INR',
        original_amount: entry.amount,
        original_amount_inr: entry.amount_inr,
        markup_type: 'none',
        markup_value: 0,
        markup_amount: 0
      })

      if (!error) {
        invoiceIdsToRecalculate.add(draftInvoice.id)
      }
    }
  }

  // 4. Recalculate total for affected invoices
  for (const invId of invoiceIdsToRecalculate) {
    const { data: allItems } = await supabase.from('invoice_items').select('total').eq('invoice_id', invId)
    const { data: allExps } = await supabase.from('invoice_expense_items').select('amount').eq('invoice_id', invId)
    const { data: inv } = await supabase.from('invoices').select('discount_amount, tax_amount').eq('id', invId).single()
    
    const taskTotal = (allItems || []).reduce((sum, it) => sum + (it.total || 0), 0)
    const expTotal = (allExps || []).reduce((sum, e) => sum + (e.amount || 0), 0)
    const discount = inv?.discount_amount || 0
    const tax = inv?.tax_amount || 0
    
    const subtotal = r2(taskTotal + expTotal)
    const total_amount = r2(subtotal - discount + tax)
    
    await supabase.from('invoices').update({ subtotal, total_amount }).eq('id', invId)
  }

  return { success: true, updatedInvoices: invoiceIdsToRecalculate.size }
}
