// Self-contained shape (only the fields this resolver needs). Kept local so
// the module has no dependency on uncommitted type additions in @/types.
interface EmployeePerformanceHistory {
  employee_id: string
  effective_from: string      // YYYY-MM-DD
  performance_rating: number
}

/**
 * Resolves the effective performance rating for an employee on a given task date.
 * 
 * Rules:
 * - Checks the performance history register for the most recent entry that is ON OR BEFORE the taskDate.
 * - If no history exists for that date or before, falls back to the current employee profile rating.
 * 
 * @param employeeId The employee's UUID
 * @param taskDate The task's date as a string (YYYY-MM-DD)
 * @param historyRecords The full array of employee_performance_history
 * @param currentProfileRating The employee's current `performance_rating` from the employee profile (ultimate fallback)
 */
export function getEffectivePerformanceRating(
  employeeId: string,
  taskDate: string,
  historyRecords: EmployeePerformanceHistory[],
  currentProfileRating: number
): number {
  if (!historyRecords || historyRecords.length === 0) {
    return currentProfileRating
  }

  // Filter history for this employee and dates <= taskDate
  const applicableHistory = historyRecords.filter(h => {
    return h.employee_id === employeeId && h.effective_from <= taskDate
  })

  // If no historical records apply on or before this date, fallback to the current profile rating
  if (applicableHistory.length === 0) {
    return currentProfileRating
  }

  // Sort descending by effective_from (most recent first)
  applicableHistory.sort((a, b) => {
    return b.effective_from.localeCompare(a.effective_from)
  })

  // Return the rating from the most recent applicable record
  return applicableHistory[0].performance_rating
}
