-- Shared Content Brief
--
-- The Social Calendar and Requests both brief a designer on a piece of
-- content. They now share one shape (src/lib/content-brief.ts):
--
--   { v: 1, contentType, caption (sanitized HTML), captionCanvas,
--     referenceImages: [url], notes, links: [{label, url}] }
--
-- * task_requests.content_brief — the brief exactly as planned. Requests
--   created from the Calendar carry the calendar item's brief unchanged;
--   requests created on the Requests page write the same object.
--   task_requests.description keeps a plain-text copy for text-only readers
--   (Tasks prefill, client portal). Older requests have no content_brief and
--   keep showing description / design_plan / remarks / links read-only.
--
-- * social_calendar_items.links — the brief's Links field on the calendar
--   side (the item already stores caption, caption_canvas, reference_urls
--   and notes).
--
-- Both columns are nullable/defaulted, so nothing existing changes.

BEGIN;

ALTER TABLE public.task_requests
  ADD COLUMN IF NOT EXISTS content_brief JSONB;

COMMENT ON COLUMN public.task_requests.content_brief IS
  'Shared Content Brief (v1): contentType, caption HTML, captionCanvas, referenceImages, notes, links. description holds its plain-text projection.';

ALTER TABLE public.social_calendar_items
  ADD COLUMN IF NOT EXISTS links JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.social_calendar_items.links IS
  'Content Brief links: [{label, url}] — http(s) only, max 10.';

COMMIT;
