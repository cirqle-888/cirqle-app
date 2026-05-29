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
};

export default nextConfig;
