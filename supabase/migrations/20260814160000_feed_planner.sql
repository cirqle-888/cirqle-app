-- Instagram Feed Planner: arrange creatives visually before committing to dates.
--
-- The grid is how a client actually experiences a feed — three columns, newest
-- first — so planning it is a visual act, not a calendar one. A creative must
-- be placeable in the grid BEFORE anyone decides when it posts; otherwise every
-- rough idea needs a date it hasn't earned.
--
-- Hence grid_order: position in the planner, independent of scheduled_at. The
-- two coexist deliberately —
--   grid_order    where it SITS while planning
--   scheduled_at  when it actually publishes
-- and the planner shows both, so a post scheduled out of grid order is visible
-- rather than silently contradictory.
--
-- Also adds 'changes_requested': the client has seen a post and wants edits.
-- Without it that outcome collapses into 'draft' and the reason is lost.

BEGIN;

ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS grid_order INTEGER;

COMMENT ON COLUMN public.social_posts.grid_order IS
  'Position in the Feed Planner grid (lower = nearer the top-left, i.e. more recent in Instagram terms). NULL = not placed in the grid. Independent of scheduled_at: a creative can be arranged visually long before it has a date.';

-- Feed-planner reads are always "this account, placed tiles, in order".
CREATE INDEX IF NOT EXISTS social_posts_grid_idx
  ON public.social_posts (account_id, grid_order)
  WHERE grid_order IS NOT NULL;

-- ── Client asked for edits ──────────────────────────────────────────────────
-- Re-state the whole CHECK: Postgres has no "add value to a CHECK".
ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_status_check;
ALTER TABLE public.social_posts ADD CONSTRAINT social_posts_status_check
  CHECK (status IN (
    'draft',
    'awaiting_approval',
    'changes_requested',   -- client reviewed it and wants changes
    'approved',
    'scheduled',
    'publishing',
    'published',
    'failed',
    'cancelled'
  ));

-- What the client said when asking for changes. Kept on the post so the note
-- travels with the creative rather than living in a chat someone has to find.
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS review_note TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- ── Client approval links ───────────────────────────────────────────────────
-- A read-only view of one account's planned grid, shareable with the client.
-- Deliberately its own table rather than a column on social_accounts: a link is
-- revocable and expiring, and several may exist over a feed's life.
CREATE TABLE IF NOT EXISTS public.feed_share_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  client_id    UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  -- URL-safe random string; the only credential the client needs.
  token        TEXT NOT NULL UNIQUE,
  label        TEXT,
  -- NULL = never expires. Revoking sets revoked_at rather than deleting, so an
  -- old link resolves to "this link was withdrawn" instead of a blank 404.
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS feed_share_links_account_idx ON public.feed_share_links (account_id);

ALTER TABLE public.feed_share_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS feed_share_links_rw ON public.feed_share_links;
CREATE POLICY feed_share_links_rw ON public.feed_share_links
  FOR ALL TO authenticated USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);

-- ── Permission ──────────────────────────────────────────────────────────────
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('social', 'plan_feed', 'social.plan_feed', 'Plan the Instagram feed',
   'Arrange creatives in the feed grid, upload new ones and share the plan with the client for approval', 89)
ON CONFLICT (key) DO NOTHING;

-- Anyone who already manages social content can plan the feed.
INSERT INTO public.designation_permissions (designation_id, permission_id)
SELECT dp.designation_id, p.id
  FROM public.designation_permissions dp
  JOIN public.permissions existing ON existing.id = dp.permission_id
  CROSS JOIN public.permissions p
 WHERE existing.key = 'social.manage'
   AND p.key = 'social.plan_feed'
ON CONFLICT DO NOTHING;

COMMIT;
