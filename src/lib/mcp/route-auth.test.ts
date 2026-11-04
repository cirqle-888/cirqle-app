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
    expect(src).toMatch(/got\.length > 0 && got === token/)
  })

  it('guards every exported HTTP method', () => {
    const handlers = src.match(/export async function (POST|GET)\(req: NextRequest\) \{\n\s+if \(!authorized\(req\)\) return unauthorized\(\)/g) || []
    expect(handlers).toHaveLength(2)
    expect(src).toContain('export const DELETE = GET')
  })

  it('is exempt from the session middleware (so the bearer check is the only gate)', () => {
    const mw = readFileSync(join(process.cwd(), 'src/lib/supabase/middleware.ts'), 'utf8')
    expect(mw).toContain("pathname.startsWith('/api/mcp')")
  })
})
