'use client'

import { ChevronDown } from 'lucide-react'
import type { SelectHTMLAttributes } from 'react'

// ─── AppSelect ────────────────────────────────────────────────────────────────
// Consistent styled wrapper for native <select> — matches Combobox visual style.
// Usage:
//   <AppSelect value={x} onChange={e => setX(e.target.value)}>
//     <option value="a">Option A</option>
//   </AppSelect>

interface AppSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  wrapperClassName?: string
}

export default function AppSelect({ className, wrapperClassName, children, ...props }: AppSelectProps) {
  return (
    <div className={`relative ${wrapperClassName ?? ''}`}>
      <select
        {...props}
        className={`w-full appearance-none bg-background border border-input rounded-lg
          px-3 py-2 pr-8 text-sm h-9 shadow-sm
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20
          disabled:opacity-50 disabled:cursor-not-allowed
          ${className ?? ''}`}
      >
        {children}
      </select>
      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
    </div>
  )
}
