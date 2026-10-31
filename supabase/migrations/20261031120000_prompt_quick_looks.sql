BEGIN;
CREATE TABLE IF NOT EXISTS public.prompt_quick_looks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  template_key text NOT NULL,
  client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE,
  values jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(values) = 'object'),
  style_id uuid REFERENCES public.prompt_library(id) ON DELETE SET NULL,
  language text NOT NULL DEFAULT '',
  created_by uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS prompt_quick_looks_template ON public.prompt_quick_looks(template_key, client_id) WHERE deleted_at IS NULL;
ALTER TABLE public.prompt_quick_looks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.prompt_quick_looks FROM anon, authenticated;
GRANT ALL ON public.prompt_quick_looks TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
