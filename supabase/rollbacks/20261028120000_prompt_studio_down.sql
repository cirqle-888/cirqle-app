BEGIN;
DELETE FROM public.designation_permissions WHERE permission_id IN (SELECT id FROM public.permissions WHERE key IN ('prompt_studio.view','prompt_studio.manage'));
DELETE FROM public.permissions WHERE key IN ('prompt_studio.view','prompt_studio.manage');
DROP TABLE IF EXISTS public.prompt_library;
DROP TABLE IF EXISTS public.prompt_templates;
DROP TABLE IF EXISTS public.prompt_client_cards;
COMMIT;
