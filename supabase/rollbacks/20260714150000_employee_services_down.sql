-- Rollback for 20260714150000_employee_services.sql
DELETE FROM public.designation_permissions
WHERE permission_id IN (SELECT id FROM public.permissions WHERE key = 'tasks.view_by_service');
DELETE FROM public.permissions WHERE key = 'tasks.view_by_service';
DROP TABLE IF EXISTS public.employee_services;
