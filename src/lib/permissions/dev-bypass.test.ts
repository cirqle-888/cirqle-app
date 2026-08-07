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
      const body = check.slice(at, at + 1200)
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
    const body = check.slice(at, at + 500)
    const nullCheck = body.indexOf('!user || user.isArchived')
    const bypass = body.indexOf('devPermissionBypass()')
    expect(nullCheck).toBeGreaterThan(-1)
    expect(nullCheck).toBeLessThan(bypass)
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
