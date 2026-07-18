-- Brainstorming-canvas upgrade for the Social Calendar planner.
--
-- 1. Ideas without a date: scheduled_date becomes NULLABLE. An undated item
--    lives on the "Idea Board" backlog lane and is dragged onto a day when
--    the team commits to it.
-- 2. Content types for EVERY service, not just social formats: poster, blog,
--    seo, ad, email join the list (CHECK widened; old values stay valid).
-- 3. reference_url: a visual reference (uploaded image or pasted link) so an
--    idea card can SHOW the intended creative, not just describe it.

ALTER TABLE public.social_calendar_items
  ALTER COLUMN scheduled_date DROP NOT NULL;

ALTER TABLE public.social_calendar_items
  DROP CONSTRAINT IF EXISTS social_calendar_items_content_type_check;

ALTER TABLE public.social_calendar_items
  ADD CONSTRAINT social_calendar_items_content_type_check
  CHECK (content_type IN (
    'post','reel','story','carousel','video','flyer',
    'poster','blog','seo','ad','email','other'
  ));

ALTER TABLE public.social_calendar_items
  ADD COLUMN IF NOT EXISTS reference_url TEXT;

-- Public bucket for reference images (idempotent; storage API also ensures it).
INSERT INTO storage.buckets (id, name, public)
VALUES ('social-refs', 'social-refs', true)
ON CONFLICT (id) DO NOTHING;
