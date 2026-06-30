'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

// Standalone advertising sub-routes that should show a "← Advertising" link.
// The module root, the project detail ([id], which has its own back link), and
// deeper pages like the campaign-mapping screen (which carry their own crumb)
// are intentionally excluded.
const SUBROUTES = new Set([
  'integrations', 'new', 'reports', 'forecast', 'health', 'admin', 'ai-center', 'executive',
])

export function AdBackBar() {
  const path = usePathname() || ''
  const seg = path.split('/').filter(Boolean) // ['dashboard','advertising', ...]
  // Only exactly /dashboard/advertising/<subroute>
  if (seg.length !== 3 || seg[1] !== 'advertising' || !SUBROUTES.has(seg[2])) return null

  return (
    <div className="px-6 pt-4">
      <Link
        href="/dashboard/advertising"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Advertising
      </Link>
    </div>
  )
}
