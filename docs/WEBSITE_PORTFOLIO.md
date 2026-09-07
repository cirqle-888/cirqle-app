# Website Portfolio module

Dashboard → **Portfolio**. Manages the work published on cirqle.work.

## Why it talks to a second Supabase project

The marketing site is a public single-page app, so whatever Supabase key it
ships is readable by anyone who opens dev tools. Pointing it at this app's
project would publish the same key that fronts payroll, finance, cashbook and
client data, leaving only Row Level Security between a policy mistake and a
leak.

So website content lives in its own Supabase project, holding nothing but
published marketing content. This module is the only thing that writes to it,
using that project's service role key — server-side, never in the browser.

## Environment

Add to `.env.local` and to Vercel:

```
WEBSITE_SUPABASE_URL=https://<website-project-ref>.supabase.co
WEBSITE_SUPABASE_SERVICE_ROLE_KEY=<website project service role key>
```

Optional, for the "View live" links (defaults to `https://cirqle.work`):

```
NEXT_PUBLIC_WEBSITE_URL=https://cirqle.work
```

Without the first two the page renders a setup notice instead of failing.

## Permissions

`portfolio.view` and `portfolio.manage`, added by
`supabase/migrations/20260907120000_website_portfolio_permissions.sql` and
auto-granted to admin designations. Grant them to other designations in
Settings → Designations.

## What can be published

The module has a **Work** tab and a **Supermarket flyers** tab.

Work entries come in three kinds, stored in `work_items.kind`:

- **image** — a still. `variants` holds its WebP renditions.
- **video** — a file we host at `media_path`, played inline on the site.
  `variants` holds the poster frame, captured from the video in the browser.
  Capped at 50 MB; `.mov` will not always decode for a poster, and the upload
  still succeeds without one.
- **reel** — hosted elsewhere, at `external_url`. Nothing is uploaded. YouTube
  is embedded and plays on the site; Instagram, TikTok and Facebook refuse to
  be embedded, so the site shows the cover and sends the visitor to the post.

A video may also carry `external_url`, so someone who watches it on the site
can still be sent to Instagram to like and share it.

Flyers live in their own `flyers` table rather than a bucket listing, because
the website flips through them like a printed brochure and object storage has
no dependable ordering. Drag to set page order.

### Video and the free tier

Supabase's free plan includes 1 GB of storage and 5 GB of egress a month. A
20 MB reel watched 250 times spends the whole monthly egress. Prefer reel
links for anything already on Instagram or YouTube.

## How uploading works

Supabase image transformation is a paid add-on, so renditions are produced in
the browser instead:

1. The file is decoded once and re-encoded as WebP at up to four widths
   (480 / 960 / 1600 / 2000), never upscaling.
2. `createWorkUploadUrls` returns one signed upload URL per width.
3. The browser PUTs each blob straight to the website project's storage, so the
   original never passes through this server.
4. `saveWorkItem` records the row with its rendition list.

A 12 MB print export becomes a few hundred kilobytes of WebP. The file name
becomes the title and the web address: `03-happy-smile-day.jpg` publishes as
"Happy Smile Day" at `/portfolio/social-media/<brand>?v=happy-smile-day`.

The widths must stay in step with `cirqle-website/scripts/seed-portfolio.mjs`,
which does the same job for bulk migrations. Both read from
`src/lib/portfolio/types.ts` on their own side.

## Schema

Owned by the website repo: `cirqle-website/supabase/schema.sql`. Three tables
(`work_collections` → `work_brands` → `work_items`) plus the `work` and
`flyers` storage buckets. The website reads them with an anon key restricted to
published rows; every write needs the service role key.
