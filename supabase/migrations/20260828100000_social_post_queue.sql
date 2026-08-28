-- ============================================================================
-- Publishing queue: the missing half of the social pipeline
-- ============================================================================
-- Additive and idempotent. Safe to re-run.
--
-- Today the social flow ends when the DESIGNER finishes. A plan goes
-- calendar → request → task → done, and then nothing: no one is told the
-- creative is ready, no caption is written, and nothing records that it went
-- out. Live proof at the time of writing — Sea Star's Independence Day poster
-- (REQ-17) was planned for 2026-08-15, the artwork was completed, and it sat
-- 13 days past its date with no trace of whether it was ever posted.
--
-- social_posts already models the publishing half (caption, hashtags, media,
-- scheduled_at, the Meta publisher cron). It has never held a row. This
-- migration adds only what it lacks to also serve the MANUAL path, which is
-- how posting actually happens today.
-- ============================================================================

BEGIN;

-- ── 1. Which clients do we actually post for? ───────────────────────────────
-- Connected accounts are NOT the signal: Sea Star Supermarket, MEZZA and Roots
-- all have live Instagram/Facebook connections used for insights and reporting,
-- but we do not publish on their behalf — they buy individual posters. Posting
-- to a client's real account is irreversible, so this is an explicit flag
-- rather than something inferred at read time.
--
-- Named to match the existing has_offer_flyer_service precedent.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS has_social_media_service BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.clients.has_social_media_service IS
  'We publish social content on this client''s behalf. Gates the posting queue. '
  'Auto-enabled when a social calendar is created for the client; can be turned '
  'off manually for a client we plan for but do not post for.';

-- Backfill: planning a month for a client is the act that means "we run their
-- social". Turns on Elara and Sea Star Catering; leaves the poster-only
-- clients off.
UPDATE public.clients c
   SET has_social_media_service = TRUE
 WHERE NOT c.has_social_media_service
   AND EXISTS (SELECT 1 FROM public.social_calendars sc WHERE sc.client_id = c.id);

-- ...and keep it true going forward. One-directional on purpose: creating a
-- calendar turns the queue ON, deleting one never turns it off, so a client is
-- never silently dropped mid-cycle by an archived calendar.
CREATE OR REPLACE FUNCTION public.social_calendar_enables_publishing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.clients
     SET has_social_media_service = TRUE
   WHERE id = NEW.client_id
     AND has_social_media_service = FALSE;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS social_calendar_enables_publishing_tr ON public.social_calendars;
CREATE TRIGGER social_calendar_enables_publishing_tr
  AFTER INSERT ON public.social_calendars
  FOR EACH ROW EXECUTE FUNCTION public.social_calendar_enables_publishing();

-- ── 2. Accessibility copy ───────────────────────────────────────────────────
-- Instagram and Facebook both accept alt text; nothing in the schema held it,
-- so it could only ever be retyped into the native app from memory.
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS alt_text TEXT;

COMMENT ON COLUMN public.social_posts.alt_text IS
  'Image alt text for screen readers. Written here so it is planned with the '
  'caption rather than improvised at posting time.';

-- ── 3. The manual path ──────────────────────────────────────────────────────
-- Posting happens by hand today: she opens Instagram, posts, and comes back to
-- record it. That is a first-class outcome, not a degraded one, so it is
-- stored rather than inferred from a missing external_media_id.
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS posted_manually BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.social_posts.posted_manually IS
  'TRUE when a human posted this natively and recorded it here. Distinguishes '
  'a real manual post from an API publish, so reporting stays honest.';

-- account_id was NOT NULL because every row was assumed to be an API publish.
-- The manual path has no account to publish through — she may not have decided
-- where it goes when she writes the caption. Safe to relax: the table is empty,
-- and the publisher only ever reads status='scheduled' rows, which the app
-- refuses to create without an account.
ALTER TABLE public.social_posts
  ALTER COLUMN account_id DROP NOT NULL;

-- ── 4. Queue lookup ─────────────────────────────────────────────────────────
-- The queue joins from calendar items to their post, so this is the hot path.
CREATE INDEX IF NOT EXISTS social_posts_calendar_item_idx
  ON public.social_posts (calendar_item_id)
  WHERE calendar_item_id IS NOT NULL AND deleted_at IS NULL;

COMMIT;
