-- Prompt Studio: the "Offer Flyer" category (3D text effects and product photo
-- fixes) for custom templates. Built-in templates live in code and need no SQL.
-- Run AFTER 20261028120000_prompt_studio.sql. Safe to re-run.
BEGIN;
ALTER TABLE public.prompt_templates DROP CONSTRAINT IF EXISTS prompt_templates_category_check;
ALTER TABLE public.prompt_templates ADD CONSTRAINT prompt_templates_category_check
  CHECK (category IN ('flyer','ad','film','product','agency','fix'));
COMMIT;
