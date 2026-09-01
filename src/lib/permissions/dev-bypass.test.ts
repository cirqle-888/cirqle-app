/**
 * SAFETY GUARD for the temporary development permission bypass.
 *
 * The whole risk of a bypass flag is that it survives to production. These
 * tests pin the two properties that make that impossible-by-construction
 * rather than remembered-by-luck, and will fail loudly if someone loosens
 * either one.
 *
 * When the bypass is removed, delete this file along with it.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const src = read('src/lib/permissions/dev-bypass.ts')

describe('the bypass cannot activate in production', () => {
  it('is AND-ed with a NODE_ENV production check', () => {
    // Next.js inlines NODE_ENV at build time, so this makes the whole
    // expression statically false in a production build and the bypass
    // branches get dead-code-eliminated. Setting the env var on a deployed
    // instance then does nothing — there is no code left to switch on.
    const enabled = src.slice(src.indexOf('const ENABLED'), src.indexOf('let warned'))
    expect(enabled).toMatch(/process\.env\.NODE_ENV\s*!==\s*'production'/)
    expect(enabled).toMatch(/&&/)
    expect(enabled).toMatch(/NEXT_PUBLIC_DEV_PERMISSION_BYPASS/)
  })

  it('requires an explicit opt-in value — it is never on by default', () => {
    const enabled = src.slice(src.indexOf('const ENABLED'), src.indexOf('let warned'))
    expect(enabled).toMatch(/===\s*'on'/)
  })
})

describe('the bypass widens rights but never invents a user', () => {
  // Authentication is not a permission. Every guard must still reject a
  // signed-out or archived caller, so the bypass answers "may they?" and
  // never "is there anybody there?".
  const check = read('src/lib/permissions/check.ts')

  it.each(['requirePermission', 'requireAnyPermission', 'requireAdmin'])(
    '%s rejects signed-out and archived callers before consulting the bypass',
    (fn) => {
      const at = check.indexOf(`export async function ${fn}`)
      expect(at).toBeGreaterThan(-1)
      // Generous window: these bodies carry long explanatory comments, and a
      // slice that ends mid-function would fail for length rather than for
      // the ordering this test is actually about.
      const body = check.slice(at, at + 2600)
      const notSignedIn = body.indexOf("'Not signed in.'")
      const archived = body.indexOf('isArchived')
      const bypass = body.indexOf('devPermissionBypass()')
      expect(notSignedIn).toBeGreaterThan(-1)
      expect(archived).toBeGreaterThan(-1)
      expect(bypass).toBeGreaterThan(-1)
      expect(notSignedIn).toBeLessThan(bypass)
      expect(archived).toBeLessThan(bypass)
    },
  )

  it('hasPermission still refuses a null or archived user', () => {
    const at = check.indexOf('export function hasPermission')
    const body = check.slice(at, at + 1200)
    const nullCheck = body.indexOf('!user || user.isArchived')
    const bypass = body.indexOf('devPermissionBypass()')
    expect(nullCheck).toBeGreaterThan(-1)
    expect(bypass).toBeGreaterThan(-1)
    expect(nullCheck).toBeLessThan(bypass)
  })

  // ── View-as must survive the bypass ────────────────────────────────────────
  // The preview exists to answer "what can THIS employee reach?". If the dev
  // bypass outranked it, that answer would be "everything" in development —
  // which is precisely where the preview gets used.
  it('hasPermission ignores the bypass while previewing another account', () => {
    const at = check.indexOf('export function hasPermission')
    const body = check.slice(at, at + 1200)
    expect(body).toMatch(/!user\.isViewAs\s*&&\s*devPermissionBypass\(\)/)
  })

  // Every guard — read and write alike — now shares one body, guardDecision,
  // so the ordering invariant is asserted there instead of once per wrapper.
  // The BEHAVIOUR this protects is covered directly in guard-decision.test.ts;
  // this keeps the source-order property that makes it hard to get wrong.
  it('guardDecision refuses a previewed mutation ahead of admin and the bypass', () => {
    const at = check.indexOf('export function guardDecision')
    expect(at, 'guardDecision has moved or been renamed').toBeGreaterThan(-1)
    const body = check.slice(at, at + 2600)
    const viewAs = body.indexOf('subject.isViewAs')
    const adminShortCircuit = body.indexOf('if (subject.isAdmin)')
    // The CHECK, not the destructured parameter in the signature above it.
    const bypass = body.indexOf('if (devBypass)')
    expect(viewAs).toBeGreaterThan(-1)
    // Previewing an ADMIN must not hand the writes back, and the dev bypass
    // must not either — so the read-only check has to come before both.
    expect(viewAs).toBeLessThan(adminShortCircuit)
    expect(viewAs).toBeLessThan(bypass)
  })

  it('both write wrappers really are write wrappers', () => {
    // The refusal above only binds mutations if requirePermission and
    // requireAnyPermission actually ask for allowViewAs:false.
    for (const fn of ['requirePermission', 'requireAnyPermission']) {
      const at = check.indexOf(`export async function ${fn}(`)
      expect(at, `${fn} has moved or been renamed`).toBeGreaterThan(-1)
      expect(check.slice(at, at + 400)).toMatch(/allowViewAs:\s*false/)
    }
  })
})

describe('removal is a documented, greppable operation', () => {
  it('every wired-in site is findable by grepping "dev-bypass"', () => {
    for (const f of [
      'src/lib/permissions/check.ts',
      'src/contexts/permission-context.tsx',
      'src/components/dev/permission-bypass-banner.tsx',
      'src/app/(dashboard)/layout.tsx',
    ]) {
      expect(read(f), `${f} should reference dev-bypass for removal`).toMatch(/dev-bypass|dev\/permission-bypass-banner/)
    }
  })

  it('the module documents how to remove it', () => {
    expect(src).toMatch(/HOW TO REMOVE IT COMPLETELY/)
  })
})
