import type { Metadata } from 'next'
import { Apple, Download, Smartphone } from 'lucide-react'
import desktop from '../../../desktop/latest.json'
import android from '../../../public/mobile/latest.json'

export const metadata: Metadata = {
  title: 'Get the Cirqle apps',
  description: 'Download Cirqle Desktop for Mac and the Cirqle app for Android.',
}

/**
 * The one public address for both installable apps. No sign-in: a new team
 * member has no session on the machine they are installing onto.
 *
 * Nothing here is typed by hand. The versions and download addresses come from
 * the two manifests the release scripts write (desktop/latest.json and
 * public/mobile/latest.json) — the same files the installed apps read to offer
 * an update — so this page can never advertise a build that was not published.
 */
export default function DownloadPage() {
  const mac = desktop as { version: string; download?: string; url?: string }
  const macHref = mac.download ?? mac.url
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Get the Cirqle apps</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Both apps open the same Cirqle you use in the browser. Sign in with your usual account.
        </p>

        <section className="mt-8 rounded-xl border border-border bg-card p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <Apple className="mt-0.5 h-6 w-6 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold">Cirqle Desktop for Mac</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Version {mac.version} · Apple Silicon Macs (M1 and newer). Cirqle and WhatsApp side by side, with
                your daily actions one click away.
              </p>
              {macHref && (
                <a
                  href={macHref}
                  className="mt-4 inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500"
                >
                  <Download className="h-4 w-4" aria-hidden /> Download for Mac
                </a>
              )}
              <h3 className="mt-5 text-sm font-semibold">The first time you open it</h3>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
                <li>Open the downloaded file and drag <b className="text-foreground">Cirqle Desktop</b> into Applications.</li>
                <li>Open Cirqle Desktop from Applications. macOS will say it could not verify the app. Choose <b className="text-foreground">Done</b>.</li>
                <li>
                  Open <b className="text-foreground">System Settings → Privacy &amp; Security</b>, scroll down, and choose{' '}
                  <b className="text-foreground">Open Anyway</b> next to Cirqle Desktop. Confirm with your Mac password.
                </li>
                <li>From then on it opens like any other app. Updates are offered inside the app.</li>
              </ol>
              <p className="mt-3 text-xs text-muted-foreground">
                The extra step is there because the app is not yet registered with Apple. It is the same Cirqle.
              </p>
            </div>
          </div>
        </section>

        <section className="mt-5 rounded-xl border border-border bg-card p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <Smartphone className="mt-0.5 h-6 w-6 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold">Cirqle for Android</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Version {android.versionName}. Notifications reach you even when the app is closed.
              </p>
              <a
                href={android.url}
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500"
              >
                <Download className="h-4 w-4" aria-hidden /> Download for Android
              </a>
              <ol className="mt-5 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
                <li>Open the downloaded file on your phone. If asked, allow your browser to install apps.</li>
                <li>Install. It replaces an older Cirqle app and keeps you signed in.</li>
                <li>Open Cirqle and choose <b className="text-foreground">Allow</b> when it asks about notifications.</li>
              </ol>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}
