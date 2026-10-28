BEGIN;
CREATE TABLE IF NOT EXISTS public.prompt_client_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL UNIQUE REFERENCES public.clients(id) ON DELETE CASCADE,
  card jsonb NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.prompt_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE,
  name text NOT NULL, category text NOT NULL CHECK (category IN ('ad','film','product','agency','fix')),
  purpose text, use_in text, uses_client_card boolean NOT NULL DEFAULT true,
  fields jsonb NOT NULL DEFAULT '[]', body text NOT NULL, based_on text,
  created_by uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.prompt_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  template_key text NOT NULL, template_name text NOT NULL, title text,
  inputs jsonb NOT NULL DEFAULT '{}', prompt text NOT NULL, ai_result text,
  is_favorite boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS prompt_library_recent ON public.prompt_library (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS prompt_library_client ON public.prompt_library (client_id);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['prompt_client_cards','prompt_templates','prompt_library'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
 ('prompt_studio','view','prompt_studio.view','Use Prompt Studio','Build, copy, generate and save prompts; download skills.',67),
 ('prompt_studio','manage','prompt_studio.manage','Manage Prompt Studio','Edit Client Cards and custom templates.',68)
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE FROM public.designations d CROSS JOIN public.permissions p
WHERE d.is_admin = TRUE AND p.key IN ('prompt_studio.view','prompt_studio.manage')
ON CONFLICT (designation_id, permission_id) DO NOTHING;
COMMIT;
