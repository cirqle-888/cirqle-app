-- Variant formats for calendar items: a planned post that also ships as a
-- story-size (or other) variant of the SAME creative. One item, one design
-- request — the variants ride along in the brief, the calendar chip, and the
-- PDF/Excel exports instead of cluttering the plan with duplicate items.
--
-- Values use the same vocabulary as content_type ('story', 'post', 'reel', …);
-- the app filters out the item's own main type.

ALTER TABLE public.social_calendar_items
  ADD COLUMN IF NOT EXISTS variants TEXT[] NOT NULL DEFAULT '{}';
