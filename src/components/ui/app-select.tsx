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
        className={`w-full appearance-none bg-[#0d1117] border border-white/10 rounded-xl
          px-3 py-2 pr-8 text-sm text-foreground
          focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20
          hover:border-white/20 transition-colors cursor-pointer
          disabled:opacity-50 disabled:cursor-not-allowed
          ${className ?? ''}`}
      >
        {children}
      </select>
      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
    </div>
  )
}
