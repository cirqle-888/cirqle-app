-- Fails if any custom template already uses the 'flyer' category: move or
-- delete those first (UPDATE public.prompt_templates SET category = 'product' WHERE category = 'flyer').
BEGIN;
ALTER TABLE public.prompt_templates DROP CONSTRAINT IF EXISTS prompt_templates_category_check;
ALTER TABLE public.prompt_templates ADD CONSTRAINT prompt_templates_category_check
  CHECK (category IN ('ad','film','product','agency','fix'));
COMMIT;
