-- Rollback: Website Portfolio permissions.

DELETE FROM public.designation_permissions
 WHERE permission_id IN (
   SELECT id FROM public.permissions WHERE key IN ('portfolio.view', 'portfolio.manage')
 );

DELETE FROM public.permissions
 WHERE key IN ('portfolio.view', 'portfolio.manage');
