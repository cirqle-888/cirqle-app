'use client'

/**
 * "Update available" banner for the sideloaded native app. Checks a hosted
 * latest.json on mount; if a newer native build exists, offers a Download that
 * opens the APK URL. Gated by isNative() — renders null on web/desktop and when
 * the app is up to date. See src/lib/native-update.ts.
 */
import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { isNative } from '@/lib/native'
import { checkForUpdate, openUpdateDownload, type UpdateInfo } from '@/lib/native-update'

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!isNative()) return
    let alive = true
    checkForUpdate().then(u => { if (alive && u.available) setInfo(u) }).catch(() => {})
    return () => { alive = false }
  }, [])

  if (!info?.available || dismissed) return null

  return (
    <div className="pointer-events-auto fixed inset-x-0 top-0 z-[60] flex justify-center pt-safe">
      <div className="mt-2 flex items-center gap-3 rounded-full bg-violet-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg">
        <span>
          Update available{info.latestVersion ? ` (${info.latestVersion})` : ''}
        </span>
        {info.url && (
          <button
            onClick={() => openUpdateDownload(info.url)}
            className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 hover:bg-white/30"
          >
            <Download className="h-3.5 w-3.5" /> Download
          </button>
        )}
        <button onClick={() => setDismissed(true)} aria-label="Dismiss" className="opacity-80 hover:opacity-100">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
