import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { ThemeProvider } from '@/contexts/theme-context'
import { DynamicFavicon } from '@/components/ui/dynamic-favicon'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Cirqle — Business Management',
  description: 'Cirqle Design agency business management system',
  icons: {
    icon: '/icon.svg',
    shortcut: '/icon.svg',
    apple: '/icon.svg',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        {/* Plain <script> in a Server Component renders to HTML on the server —
            no React 19 client-side script-tag warning. Runs before hydration
            to set the correct theme class without a flash. */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/theme-init.js" />
      </head>
      <body className="h-full bg-background text-foreground">
        <DynamicFavicon />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
