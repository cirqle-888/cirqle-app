/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEMPORARY DEVELOPMENT PERMISSION BYPASS — REMOVE BEFORE PRODUCTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lets a single developer/owner exercise every module without first seeding
 * designations and permission rows. The permission ARCHITECTURE is untouched:
 * every key, every role mapping, every `requirePermission()` call site and
 * every `can()` check stays exactly where it is. This only short-circuits the
 * four predicates that answer "may they?", and only under the conditions below.
 *
 * ── WHY THIS CANNOT LEAK INTO PRODUCTION ──────────────────────────────────
 *
 * The switch is AND-ed with `process.env.NODE_ENV !== 'production'`. Next.js
 * inlines NODE_ENV at build time, so in a production build this expression is
 * statically `false` and the bypass branches are dead-code-eliminated by the
 * minifier. Setting the environment variable on a production deployment does
 * nothing — there is no code left to activate.
 *
 * That is a stronger guarantee than "remember to remove it", which is the
 * failure mode this kind of flag is famous for. Removal is still trivial (see
 * below); the point is that forgetting is not catastrophic.
 *
 * ── HOW TO TURN IT ON (local development only) ────────────────────────────
 *
 *   # .env.local
 *   NEXT_PUBLIC_DEV_PERMISSION_BYPASS=on
 *
 * Restart the dev server. A loud warning is logged on first use.
 * Omit the variable, or set it to anything else, and enforcement is normal.
 *
 * ── HOW TO REMOVE IT COMPLETELY (before production) ───────────────────────
 *
 *   1. Delete this file and src/components/dev/permission-bypass-banner.tsx
 *   2. Delete the five `devPermissionBypass()` early-returns it is imported
 *      into — grep for `dev-bypass` to find every one:
 *        src/lib/permissions/check.ts        (hasPermission, requirePermission,
 *                                             requireAnyPermission, requireAdmin)
 *        src/contexts/permission-context.tsx (can)
 *   3. Remove the banner mount in src/app/(dashboard)/layout.tsx
 *   4. Drop NEXT_PUBLIC_DEV_PERMISSION_BYPASS from .env.local
 *
 * Nothing else in the permission system changes, so re-enabling full
 * enforcement needs no redesign — it is the default the moment this is gone.
 *
 * ── WHAT IT DOES *NOT* BYPASS ─────────────────────────────────────────────
 *
 * Authentication. A signed-out or archived user is still rejected: the bypass
 * answers "may this user do X", not "is there a user". It also does not touch
 * Supabase RLS, so the database's own rules still apply.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * NEXT_PUBLIC_ so the client bundle can read it too — one variable governs
 * both sides, rather than two that could drift out of sync.
 */
const ENABLED =
  process.env.NODE_ENV !== 'production' &&
  process.env.NEXT_PUBLIC_DEV_PERMISSION_BYPASS === 'on'

let warned = false

/**
 * True when permission checks should be short-circuited for development.
 *
 * Call sites read as `if (devPermissionBypass()) return <allow>` placed AFTER
 * the authentication and archived checks, so the bypass can only ever widen a
 * real user's rights — never conjure one.
 */
export function devPermissionBypass(): boolean {
  if (!ENABLED) return false
  if (!warned) {
    warned = true
    // Loud, once per process. Silence is how a bypass survives to production.
    console.warn(
      '\n[41m[97m  PERMISSION ENFORCEMENT IS BYPASSED (development)  [0m\n' +
      '  Every permission check is returning ALLOW.\n' +
      '  Unset NEXT_PUBLIC_DEV_PERMISSION_BYPASS in .env.local to restore enforcement.\n' +
      '  See src/lib/permissions/dev-bypass.ts for removal steps.\n',
    )
  }
  return true
}

/** Same predicate, safe to read during render (no logging side-effect). */
export const isDevPermissionBypassActive = (): boolean => ENABLED
