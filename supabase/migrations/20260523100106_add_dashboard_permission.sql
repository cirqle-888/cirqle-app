-- Idempotent: ON CONFLICT DO NOTHING prevents duplicate-key error on re-run.
INSERT INTO public.permissions (key, label, module, action)
VALUES ('dashboard.view', 'View Dashboard', 'Dashboard', 'view')
ON CONFLICT (key) DO NOTHING;
