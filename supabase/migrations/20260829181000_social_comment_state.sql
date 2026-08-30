-- ============================================================================
-- Comment inbox — the bit Meta will not remember for us
-- ============================================================================
-- Additive and idempotent. Safe to re-run.
--
-- Whether a comment has been ANSWERED is derived live from Meta: if the newest
-- message in the thread is not ours, it is waiting. That needs no storage and
-- cannot drift.
--
-- What Meta has no concept of is a comment somebody deliberately decided not to
-- answer — an emoji, a bot, a "🔥". Without somewhere to record that, those sit
-- at the top of the queue forever and the queue stops being believed. This
-- table holds only that decision.
--
-- Keyed by Meta's comment id, which is stable and globally unique across both
-- platforms, so no foreign key is possible or wanted: a comment deleted on
-- Instagram should simply stop appearing, not fail a constraint.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.social_comment_state (
  comment_id   TEXT PRIMARY KEY,
  account_id   UUID NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  -- 'dismissed' = consciously not replying. Nothing else is stored, because
  -- everything else is a question better asked of Meta.
  state        TEXT NOT NULL DEFAULT 'dismissed' CHECK (state IN ('dismissed')),
  note         TEXT,
  handled_by   UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  handled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.social_comment_state IS
  'Comments a human decided not to answer. Whether a comment was ANSWERED is '
  'read live from Meta and deliberately not stored here.';

CREATE INDEX IF NOT EXISTS social_comment_state_account_idx
  ON public.social_comment_state (account_id);

-- Service-role only, like the rest of the social tables.
ALTER TABLE public.social_comment_state ENABLE ROW LEVEL SECURITY;

COMMIT;
