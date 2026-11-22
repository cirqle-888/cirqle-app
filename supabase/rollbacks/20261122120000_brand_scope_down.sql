-- Undo 20261122120000_brand_scope.
-- Drops brand staff assignments, the department → brand link and task_label.
-- The "Personalised Gifts" department is removed only while no service uses
-- it; once Memoura's products live there it stays (delete it by hand if
-- truly unwanted).
BEGIN;
DROP TABLE IF EXISTS public.employee_brands;
DELETE FROM public.service_categories c
 WHERE lower(c.name) = 'personalised gifts'
   AND NOT EXISTS (SELECT 1 FROM public.services s WHERE s.category_id = c.id);
ALTER TABLE public.service_categories DROP COLUMN IF EXISTS brand_id;
ALTER TABLE public.brands DROP COLUMN IF EXISTS task_label;
NOTIFY pgrst, 'reload schema';
COMMIT;
