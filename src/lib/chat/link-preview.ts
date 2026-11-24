import 'server-only'
import { lookup } from 'node:dns/promises'
import { createAdminClient } from '@/lib/supabase/admin'
import { extractUrls, isBlockedHost, isPrivateIp, parsePreview, type LinkPreview } from './links'

const MAX_BYTES = 300_000
const MAX_HOPS = 3

/** Only ordinary web addresses on the default ports, and never a private machine. */
async function isSafeToFetch(url: URL): Promise<boolean> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (url.port && url.port !== '80' && url.port !== '443') return false
  if (url.username || url.password) return false
  if (isBlockedHost(url.hostname)) return false
  try {
    const addrs = await lookup(url.hostname, { all: true })
    return addrs.length > 0 && addrs.every(a => !isPrivateIp(a.address))
  } catch { return false }
}

/**
 * Fetch a page and read its preview. Every redirect hop is checked again, the
 * read is capped, and anything unusual simply yields no preview.
 */
export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreview | null> {
  let url: URL
  try { url = new URL(rawUrl) } catch { return null }
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (!(await isSafeToFetch(url))) return null
      const res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(4000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; LinkPreview/1.0)', accept: 'text/html,application/xhtml+xml' },
      })
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location')
        if (!next) return null
        url = new URL(next, url)
        continue
      }
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html') || !res.body) return null
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      while (size < MAX_BYTES) {
        const { done, value } = await reader.read()
        if (done || !value) break
        chunks.push(value)
        size += value.byteLength
      }
      void reader.cancel().catch(() => {})
      const html = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks))
      return parsePreview(html, url.toString())
    }
  } catch { /* slow, blocked or not a page — no preview */ }
  return null
}

/** After a message is sent: read its first link and store the preview on the message. */
export async function attachLinkPreview(messageId: string, text: string): Promise<void> {
  const first = extractUrls(text)[0]
  if (!first) return
  const preview = await fetchLinkPreview(first)
  if (!preview) return
  const admin = createAdminClient()
  const { data } = await admin.from('messages').select('metadata, deleted_at').eq('id', messageId).maybeSingle()
  if (!data || data.deleted_at) return
  await admin.from('messages')
    .update({ metadata: { ...((data.metadata as Record<string, unknown>) ?? {}), linkPreview: preview } })
    .eq('id', messageId)
}
