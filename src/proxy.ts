import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  /*
   * `webmanifest` is in this list for a reason that is easy to miss: a browser
   * fetches the web app manifest ANONYMOUSLY — no cookies, unless the link tag
   * opts in with crossorigin="use-credentials". Running it through the auth
   * check therefore redirected /manifest.webmanifest to /login, and Chrome saw
   * an HTML login page where it expected JSON. The icons were all fine (they
   * are excluded by extension), so the iPhone home-screen icon worked and
   * nothing looked broken — but "Install app" on Android and desktop Chrome
   * had no name, no icons and no standalone display to read.
   *
   * The manifest holds the app's name and icon paths and nothing private.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|webmanifest|ico)$).*)'],
}
