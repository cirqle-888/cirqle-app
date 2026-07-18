-- Canvas upgrade #2 for the Social Calendar planner.
--
-- 1. scheduled_end_date: some deliverables run over a PERIOD, not one day
--    (ad campaigns, SEO sprints, email series). An item with an end date spans
--    from scheduled_date → scheduled_end_date on the calendar.
-- 2. reference_urls: MULTIPLE visual references per item (a mood board), not
--    just one. reference_url (added in canvas #1) stays as the legacy single
--    field and is kept in sync with reference_urls[0] for old readers.

ALTER TABLE public.social_calendar_items
  ADD COLUMN IF NOT EXISTS scheduled_end_date DATE;

ALTER TABLE public.social_calendar_items
  ADD COLUMN IF NOT EXISTS reference_urls TEXT[] NOT NULL DEFAULT '{}';

-- Backfill the array from any existing single reference so nothing is lost.
UPDATE public.social_calendar_items
   SET reference_urls = ARRAY[reference_url]
 WHERE reference_url IS NOT NULL
   AND (reference_urls IS NULL OR reference_urls = '{}');
