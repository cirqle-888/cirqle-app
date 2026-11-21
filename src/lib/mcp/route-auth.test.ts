import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * /api/mcp runs as the service role behind one shared bearer token, exactly
 * like /api/shortcut and the cron routes. The same fail-closed rule applies:
 * an unset MCP_API_TOKEN must reject every request, never admit "Bearer
 * undefined". Mirrors src/lib/permissions/cron-auth.test.ts.
 */
describe('MCP route authentication', () => {
  const src = readFileSync(join(process.cwd(), 'src/app/api/mcp/route.ts'), 'utf8')

  it('checks MCP_API_TOKEN', () => {
    expect(src).toContain('process.env.MCP_API_TOKEN')
  })

  it('fails closed when the token is unset', () => {
    expect(src).toMatch(/if \(!token\) return false/)
  })

  it('rejects an empty bearer value', () => {
    expect(src).toMatch(/if \(!got\) return false/)
  })

  it('accepts an OAuth token only for an active, not archived employee', () => {
    expect(src).toContain('accessTokenSubject(got')
    expect(src).toMatch(/\.eq\('is_active', true\)\.eq\('is_archived', false\)/)
  })

  it('points a refused caller at the OAuth metadata', () => {
    expect(src).toContain('resource_metadata=')
  })

  it('guards every exported HTTP method', () => {
    const handlers = src.match(/export async function (POST|GET)\(req: NextRequest\) \{\n\s+if \(!\(await authorized\(req\)\)\) return unauthorized\(req\)/g) || []
    expect(handlers).toHaveLength(2)
    expect(src).toContain('export const DELETE = GET')
  })

  it('is exempt from the session middleware (so the bearer check is the only gate)', () => {
    const mw = readFileSync(join(process.cwd(), 'src/lib/supabase/middleware.ts'), 'utf8')
    expect(mw).toContain("pathname.startsWith('/api/mcp')")
  })
})
