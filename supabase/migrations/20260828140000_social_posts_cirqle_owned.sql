-- ============================================================================
-- Let Cirqle's own accounts hold content
-- ============================================================================
-- Additive and idempotent. Safe to re-run.
--
-- social_accounts.owner_type already separates the two kinds of account:
--
--   'client'  → 7 accounts, every one assigned to a client
--   'cirqle'  → 2 accounts (@cirqle.works on Instagram and Facebook), which
--               have NO client and never will. Asset Assignment groups them
--               under "Cirqle — our own accounts · excluded from all client
--               reporting", which is exactly right.
--
-- social_posts.client_id was NOT NULL, written when every post was assumed to
-- belong to a client. So nothing could be planned or uploaded for our own
-- feed: the Feed Planner refused with "No client on this account — assign it
-- to a client in Asset Assignment first", advice that cannot be followed and
-- should not be. The planner's own source comment says the opposite of what it
-- did: "Client-owned and Cirqle-owned both appear; the planner is useful for
-- our own feed too."
--
-- NULL client_id now means "Cirqle's own", which is the same thing it already
-- means on social_accounts. Reporting is unaffected: every client-facing query
-- filters by a specific client_id, so a NULL row is excluded by construction —
-- matching the "excluded from all client reporting" promise rather than
-- working around it.
--
-- The app still requires a client for CLIENT-owned accounts; an unassigned
-- client account is a real misconfiguration and keeps the original error.
-- ============================================================================

BEGIN;

ALTER TABLE public.social_posts
  ALTER COLUMN client_id DROP NOT NULL;

COMMENT ON COLUMN public.social_posts.client_id IS
  'The client this post belongs to, or NULL for content on one of Cirqle''s '
  'own accounts (social_accounts.owner_type = ''cirqle''). Client reporting '
  'filters by a specific client_id and therefore excludes NULL rows.';

-- The existing (client_id, status) index does not serve "our own" lookups,
-- because NULLs are not useful there. This one does.
CREATE INDEX IF NOT EXISTS social_posts_cirqle_owned_idx
  ON public.social_posts (account_id, status)
  WHERE client_id IS NULL AND deleted_at IS NULL;

COMMIT;
