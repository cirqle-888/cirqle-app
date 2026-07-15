-- Rollback for 20260715090000_clients_module_permissions.sql
DELETE FROM public.designation_permissions
WHERE permission_id IN (SELECT id FROM public.permissions WHERE key = 'clients.view');
DELETE FROM public.permissions WHERE key = 'clients.view';
