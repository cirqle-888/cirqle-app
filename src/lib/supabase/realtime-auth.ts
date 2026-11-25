/**
 * Make every Realtime channel wait until the socket knows who is signed in.
 *
 * WHY: a channel's "join" carries the access token the socket holds at that
 * instant. On a fresh page the socket has none yet — it is still asking the
 * auth client for the session — so a channel subscribed straight away joins as
 * the anonymous role. The library does fetch the token a moment later, but it
 * only pushes a token to channels that are ALREADY joined, and only when the
 * token CHANGES; a channel that was mid-join stays anonymous until the next
 * token refresh, about an hour on. Anonymous cannot read `messages`, so
 * Supabase delivered every new message as an empty row marked
 * "401: Unauthorized": nothing appeared live in chat, read receipts and
 * presence did not move, and the empty rows surfaced as blank "New message"
 * pop-ups. (Found 25 Nov 2026: every subscription in `realtime.subscription`
 * had role `anon`.)
 *
 * FIX: `subscribe()` first awaits `realtime.setAuth()`, which resolves once
 * the socket holds the signed-in token, so the join goes out authenticated.
 * `subscribe()` still returns the channel at once, as callers expect. A channel
 * removed before its turn comes is never subscribed.
 */

interface ChannelLike {
  subscribe: (...args: never[]) => unknown
  unsubscribe: (...args: never[]) => unknown
}
interface ClientLike {
  channel: (...args: never[]) => ChannelLike
  realtime: { setAuth: () => Promise<void> }
}

const patched = new WeakSet<object>()

/** Patch a Supabase client once; safe to call on every createClient(). */
export function subscribeAfterAuth<T extends ClientLike>(client: T): T {
  if (patched.has(client)) return client
  patched.add(client)

  const makeChannel = client.channel.bind(client)
  client.channel = ((...args: never[]) => {
    const channel = makeChannel(...args)
    const subscribe = channel.subscribe.bind(channel)
    const unsubscribe = channel.unsubscribe.bind(channel)
    let removed = false

    channel.unsubscribe = ((...a: never[]) => { removed = true; return unsubscribe(...a) }) as ChannelLike['unsubscribe']
    channel.subscribe = ((...a: never[]) => {
      // A failed token lookup must not leave the page without live updates at
      // all: subscribe anyway, exactly as before this existed.
      void client.realtime.setAuth().catch(() => {}).then(() => { if (!removed) subscribe(...a) })
      return channel
    }) as ChannelLike['subscribe']
    return channel
  }) as T['channel']
  return client
}
