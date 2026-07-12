import type { MetadataRoute } from 'next'

/**
 * Web App Manifest — makes Cirqle an installable PWA (Android/desktop Chrome
 * "Install app", iOS/iPadOS Safari "Add to Home Screen"). Next auto-injects the
 * <link rel="manifest"> tag from this file convention.
 *
 * This is the zero-cost, no-Apple-account path to an installable iPhone/iPad
 * app: the home-screen icon (apple-icon.png) + these standalone hints give a
 * chromeless, native-feeling shell over the live app. Android employees use the
 * signed APK instead; this manifest is harmless there and on the desktop app.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Cirqle — Business Management',
    short_name: 'Cirqle',
    description: 'Cirqle business management system',
    // Installed app opens straight into the workspace; middleware handles auth.
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
