import type { Metadata, Viewport } from 'next'
import { Inter, Geist_Mono } from 'next/font/google'
import './globals.css'
import { ThemeProvider } from '@/contexts/theme-context'
import { DynamicFavicon } from '@/components/ui/dynamic-favicon'
import { MobileShell } from '@/components/mobile/mobile-shell'

// Inter — the professional SaaS standard. `display: swap` avoids invisible text
// while the font loads. Exposed as --font-inter; globals.css maps --font-sans
// (and --font-heading) onto it, so the whole app inherits Inter.
const inter = Inter({ variable: '--font-inter', subsets: ['latin'], display: 'swap' })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'], display: 'swap' })

export const metadata: Metadata = {
  title: 'Cirqle — Business Management',
  description: 'Cirqle Works business management system',
  // Icons come from the app/ file conventions: icon.svg → <link rel="icon">
  // (favicon) and apple-icon.png → <link rel="apple-touch-icon"> (iOS home
  // screen — iOS ignores SVG icons, so a real 180² PNG is required). A manual
  // `icons` block here would suppress the apple-icon convention, so it's omitted.
  //
  // Standalone "Add to Home Screen" behaviour on iOS/iPadOS: chromeless launch,
  // app title, and a status bar that follows the page. Emits the
  // apple-mobile-web-app-* + mobile-web-app-capable meta tags.
  appleWebApp: {
    capable: true,
    title: 'Cirqle',
    statusBarStyle: 'default',
  },
}

// viewport-fit=cover is what makes env(safe-area-inset-*) resolve to real
// values on notched phones (the native Capacitor shell + iOS/Android Safari);
// on web and Electron there are no insets, so this is a no-op there.
// initialScale=1 with NO maximumScale/userScalable — pinch-zoom stays enabled
// (WCAG 1.4.4). themeColor tints the mobile browser/status-bar chrome per theme.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0f1a' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${geistMono.variable} antialiased bg-background`}>
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
        <ThemeProvider>
          <MobileShell />
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
