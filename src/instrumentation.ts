/**
 * Server start-up hook (Next.js instrumentation).
 *
 * Keeps the server's HTTPS connections to Supabase WARM between requests.
 *
 * Node's fetch drops an idle keep-alive socket after 4 seconds. A page here
 * fans out to 20–30 database reads at once, so after any pause longer than
 * that — which is every page view a real person makes — the whole fan-out
 * starts by opening fresh TLS connections to the database, in parallel. Each
 * handshake costs a full round trip and then some: measured on 9 Nov 2026,
 * five concurrent reads on cold sockets took 1,164 ms EACH against 291 ms for
 * one warm read, and on the Contributions page ten-row lookups like `groups`
 * and `tools` cost 1,259 ms for the same reason. The queries were never slow;
 * the sockets were cold.
 *
 * A 30-second idle timeout keeps the pool warm across a person clicking
 * around, and across requests to a warm serverless instance in production.
 * It is well inside what the database's edge keeps a connection open for, and
 * a socket the far side has closed is detected and replaced before use, so a
 * longer timeout can only ever save a handshake, never fail a request.
 *
 * Node runtime only: the middleware runs on the Edge runtime, which has no
 * undici dispatcher to configure and keeps its own connections.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { Agent, setGlobalDispatcher } = await import('undici')
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 120_000,
    // Wide enough for one page's full fan-out plus a few concurrent viewers
    // on the same instance; undici queues anything beyond it rather than
    // opening more.
    connections: 64,
  }))
}
