import { createAdminClient } from '@/lib/supabase/server'

export async function checkDailyBudget(clientId: string, dailyLimit: number): Promise<boolean> {
  const supabase = createAdminClient()
  
  // Compute total cost for this client today
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const { data, error } = await supabase
    .from('ad_ai_usage')
    .select('estimated_cost')
    .eq('client_id', clientId)
    .gte('created_at', today.toISOString())
    
  if (error || !data) return true // default to allowing if error

  const totalCostToday = data.reduce((sum, row) => sum + (row.estimated_cost || 0), 0)
  
  return totalCostToday < dailyLimit
}
