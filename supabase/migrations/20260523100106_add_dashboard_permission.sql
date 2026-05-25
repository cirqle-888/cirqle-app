-- Idempotent: ON CONFLICT DO NOTHING prevents duplicate-key error on re-run.
INSERT INTO public.permissions (key, label, module)
VALUES ('dashboard.view', 'View Dashboard', 'Dashboard')
ON CONFLICT (key) DO NOTHING;
