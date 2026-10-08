'use client'

/**
 * Last-resort boundary: an error in the root layout itself. It replaces the
 * whole document, so it renders its own <html>/<body> and pulls in the global
 * styles. See components/errors/app-error-screen.
 */
import './globals.css'
import AppErrorScreen from '@/components/errors/app-error-screen'

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en" className="bg-background">
      <body className="bg-background text-foreground antialiased">
        <AppErrorScreen error={error} boundary="global" />
      </body>
    </html>
  )
}
