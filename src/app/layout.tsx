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
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background`}>
      <head>
        {/* Plain <script> in a Server Component renders to HTML on the server —
            no React 19 client-side script-tag warning. Runs before hydration
            to set the correct theme class without a flash. */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/theme-init.js" />
      </head>
      {/* No h-full on body/html — let them be auto-height (= content height).
          h-full resolves to the ICB height which on Chrome iOS equals the
          screen minus only the *permanent* browser chrome (bottom nav bar),
          making body taller than the h-dvh dashboard wrapper. That gap
          appears as a blank strip that elastic-scroll reveals. Auto-height
          ensures body never exceeds the layout wrapper. */}
      <body className="bg-background text-foreground">
        <DynamicFavicon />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
