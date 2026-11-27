import { redirect } from 'next/navigation'
import { loadCurrentUser } from '@/lib/permissions/check'
import { checkAuthorize, nowSeconds, type AuthorizeRequest } from '@/lib/mcp/oauth'
import { approveConnection, denyConnection } from './actions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Connect an AI app · Cirqle' }

/**
 * Consent screen for AI apps connecting to Cirqle's MCP endpoint (OAuth,
 * see lib/mcp/oauth.ts). Not public: the session middleware sends a
 * signed-out visitor to /login and back here. Only admins can approve.
 */

const KNOWN_HOSTS: Record<string, string> = {
  'claude.ai': 'Claude', 'claude.com': 'Claude', 'chatgpt.com': 'ChatGPT', 'chat.openai.com': 'ChatGPT',
  localhost: 'an app on this computer', '127.0.0.1': 'an app on this computer',
}

const FIELDS = ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'response_type', 'state', 'scope'] as const

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md bg-card border border-border rounded-2xl p-6 space-y-4 shadow-sm">{children}</div>
    </div>
  )
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const p = Object.fromEntries(FIELDS.map(k => [k, sp[k] ?? ''])) as Partial<AuthorizeRequest>
  const me = await loadCurrentUser().catch(() => null)
  if (!me) {
    const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]).toString()
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${qs}`)}`)
  }

  const check = checkAuthorize(p, nowSeconds())
  if (!check.ok) {
    if (check.redirectOk && p.redirect_uri) {
      const u = new URL(p.redirect_uri)
      u.searchParams.set('error', check.error)
      u.searchParams.set('error_description', check.description)
      if (p.state) u.searchParams.set('state', p.state)
      redirect(u.toString())
    }
    return (
      <Card>
        <h1 className="text-lg font-semibold">This link cannot connect an app</h1>
        <p className="text-sm text-muted-foreground">{check.description}</p>
      </Card>
    )
  }

  const host = new URL(p.redirect_uri!).hostname
  const knownAs = KNOWN_HOSTS[host]
  if (!me.isAdmin) {
    return (
      <Card>
        <h1 className="text-lg font-semibold">Ask an admin</h1>
        <p className="text-sm text-muted-foreground">Only Cirqle admins can connect an AI app to Cirqle. Ask an admin to connect it from their account.</p>
      </Card>
    )
  }

  const hidden = FIELDS.map(k => <input key={k} type="hidden" name={k} value={p[k] ?? ''} />)
  return (
    <Card>
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Connect an AI app</p>
        <h1 className="text-lg font-semibold">{knownAs ? `Let ${knownAs} use Cirqle?` : 'Let this app use Cirqle?'}</h1>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{check.client.n}</span> wants to connect, and will return to <span className="font-mono text-foreground">{host}</span>.
        </p>
      </div>
      {!knownAs && (
        <p className="text-xs rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
          This is not Claude or ChatGPT. Allow it only if you started this connection yourself.
        </p>
      )}
      <div className="text-sm space-y-1.5">
        <p>It will be able to, as you:</p>
        <ul className="list-disc pl-5 text-muted-foreground space-y-0.5">
          <li>read clients, tasks, requests, invoices, leads and the cash summary</li>
          <li>plan social posts, edit Client Cards and Prompt Studio, send planned posts to Requests</li>
          <li>create tasks and requests, move task status, record payments and expenses</li>
        </ul>
        <p className="text-xs text-muted-foreground">It cannot see payroll, salaries or bank details, delete started work, or message anyone outside Cirqle. You can cut it off by removing the connector in the AI app; changing MCP_API_TOKEN cuts off every app.</p>
      </div>
      <div className="flex gap-2 pt-1">
        <form action={denyConnection} className="flex-1">{hidden}
          <button type="submit" className="w-full px-4 py-2 rounded-lg border border-border text-sm hover:bg-secondary">Cancel</button>
        </form>
        <form action={approveConnection} className="flex-1">{hidden}
          <button type="submit" className="w-full px-4 py-2 rounded-lg gradient-bg text-white text-sm font-medium">Allow</button>
        </form>
      </div>
      <p className="text-[11px] text-muted-foreground">Signed in as {me.cqid || 'you'}.</p>
    </Card>
  )
}
