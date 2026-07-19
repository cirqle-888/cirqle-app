/**
 * SSRF-hardened fetch for URLs that came from outside the app — pasted image
 * links, client-supplied Google Sheet links, anything a user can influence.
 *
 * Shared by the offer intake image proxy and the Google Sheet pull, so the
 * guard exists once rather than being re-derived (and re-weakened) per caller.
 */

export class BlockedHostError extends Error {}

/**
 * True for any address that must never be reachable from a server-side fetch:
 * loopback, RFC-1918 private ranges, carrier-grade NAT, link-local — including
 * 169.254.169.254, the cloud instance metadata endpoint whose response would
 * hand out our own deployment credentials — plus the IPv6 equivalents and
 * IPv4-mapped IPv6 forms.
 */
export function isBlockedAddress(ip: string, family: number): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, '')

  if (family === 6) {
    // ::ffff:10.0.0.1 and friends are IPv4 wearing an IPv6 hat — unwrap and
    // re-test rather than letting the mapping bypass the v4 rules below.
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isBlockedAddress(mapped[1], 4)
    return (
      addr === '::' || addr === '::1' ||
      addr.startsWith('fe80:') ||          // link-local
      /^f[cd][0-9a-f]{2}:/.test(addr)      // unique local (fc00::/7)
    )
  }

  const parts = addr.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  return (
    a === 0 ||                              // "this network"
    a === 127 ||                            // loopback
    a === 10 ||                             // private
    (a === 172 && b >= 16 && b <= 31) ||    // private
    (a === 192 && b === 168) ||             // private
    (a === 169 && b === 254) ||             // link-local INCLUDING cloud metadata
    (a === 100 && b >= 64 && b <= 127) ||   // carrier-grade NAT
    a >= 224                                // multicast + reserved
  )
}

/**
 * Fetch a user-supplied URL with the SSRF checks applied at every hop.
 *
 * Two things a string-matching guard misses:
 *  - A hostname is not an address. `evil.com` can simply resolve to
 *    169.254.169.254, so the host has to be resolved and the resulting IP
 *    checked — matching on the text of the hostname proves nothing.
 *  - fetch() follows redirects by default, so a public host could answer 302
 *    and send us anywhere after the check had already passed. Redirects are
 *    therefore handled manually, re-validating each Location.
 */
export async function safePublicFetch(
  initial: URL,
  { maxRedirects = 3, timeoutMs = 15_000 }: { maxRedirects?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const { lookup } = await import('node:dns/promises')
  let target = initial

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new BlockedHostError('Only http(s) URLs are supported.')
    }

    const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new BlockedHostError('Blocked host.')
    }

    // Resolve every address the name maps to and reject if ANY is internal —
    // a name with both a public and a private A record must not slip through.
    let addresses: { address: string; family: number }[]
    try {
      addresses = await lookup(host, { all: true })
    } catch {
      throw new BlockedHostError('Could not resolve host.')
    }
    if (!addresses.length || addresses.some(a => isBlockedAddress(a.address, a.family))) {
      throw new BlockedHostError('Blocked host.')
    }

    const res = await fetch(target.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    })

    if (res.status < 300 || res.status > 399) return res

    const location = res.headers.get('location')
    if (!location) return res
    try {
      target = new URL(location, target)
    } catch {
      throw new BlockedHostError('Bad redirect target.')
    }
  }

  throw new BlockedHostError('Too many redirects.')
}
