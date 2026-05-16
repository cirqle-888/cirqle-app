// Given a task with is_recurring=true, calculate the next occurrence date
export function getNextOccurrence(taskDate: string, interval: string): string {
  const d = new Date(taskDate + 'T00:00:00')
  switch (interval) {
    case 'daily':     d.setDate(d.getDate() + 1); break
    case 'weekly':    d.setDate(d.getDate() + 7); break
    case 'biweekly':  d.setDate(d.getDate() + 14); break
    case 'monthly':   d.setMonth(d.getMonth() + 1); break
  }
  return d.toISOString().split('T')[0]
}

export function shouldGenerateNext(task: { recurring_end_date?: string | null }, nextDate: string): boolean {
  if (!task.recurring_end_date) return true
  return nextDate <= task.recurring_end_date
}
