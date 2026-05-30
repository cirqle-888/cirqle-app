import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Global UI interaction states
export const ROW_INTERACTIVE_CLASS = "cursor-pointer" // No background changes on hover

// Embedded Branded Pill states for primary content
export const BRANDED_PILL_BASE_CLASS = "inline-flex px-3 py-1.5 -mx-3 -my-1.5 rounded-lg transition-all duration-200"
export const BRANDED_PILL_SELECTED_CLASS = "gradient-bg !text-white shadow-md [&_.text-muted-foreground]:!text-white/80 [&_.opacity-70]:!opacity-100 [&_.bg-foreground]:!bg-white/20 [&_.text-foreground]:!text-white"
export const BRANDED_PILL_ACTIVE_CLASS = "gradient-bg !text-white shadow-lg ring-2 ring-violet-500/50 ring-offset-1 ring-offset-background [&_.text-muted-foreground]:!text-white/80 [&_.opacity-70]:!opacity-100 [&_.bg-foreground]:!bg-white/20 [&_.text-foreground]:!text-white"

