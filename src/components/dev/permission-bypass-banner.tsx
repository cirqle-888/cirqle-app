'use client'

/**
 * TEMPORARY — remove with the permission bypass.
 * See src/lib/permissions/dev-bypass.ts for the full removal checklist.
 *
 * A permanently visible reminder that permission enforcement is OFF. The
 * failure mode of a dev bypass is forgetting it is active and mistaking
 * "everything works" for "permissions are correct" — so this is deliberately
 * hard to ignore and cannot be dismissed.
 *
 * Renders nothing at all when the bypass is inactive, and the whole component
 * is dead code in a production build (the predicate is statically false there).
 */

import { ShieldOff } from 'lucide-react'
import { isDevPermissionBypassActive } from '@/lib/permissions/dev-bypass'

export function PermissionBypassBanner() {
  if (!isDevPermissionBypassActive()) return null
  return (
    <div
      role="status"
      // pointer-events-none: this sits at z-[200], above every modal in the
      // app (overlays default to z-50), and centred on the bottom edge — exactly
      // where modal action bars put Save and Confirm. It is purely
      // informational and never needs a click, so it must not absorb one. It
      // silently swallowed a Save click during testing before this was added.
      className="pointer-events-none fixed bottom-2 left-1/2 z-[200] -translate-x-1/2 rounded-full border border-amber-500/40 bg-amber-500/95 px-3 py-1 text-[11px] font-semibold text-amber-950 shadow-lg"
      title="NEXT_PUBLIC_DEV_PERMISSION_BYPASS=on in .env.local — every permission check returns allow. Remove before production."
    >
      <span className="inline-flex items-center gap-1.5">
        <ShieldOff className="h-3.5 w-3.5" />
        Permissions bypassed (dev)
      </span>
    </div>
  )
}
