'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, X, Loader2 } from 'lucide-react'
import { stopViewAs } from '@/lib/permissions/view-as-actions'

/**
 * Always-visible reminder that this session is not showing your own account.
 *
 * Fixed to the top and impossible to dismiss without leaving the preview: the
 * one genuine danger of view-as is forgetting you are in it and reading
 * someone else's screen as your own. z-[300] puts it above modals and the
 * chat launcher for the same reason.
 */
export function ViewAsBanner({ cqid, designation }: { cqid: string; designation: string | null }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [leaving, setLeaving] = useState(false)

  function exit() {
    setLeaving(true)
    start(async () => {
      await stopViewAs()
      router.refresh()
      // Land somewhere the previewed employee may not have been able to reach,
      // rather than 404-ing on their page as yourself.
      router.push('/dashboard/settings/access-preview')
    })
  }

  return (
    <div className="fixed top-0 inset-x-0 z-[300] bg-amber-500 text-black">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium">
        <Eye className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">
          Viewing as <strong>{cqid}</strong>
          {designation && <span className="hidden sm:inline"> · {designation}</span>}
          <span className="hidden sm:inline"> — read-only, nothing can be changed</span>
        </span>
        <span className="flex-1" />
        <button
          onClick={exit} disabled={pending || leaving}
          className="inline-flex items-center gap-1 rounded bg-black/15 hover:bg-black/25 px-2 py-1 disabled:opacity-60 shrink-0"
        >
          {pending || leaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
          Exit
        </button>
      </div>
    </div>
  )
}
