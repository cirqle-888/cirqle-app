-- Website Portfolio module — permissions only.
--
-- The content itself lives in a SEPARATE Supabase project (the one that serves
-- cirqle.work). Nothing is created here but the right to manage it; see
-- cirqle-website/supabase/schema.sql for the tables and buckets.

INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('portfolio', 'view',   'portfolio.view',
    'View Website Portfolio', 'See the portfolio work published on cirqle.work', 82),
  ('portfolio', 'manage', 'portfolio.manage',
    'Manage Website Portfolio', 'Upload, edit, reorder and unpublish work shown on cirqle.work', 83)
ON CONFLICT (key) DO NOTHING;

-- Auto-grant to admin designations (mirrors social calendar).
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('portfolio.view', 'portfolio.manage')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;
