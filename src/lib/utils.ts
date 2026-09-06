import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

import { endOfMonth, differenceInDays, parseISO, startOfDay, isSameMonth, isPast } from 'date-fns'

export function getDeliveryPaceText(currentMonth: string, remaining: number): string | null {
  if (remaining <= 0) return null
  
  const today = startOfDay(new Date())
  const normalizedMonth = currentMonth.slice(0, 7) // Ensure YYYY-MM
  const monthDate = parseISO(`${normalizedMonth}-01`)
  const monthEnd = endOfMonth(monthDate)
  
  let daysRemaining = 0
  if (isSameMonth(today, monthDate)) {
    daysRemaining = differenceInDays(monthEnd, today)
  } else if (isPast(monthDate)) {
    return 'Month ended'
  } else {
    daysRemaining = differenceInDays(monthEnd, monthDate) + 1
  }

  if (daysRemaining === 0) return `0 days remaining (due today!)`
  
  const pace = daysRemaining / remaining
  let paceText = ''
  if (pace >= 1) {
    paceText = `Need 1 deliverable every ${pace.toFixed(1).replace(/\.0$/, '')} days`
  } else {
    paceText = `Need ${(1/pace).toFixed(1).replace(/\.0$/, '')} deliverables per day`
  }
  
  return `${daysRemaining} days remaining · ${paceText}`
}

/**
 * Client display name with its unique code appended for disambiguation
 * (two clients can share a name; the code never repeats). e.g. "Sea Star · 015".
 * Returns a plain string — use where client names render as text.
 */
export function clientLabel(
  client?: { name?: string | null; code?: string | null } | null,
  fallback = '—',
): string {
  const name = client?.name?.trim()
  if (!name) return fallback
  return client?.code ? `${name} · ${client.code}` : name
}

// Global UI interaction states
export const ROW_INTERACTIVE_CLASS = "cursor-pointer" // No background changes on hover

// Embedded Branded Pill states for primary content
export const BRANDED_PILL_BASE_CLASS = "inline-flex px-3 py-1.5 -mx-3 -my-1.5 rounded-lg transition-all duration-200"
export const BRANDED_PILL_SELECTED_CLASS = "gradient-bg !text-white shadow-md [&_.text-muted-foreground]:!text-white/80 [&_.opacity-70]:!opacity-100 [&_.bg-foreground]:!bg-white/20 [&_.text-foreground]:!text-white"
export const BRANDED_PILL_ACTIVE_CLASS = "gradient-bg !text-white shadow-lg ring-2 ring-violet-500/50 ring-offset-1 ring-offset-background [&_.text-muted-foreground]:!text-white/80 [&_.opacity-70]:!opacity-100 [&_.bg-foreground]:!bg-white/20 [&_.text-foreground]:!text-white"

export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (e) {
      console.warn('Clipboard API failed', e)
    }
  }
  // Fallback
  try {
    const textArea = document.createElement("textarea")
    textArea.value = text
    textArea.style.position = "fixed"
    textArea.style.top = "0"
    textArea.style.left = "0"
    textArea.style.opacity = "0"
    document.body.appendChild(textArea)
    textArea.focus()
    textArea.select()
    const successful = document.execCommand('copy')
    document.body.removeChild(textArea)
    return successful
  } catch (err) {
    console.error('Fallback: Oops, unable to copy', err)
    return false
  }
}
