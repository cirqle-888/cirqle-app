'use client'

/**
 * Compact per-client social panel for the client detail page. Plain props only
 * (no token, no server calls) — links out to the full Social Hub.
 */

import Link from 'next/link'
import { PlatformIcon } from './platform-icon'
import { Share2, ChevronRight } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

export interface ClientSocialAccount {
  id: string
  platform: 'facebook_page' | 'instagram'
  name: string
  username: string | null
  profile_picture_url: string | null
  followers_count: number | null
  status: 'connected' | 'disconnected' | 'needs_reauth' | 'error'
  last_synced_at: string | null
}

const STATUS_DOT: Record<string, string> = {
  connected: 'bg-emerald-500',
  needs_reauth: 'bg-red-500',
  error: 'bg-red-500',
  disconnected: 'bg-gray-500',
}

export function ClientSocialSection({ accounts }: { accounts: ClientSocialAccount[] }) {
  return (
    <div className="bg-card border border-border rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold flex items-center gap-1.5"><Share2 className="w-4 h-4" /> Social accounts</h2>
        <Link href="/dashboard/social" className="text-xs text-primary hover:underline flex items-center">Hub <ChevronRight className="w-3 h-3" /></Link>
      </div>

      {accounts.length === 0 ? (
        <p className="text-xs text-muted-foreground leading-relaxed">
          No Meta assets connected. Connect this client&apos;s Facebook Pages and Instagram accounts from the{' '}
          <Link href="/dashboard/advertising/integrations" className="text-primary hover:underline">integrations</Link> page.
        </p>
      ) : (
        <div className="space-y-2">
          {accounts.map((a) => (
            <Link
              key={a.id}
              href={`/dashboard/social/accounts/${a.id}`}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 -mx-2 hover:bg-secondary/50 transition-colors"
            >
              <div className="relative">
                {a.profile_picture_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.profile_picture_url} alt="" className="h-8 w-8 rounded-full object-cover border border-border" />
                ) : (
                  <div className="h-8 w-8 rounded-full bg-secondary flex items-center justify-center">
                    <PlatformIcon platform={a.platform} className={a.platform === 'instagram' ? 'w-4 h-4 text-pink-500' : 'w-4 h-4 text-blue-500'} />
                  </div>
                )}
                <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-card ${STATUS_DOT[a.status] ?? 'bg-gray-500'}`} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{a.name}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {a.username ? `@${a.username}` : a.platform === 'instagram' ? 'Instagram' : 'Facebook Page'}
                  {a.followers_count != null && ` · ${Intl.NumberFormat('en', { notation: 'compact' }).format(a.followers_count)} followers`}
                </div>
              </div>
              {a.status === 'needs_reauth' && <span className="text-[10px] text-red-400 shrink-0">Reauth</span>}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
