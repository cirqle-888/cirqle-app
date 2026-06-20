-- Adds the `contributions.view_activity` permission to the catalog.
--
-- Gates the per-task Activity Log + "Log note" on the Contributions detail.
-- Off by default for every designation (only super-admins have all perms);
-- grant it per-designation in Settings → Designations.
--
-- Idempotent: ON CONFLICT DO NOTHING so re-runs are safe.
INSERT INTO public.permissions (module, action, key, label, description, display_order)
VALUES (
  'contributions',
  'view_activity',
  'contributions.view_activity',
  'View contribution activity log',
  'See the per-task activity timeline and post log notes on the Contributions detail',
  33
)
ON CONFLICT (key) DO NOTHING;
