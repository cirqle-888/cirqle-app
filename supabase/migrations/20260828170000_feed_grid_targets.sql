-- ============================================================================
-- Target grid layout — the arrangement we WANT, not one we can impose
-- ============================================================================
-- Additive and idempotent. Safe to re-run.
--
-- Instagram's Grid Reorder (8 June 2026) and pinning are both app-only. Meta's
-- media endpoint takes exactly one writable field, comment_enabled: there is no
-- pin endpoint, no position field, and pinned state cannot even be READ back.
-- So Cirqle cannot move a live post, and this table does not pretend to. It
-- stores the layout someone wants, so the app can work out the fewest moves to
-- get there and hand them a checklist to follow on their phone.
--
-- WHY A SEPARATE TABLE. The obvious home is a column on social_media_items,
-- but that table is a MIRROR owned by the social-sync cron — every pull
-- rewrites it, and a plan living there would be destroyed on a schedule. This
-- is our own layer, keyed by account, and sync cannot touch it.
--
-- WHY KEYS RATHER THAN FOREIGN KEYS. A grid mixes two sources: published posts
-- (social_media_items) and planned ones (social_posts). The tile keys already
-- used by the planner — 'published:<uuid>' and 'planned:<uuid>' — address both
-- in one ordered list. The cost is no referential integrity, so every read
-- filters against the tiles that currently exist; a post deleted in the app
-- simply drops out of the plan instead of producing an instruction about
-- something that is no longer there.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.feed_grid_targets (
  account_id    UUID PRIMARY KEY REFERENCES public.social_accounts(id) ON DELETE CASCADE,

  -- The layout someone arranged, as an ordered array of tile keys.
  target_order  JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Up to 3, Instagram's cap. Enforced in the app, not here: a longer list
  -- should be truncated for display, never rejected at write time and lost.
  pinned_keys   JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- What we BELIEVE is live, which is the best anyone can do — the API returns
  -- media by date with no position. Seeded from newest-first and replaced by
  -- the target whenever someone confirms they have applied it. If they reorder
  -- on their phone without saying so, this drifts, and the instructions are
  -- wrong until the next confirmation. That is why they are guidance.
  live_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  live_pinned   JSONB NOT NULL DEFAULT '[]'::jsonb,

  applied_at    TIMESTAMPTZ,
  applied_by    UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  updated_by    UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.feed_grid_targets IS
  'Desired profile-grid layout per Instagram account. Instagram exposes no API '
  'for reordering or pinning, so this drives a checklist a human follows in the '
  'app; it never reaches Meta.';

COMMENT ON COLUMN public.feed_grid_targets.live_snapshot IS
  'What Cirqle believes is currently live. Not readable from the API — seeded '
  'newest-first, then replaced each time someone confirms they applied the target.';

-- Reached only through the service role, like the rest of the social tables.
-- RLS on with no policy = deny-all for anon/authenticated; the service role
-- bypasses it. Matches the post-sweep convention.
ALTER TABLE public.feed_grid_targets ENABLE ROW LEVEL SECURITY;

COMMIT;
