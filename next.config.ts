import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Client Router Cache TTLs (seconds). Next 15+ defaults `dynamic` to 0,
    // which means our `force-dynamic` pages are NEVER cached client-side — so
    // every sidebar click re-runs all server queries and re-fetches the full
    // payload, even when returning to a page you visited seconds ago. That is
    // the page-switch lag.
    //
    // Setting `dynamic: 30` lets the client reuse a page's rendered segments
    // for 30s after a visit: re-navigation within that window is instant (no
    // server round-trip). Safe for our data because every mutating server
    // action calls `revalidatePath(...)`, which busts this cache immediately —
    // so an edit is always reflected on the next navigation, never stale.
    // `static: 300` keeps loading.tsx shells/prefetched routes reusable for 5m.
    staleTimes: {
      dynamic: 30,
      static: 300,
    },
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // Clickjacking protection — the app is never legitimately iframed.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          // Prevent MIME-type sniffing of responses.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Force HTTPS for a year (Vercel already serves HTTPS; this pins it).
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          // Don't leak full URLs (which contain portal/intake tokens) to third parties.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Lock down powerful browser features the app doesn't use.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]
  },
  async redirects() {
    return [
      {
        source: '/dashboard/advertising/campaigns/:id',
        destination: '/dashboard/advertising/:id',
        permanent: true,
      },
    ]
  },
};

export default nextConfig;
